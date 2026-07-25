/**
 * Technical debt: the marker scan, and the report that turns raw analyzer
 * output into a prioritized, costed backlog.
 *
 * Two design commitments run through this file.
 *
 * **Markers come from comments only.** Grepping a repository for `TODO` finds
 * the word in string constants, in test fixtures, in documentation prose and in
 * any file that happens to discuss task tracking. Every one of those is a false
 * positive. `scanMarkers` reuses the lexer in `complexity.ts` and searches only
 * the comment channel, and only in real source files — so a Markdown checklist
 * or a `const label = 'TODO'` never shows up as debt.
 *
 * **Every item cites numbers.** A debt report that says "complexity is high" is
 * worthless; a maintainer cannot act on an adjective. Each `DebtItem` names the
 * files and quotes the measurements that produced it, so the reader can check
 * the claim and decide for themselves.
 */

import type {
  CodeMarker,
  ComplexityReport,
  DebtItem,
  DependencyReport,
  DuplicateBlock,
  RepoSnapshot,
  RepoStats,
  Severity,
  TechDebtReport,
} from '../types';
import { isCountableSource, isDocumentationFile, isTestFile } from '../shared/classify';
import { basename, dirname, stem } from '../shared/paths';
import { clamp, hashString, squish, truncate } from '../shared/text';
import { maskSource } from './complexity';

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/**
 * Uppercase only, on purpose.
 *
 * `TODO`/`FIXME`/`HACK`/`XXX`/`DEPRECATED` are shouted by convention in every
 * ecosystem. Matching case-insensitively would turn ordinary English ("the
 * deprecated API", "a todo list") into findings, and prose in comments is
 * common. Precision beats recall here — a missed lowercase `todo` costs nothing,
 * a hundred false markers destroys the report's credibility.
 */
const MARKER_PATTERN = /\b(TODO|FIXME|HACK|XXX|DEPRECATED)\b\s*(?:\([^)]*\))?\s*[:\-–—]?\s*(.*)$/;

/** Payload cap. A repository with thousands of markers has one problem, not thousands. */
const MAX_MARKERS = 500;

/** Longest line we bother scanning; anything longer is minified or data. */
const MAX_SCAN_LINE = 2000;

/** Find TODO-family markers, in comments only, across real source files. */
export function scanMarkers(snapshot: RepoSnapshot): CodeMarker[] {
  const markers: CodeMarker[] = [];

  for (const file of snapshot.files) {
    if (file.isBinary || file.content === null) continue;
    if (!isCountableSource(file.path, file.content)) continue;

    const { comments } = maskSource(file.content, file.path);

    comments.forEach((comment, offset) => {
      if (comment === '' || comment.length > MAX_SCAN_LINE) return;

      const match = MARKER_PATTERN.exec(comment);
      if (!match) return;

      const kind = match[1];
      if (!isMarkerKind(kind)) return;

      markers.push({
        kind,
        file: file.path,
        line: offset + 1,
        text: truncate(squish(match[2] ?? ''), 200),
      });
    });
  }

  return markers.slice(0, MAX_MARKERS);
}

function isMarkerKind(value: string | undefined): value is CodeMarker['kind'] {
  return (
    value === 'TODO' ||
    value === 'FIXME' ||
    value === 'HACK' ||
    value === 'XXX' ||
    value === 'DEPRECATED'
  );
}

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/**
 * Remediation cost model — engineer-hours, and where the numbers come from.
 *
 * These are deliberately conservative, ordinal estimates whose job is to let a
 * team *rank* debt and budget a sprint, not to be right to the hour. Each rate
 * is anchored to a concrete unit of work rather than pulled from the air:
 *
 * | Item                     | Model                                        |
 * |--------------------------|----------------------------------------------|
 * | Complexity hotspot       | `sloc/120 + cyclomatic/20 + nesting`, 2–24h  |
 * |                          | (read the file, extract units, re-test)       |
 * | Oversized file (>500)    | 2.5h each to split, capped at 30h            |
 * | Deeply nested file       | 1.5h each to flatten, capped at 20h          |
 * | Duplication              | 1h per 40 duplicated lines, 1–40h            |
 * | Missing README           | 3h to write a usable one                     |
 * | Thin module docs         | 0.05h per source file, capped at 20h         |
 * | No tests at all          | `totalSloc/150`, 4–80h (harness + coverage)  |
 * | Low test ratio           | proportional to the coverage gap, 2–40h      |
 * | Missing lockfile         | 1h to generate, verify and commit            |
 * | Unpinned range           | 0.25h each to pin and verify, capped at 8h   |
 * | Flagged dependency       | 4h each to migrate, capped at 40h            |
 * | Flat oversized directory | 4h to introduce structure                    |
 * | Deep tree                | 3h to flatten                                |
 * | TODO-family marker       | 0.4h each to resolve or delete, capped 24h   |
 * | DEPRECATED marker        | 0.75h each to remove the shim, capped 12h    |
 *
 * Rounded to the nearest half hour so the output does not imply false precision.
 */
