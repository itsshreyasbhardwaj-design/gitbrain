/**
 * Repository health scoring.
 *
 * Eight dimensions, each scored 0–100 from facts that other analyzers already
 * produced. Three properties are non-negotiable, because a score nobody trusts
 * is worse than no score at all:
 *
 *  1. **Deterministic.** Same input, same output. No clocks, no randomness, no
 *     iteration over unordered structures whose order could change a number.
 *  2. **Monotonic.** Every model is built so that improving the underlying
 *     reality can only raise the score. Adding tests raises `testing`; removing
 *     a cycle raises `architecture`; deleting a secret raises `security`. There
 *     is no term anywhere that rewards doing less.
 *  3. **Defensible.** Every number in a rationale is a measured quantity, never
 *     an adjective. "3 circular dependency chains across 11 files" is a fact a
 *     maintainer can go and check; "architecture could be cleaner" is not.
 *
 * Each scorer carries a doc comment explaining the curve it uses and why the
 * thresholds sit where they do. Read those before changing a constant — the
 * numbers are calibrated against each other, and moving one in isolation makes
 * the composite score dishonest.
 *
 * Two hard floors override the smooth curves, because averaging can otherwise
 * launder a disqualifying defect:
 *
 *  - A repository with **zero test files** cannot exceed
 *    {@link NO_TESTS_CEILING} on `testing`, whatever its tooling looks like.
 *  - A repository with a **critical committed secret** cannot exceed
 *    {@link CRITICAL_SECRET_CEILING} on `security`, whatever its score input
 *    said.
 */

import type {
  ComplexityReport,
  DependencyReport,
  HealthDimension,
  HealthReport,
  HealthScore,
  LanguageBreakdown,
  ModuleGraph,
  ReadmeReport,
  RepoStats,
  SecurityReport,
  StackDetection,
  Suggestion,
  TechDebtReport,
} from '../types';
import { basename } from '../shared/paths';
import { clamp } from '../shared/text';