function hours(value: number): number {
  return Math.round(value * 2) / 2;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Risk score above which a file is worth naming individually. */
const HOTSPOT_THRESHOLD = 70;

/** Source lines above which a single file should have been split. */
const OVERSIZED_SLOC = 500;

/** Nesting depth at which control flow stops being readable. */
const DEEP_NESTING = 6;

/** Source files in one directory before the layout counts as flat. */
const FLAT_DIRECTORY_FILES = 30;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Turn measurements into a costed, prioritized debt backlog.
 *
 * Every analyzer input is already computed elsewhere; this function's only job
 * is judgement — deciding which measurements cross a threshold worth a
 * maintainer's attention, and what it costs to clear them.
 */
export function analyzeTechDebt(
  snapshot: RepoSnapshot,
  complexity: ComplexityReport,
  duplicates: readonly DuplicateBlock[],
  deps: DependencyReport,
  stats: RepoStats,
): TechDebtReport {
  const markers = scanMarkers(snapshot);
  const items: DebtItem[] = [
    ...complexityItems(complexity),
    ...duplicationItems(duplicates),
    ...documentationItems(snapshot, complexity, stats),
    ...testingItems(complexity, stats),
    ...dependencyItems(deps),
    ...structureItems(snapshot, stats),
    ...conventionItems(snapshot, complexity, markers),
  ];

  items.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.estimatedHours - a.estimatedHours ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const total = items.reduce((sum, item) => sum + item.estimatedHours, 0);

  return {
    items,
    totalEstimatedHours: Math.round(total * 10) / 10,
    markers,
    duplicates,
  };
}

function item(
  category: DebtItem['category'],
  slug: string,
  title: string,
  detail: string,
  severity: Severity,
  files: readonly string[],
  estimatedHours: number,
): DebtItem {
  return {
    id: `debt-${category}-${slug}`,
    title,
    detail,
    severity,
    category,
    files,
    estimatedHours,
  };
}

// --- complexity -------------------------------------------------------------

function complexityItems(complexity: ComplexityReport): DebtItem[] {
  const items: DebtItem[] = [];
  const named = new Set<string>();

  for (const file of complexity.hotspots) {
    if (file.riskScore < HOTSPOT_THRESHOLD) break;
    if (items.length >= 5) break;
    named.add(file.path);

    items.push(
      item(
        'complexity',
        `hotspot-${hashString(file.path)}`,
        `Break up high-risk file ${basename(file.path)}`,
        `${file.path} scores ${file.riskScore}/100 on maintainability risk: ${file.sloc} source lines, ` +
          `cyclomatic complexity ${file.cyclomatic}, nesting depth ${file.maxNesting}, ${file.functions} functions. ` +
          `That is ${Math.round((file.cyclomatic / Math.max(file.sloc, 1)) * 100)} decision points per 100 lines.`,
        file.riskScore >= 85 ? 'high' : 'medium',
        [file.path],
        hours(clamp(file.sloc / 120 + file.cyclomatic / 20 + file.maxNesting, 2, 24)),
      ),
    );
  }

  const oversized = complexity.files
    .filter((file) => file.sloc > OVERSIZED_SLOC && !named.has(file.path))
    .sort((a, b) => b.sloc - a.sloc);

  if (oversized.length > 0) {
    const listed = oversized.slice(0, 10);
    items.push(
      item(
        'complexity',
        'oversized-files',
        `${oversized.length} file${oversized.length === 1 ? '' : 's'} exceed ${OVERSIZED_SLOC} source lines`,
        `Largest: ${listed
          .map((file) => `${file.path} (${file.sloc} sloc)`)
          .join(', ')}. Files this size are read by nobody in full before being edited, ` +
          `which is how unrelated changes end up in the same commit.`,
        oversized.length > 5 ? 'medium' : 'low',
        listed.map((file) => file.path),
        hours(Math.min(30, oversized.length * 2.5)),
      ),
    );
  }

  const deep = complexity.files
    .filter((file) => file.maxNesting >= DEEP_NESTING && !named.has(file.path))
    .sort((a, b) => b.maxNesting - a.maxNesting);

  if (deep.length > 0) {
    const listed = deep.slice(0, 10);
    items.push(
      item(
        'complexity',
        'deep-nesting',
        `${deep.length} file${deep.length === 1 ? '' : 's'} nest control flow ${DEEP_NESTING} levels or deeper`,
        `Deepest: ${listed
          .map((file) => `${file.path} (depth ${file.maxNesting})`)
          .join(
            ', ',
          )}. Guard clauses and early returns usually remove two or three levels for free.`,
        deep.some((file) => file.maxNesting >= 9) ? 'medium' : 'low',
        listed.map((file) => file.path),
        hours(Math.min(20, deep.length * 1.5)),
      ),
    );
  }

  return items;
}

// --- duplication ------------------------------------------------------------

function duplicationItems(duplicates: readonly DuplicateBlock[]): DebtItem[] {
  if (duplicates.length === 0) return [];

  const items: DebtItem[] = [];
  const duplicatedLines = duplicates.reduce(
    (sum, block) => sum + block.lineCount * (block.occurrences.length - 1),
    0,
  );

  const files = new Set<string>();
  for (const block of duplicates) {
    for (const occurrence of block.occurrences) files.add(occurrence.file);
  }

  items.push(
    item(
      'duplication',
      'copy-paste',
      `${duplicates.length} duplicated block${duplicates.length === 1 ? '' : 's'} across ${files.size} file${files.size === 1 ? '' : 's'}`,
      `Roughly ${duplicatedLines} lines exist in more than one place. Largest block: ` +
        `${duplicates
          .slice(0, 3)
          .map(
            (block) =>
              `${block.lineCount} lines × ${block.occurrences.length} (${block.occurrences
                .map((occurrence) => `${occurrence.file}:${occurrence.startLine}`)
                .slice(0, 3)
                .join(', ')})`,
          )
          .join('; ')}. Every one of these is a place a bug fix has to be applied twice.`,
      duplicatedLines > 400 ? 'high' : duplicatedLines > 100 ? 'medium' : 'low',
      [...files].slice(0, 10),
      hours(clamp(duplicatedLines / 40, 1, 40)),
    ),
  );

  const largest = duplicates[0];
  if (largest && largest.lineCount >= 15) {
    items.push(
      item(
        'duplication',
        `block-${largest.hash}`,
        `Extract a ${largest.lineCount}-line block repeated ${largest.occurrences.length} times`,
        `The same ${largest.lineCount} significant lines appear at ${largest.occurrences
          .map((occurrence) => `${occurrence.file}:${occurrence.startLine}`)
          .join(', ')}. A block this long is a missing abstraction, not an accident.`,
        'medium',
        largest.occurrences.map((occurrence) => occurrence.file),
        hours(clamp(largest.lineCount / 15, 1, 12)),
      ),
    );
  }

  return items;
}

// --- documentation ----------------------------------------------------------

function documentationItems(
  snapshot: RepoSnapshot,
  complexity: ComplexityReport,
  stats: RepoStats,
): DebtItem[] {
  const items: DebtItem[] = [];

  const readme = snapshot.files.find((file) => /^readme(\.|$)/i.test(basename(file.path)));
  if (!readme) {
    items.push(
      item(
        'documentation',
        'missing-readme',
        'Repository has no README',
        `None of the ${stats.files} files is a README. A reader arriving from a link has no entry point, ` +
          `no install steps and no statement of what the project is for.`,
        'high',
        [],
        hours(3),
      ),
    );
  }

  const docFiles = snapshot.files.filter((file) => isDocumentationFile(file.path));
  const sourceFiles = complexity.files.length;

  if (readme && docFiles.length <= 1 && sourceFiles > 40) {
    items.push(
      item(
        'documentation',
        'readme-only',
        'README is the only documentation',
        `${sourceFiles} source files are described by ${docFiles.length} documentation file${docFiles.length === 1 ? '' : 's'}. ` +
          `Architecture, deployment and contribution guidance have nowhere to live.`,
        'low',
        docFiles.map((file) => file.path).slice(0, 5),
        hours(6),
      ),
    );
  }

  if (stats.commentRatio < 0.1 && complexity.totalSloc > 1000) {
    items.push(
      item(
        'documentation',
        'sparse-comments',
        'Modules carry almost no explanatory comments',
        `Only ${Math.round(stats.commentRatio * 100)}% of source files open with a doc comment across ` +
          `${complexity.totalSloc} source lines. The "why" behind non-obvious code is not written down anywhere.`,
        'low',
        [],
        hours(Math.min(20, sourceFiles * 0.05)),
      ),
    );
  }

  return items;
}

// --- testing ----------------------------------------------------------------

function testingItems(complexity: ComplexityReport, stats: RepoStats): DebtItem[] {
  const items: DebtItem[] = [];

  if (stats.testFiles === 0) {
    items.push(
      item(
        'testing',
        'no-tests',
        'Repository has no test files',
        `${complexity.files.length} source files and ${complexity.totalSloc} source lines ship with zero tests. ` +
          `Every change is an unverified change, and no refactor of the complexity hotspots above is safe.`,
        complexity.totalSloc > 200 ? 'critical' : 'high',
        [],
        hours(clamp(complexity.totalSloc / 150, 4, 80)),
      ),
    );
  } else if (stats.testRatio < 0.15) {
    items.push(
      item(
        'testing',
        'low-test-ratio',
        'Test coverage of the file tree is thin',
        `${stats.testFiles} test files cover ${complexity.files.length} source files — a ratio of ` +
          `${Math.round(stats.testRatio * 100)}%, against roughly 30% for a comfortably tested codebase.`,
        stats.testRatio < 0.05 ? 'high' : 'medium',
        [],
        hours(clamp(((0.15 - stats.testRatio) * complexity.totalSloc) / 120, 2, 40)),
      ),
    );
  }

  return items;
}

// --- dependencies -----------------------------------------------------------

function dependencyItems(deps: DependencyReport): DebtItem[] {
  const items: DebtItem[] = [];

  if (!deps.hasLockfile && deps.manifests.length > 0) {
    items.push(
      item(
        'dependencies',
        'missing-lockfile',
        'No lockfile is committed',
        `${deps.manifests.length} manifest${deps.manifests.length === 1 ? '' : 's'} (${deps.manifests
          .slice(0, 5)
          .join(
            ', ',
          )}) declare ${deps.dependencies.length} dependencies with no lockfile beside them. ` +
          `Two installs a week apart can resolve to different code.`,
        'medium',
        deps.manifests.slice(0, 5),
        hours(1),
      ),
    );
  }

  if (deps.unpinned.length > 0) {
    items.push(
      item(
        'dependencies',
        'unpinned-ranges',
        `${deps.unpinned.length} dependenc${deps.unpinned.length === 1 ? 'y is' : 'ies are'} unpinned`,
        `${deps.unpinned.slice(0, 10).join(', ')} resolve to whatever is newest at install time. ` +
          `Builds are not reproducible and an upstream breaking change lands without a commit.`,
        deps.unpinned.length > 5 ? 'medium' : 'low',
        deps.manifests.slice(0, 5),
        hours(Math.min(8, deps.unpinned.length * 0.25)),
      ),
    );
  }

  if (deps.flagged.length > 0) {
    const worst = deps.flagged.reduce<Severity>(
      (max, flag) => (SEVERITY_RANK[flag.severity] > SEVERITY_RANK[max] ? flag.severity : max),
      'low',
    );
    items.push(
      item(
        'dependencies',
        'flagged-packages',
        `${deps.flagged.length} dependenc${deps.flagged.length === 1 ? 'y is' : 'ies are'} deprecated or unsafe`,
        deps.flagged
          .slice(0, 8)
          .map(
            (flag) =>
              `${flag.name}: ${flag.reason}${flag.replacement ? ` (use ${flag.replacement})` : ''}`,
          )
          .join('; '),
        worst,
        deps.manifests.slice(0, 5),
        hours(Math.min(40, deps.flagged.length * 4)),
      ),
    );
  }

  return items;
}

// --- structure --------------------------------------------------------------

function structureItems(snapshot: RepoSnapshot, stats: RepoStats): DebtItem[] {
  const items: DebtItem[] = [];
  const perDirectory = new Map<string, number>();

  for (const file of snapshot.files) {
    if (!isCountableSource(file.path, file.content)) continue;
    const dir = dirname(file.path);
    perDirectory.set(dir, (perDirectory.get(dir) ?? 0) + 1);
  }

  const crowded = [...perDirectory.entries()]
    .filter(([, count]) => count > FLAT_DIRECTORY_FILES)
    .sort((a, b) => b[1] - a[1]);

  if (crowded.length > 0) {
    items.push(
      item(
        'structure',
        'flat-directories',
        `${crowded.length} director${crowded.length === 1 ? 'y holds' : 'ies hold'} more than ${FLAT_DIRECTORY_FILES} source files`,
        crowded
          .slice(0, 5)
          .map(([dir, count]) => `${dir === '' ? '<root>' : dir} (${count} files)`)
          .join(', ') + `. A directory this flat gives no hint about which files belong together.`,
        'low',
        crowded.slice(0, 5).map(([dir]) => dir),
        hours(4),
      ),
    );
  }

  if (stats.maxDepth > 8) {
    items.push(
      item(
        'structure',
        'deep-tree',
        `Directory tree is ${stats.maxDepth} levels deep`,
        `Paths this long are usually a sign of mirrored folder hierarchies (one per layer, per feature, per type) ` +
          `rather than genuine grouping.`,
        'low',
        [],
        hours(3),
      ),
    );
  }

  return items;
}

// --- convention -------------------------------------------------------------

const NAMING_STYLES: readonly { readonly name: string; readonly test: RegExp }[] = [
  { name: 'kebab-case', test: /^[a-z0-9]+(?:-[a-z0-9]+)+$/ },
  { name: 'snake_case', test: /^[a-z0-9]+(?:_[a-z0-9]+)+$/ },
  { name: 'PascalCase', test: /^[A-Z][A-Za-z0-9]*$/ },
  { name: 'camelCase', test: /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/ },
];

function conventionItems(
  snapshot: RepoSnapshot,
  complexity: ComplexityReport,
  markers: readonly CodeMarker[],
): DebtItem[] {
  const items: DebtItem[] = [];

  const todoish = markers.filter((marker) => marker.kind !== 'DEPRECATED');
  const density = complexity.totalSloc > 0 ? (todoish.length / complexity.totalSloc) * 1000 : 0;

  if (todoish.length >= 20 || (todoish.length > 0 && density > 5)) {
    const byKind = new Map<string, number>();
    for (const marker of todoish) byKind.set(marker.kind, (byKind.get(marker.kind) ?? 0) + 1);

    items.push(
      item(
        'convention',
        'marker-density',
        `${todoish.length} unresolved TODO/FIXME markers in the source`,
        `${[...byKind.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ')} — ` +
          `${density.toFixed(1)} per 1000 source lines. Examples: ${todoish
            .slice(0, 3)
            .map(
              (marker) => `${marker.file}:${marker.line}${marker.text ? ` (${marker.text})` : ''}`,
            )
            .join('; ')}.`,
        density > 12 ? 'medium' : 'low',
        [...new Set(todoish.map((marker) => marker.file))].slice(0, 10),
        hours(Math.min(24, todoish.length * 0.4)),
      ),
    );
  }

  const deprecated = markers.filter((marker) => marker.kind === 'DEPRECATED');
  if (deprecated.length > 0) {
    items.push(
      item(
        'convention',
        'deprecated-code',
        `${deprecated.length} deprecated code path${deprecated.length === 1 ? '' : 's'} still in the tree`,
        `Marked at ${deprecated
          .slice(0, 5)
          .map((marker) => `${marker.file}:${marker.line}`)
          .join(
            ', ',
          )}. Deprecated code that is never deleted becomes code everyone is afraid to delete.`,
        deprecated.length > 5 ? 'medium' : 'low',
        [...new Set(deprecated.map((marker) => marker.file))].slice(0, 10),
        hours(Math.min(12, deprecated.length * 0.75)),
      ),
    );
  }

  const naming = namingSplit(snapshot);
  if (naming) {
    items.push(
      item(
        'convention',
        'mixed-file-naming',
        'Source files mix naming conventions',
        `${naming.first.count} files use ${naming.first.name} and ${naming.second.count} use ${naming.second.name} ` +
          `out of ${naming.total} named source files. Contributors have to guess, and the guess is wrong half the time.`,
        'low',
        [],
        hours(2),
      ),
    );
  }

  return items;
}

interface NamingSplit {
  readonly total: number;
  readonly first: { readonly name: string; readonly count: number };
  readonly second: { readonly name: string; readonly count: number };
}

/**
 * Detect a genuinely mixed naming convention.
 *
 * Requires both leaders to hold at least 20% of classified files, so a codebase
 * with one stray `MyComponent.tsx` among kebab-case modules is not reported.
 * Test files are excluded because test naming legitimately follows the module
 * it covers.
 */
function namingSplit(snapshot: RepoSnapshot): NamingSplit | null {
  const counts = new Map<string, number>();
  let total = 0;

  for (const file of snapshot.files) {
    if (!isCountableSource(file.path, file.content)) continue;
    if (isTestFile(file.path)) continue;

    const name = stem(file.path);
    const style = NAMING_STYLES.find((candidate) => candidate.test.test(name));
    if (!style) continue;

    counts.set(style.name, (counts.get(style.name) ?? 0) + 1);
    total += 1;
  }

  if (total < 20) return null;

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const first = ranked[0];
  const second = ranked[1];
  if (!first || !second) return null;
  if (second[1] / total < 0.2) return null;

  return {
    total,
    first: { name: first[0], count: first[1] },
    second: { name: second[0], count: second[1] },
  };
}