export interface HealthInput {
  readonly stats: RepoStats;
  readonly languages: readonly LanguageBreakdown[];
  readonly stack: StackDetection;
  readonly dependencies: DependencyReport;
  readonly graph: ModuleGraph;
  readonly complexity: ComplexityReport;
  readonly debt: TechDebtReport;
  readonly security: SecurityReport;
  readonly readme: ReadmeReport;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

type Grade = HealthScore['grade'];

/** A>=90, B>=80, C>=70, D>=60, else F. Deliberately the school scale users expect. */
function toGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/** Safe division that returns `fallback` instead of NaN/Infinity. */
function ratio(part: number, total: number, fallback = 0): number {
  if (!Number.isFinite(total) || total <= 0) return fallback;
  return part / total;
}

/**
 * A linear penalty ramp.
 *
 * Returns 0 while `value` is at or below `free`, then rises linearly to `max`
 * as `value` reaches `worst`. Every penalty in this module is expressed with
 * this one function, which is what guarantees monotonicity: improving `value`
 * can only ever move the penalty down.
 */
function ramp(value: number, free: number, worst: number, max: number): number {
  if (!Number.isFinite(value) || value <= free) return 0;
  if (worst <= free) return max;
  return clamp(((value - free) / (worst - free)) * max, 0, max);
}

/** The inverse ramp: full credit at `best`, none at or below `none`. */
function reward(value: number, none: number, best: number, max: number): number {
  if (!Number.isFinite(value) || value <= none) return 0;
  if (best <= none) return max;
  return clamp(((value - none) / (best - none)) * max, 0, max);
}

function round(value: number): number {
  return Math.round(value);
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

function pct(value: number): string {
  return `${(clamp(value, 0, 1) * 100).toFixed(1)}%`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function suggestion(
  id: string,
  title: string,
  detail: string,
  impact: Suggestion['impact'],
  effort: Suggestion['effort'],
  files: readonly string[] = [],
): Suggestion {
  return { id, title, detail, impact, effort, files };
}

// ---------------------------------------------------------------------------
// Derived facts — computed once, shared by every scorer
// ---------------------------------------------------------------------------

type NamingStyle = 'kebab-case' | 'snake_case' | 'camelCase' | 'PascalCase' | 'mixed';

interface DerivedFacts {
  /** Every repo-relative path any analyzer mentioned. Used to infer file presence. */
  readonly paths: readonly string[];
  readonly analysedFiles: number;
  readonly totalSloc: number;
  readonly duplicatedLines: number;
  readonly duplicationRatio: number;
  readonly averageLoc: number;
  readonly averageNesting: number;
  readonly bigFiles: number;
  readonly hugeFiles: number;
  readonly hotspots: number;
  readonly namingStyle: NamingStyle;
  readonly namingConsistency: number;
  readonly primaryLanguage: string;
  readonly primaryLanguagePercent: number;
  readonly idiomaticNaming: boolean;
  readonly orphanRatio: number;
  readonly averageInstability: number;
  readonly cohesion: number;
  readonly cyclicFiles: number;
  readonly runtimeDeps: number;
  readonly totalDeps: number;
  readonly largeFileBytes: number;
  readonly debtHoursPerKSloc: number;
  readonly criticalSecrets: number;
  readonly highSecrets: number;
  readonly hasLicense: boolean;
  readonly hasContributing: boolean;
  readonly hasCodeOfConduct: boolean;
  readonly hasDocsDir: boolean;
  readonly hasLinterConfig: boolean;
  readonly hasContainer: boolean;
  readonly hasEnvTemplate: boolean;
  readonly hasTaskRunner: boolean;
  readonly ciRunsTests: boolean;
}

/**
 * Collect every repo-relative path mentioned anywhere in the input.
 *
 * `HealthInput` deliberately excludes the raw snapshot — health scoring runs on
 * conclusions, not on files. But several dimensions need to know whether a
 * LICENSE or a Dockerfile exists, so the union of every path cited as evidence
 * by the other analyzers is used as a proxy for the file listing. It is a
 * subset of the real tree, so this inference can produce a false negative
 * (a file nobody cited) but never a false positive.
 */
function collectPaths(input: HealthInput): string[] {
  const paths = new Set<string>();
  const add = (path: string | null | undefined): void => {
    if (path) paths.add(path);
  };

  add(input.readme.path);
  for (const manifest of input.dependencies.manifests) add(manifest);

  const groups = [
    input.stack.frameworks,
    input.stack.packageManagers,
    input.stack.ci,
    input.stack.deployment,
    input.stack.testing,
    input.stack.databases,
    input.stack.runtimes,
  ];
  for (const group of groups) {
    for (const detection of group) {
      for (const file of detection.files) add(file);
    }
  }
  for (const endpoint of input.stack.api.endpoints) add(endpoint.file);

  for (const node of input.graph.nodes) add(node.path);
  for (const file of input.complexity.files) add(file.path);
  for (const item of input.debt.items) for (const file of item.files) add(file);
  for (const marker of input.debt.markers) add(marker.file);
  for (const duplicate of input.debt.duplicates) {
    for (const occurrence of duplicate.occurrences) add(occurrence.file);
  }
  for (const secret of input.security.secrets) add(secret.file);
  for (const envVar of input.security.envVars) for (const file of envVar.files) add(file);
  for (const large of input.security.largeFiles) add(large.path);
  for (const risk of input.security.risks) for (const file of risk.files) add(file);

  // Sorted so the derived facts are byte-for-byte reproducible.
  return [...paths].sort();
}

function anyPath(paths: readonly string[], pattern: RegExp): boolean {
  return paths.some((path) => pattern.test(path));
}

const LICENSE_PATH = /(^|\/)licen[cs]e(\.[a-z]+)?$/i;
const CONTRIBUTING_PATH = /(^|\/)contributing(\.[a-z]+)?$/i;
const CONDUCT_PATH = /(^|\/)code[_-]of[_-]conduct(\.[a-z]+)?$/i;
const DOCS_DIR = /^(docs|doc|documentation)\//i;
const LINTER_CONFIG =
  /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[^/]*|prettier\.config\.[cm]?[jt]s|biome\.jsonc?|\.golangci\.ya?ml|ruff\.toml|\.flake8|\.rubocop\.yml|rustfmt\.toml|\.editorconfig|setup\.cfg)$/i;
const CONTAINER_FILE = /(^|\/)(dockerfile[^/]*|docker-compose\.ya?ml|compose\.ya?ml)$/i;
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template|dist)$/i;
const TASK_RUNNER =
  /(^|\/)(makefile|justfile|taskfile\.ya?ml|package\.json|pyproject\.toml|cargo\.toml|build\.gradle(\.kts)?|pom\.xml|composer\.json|gemfile)$/i;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SNAKE = /^[a-z0-9]+(_[a-z0-9]+)*$/;
const CAMEL = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL = /^[A-Z][a-zA-Z0-9]*$/;

/**
 * Naming convention agreement across source filenames.
 *
 * A single lowercase word (`index`, `server`) is valid kebab, snake *and*
 * camel, so it is counted for all three. That is intentional: such files are
 * never the reason a codebase feels inconsistent, and penalising them would
 * make small repositories score worse than large ones for no reason.
 */
function analyseNaming(paths: readonly string[]): { style: NamingStyle; consistency: number } {
  const counts = new Map<NamingStyle, number>([
    ['kebab-case', 0],
    ['snake_case', 0],
    ['camelCase', 0],
    ['PascalCase', 0],
  ]);

  let total = 0;
  for (const path of paths) {
    const stem = basename(path).split('.')[0] ?? '';
    if (!stem) continue;
    total++;
    if (KEBAB.test(stem)) counts.set('kebab-case', (counts.get('kebab-case') ?? 0) + 1);
    if (SNAKE.test(stem)) counts.set('snake_case', (counts.get('snake_case') ?? 0) + 1);
    if (CAMEL.test(stem)) counts.set('camelCase', (counts.get('camelCase') ?? 0) + 1);
    if (PASCAL.test(stem)) counts.set('PascalCase', (counts.get('PascalCase') ?? 0) + 1);
  }

  if (total === 0) return { style: 'mixed', consistency: 1 };

  let style: NamingStyle = 'mixed';
  let best = 0;
  for (const [candidate, count] of counts) {
    if (count > best) {
      best = count;
      style = candidate;
    }
  }

  return { style: best === 0 ? 'mixed' : style, consistency: best / total };
}

/** File-naming conventions that read as idiomatic for a given language. */
const IDIOMATIC_NAMING: Readonly<Record<string, readonly NamingStyle[]>> = {
  Python: ['snake_case'],
  Rust: ['snake_case'],
  Go: ['snake_case', 'kebab-case'],
  Ruby: ['snake_case'],
  Elixir: ['snake_case'],
  Java: ['PascalCase'],
  Kotlin: ['PascalCase'],
  Scala: ['PascalCase'],
  'C#': ['PascalCase'],
  Swift: ['PascalCase'],
  TypeScript: ['kebab-case', 'camelCase', 'PascalCase'],
  JavaScript: ['kebab-case', 'camelCase', 'PascalCase'],
};

function deriveFacts(input: HealthInput): DerivedFacts {
  const paths = collectPaths(input);
  const { complexity, graph, debt, security, dependencies, stats } = input;

  const analysedFiles = complexity.files.length || graph.nodes.length || stats.files;
  const totalSloc = complexity.totalSloc || stats.linesOfCode;

  let duplicatedLines = 0;
  for (const block of debt.duplicates) {
    duplicatedLines += block.lineCount * Math.max(0, block.occurrences.length - 1);
  }

  let nestingSum = 0;
  let bigFiles = 0;
  let hugeFiles = 0;
  let hotspots = 0;
  for (const file of complexity.files) {
    nestingSum += file.maxNesting;
    if (file.loc > 500) bigFiles++;
    if (file.loc > 1000) hugeFiles++;
    if (file.riskScore >= 70) hotspots++;
  }
  if (hotspots === 0) {
    hotspots = complexity.hotspots.filter((file) => file.riskScore >= 70).length;
  }

  const namingSource =
    complexity.files.length > 0
      ? complexity.files.map((file) => file.path)
      : graph.nodes.map((node) => node.path);
  const naming = analyseNaming(namingSource);

  const primaryLanguage = input.languages.reduce<LanguageBreakdown | null>(
    (best, language) => (best === null || language.percent > best.percent ? language : best),
    null,
  );
  const primaryName = primaryLanguage?.language ?? 'Unknown';
  const idiomatic = IDIOMATIC_NAMING[primaryName];
  const idiomaticNaming =
    idiomatic === undefined || naming.style === 'mixed' ? true : idiomatic.includes(naming.style);

  let instabilitySum = 0;
  for (const node of graph.nodes) instabilitySum += node.instability;

  const nodePaths = new Map<string, string>();
  for (const node of graph.nodes) nodePaths.set(node.id, node.path);
  const topDir = (path: string): string => path.split('/')[0] ?? '';

  let internalEdges = 0;
  for (const edge of graph.edges) {
    const from = nodePaths.get(edge.from);
    const to = nodePaths.get(edge.to);
    if (from !== undefined && to !== undefined && topDir(from) === topDir(to)) internalEdges++;
  }

  const cyclicFiles = new Set<string>();
  for (const cycle of graph.cycles) for (const member of cycle) cyclicFiles.add(member);

  let criticalSecrets = 0;
  let highSecrets = 0;
  for (const secret of security.secrets) {
    if (secret.severity === 'critical') criticalSecrets++;
    if (secret.severity === 'high') highSecrets++;
  }

  let largeFileBytes = 0;
  for (const file of security.largeFiles) largeFileBytes += file.size;

  const ciEvidence = input.stack.ci
    .flatMap((detection) => [detection.name, ...detection.evidence, ...detection.files])
    .join(' ')
    .toLowerCase();

  return {
    paths,
    analysedFiles,
    totalSloc,
    duplicatedLines,
    duplicationRatio: ratio(duplicatedLines, totalSloc),
    averageLoc: ratio(complexity.totalLoc || stats.linesOfCode, analysedFiles),
    averageNesting: ratio(nestingSum, complexity.files.length),
    bigFiles,
    hugeFiles,
    hotspots,
    namingStyle: naming.style,
    namingConsistency: naming.consistency,
    primaryLanguage: primaryName,
    primaryLanguagePercent: primaryLanguage?.percent ?? 0,
    idiomaticNaming,
    orphanRatio: ratio(graph.orphans.length, graph.nodes.length),
    averageInstability: ratio(instabilitySum, graph.nodes.length),
    cohesion: ratio(internalEdges, graph.edges.length, 1),
    cyclicFiles: cyclicFiles.size,
    runtimeDeps: dependencies.counts.runtime,
    totalDeps: dependencies.dependencies.length,
    largeFileBytes,
    debtHoursPerKSloc: ratio(debt.totalEstimatedHours, totalSloc / 1000),
    criticalSecrets,
    highSecrets,
    hasLicense: anyPath(paths, LICENSE_PATH) || sectionPresent(input.readme, 'License'),
    hasContributing:
      anyPath(paths, CONTRIBUTING_PATH) || sectionPresent(input.readme, 'Contributing'),
    hasCodeOfConduct: anyPath(paths, CONDUCT_PATH),
    hasDocsDir: anyPath(paths, DOCS_DIR),
    hasLinterConfig: anyPath(paths, LINTER_CONFIG),
    hasContainer:
      anyPath(paths, CONTAINER_FILE) ||
      input.stack.deployment.some((detection) => /docker|container/i.test(detection.name)),
    hasEnvTemplate:
      anyPath(paths, ENV_TEMPLATE) || security.envVars.some((envVar) => envVar.documented),
    hasTaskRunner: anyPath(paths, TASK_RUNNER) || dependencies.manifests.length > 0,
    ciRunsTests:
      input.stack.ci.length > 0 && (ciEvidence.includes('test') || input.stack.testing.length > 0),
  };
}

function sectionPresent(readme: ReadmeReport, name: string): boolean {
  return readme.sections.some((section) => section.name === name && section.present);
}

// ---------------------------------------------------------------------------
// Dimension: documentation
// ---------------------------------------------------------------------------

/**
 * Documentation = can a stranger understand this repository without asking?
 *
 * Additive model out of 100, because documentation is genuinely a sum of
 * independent artefacts rather than a pristine state degraded by defects:
 *
 * - **README quality, 50 points.** Straight pass-through of `readme.score`,
 *   scaled. Half the weight, because the README is the only document most
 *   people ever read.
 * - **Prose documentation, 20 points.** Full credit at five documentation
 *   files, which is roughly "README + CONTRIBUTING + a `docs/` folder with
 *   three guides". A dedicated `docs/` tree is worth 5 of those 20 on its own,
 *   since it is what distinguishes a documented project from a described one.
 * - **Comment ratio, 20 points.** Full credit at 40% of source files carrying a
 *   leading doc comment. The target is deliberately not 100%: comments on every
 *   file is a smell, not a virtue, and past ~40% the marginal reader value is
 *   nil.
 * - **Community health files, 10 points.** LICENSE 5, CONTRIBUTING 3,
 *   CODE_OF_CONDUCT 2 — ordered by how badly their absence blocks an outsider.
 */
function scoreDocumentation(input: HealthInput, facts: DerivedFacts): HealthScore {
  const { readme, stats } = input;

  const readmePoints = (clamp(readme.score, 0, 100) / 100) * 50;
  const docsPoints = reward(stats.documentationFiles, 0, 5, 15) + (facts.hasDocsDir ? 5 : 0);
  const commentPoints = reward(stats.commentRatio, 0, 0.4, 20);
  const communityPoints =
    (facts.hasLicense ? 5 : 0) + (facts.hasContributing ? 3 : 0) + (facts.hasCodeOfConduct ? 2 : 0);

  const score = clamp(round(readmePoints + docsPoints + commentPoints + communityPoints), 0, 100);

  const rationale: string[] = [
    readme.exists
      ? `README at ${readme.path ?? 'the repository root'} scored ${readme.score}/100 with ${readme.wordCount} words and ${readme.missingSections.length} of ${readme.sections.length} sections missing.`
      : 'No README at the repository root.',
    `${plural(stats.documentationFiles, 'documentation file')} in the tree; dedicated docs directory: ${facts.hasDocsDir ? 'yes' : 'no'}.`,
    `${pct(stats.commentRatio)} of source files carry a leading doc comment (${commentPoints.toFixed(0)}/20 points).`,
    `Community health files score ${communityPoints}/10 — LICENSE: ${facts.hasLicense ? 'present' : 'absent'}, CONTRIBUTING: ${facts.hasContributing ? 'present' : 'absent'}, CODE_OF_CONDUCT: ${facts.hasCodeOfConduct ? 'present' : 'absent'}.`,
  ];

  const suggestions: Suggestion[] = [];
  if (!readme.exists) {
    suggestions.push(
      suggestion(
        'doc-readme-create',
        'Create a README',
        "The repository has no root README, so its GitHub page is blank. The README analyzer already generated a complete starter set of sections filled in with this repository's clone URL, package manager and scripts.",
        'high',
        'low',
      ),
    );
  } else if (readme.score < 70) {
    suggestions.push(
      suggestion(
        'doc-readme-improve',
        `Fill the ${readme.missingSections.length} missing README sections`,
        `README scores ${readme.score}/100. Missing: ${readme.missingSections.join(', ')}. Generated Markdown for each is available in the README report.`,
        'high',
        'low',
        readme.path ? [readme.path] : [],
      ),
    );
  }
  if (!facts.hasLicense) {
    suggestions.push(
      suggestion(
        'doc-license',
        'Add a LICENSE file',
        'No LICENSE file or README licence section was found. Without one, default copyright applies and nobody may legally reuse the code.',
        'high',
        'low',
      ),
    );
  }
  if (!facts.hasDocsDir && stats.documentationFiles < 3) {
    suggestions.push(
      suggestion(
        'doc-guides',
        'Start a docs/ directory',
        `Only ${plural(stats.documentationFiles, 'documentation file')} exists. Move setup, architecture and deployment guides into docs/ so the README can stay short.`,
        'medium',
        'medium',
      ),
    );
  }
  if (stats.commentRatio < 0.2) {
    suggestions.push(
      suggestion(
        'doc-comments',
        'Add file-level doc comments',
        `Only ${pct(stats.commentRatio)} of source files open with a doc comment. Target the ${facts.hotspots} highest-risk files first — those are the ones nobody wants to read cold.`,
        'medium',
        'medium',
      ),
    );
  }
  if (!facts.hasContributing) {
    suggestions.push(
      suggestion(
        'doc-contributing',
        'Add CONTRIBUTING.md',
        'No contributing guide was found. State the branch naming, install command, test command and review expectations once, rather than in every pull request.',
        'medium',
        'low',
      ),
    );
  }

  return {
    dimension: 'documentation',
    label: 'Documentation',
    score,
    grade: toGrade(score),
    rationale,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Dimension: maintainability
// ---------------------------------------------------------------------------

/**
 * Maintainability = how expensive is the next change?
 *
 * Penalty model from a perfect 100, because maintainability really is a
 * pristine state degraded by specific defects. Five ramps, capped at 105 points
 * of total penalty so a repository can bottom out at 0 without any single term
 * dominating:
 *
 * - **Average cyclomatic complexity, ≤35.** Free up to 5 (a file with a couple
 *   of branches), maximum at 25. Twenty-five is where a file stops fitting in
 *   one person's head.
 * - **Hotspot density, ≤20.** Share of analysed files scoring ≥70 risk. Free at
 *   0, maximum at 20% — one file in five being high-risk means the risk is the
 *   architecture, not the file.
 * - **Duplication, ≤20.** Duplicated lines over total SLOC. Free at 0, maximum
 *   at 10%. Ten percent is the level at which every bug fix has to be applied
 *   more than once.
 * - **Oversized files, ≤15.** Share of files over 500 LOC. Maximum at 15%.
 * - **Debt density, ≤15.** Estimated remediation hours per 1,000 SLOC, maximum
 *   at 40. Normalising by size is what stops a large healthy repository from
 *   scoring worse than a small rotten one.
 */
function scoreMaintainability(input: HealthInput, facts: DerivedFacts): HealthScore {
  const { complexity, debt } = input;

  const complexityPenalty = ramp(complexity.averageComplexity, 5, 25, 35);
  const hotspotPenalty = ramp(ratio(facts.hotspots, facts.analysedFiles), 0, 0.2, 20);
  const duplicationPenalty = ramp(facts.duplicationRatio, 0, 0.1, 20);
  const sizePenalty = ramp(ratio(facts.bigFiles, facts.analysedFiles), 0, 0.15, 15);
  const debtPenalty = ramp(facts.debtHoursPerKSloc, 0, 40, 15);

  const score = clamp(
    round(
      100 - complexityPenalty - hotspotPenalty - duplicationPenalty - sizePenalty - debtPenalty,
    ),
    0,
    100,
  );

  const rationale: string[] = [
    `Average cyclomatic complexity ${fixed(complexity.averageComplexity, 1)} across ${plural(facts.analysedFiles, 'analysed file')} (−${complexityPenalty.toFixed(0)}).`,
    `${plural(facts.hotspots, 'file')} scored risk ≥70, ${pct(ratio(facts.hotspots, facts.analysedFiles))} of the codebase (−${hotspotPenalty.toFixed(0)}).`,
    `${facts.duplicatedLines} duplicated lines across ${plural(debt.duplicates.length, 'clone group')}, ${pct(facts.duplicationRatio)} of ${facts.totalSloc} SLOC (−${duplicationPenalty.toFixed(0)}).`,
    `${plural(facts.bigFiles, 'file')} over 500 LOC, ${plural(facts.hugeFiles, 'file')} over 1000 LOC (−${sizePenalty.toFixed(0)}).`,
    `${fixed(debt.totalEstimatedHours, 1)} estimated debt hours across ${plural(debt.items.length, 'item')} = ${fixed(facts.debtHoursPerKSloc, 1)} h per 1000 SLOC (−${debtPenalty.toFixed(0)}).`,
    `${plural(debt.markers.length, 'TODO/FIXME marker')} left in source.`,
  ];

  const suggestions: Suggestion[] = [];
  const worst = complexity.hotspots.slice(0, 5);
  if (facts.hotspots > 0 && worst.length > 0) {
    suggestions.push(
      suggestion(
        'maint-hotspots',
        `Split the ${plural(facts.hotspots, 'high-risk file')}`,
        `${worst.map((file) => `${file.path} (risk ${file.riskScore}, ${file.loc} LOC, complexity ${file.cyclomatic})`).join('; ')}. Extract the branchiest functions first — risk score is dominated by branch density, not length.`,
        'high',
        'medium',
        worst.map((file) => file.path),
      ),
    );
  }
  if (facts.duplicationRatio > 0.03) {
    const biggest = [...debt.duplicates].sort((a, b) => b.lineCount - a.lineCount).slice(0, 3);
    suggestions.push(
      suggestion(
        'maint-duplication',
        `Deduplicate ${facts.duplicatedLines} repeated lines`,
        `${pct(facts.duplicationRatio)} of the codebase is duplicated across ${plural(debt.duplicates.length, 'clone group')}. Largest: ${biggest.map((block) => `${block.lineCount} lines in ${block.occurrences.length} places`).join(', ')}.`,
        'medium',
        'medium',
        biggest.flatMap((block) => block.occurrences.map((occurrence) => occurrence.file)),
      ),
    );
  }
  if (facts.bigFiles > 0) {
    suggestions.push(
      suggestion(
        'maint-file-size',
        `Break up ${plural(facts.bigFiles, 'file')} over 500 LOC`,
        `${plural(facts.hugeFiles, 'file')} exceed 1000 LOC. Files that large hide their own structure and make review diffs unreadable.`,
        'medium',
        'medium',
        complexity.files
          .filter((file) => file.loc > 500)
          .slice(0, 5)
          .map((file) => file.path),
      ),
    );
  }
  if (debt.markers.length > 10) {
    suggestions.push(
      suggestion(
        'maint-markers',
        `Triage ${plural(debt.markers.length, 'TODO/FIXME marker')}`,
        'Convert each marker into a tracked issue or delete it. Markers that survive a year are noise that trains everyone to ignore the rest.',
        'low',
        'low',
        [...new Set(debt.markers.map((marker) => marker.file))].slice(0, 5),
      ),
    );
  }

  return {
    dimension: 'maintainability',
    label: 'Maintainability',
    score,
    grade: toGrade(score),
    rationale,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Dimension: architecture
// ---------------------------------------------------------------------------

/** Below this many modules the graph is too small for shape metrics to mean anything. */
const MIN_GRAPH_NODES = 5;

/**
 * Architecture = does the dependency structure have a direction?
 *
 * Penalty model from 100, weighted so that the two defects which actually stop
 * work — cycles and dead code — outweigh the two which merely predict pain.
 *
 * - **Circular dependencies, ≤35.** 10 points per cycle to a cap. Cycles are
 *   the only item here that can make a module physically un-extractable and
 *   un-testable in isolation, so they carry the heaviest single penalty and the
 *   steepest slope: three cycles already costs 30.
 * - **Orphan ratio, ≤20.** Files nothing imports and which are not entry
 *   points. Maximum at 25% — a quarter of the tree being unreachable means
 *   nobody can tell what is live.
 * - **Module cohesion, ≤20.** Share of edges that stay inside one top-level
 *   directory. Full credit at 60%; below that, imports cross directory
 *   boundaries more often than not, which means the directories are not
 *   modules.
 * - **Average instability, ≤15.** Distance from 0.4 on Martin's I metric, in
 *   either direction. Near 1.0 nothing is stable enough to depend on; near 0.0
 *   everything is rigid. Only applied at {@link MIN_GRAPH_NODES}+ modules,
 *   because a four-file repository has no meaningful instability.
 * - **Directory depth, ≤10.** Free to depth 6, maximum at 12.
 */
function scoreArchitecture(input: HealthInput, facts: DerivedFacts): HealthScore {
  const { graph, stats } = input;
  const bigEnough = graph.nodes.length >= MIN_GRAPH_NODES;

  const cyclePenalty = clamp(graph.cycles.length * 10, 0, 35);
  const orphanPenalty = ramp(facts.orphanRatio, 0, 0.25, 20);
  const cohesionPenalty = graph.edges.length === 0 ? 0 : ramp(0.6 - facts.cohesion, 0, 0.6, 20);
  const instabilityPenalty = bigEnough
    ? ramp(Math.abs(facts.averageInstability - 0.4), 0, 0.5, 15)
    : 0;
  const depthPenalty = ramp(stats.maxDepth, 6, 12, 10);

  const score = clamp(
    round(100 - cyclePenalty - orphanPenalty - cohesionPenalty - instabilityPenalty - depthPenalty),
    0,
    100,
  );

  const rationale: string[] = [
    `${plural(graph.cycles.length, 'circular dependency chain')} across ${plural(facts.cyclicFiles, 'file')} (−${cyclePenalty.toFixed(0)}).`,
    `${plural(graph.orphans.length, 'orphan module')} out of ${plural(graph.nodes.length, 'module')}, ${pct(facts.orphanRatio)} unreachable (−${orphanPenalty.toFixed(0)}).`,
    `${pct(facts.cohesion)} of ${plural(graph.edges.length, 'import edge')} stay within one top-level directory (−${cohesionPenalty.toFixed(0)}).`,
    bigEnough
      ? `Average instability ${fixed(facts.averageInstability, 2)} against a 0.40 target (−${instabilityPenalty.toFixed(0)}).`
      : `Graph has ${plural(graph.nodes.length, 'module')}, below the ${MIN_GRAPH_NODES}-module floor for instability analysis; no penalty applied.`,
    `Maximum directory depth ${stats.maxDepth} (−${depthPenalty.toFixed(0)}).`,
    `${plural(graph.externals.filter((external) => external.undeclared).length, 'undeclared external import')} resolved outside any manifest.`,
  ];

  const suggestions: Suggestion[] = [];
  if (graph.cycles.length > 0) {
    const shown = graph.cycles.slice(0, 3);
    suggestions.push(
      suggestion(
        'arch-cycles',
        `Break ${plural(graph.cycles.length, 'circular dependency chain')}`,
        `${shown.map((cycle) => cycle.join(' → ')).join(' | ')}. Invert the weakest edge in each loop — usually by moving the shared type or interface into its own module.`,
        'high',
        'medium',
        shown.flat(),
      ),
    );
  }
  if (graph.orphans.length > 0) {
    suggestions.push(
      suggestion(
        'arch-orphans',
        `Delete or wire up ${plural(graph.orphans.length, 'orphan module')}`,
        `${pct(facts.orphanRatio)} of modules have no incoming imports and are not entry points: ${graph.orphans.slice(0, 6).join(', ')}. Either they are dead code or the entry-point list is wrong; both are worth resolving.`,
        'medium',
        'low',
        graph.orphans.slice(0, 6),
      ),
    );
  }
  if (graph.edges.length > 0 && facts.cohesion < 0.6) {
    suggestions.push(
      suggestion(
        'arch-cohesion',
        'Raise module cohesion',
        `Only ${pct(facts.cohesion)} of imports stay inside one top-level directory, so the folder layout does not match the dependency structure. Group by feature rather than by file type.`,
        'medium',
        'high',
      ),
    );
  }
  if (stats.maxDepth > 6) {
    suggestions.push(
      suggestion(
        'arch-depth',
        `Flatten a ${stats.maxDepth}-level directory tree`,
        'Deep nesting makes import paths long and moves unrelated code far apart. Six levels is enough for almost any repository.',
        'low',
        'medium',
      ),
    );
  }
  const undeclared = graph.externals.filter((external) => external.undeclared);
  if (undeclared.length > 0) {
    suggestions.push(
      suggestion(
        'arch-undeclared',
        `Declare ${plural(undeclared.length, 'imported package')}`,
        `${undeclared
          .slice(0, 5)
          .map((external) => `${external.name} (${external.count} importers)`)
          .join(', ')} are imported but absent from every manifest, so a clean install will fail.`,
        'high',
        'low',
        undeclared.flatMap((external) => external.importers).slice(0, 6),
      ),
    );
  }

  return {
    dimension: 'architecture',
    label: 'Architecture',
    score,
    grade: toGrade(score),
    rationale,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Dimension: testing
// ---------------------------------------------------------------------------

/** Hard ceiling for a repository with no test files at all. */
const NO_TESTS_CEILING = 10;
/** Test-file-to-source-file ratio that earns full marks. */
const TARGET_TEST_RATIO = 0.25;

/**
 * Testing = is a change verified before it ships?
 *
 * Additive out of 100, then hard-capped:
 *
 * - **Test ratio, 60 points.** Linear to full credit at
 *   {@link TARGET_TEST_RATIO} — one test file per three source files. That
 *   threshold is chosen because test *files* are a proxy for coverage, not a
 *   measure of it; demanding 1:1 would reward file-splitting rather than
 *   testing. Sixty of the hundred points sit here because everything else in
 *   this dimension is infrastructure around tests that may not exist.
 * - **Test framework detected, 20 points.**
 * - **CI runs the tests, 20 points** (8 if CI exists but no test signal was
 *   found in it). A suite nobody runs on every push decays within a quarter.
 *
 * **The cap.** If the repository has zero test files the total is clamped to
 * {@link NO_TESTS_CEILING}. Without it, a repository with vitest in its
 * devDependencies and a CI workflow would score 40/100 on testing while having
 * no tests — which is exactly the kind of laundering that makes a health score
 * worthless. Monotonicity is preserved: adding the first test file lifts the
 * cap and the score jumps up, never down.
 */
function scoreTesting(input: HealthInput, facts: DerivedFacts): HealthScore {
  const { stats, stack } = input;

  const ratioPoints = reward(stats.testRatio, 0, TARGET_TEST_RATIO, 60);
  const frameworkPoints = stack.testing.length > 0 ? 20 : 0;
  const ciPoints = facts.ciRunsTests ? 20 : stack.ci.length > 0 ? 8 : 0;

  const raw = ratioPoints + frameworkPoints + ciPoints;
  const score = clamp(round(stats.testFiles === 0 ? Math.min(raw, NO_TESTS_CEILING) : raw), 0, 100);

  const frameworks = stack.testing.map((detection) => detection.name);

  const rationale: string[] = [
    `${plural(stats.testFiles, 'test file')} against ${plural(stats.files, 'file')} in the repository; test ratio ${fixed(stats.testRatio, 2)} against a ${TARGET_TEST_RATIO} target (${ratioPoints.toFixed(0)}/60).`,
    frameworks.length > 0
      ? `Test framework detected: ${frameworks.join(', ')} (${frameworkPoints}/20).`
      : `No test framework detected in any manifest (0/20).`,
    facts.ciRunsTests
      ? `CI is configured and runs tests: ${stack.ci.map((detection) => detection.name).join(', ')} (20/20).`
      : stack.ci.length > 0
        ? `CI is configured (${stack.ci.map((detection) => detection.name).join(', ')}) but no test step was detected (8/20).`
        : 'No CI configuration found (0/20).',
  ];
  if (stats.testFiles === 0) {
    rationale.push(
      `Zero test files, so the score is capped at ${NO_TESTS_CEILING}/100 regardless of tooling.`,
    );
  }

  const suggestions: Suggestion[] = [];
  if (stats.testFiles === 0) {
    suggestions.push(
      suggestion(
        'test-first',
        'Write the first test',
        `The repository has no test files. Start with the ${facts.hotspots > 0 ? `${facts.hotspots} highest-risk files` : 'entry point'} — one characterisation test there catches more regressions than ten tests on trivial helpers.`,
        'high',
        'medium',
        input.complexity.hotspots.slice(0, 3).map((file) => file.path),
      ),
    );
  } else if (stats.testRatio < TARGET_TEST_RATIO) {
    const needed = Math.ceil(
      (TARGET_TEST_RATIO * stats.files - stats.testFiles) / (1 - TARGET_TEST_RATIO),
    );
    suggestions.push(
      suggestion(
        'test-coverage',
        `Raise the test ratio from ${fixed(stats.testRatio, 2)} to ${TARGET_TEST_RATIO}`,
        `Roughly ${Math.max(1, needed)} more test files would reach the target. Prioritise the modules with the highest risk score and the highest fan-in.`,
        'high',
        'medium',
        input.complexity.hotspots.slice(0, 3).map((file) => file.path),
      ),
    );
  }
  if (stack.testing.length === 0) {
    suggestions.push(
      suggestion(
        'test-framework',
        'Adopt a test framework',
        'No test runner is declared in any manifest. Pick the ecosystem default and commit its config so `test` is a one-word command.',
        'high',
        'low',
      ),
    );
  }
  if (!facts.ciRunsTests) {
    suggestions.push(
      suggestion(
        'test-ci',
        'Run the suite in CI on every push',
        stack.ci.length > 0
          ? 'CI is configured but no test step was detected in it. A suite that only runs locally stops running.'
          : 'No CI is configured. Add a workflow that installs dependencies and runs the test command on every pull request.',
        'high',
        'low',
      ),
    );
  }

  return {
    dimension: 'testing',
    label: 'Testing',
    score,
    grade: toGrade(score),
    rationale,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Dimension: performance
// ---------------------------------------------------------------------------

/**
 * Performance = what does this repository cost to install, build and ship?
 *
 * This is a *static* proxy. GitBrain never executes the code, so it scores the
 * things that reliably predict slow builds and heavy bundles rather than
 * pretending to measure runtime. It carries the smallest weight in the
 * composite (see {@link DIMENSION_WEIGHTS}) precisely because it is a proxy.
 *
 * Penalty model from 100:
 *
 * - **Oversized committed files, ≤25.** 5 points each. Large binaries in git
 *   are paid for on every clone, forever, by everyone.
 * - **Asset share of the repository, ≤20.** Maximum when oversized files are
 *   30% of all bytes.
 * - **Runtime dependency count, ≤25.** Free to 20, maximum at 100. Runtime
 *   dependencies — not dev ones — are what ends up in the install and the
 *   bundle.
 * - **Very large source files, ≤15.** 3 points per file over 1000 LOC; these
 *   dominate parse and transform time in every toolchain.
 * - **Duplication, ≤15.** Duplicated code is duplicated bytes shipped.
 */
function scorePerformance(input: HealthInput, facts: DerivedFacts): HealthScore {
  const { security, stats, dependencies } = input;

  const largeFilePenalty = clamp(security.largeFiles.length * 5, 0, 25);
  const assetPenalty = ramp(ratio(facts.largeFileBytes, stats.totalBytes), 0, 0.3, 20);
  const depPenalty = ramp(facts.runtimeDeps, 20, 100, 25);
  const hugeFilePenalty = clamp(facts.hugeFiles * 3, 0, 15);
  const duplicationPenalty = ramp(facts.duplicationRatio, 0, 0.1, 15);

  const score = clamp(
    round(
      100 - largeFilePenalty - assetPenalty - depPenalty - hugeFilePenalty - duplicationPenalty,
    ),
    0,
    100,
  );

  const rationale: string[] = [
    `${plural(security.largeFiles.length, 'oversized file')} totalling ${Math.round(facts.largeFileBytes / 1024)} KB, ${pct(ratio(facts.largeFileBytes, stats.totalBytes))} of ${Math.round(stats.totalBytes / 1024)} KB analysed (−${(largeFilePenalty + assetPenalty).toFixed(0)}).`,
    `${plural(facts.runtimeDeps, 'runtime dependency')} of ${plural(facts.totalDeps, 'declared dependency')} across ${plural(dependencies.manifests.length, 'manifest')} (−${depPenalty.toFixed(0)}).`,
    `${plural(facts.hugeFiles, 'source file')} over 1000 LOC (−${hugeFilePenalty.toFixed(0)}).`,
    `${facts.duplicatedLines} duplicated lines, ${pct(facts.duplicationRatio)} of ${facts.totalSloc} SLOC (−${duplicationPenalty.toFixed(0)}).`,
  ];

  const suggestions: Suggestion[] = [];
  if (security.largeFiles.length > 0) {
    const biggest = [...security.largeFiles].sort((a, b) => b.size - a.size).slice(0, 5);
    suggestions.push(
      suggestion(
        'perf-large-files',
        `Move ${plural(security.largeFiles.length, 'oversized file')} out of git`,
        `${biggest.map((file) => `${file.path} (${Math.round(file.size / 1024)} KB)`).join(', ')}. Use Git LFS or a CDN — binaries in history are re-downloaded on every fresh clone.`,
        'medium',
        'medium',
        biggest.map((file) => file.path),
      ),
    );
  }
  if (facts.runtimeDeps > 40) {
    suggestions.push(
      suggestion(
        'perf-dependencies',
        `Audit ${plural(facts.runtimeDeps, 'runtime dependency')}`,
        'Every runtime dependency is install time, bundle size and supply-chain surface. Move build-only packages to devDependencies and drop single-function packages.',
        'medium',
        'medium',
      ),
    );
  }
  if (facts.hugeFiles > 0) {
    suggestions.push(
      suggestion(
        'perf-huge-files',
        `Split ${plural(facts.hugeFiles, 'file')} over 1000 LOC`,
        'Very large modules defeat incremental compilation and tree shaking; every edit re-processes the whole file.',
        'low',
        'medium',
        input.complexity.files
          .filter((file) => file.loc > 1000)
          .slice(0, 5)
          .map((file) => file.path),
      ),
    );
  }

  return {
    dimension: 'performance',
    label: 'Performance',
    score,
    grade: toGrade(score),
    rationale,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Dimension: security
// ---------------------------------------------------------------------------

/** Ceilings applied when a committed credential was found. */
const CRITICAL_SECRET_CEILING = 20;
const HIGH_SECRET_CEILING = 45;

const FLAG_PENALTY: Readonly<Record<string, number>> = {
  critical: 10,
  high: 6,
  medium: 3,
  low: 1,
  info: 0,
};

/**
 * Security = how exposed is this repository right now?
 *
 * The security analyzer already produces a calibrated 0–100 score from secrets,
 * risky patterns and exposed configuration, so this dimension starts from that
 * number rather than re-deriving it. Two adjustments are layered on, both of
 * which are supply-chain facts the security analyzer does not own:
 *
 * - **No lockfile, −10.** Without one, `install` resolves differently on every
 *   machine and a compromised transitive release lands silently.
 * - **Flagged dependencies, ≤−20.** Weighted by severity (critical 10, high 6,
 *   medium 3, low 1) and capped, so one abandoned package is a dent and eight
 *   of them are a wall.
 *
 * **The ceilings.** A single committed credential of `critical` severity caps
 * the dimension at {@link CRITICAL_SECRET_CEILING}; a `high` one caps it at
 * {@link HIGH_SECRET_CEILING}. A live secret in a public repository is a breach
 * that has already happened, and no amount of good practice elsewhere offsets
 * it. The caps are `Math.min`, so they can only lower a score — removing the
 * secret can only raise it.
 */
function scoreSecurity(input: HealthInput, facts: DerivedFacts): HealthScore {
  const { security, dependencies } = input;

  const lockfilePenalty = dependencies.hasLockfile ? 0 : 10;

  let flagPenalty = 0;
  for (const flag of security.flaggedDependencies) {
    flagPenalty += FLAG_PENALTY[flag.severity] ?? 0;
  }
  flagPenalty = clamp(flagPenalty, 0, 20);

  let score = clamp(round(clamp(security.score, 0, 100) - lockfilePenalty - flagPenalty), 0, 100);
  if (facts.criticalSecrets > 0) score = Math.min(score, CRITICAL_SECRET_CEILING);
  else if (facts.highSecrets > 0) score = Math.min(score, HIGH_SECRET_CEILING);

  const criticalRisks = security.risks.filter((risk) => risk.severity === 'critical').length;
  const highRisks = security.risks.filter((risk) => risk.severity === 'high').length;

  const rationale: string[] = [
    `Security analyzer scored ${security.score}/100 from ${plural(security.secrets.length, 'secret finding')} and ${plural(security.risks.length, 'risk')} (${criticalRisks} critical, ${highRisks} high).`,
    dependencies.hasLockfile
      ? 'A lockfile is committed, so installs are reproducible (−0).'
      : 'No lockfile is committed, so dependency resolution is not reproducible (−10).',
    `${plural(security.flaggedDependencies.length, 'flagged dependency')} and ${plural(dependencies.unpinned.length, 'unpinned range')} across ${plural(dependencies.manifests.length, 'manifest')} (−${flagPenalty.toFixed(0)}).`,
    `${plural(security.undocumentedEnvVars.length, 'environment variable')} referenced in code but absent from any committed template.`,
  ];
  if (facts.criticalSecrets > 0) {
    rationale.push(
      `${plural(facts.criticalSecrets, 'critical secret')} committed to the repository, so the score is capped at ${CRITICAL_SECRET_CEILING}/100.`,
    );
  } else if (facts.highSecrets > 0) {
    rationale.push(
      `${plural(facts.highSecrets, 'high-severity secret')} committed to the repository, so the score is capped at ${HIGH_SECRET_CEILING}/100.`,
    );
  }

  const suggestions: Suggestion[] = [];
  if (security.secrets.length > 0) {
    const files = [...new Set(security.secrets.map((secret) => secret.file))];
    suggestions.push(
      suggestion(
        'sec-secrets',
        `Rotate and purge ${plural(security.secrets.length, 'committed secret')}`,
        `${security.secrets
          .slice(0, 5)
          .map((secret) => `${secret.rule} in ${secret.file}:${secret.line}`)
          .join(
            ', ',
          )}. Rotate the credentials first — deleting the file does not remove them from git history.`,
        'high',
        'low',
        files.slice(0, 6),
      ),
    );
  }
  if (!dependencies.hasLockfile) {
    suggestions.push(
      suggestion(
        'sec-lockfile',
        'Commit a lockfile',
        'Dependency resolution is currently non-deterministic, so CI and production can install different code than a developer tested.',
        'high',
        'low',
      ),
    );
  }
  if (security.flaggedDependencies.length > 0) {
    suggestions.push(
      suggestion(
        'sec-dependencies',
        `Replace ${plural(security.flaggedDependencies.length, 'flagged dependency')}`,
        security.flaggedDependencies
          .slice(0, 5)
          .map(
            (flag) =>
              `${flag.name} — ${flag.reason}${flag.replacement ? ` (use ${flag.replacement})` : ''}`,
          )
          .join('; '),
        'high',
        'medium',
      ),
    );
  }
  if (security.undocumentedEnvVars.length > 0) {
    suggestions.push(
      suggestion(
        'sec-env-docs',
        `Document ${plural(security.undocumentedEnvVars.length, 'environment variable')}`,
        `${security.undocumentedEnvVars.slice(0, 8).join(', ')} are read by the code but appear in no committed template, so a fresh deployment fails in ways nobody can diagnose.`,
        'medium',
        'low',
      ),
    );
  }
  for (const risk of security.risks.filter(
    (item) => item.severity === 'critical' || item.severity === 'high',
  )) {
    suggestions.push(
      suggestion(
        `sec-risk-${risk.id}`,
        risk.title,
        `${risk.detail} ${risk.recommendation}`.trim(),
        risk.severity === 'critical' ? 'high' : 'medium',
        'medium',
        risk.files.slice(0, 5),
      ),
    );
  }

  return {
    dimension: 'security',
    label: 'Security',
    score,
    grade: toGrade(score),
    rationale,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Dimension: readability
// ---------------------------------------------------------------------------

/**
 * Readability = how long does it take to understand a file you did not write?
 *
 * Penalty model from 100. All four terms are about local comprehension, which
 * is why they are separated from `maintainability` (change cost) even though
 * the two share inputs:
 *
 * - **Average file length, ≤30.** Free to 200 LOC, maximum at 500. Two hundred
 *   lines is roughly what fits in a scroll-free reading pass.
 * - **Average nesting depth, ≤25.** Free to 3, maximum at 7. Every level past
 *   the third adds a condition the reader must hold in memory.
 * - **Comment ratio, ≤25.** Reverse ramp: full penalty at 0%, none at 30% of
 *   files carrying a leading doc comment. Lower than the documentation
 *   dimension's 40% target because here the question is only "is there a note
 *   at the top of the file", not "is the project documented".
 * - **Naming consistency, ≤20.** Share of filenames following the dominant
 *   convention, with full credit at 80%. A further 5-point penalty applies when
 *   the dominant convention is not idiomatic for the repository's primary
 *   language — `PascalCase` modules in a Python codebase are consistent and
 *   still surprising.
 */
function scoreReadability(input: HealthInput, facts: DerivedFacts): HealthScore {
  const { stats } = input;

  const lengthPenalty = ramp(facts.averageLoc, 200, 500, 30);
  const nestingPenalty = ramp(facts.averageNesting, 3, 7, 25);
  const commentPenalty = 25 - reward(stats.commentRatio, 0, 0.3, 25);
  const namingPenalty =
    20 - reward(facts.namingConsistency, 0, 0.8, 20) + (facts.idiomaticNaming ? 0 : 5);

  const score = clamp(
    round(100 - lengthPenalty - nestingPenalty - commentPenalty - namingPenalty),
    0,
    100,
  );

  const rationale: string[] = [
    `Average file length ${fixed(facts.averageLoc, 0)} LOC across ${plural(facts.analysedFiles, 'file')} (−${lengthPenalty.toFixed(0)}).`,
    `Average maximum nesting depth ${fixed(facts.averageNesting, 1)} (−${nestingPenalty.toFixed(0)}).`,
    `${pct(stats.commentRatio)} of source files open with a doc comment against a 30% target (−${commentPenalty.toFixed(0)}).`,
    `${pct(facts.namingConsistency)} of filenames follow ${facts.namingStyle}, the dominant convention${facts.idiomaticNaming ? '' : ` — which is not idiomatic for ${facts.primaryLanguage}`} (−${namingPenalty.toFixed(0)}).`,
    `Primary language ${facts.primaryLanguage} at ${fixed(facts.primaryLanguagePercent, 1)}% of analysed bytes.`,
  ];

  const suggestions: Suggestion[] = [];
  if (facts.averageLoc > 250) {
    suggestions.push(
      suggestion(
        'read-file-length',
        `Bring the ${fixed(facts.averageLoc, 0)}-LOC average file down`,
        'Files past roughly 200 lines stop fitting in one reading pass. Split by responsibility, not by line count.',
        'medium',
        'medium',
      ),
    );
  }
  if (facts.averageNesting > 4) {
    suggestions.push(
      suggestion(
        'read-nesting',
        `Flatten control flow (average depth ${fixed(facts.averageNesting, 1)})`,
        'Use early returns and guard clauses. Each nesting level is one more condition the reader has to keep in their head to the bottom of the function.',
        'medium',
        'medium',
        input.complexity.files
          .filter((file) => file.maxNesting >= 5)
          .slice(0, 5)
          .map((file) => file.path),
      ),
    );
  }
  if (facts.namingConsistency < 0.8) {
    suggestions.push(
      suggestion(
        'read-naming',
        `Standardise filenames on ${facts.namingStyle === 'mixed' ? 'one convention' : facts.namingStyle}`,
        `Only ${pct(facts.namingConsistency)} of files follow the dominant convention, so readers cannot guess a path from a symbol name.`,
        'low',
        'low',
      ),
    );
  }
  if (stats.commentRatio < 0.3) {
    suggestions.push(
      suggestion(
        'read-file-headers',
        'Open each module with one paragraph on why it exists',
        `${pct(stats.commentRatio)} of source files currently do. A header that explains the file's role beats any amount of line-by-line commentary.`,
        'medium',
        'low',
      ),
    );
  }

  return {
    dimension: 'readability',
    label: 'Readability',
    score,
    grade: toGrade(score),
    rationale,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Dimension: developer experience
// ---------------------------------------------------------------------------

/**
 * Developer experience = how long from `git clone` to a passing local change?
 *
 * Purely additive out of 100, because DX is a checklist of affordances that
 * either exist or do not. Nothing here is a matter of degree except the README:
 *
 * - **Setup documentation, 25 points.** 15 scaled from `readme.score` plus a
 *   flat 10 when the README actually has an Installation section. The split
 *   matters: a beautiful README with no install instructions is not setup
 *   documentation.
 * - **CI, 15 points.**
 * - **Lockfile, 10 points.** Reproducible installs are a DX feature before they
 *   are a security one.
 * - **Linter/formatter config, 12 points.** Committed config ends style
 *   arguments in review permanently.
 * - **Containerisation, 8 points.** Lowest of the tooling items — valuable, but
 *   many healthy projects legitimately have no container.
 * - **Task runner / manifest with scripts, 15 points.**
 * - **Environment template, 15 points.** Full credit for a committed template,
 *   reduced proportionally by the share of environment variables the code reads
 *   that the template does not mention — a template that documents half the
 *   variables solves half the problem.
 */
function scoreDeveloperExperience(input: HealthInput, facts: DerivedFacts): HealthScore {
  const { readme, security, dependencies, stack } = input;

  const readmePoints =
    (clamp(readme.score, 0, 100) / 100) * 15 + (sectionPresent(readme, 'Installation') ? 10 : 0);
  const ciPoints = stack.ci.length > 0 ? 15 : 0;
  const lockfilePoints = dependencies.hasLockfile ? 10 : 0;
  const linterPoints = facts.hasLinterConfig ? 12 : 0;
  const containerPoints = facts.hasContainer ? 8 : 0;
  const scriptPoints = facts.hasTaskRunner ? 15 : 0;

  const documentedShare =
    security.envVars.length === 0
      ? 1
      : 1 - ratio(security.undocumentedEnvVars.length, security.envVars.length);
  const envPoints = facts.hasEnvTemplate ? 15 * clamp(documentedShare, 0, 1) : 0;

  const score = clamp(
    round(
      readmePoints +
        ciPoints +
        lockfilePoints +
        linterPoints +
        containerPoints +
        scriptPoints +
        envPoints,
    ),
    0,
    100,
  );

  const rationale: string[] = [
    `README scores ${readme.score}/100 and ${sectionPresent(readme, 'Installation') ? 'has' : 'lacks'} an Installation section (${readmePoints.toFixed(0)}/25).`,
    `CI: ${stack.ci.length > 0 ? stack.ci.map((detection) => detection.name).join(', ') : 'none'} (${ciPoints}/15). Lockfile: ${dependencies.hasLockfile ? 'committed' : 'absent'} (${lockfilePoints}/10).`,
    `Linter/formatter config: ${facts.hasLinterConfig ? 'committed' : 'absent'} (${linterPoints}/12). Container: ${facts.hasContainer ? 'committed' : 'absent'} (${containerPoints}/8).`,
    `Task runner or script manifest: ${facts.hasTaskRunner ? 'present' : 'absent'} (${scriptPoints}/15).`,
    `Environment template: ${facts.hasEnvTemplate ? 'committed' : 'absent'}; ${plural(security.undocumentedEnvVars.length, 'variable')} of ${plural(security.envVars.length, 'variable')} used in code are undocumented (${envPoints.toFixed(0)}/15).`,
  ];

  const suggestions: Suggestion[] = [];
  if (!sectionPresent(readme, 'Installation')) {
    suggestions.push(
      suggestion(
        'dx-setup-docs',
        'Document the setup in the README',
        'No Installation section was detected. A copyable clone-plus-install block is the single highest-leverage paragraph in any README.',
        'high',
        'low',
        readme.path ? [readme.path] : [],
      ),
    );
  }
  if (stack.ci.length === 0) {
    suggestions.push(
      suggestion(
        'dx-ci',
        'Add a CI pipeline',
        'No CI configuration was found, so nothing checks a pull request before a human does.',
        'high',
        'low',
      ),
    );
  }
  if (!dependencies.hasLockfile) {
    suggestions.push(
      suggestion(
        'dx-lockfile',
        'Commit a lockfile',
        'Without one, two developers running the same install command get different trees, and "works on my machine" becomes unfalsifiable.',
        'high',
        'low',
      ),
    );
  }
  if (!facts.hasLinterConfig) {
    suggestions.push(
      suggestion(
        'dx-linting',
        'Commit a linter and formatter config',
        'No lint or format configuration was found. Committing one moves style from review comments to a pre-commit hook, permanently.',
        'medium',
        'low',
      ),
    );
  }
  if (!facts.hasEnvTemplate) {
    suggestions.push(
      suggestion(
        'dx-env-template',
        'Commit a .env.example',
        `The code reads ${plural(security.envVars.length, 'environment variable')} but no template documents them, so first-run failures are guesswork.`,
        'high',
        'low',
      ),
    );
  }
  if (!facts.hasContainer) {
    suggestions.push(
      suggestion(
        'dx-container',
        'Add a Dockerfile',
        'A committed container image removes the "which runtime version" class of onboarding failures entirely.',
        'low',
        'medium',
      ),
    );
  }

  return {
    dimension: 'developerExperience',
    label: 'Developer Experience',
    score,
    grade: toGrade(score),
    rationale,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

/**
 * Weights for the overall score. They sum to exactly 1.0.
 *
 * The ordering encodes what actually determines whether a repository can be
 * relied on. Security and maintainability lead at 0.18 each: a leaked
 * credential is unrecoverable, and maintenance cost is what every future change
 * is billed against. Testing (0.14) and architecture (0.13) come next because
 * they govern whether change is safe and possible. Documentation (0.12) is what
 * makes the project usable by someone other than its author. Readability and
 * developer experience (0.10 each) compound over time but rarely block anyone
 * outright. Performance is last at 0.05 — not because performance does not
 * matter, but because everything GitBrain can measure about it statically is a
 * proxy, and a proxy should not outweigh a measurement.
 */
const DIMENSION_WEIGHTS: Readonly<Record<HealthDimension, number>> = {
  security: 0.18,
  maintainability: 0.18,
  testing: 0.14,
  architecture: 0.13,
  documentation: 0.12,
  readability: 0.1,
  developerExperience: 0.1,
  performance: 0.05,
};

const IMPACT_VALUE: Readonly<Record<Suggestion['impact'], number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

const EFFORT_COST: Readonly<Record<Suggestion['effort'], number>> = {
  low: 1,
  medium: 2,
  high: 3,
};

const MAX_TOP_SUGGESTIONS = 8;

interface RankedSuggestion {
  readonly suggestion: Suggestion;
  readonly ratio: number;
  readonly impact: number;
  readonly weight: number;
  readonly order: number;
}

/**
 * Rank suggestions by impact-to-effort, deduplicate by id, keep the best eight.
 *
 * The ratio is deliberately crude — three impact levels over three effort
 * levels gives nine distinct values — because a finer scale would imply a
 * precision the underlying heuristics do not have. That crudeness produces a
 * lot of ties, so the tie-breaks carry real weight and are chosen, not
 * accidental:
 *
 *  1. **Raw impact**, so a high/medium item beats a medium/low one on merit
 *     rather than on arithmetic.
 *  2. **The originating dimension's composite weight**, so when a committed
 *     secret and a missing linter config are both "high impact, low effort",
 *     the one from the dimension that matters more to the overall score wins.
 *     Sorting alphabetically here — the obvious alternative — would push
 *     `sec-secrets` off the list behind `dx-ci`, which is indefensible.
 *  3. **Emission order**, which is fixed, so the total ordering is
 *     deterministic with no dependence on `Map` or `sort` stability.
 */
function rankSuggestions(scores: readonly HealthScore[]): Suggestion[] {
  const seen = new Set<string>();
  const ranked: RankedSuggestion[] = [];
  let order = 0;

  for (const score of scores) {
    for (const item of score.suggestions) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      ranked.push({
        suggestion: item,
        ratio: IMPACT_VALUE[item.impact] / EFFORT_COST[item.effort],
        impact: IMPACT_VALUE[item.impact],
        weight: DIMENSION_WEIGHTS[score.dimension],
        order: order++,
      });
    }
  }

  return ranked
    .sort((a, b) => {
      if (b.ratio !== a.ratio) return b.ratio - a.ratio;
      if (b.impact !== a.impact) return b.impact - a.impact;
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.order - b.order;
    })
    .slice(0, MAX_TOP_SUGGESTIONS)
    .map((entry) => entry.suggestion);
}

/**
 * Score a repository across all eight health dimensions.
 *
 * Pure and total: every field of `HealthInput` may be empty and the function
 * still returns a complete, well-formed report. An empty repository scores
 * badly rather than throwing, which is the honest answer.
 */
export function computeHealth(input: HealthInput): HealthReport {
  const facts = deriveFacts(input);

  const scores: readonly HealthScore[] = [
    scoreDocumentation(input, facts),
    scoreMaintainability(input, facts),
    scoreArchitecture(input, facts),
    scoreTesting(input, facts),
    scorePerformance(input, facts),
    scoreSecurity(input, facts),
    scoreReadability(input, facts),
    scoreDeveloperExperience(input, facts),
  ];

  let weightedTotal = 0;
  for (const score of scores) {
    weightedTotal += score.score * DIMENSION_WEIGHTS[score.dimension];
  }

  const overall = clamp(Math.round(weightedTotal * 10) / 10, 0, 100);

  return {
    overall,
    grade: toGrade(overall),
    scores,
    topSuggestions: rankSuggestions(scores),
  };
}
