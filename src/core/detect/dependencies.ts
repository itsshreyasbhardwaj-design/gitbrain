/**
 * Manifest parsing and dependency reporting.
 *
 * GitBrain reads the manifests a human would read, in the eight ecosystems that
 * cover the overwhelming majority of real repositories. Three constraints shape
 * the implementation:
 *
 *   1. **No parser dependencies.** Adding a TOML or YAML library to the core
 *      engine would break its "pure, portable, zero-dependency" contract and
 *      pull a supply-chain risk into a tool whose whole job is flagging
 *      supply-chain risk. The formats we touch are read line-by-line with
 *      targeted scanners that cover the shapes manifests actually use.
 *   2. **Declared, not resolved.** We report what the manifest says, never what
 *      a resolver would install. Lockfiles are detected but not parsed: their
 *      only role here is the reproducibility signal, and parsing a 300 kB
 *      `pnpm-lock.yaml` would cost far more than it tells the reader.
 *   3. **Ecosystem-scoped flags.** Every curated flag is matched against an
 *      exact name *within one ecosystem*. Python's `requests` must never be
 *      flagged because npm's `request` is deprecated.
 */

import type {
  Dependency,
  DependencyFlag,
  DependencyKind,
  DependencyReport,
  RepoFile,
  RepoSnapshot,
  Severity,
} from '../types';
import { basename } from '../shared/paths';
import { toLines } from '../shared/text';
import { isVendored } from '../shared/classify';

// ---------------------------------------------------------------------------
// Curated risk list
// ---------------------------------------------------------------------------

interface FlagRule {
  readonly ecosystem: string;
  readonly name: string;
  readonly reason: string;
  readonly severity: Severity;
  readonly replacement?: string;
  /**
   * Optional escalation: when the declared range mentions one of these
   * fragments the finding is raised to `critical`. Used for packages that are
   * only catastrophic at a specific sabotaged version.
   */
  readonly criticalRanges?: readonly string[];
}

/**
 * Packages that are genuinely deprecated, abandoned or historically malicious.
 *
 * The bar for inclusion is deliberately high: every entry is either formally
 * deprecated by its own maintainer, archived upstream, or the subject of a
 * documented supply-chain incident. "Old" or "unfashionable" is not enough —
 * a report full of taste-based complaints trains people to ignore it.
 */
const FLAG_RULES: readonly FlagRule[] = [
  {
    ecosystem: 'npm',
    name: 'request',
    reason: 'Fully deprecated by its maintainers in 2020 and no longer patched.',
    severity: 'high',
    replacement: 'undici (or the built-in fetch)',
  },
  {
    ecosystem: 'npm',
    name: 'request-promise',
    reason: 'Wrapper around the deprecated `request` package; deprecated alongside it.',
    severity: 'high',
    replacement: 'undici (or the built-in fetch)',
  },
  {
    ecosystem: 'npm',
    name: 'node-sass',
    reason: 'Deprecated; binds to libsass, which is itself deprecated, and needs native rebuilds.',
    severity: 'high',
    replacement: 'sass (Dart Sass)',
  },
  {
    ecosystem: 'npm',
    name: 'moment',
    reason: 'In maintenance mode by project decision; large, mutable, and not tree-shakeable.',
    severity: 'medium',
    replacement: 'date-fns or dayjs',
  },
  {
    ecosystem: 'npm',
    name: 'left-pad',
    reason: 'One-line helper superseded by a language built-in; a needless dependency edge.',
    severity: 'low',
    replacement: 'String.prototype.padStart',
  },
  {
    ecosystem: 'npm',
    name: 'lodash.isequal',
    reason: 'Deprecated single-method lodash package; the split packages are no longer published.',
    severity: 'low',
    replacement: 'node:util isDeepStrictEqual, or lodash itself',
  },
  {
    ecosystem: 'npm',
    name: 'tslint',
    reason: 'Deprecated in 2019 in favour of the TypeScript ESLint toolchain.',
    severity: 'high',
    replacement: 'eslint with typescript-eslint',
  },
  {
    ecosystem: 'npm',
    name: 'istanbul',
    reason: 'Deprecated top-level package; the project moved to the nyc / istanbuljs toolchain.',
    severity: 'medium',
    replacement: 'nyc, or a runner with built-in coverage',
  },
  {
    ecosystem: 'npm',
    name: 'gulp-util',
    reason: 'Deprecated by the Gulp team; bundled a grab-bag of utilities with no upgrade path.',
    severity: 'medium',
    replacement: 'the individual replacement modules named in its deprecation notice',
  },
  {
    ecosystem: 'npm',
    name: 'phantomjs',
    reason: 'Headless browser suspended by its maintainer; no security updates.',
    severity: 'high',
    replacement: 'playwright or puppeteer',
  },
  {
    ecosystem: 'npm',
    name: 'phantomjs-prebuilt',
    reason: 'Prebuilt distribution of the suspended PhantomJS browser; unmaintained.',
    severity: 'high',
    replacement: 'playwright or puppeteer',
  },
  {
    ecosystem: 'npm',
    name: 'bower',
    reason: 'Package manager deprecated by its own team; recommends migrating off.',
    severity: 'medium',
    replacement: 'npm, pnpm or yarn',
  },
  {
    ecosystem: 'npm',
    name: 'coffee-script',
    reason: 'Renamed to `coffeescript`; this name is a frozen 1.x line receiving no fixes.',
    severity: 'medium',
    replacement: 'coffeescript, or TypeScript',
  },
  {
    ecosystem: 'npm',
    name: 'event-stream',
    reason: 'Subject of the 2018 supply-chain attack that shipped a wallet stealer downstream.',
    severity: 'critical',
    replacement: 'rxjs, or Node streams directly',
  },
  {
    ecosystem: 'npm',
    name: 'flatmap-stream',
    reason: 'The malicious payload package from the event-stream incident. Never safe to install.',
    severity: 'critical',
    replacement: 'remove it',
  },
  {
    ecosystem: 'npm',
    name: 'faker',
    reason:
      'The original package was sabotaged by its author at 6.6.6 and is no longer maintained.',
    severity: 'high',
    replacement: '@faker-js/faker',
    criticalRanges: ['6.6.6'],
  },
  {
    ecosystem: 'npm',
    name: 'colors',
    reason: 'Sabotaged by its author in 2022 with an infinite-loop payload in a patch release.',
    severity: 'high',
    replacement: 'chalk or picocolors',
    criticalRanges: ['1.4.44', '1.4.1'],
  },
  {
    ecosystem: 'npm',
    name: 'babel-eslint',
    reason: 'Deprecated and renamed; the old name stopped receiving updates at Babel 7.',
    severity: 'medium',
    replacement: '@babel/eslint-parser',
  },
  {
    ecosystem: 'npm',
    name: 'node-uuid',
    reason: 'Deprecated and renamed; the old name is frozen.',
    severity: 'medium',
    replacement: 'uuid, or crypto.randomUUID',
  },
  {
    ecosystem: 'pypi',
    name: 'nose',
    reason: 'Unmaintained since 2015 and broken on modern Python releases.',
    severity: 'high',
    replacement: 'pytest',
  },
  {
    ecosystem: 'pypi',
    name: 'ctx',
    reason: 'Hijacked in 2022 to exfiltrate environment variables, including AWS credentials.',
    severity: 'critical',
    replacement: 'remove it',
  },
];

// ---------------------------------------------------------------------------
// Lockfiles
// ---------------------------------------------------------------------------

/**
 * Lockfile basenames, mapped to the ecosystem they pin.
 *
 * Presence is the whole signal: a repo with declared ranges and no lockfile
 * cannot reproduce a build, which is a real finding independent of what the
 * lockfile contains.
 */
const LOCKFILES: Readonly<Record<string, string>> = {
  'pnpm-lock.yaml': 'npm',
  'package-lock.json': 'npm',
  'yarn.lock': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'bun.lockb': 'npm',
  'bun.lock': 'npm',
  'poetry.lock': 'pypi',
  'pdm.lock': 'pypi',
  'uv.lock': 'pypi',
  'pipfile.lock': 'pypi',
  'cargo.lock': 'cargo',
  'go.sum': 'go',
  'gemfile.lock': 'rubygems',
  'composer.lock': 'composer',
};

/** True when the basename is a lockfile GitBrain recognises. */
export function isLockfile(path: string): boolean {
  return basename(path).toLowerCase() in LOCKFILES;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse every manifest in the snapshot into one dependency report.
 *
 * Vendored trees are skipped: a checked-in `vendor/` copy of a library carries
 * its own `package.json`, and counting those would attribute somebody else's
 * dependencies to this repository.
 */
export function analyzeDependencies(snapshot: RepoSnapshot): DependencyReport {
  const dependencies: Dependency[] = [];
  const manifests: string[] = [];
  let hasLockfile = false;

  for (const file of snapshot.files) {
    if (isVendored(file.path)) continue;

    const base = basename(file.path).toLowerCase();

    if (base in LOCKFILES) {
      hasLockfile = true;
      continue;
    }

    const parsed = parseManifest(file, base);
    if (!parsed) continue;

    manifests.push(file.path);
    dependencies.push(...parsed);
  }

  const deduped = dedupe(dependencies);

  return {
    dependencies: deduped,
    manifests: manifests.sort((a, b) => a.localeCompare(b)),
    counts: countByKind(deduped),
    flagged: flagDependencies(deduped),
    unpinned: collectUnpinned(deduped),
    hasLockfile,
  };
}

/** Dispatch a file to the parser for its manifest format, or `null`. */
function parseManifest(file: RepoFile, base: string): Dependency[] | null {
  const content = file.content;
  if (content === null || file.isBinary) return null;

  switch (base) {
    case 'package.json':
      return parsePackageJson(content, file.path);
    case 'requirements.txt':
      return parseRequirementsTxt(content, file.path);
    case 'pyproject.toml':
      return parsePyprojectToml(content, file.path);
    case 'go.mod':
      return parseGoMod(content, file.path);
    case 'cargo.toml':
      return parseCargoToml(content, file.path);
    case 'gemfile':
      return parseGemfile(content, file.path);
    case 'composer.json':
      return parseComposerJson(content, file.path);
    case 'pom.xml':
      return parsePomXml(content, file.path);
    default:
      // `requirements-dev.txt`, `requirements/base.txt` and friends are the
      // conventional split of a single requirements set, so they are parsed
      // too — but only when the name is unambiguous about being requirements.
      if (/^requirements[.-][a-z0-9_-]+\.txt$/.test(base)) {
        return parseRequirementsTxt(content, file.path, base.includes('dev') ? 'dev' : 'runtime');
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

const NPM_SECTIONS: readonly (readonly [string, DependencyKind])[] = [
  ['dependencies', 'runtime'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
];

function parsePackageJson(content: string, manifest: string): Dependency[] {
  const root = parseJsonObject(content);
  if (!root) return [];

  const out: Dependency[] = [];

  for (const [section, kind] of NPM_SECTIONS) {
    const table = asRecord(root[section]);
    if (!table) continue;

    for (const [name, range] of Object.entries(table)) {
      if (typeof range !== 'string') continue;
      out.push({ name, range: range.trim(), kind, manifest, ecosystem: 'npm' });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

const COMPOSER_SECTIONS: readonly (readonly [string, DependencyKind])[] = [
  ['require', 'runtime'],
  ['require-dev', 'dev'],
  ['suggest', 'optional'],
];

function parseComposerJson(content: string, manifest: string): Dependency[] {
  const root = parseJsonObject(content);
  if (!root) return [];

  const out: Dependency[] = [];

  for (const [section, kind] of COMPOSER_SECTIONS) {
    const table = asRecord(root[section]);
    if (!table) continue;

    for (const [name, range] of Object.entries(table)) {
      if (typeof range !== 'string') continue;
      // `php` and `ext-*` are platform requirements, not packages. They belong
      // in the runtime detector, not in a dependency list a human scans for
      // libraries, so they are dropped here.
      if (name === 'php' || name.startsWith('ext-') || name.startsWith('lib-')) continue;
      out.push({ name, range: range.trim(), kind, manifest, ecosystem: 'composer' });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/**
 * PEP 508 requirement: name, optional extras, then everything else.
 *
 * The name is the only part that must be exact; the remainder is preserved
 * verbatim as the range so the UI can show precisely what the author wrote.
 */
const PEP508 = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/;

function parseRequirementsTxt(
  content: string,
  manifest: string,
  kind: DependencyKind = 'runtime',
): Dependency[] {
  const out: Dependency[] = [];

  for (const rawLine of toLines(content)) {
    // Environment markers (`; python_version < "3.9"`) and trailing comments
    // are metadata about *when* to install, not about the package identity.
    const line = rawLine.split(' #')[0]?.split(';')[0]?.trim() ?? '';
    if (!line || line.startsWith('#')) continue;
    // `-r other.txt`, `-e .`, `--index-url ...`: directives, not requirements.
    if (line.startsWith('-') || line.startsWith('.')) continue;
    // URL and VCS requirements have no parseable name/range pair.
    if (/^[a-z+]+:\/\//i.test(line)) continue;

    const match = PEP508.exec(line);
    const name = match?.[1];
    if (!name) continue;

    out.push({
      name,
      range: (match?.[3] ?? '').trim(),
      kind,
      manifest,
      ecosystem: 'pypi',
    });
  }

  return out;
}

function parsePyprojectToml(content: string, manifest: string): Dependency[] {
  const entries = parseTomlEntries(content);
  const out: Dependency[] = [];

  for (const entry of entries) {
    // PEP 621: `[project] dependencies = ["fastapi>=0.100"]`.
    if (entry.section === 'project' && entry.key === 'dependencies') {
      for (const item of tomlArrayItems(entry.value)) {
        const dep = pep508ToDependency(item, manifest, 'runtime');
        if (dep) out.push(dep);
      }
      continue;
    }

    // PEP 735 / setuptools convention: every key under
    // `[project.optional-dependencies]` is a named extra.
    if (entry.section === 'project.optional-dependencies') {
      const kind: DependencyKind = /dev|test|lint|check/i.test(entry.key) ? 'dev' : 'optional';
      for (const item of tomlArrayItems(entry.value)) {
        const dep = pep508ToDependency(item, manifest, kind);
        if (dep) out.push(dep);
      }
      continue;
    }

    // Poetry keeps dependencies as a table rather than an array, and encodes
    // the kind in the section name: `[tool.poetry.group.dev.dependencies]`.
    if (entry.section === 'tool.poetry.dependencies') {
      if (entry.key.toLowerCase() === 'python') continue; // Interpreter, not a package.
      out.push({
        name: entry.key,
        range: tomlVersionOf(entry.value),
        kind: 'runtime',
        manifest,
        ecosystem: 'pypi',
      });
      continue;
    }

    const group = /^tool\.poetry\.(?:group\.([^.]+)\.)?dev-dependencies$/.exec(entry.section);
    const namedGroup = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(entry.section);
    if (group ?? namedGroup) {
      out.push({
        name: entry.key,
        range: tomlVersionOf(entry.value),
        kind: 'dev',
        manifest,
        ecosystem: 'pypi',
      });
    }
  }

  return out;
}

function pep508ToDependency(
  requirement: string,
  manifest: string,
  kind: DependencyKind,
): Dependency | null {
  const cleaned = requirement.split(';')[0]?.trim() ?? '';
  const match = PEP508.exec(cleaned);
  const name = match?.[1];
  if (!name) return null;

  return { name, range: (match[3] ?? '').trim(), kind, manifest, ecosystem: 'pypi' };
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_REQUIRE_LINE = /^([^\s]+)\s+(v[^\s]+)/;

/**
 * Parse `go.mod` require directives.
 *
 * `// indirect` entries are transitive modules that Go records for
 * reproducibility. They are reported as runtime dependencies because that is
 * what the require block declares — the module graph, not a curated list — and
 * suppressing them would understate what actually gets built.
 *
 * `replace` and `exclude` blocks use the same parenthesised syntax and must not
 * be mistaken for requirements, so block context is tracked explicitly.
 */
function parseGoMod(content: string, manifest: string): Dependency[] {
  const out: Dependency[] = [];
  let block: string | null = null;

  for (const rawLine of toLines(content)) {
    const line = stripLineComment(rawLine, '//').trim();
    if (!line) continue;

    if (block) {
      if (line === ')') {
        block = null;
        continue;
      }
      if (block === 'require') pushGoRequire(out, line, manifest);
      continue;
    }

    const opening = /^(require|replace|exclude|retract)\s*\($/.exec(line);
    if (opening) {
      block = opening[1] ?? null;
      continue;
    }

    const single = /^require\s+(.+)$/.exec(line);
    if (single) pushGoRequire(out, single[1] ?? '', manifest);
  }

  return out;
}

function pushGoRequire(out: Dependency[], line: string, manifest: string): void {
  const match = GO_REQUIRE_LINE.exec(line);
  const name = match?.[1];
  const version = match?.[2];
  if (!name || !version) return;

  out.push({ name, range: version, kind: 'runtime', manifest, ecosystem: 'go' });
}

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------

const CARGO_SECTIONS: Readonly<Record<string, DependencyKind>> = {
  dependencies: 'runtime',
  'dev-dependencies': 'dev',
  // Build scripts run at compile time only, which is exactly what `dev` means
  // to a reader scanning for "ships to production or not".
  'build-dependencies': 'dev',
};

function parseCargoToml(content: string, manifest: string): Dependency[] {
  const out: Dependency[] = [];

  for (const entry of parseTomlEntries(content)) {
    // Target-specific tables (`[target.'cfg(unix)'.dependencies]`) end with the
    // same three section names, so match on the final segment.
    const section = entry.section.startsWith('target.')
      ? (entry.section.split('.').pop() ?? '')
      : entry.section;

    const kind = CARGO_SECTIONS[section];
    if (!kind) continue;

    out.push({
      name: entry.key,
      range: tomlVersionOf(entry.value),
      kind,
      manifest,
      ecosystem: 'cargo',
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Bundler
// ---------------------------------------------------------------------------

const GEM_LINE = /^gem\s+["']([^"']+)["']\s*(?:,\s*(.+))?$/;

/**
 * Parse a Gemfile's `gem` declarations.
 *
 * Gemfiles are Ruby, so a complete parse is out of scope; what matters is that
 * `group :development, :test do … end` blocks classify their gems as dev, which
 * is the difference between "this ships" and "this doesn't". Block depth is
 * tracked with a counter rather than a stack because Gemfiles nest at most one
 * level in practice and a counter cannot desynchronise.
 */
function parseGemfile(content: string, manifest: string): Dependency[] {
  const out: Dependency[] = [];
  let devDepth = 0;
  let otherDepth = 0;

  for (const rawLine of toLines(content)) {
    const line = stripLineComment(rawLine, '#').trim();
    if (!line) continue;

    if (/^end\b/.test(line)) {
      if (devDepth > 0) devDepth--;
      else if (otherDepth > 0) otherDepth--;
      continue;
    }

    const groupMatch = /^group\s+(.+?)\s+do$/.exec(line);
    if (groupMatch) {
      const names = groupMatch[1] ?? '';
      if (/:(development|test|dev)\b/.test(names)) devDepth++;
      else otherDepth++;
      continue;
    }

    if (/\bdo$/.test(line) && !/^gem\b/.test(line)) {
      otherDepth++;
      continue;
    }

    const gem = GEM_LINE.exec(line);
    const name = gem?.[1];
    if (!name) continue;

    // The first quoted argument after the name is the version requirement;
    // anything else (`require:`, `group:`, `git:`) is an option, not a range.
    const rest = gem?.[2] ?? '';
    const versionMatch = /^\s*["']([^"']+)["']/.exec(rest);
    const inlineGroup = /group:\s*:(\w+)|:group\s*=>\s*:(\w+)/.exec(rest);
    const inlineIsDev = /^(development|test|dev)$/.test(inlineGroup?.[1] ?? inlineGroup?.[2] ?? '');

    out.push({
      name,
      range: versionMatch?.[1] ?? '',
      kind: devDepth > 0 || inlineIsDev ? 'dev' : 'runtime',
      manifest,
      ecosystem: 'rubygems',
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Maven
// ---------------------------------------------------------------------------

const POM_DEPENDENCY = /<dependency>([\s\S]*?)<\/dependency>/g;

/**
 * Parse `<dependency>` blocks out of a `pom.xml`.
 *
 * A regex sweep is used rather than an XML parse because the only structure we
 * need is flat and unambiguous, and because `<dependencyManagement>` blocks
 * contain the identical shape — they are versions-only declarations, so their
 * entries are reported too, which matches how Maven users read the file.
 *
 * Unresolved `${property}` versions are kept verbatim: showing the reader the
 * indirection is more honest than inventing a resolved number.
 */
function parsePomXml(content: string, manifest: string): Dependency[] {
  const out: Dependency[] = [];

  POM_DEPENDENCY.lastIndex = 0;
  let match = POM_DEPENDENCY.exec(content);

  while (match) {
    const block = match[1] ?? '';
    const groupId = xmlTag(block, 'groupId');
    const artifactId = xmlTag(block, 'artifactId');

    if (artifactId) {
      const scope = (xmlTag(block, 'scope') ?? '').toLowerCase();
      const optional = (xmlTag(block, 'optional') ?? '').toLowerCase() === 'true';

      out.push({
        name: groupId ? `${groupId}:${artifactId}` : artifactId,
        range: xmlTag(block, 'version') ?? '',
        kind: optional ? 'optional' : mavenScopeToKind(scope),
        manifest,
        ecosystem: 'maven',
      });
    }

    match = POM_DEPENDENCY.exec(content);
  }

  return out;
}

/** `test` and `provided` artifacts never ship, which is what `dev` conveys. */
function mavenScopeToKind(scope: string): DependencyKind {
  if (scope === 'test' || scope === 'provided') return 'dev';
  return 'runtime';
}

function xmlTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

/**
 * Collapse exact repeats.
 *
 * The same package legitimately appears once per manifest in a monorepo, and
 * those are distinct facts worth keeping. Only an identical
 * (manifest, kind, name) triple is a genuine duplicate — which happens in
 * hand-edited `requirements.txt` files.
 */
function dedupe(dependencies: readonly Dependency[]): Dependency[] {
  const seen = new Set<string>();
  const out: Dependency[] = [];

  for (const dependency of dependencies) {
    const key = `${dependency.manifest} ${dependency.kind} ${dependency.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dependency);
  }

  return out;
}

function countByKind(dependencies: readonly Dependency[]): Record<DependencyKind, number> {
  const counts: Record<DependencyKind, number> = { runtime: 0, dev: 0, peer: 0, optional: 0 };
  for (const dependency of dependencies) counts[dependency.kind] += 1;
  return counts;
}

/**
 * Ranges that pin nothing.
 *
 * `*`, `latest` and an empty range all resolve to "whatever is newest at
 * install time", which makes a build unreproducible. The array holds
 * dependency *names*, not the ranges themselves — a list reading
 * `['*', '*', 'latest']` would be unactionable, whereas the names tell a reader
 * exactly what to pin.
 *
 * Protocol ranges such as `workspace:*` and `catalog:` are deliberately not
 * matched: they are resolved by the workspace, not by the registry.
 */
function collectUnpinned(dependencies: readonly Dependency[]): string[] {
  const names = new Set<string>();

  for (const dependency of dependencies) {
    const range = dependency.range.trim().toLowerCase();
    if (range === '' || range === '*' || range === 'x' || range === 'latest') {
      names.add(dependency.name);
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Match declared dependencies against the curated risk list.
 *
 * Matching is exact and ecosystem-scoped. Results are ordered by severity so
 * the UI can render the list without re-sorting, and deduplicated by name so a
 * package declared in five workspace manifests produces one finding.
 */
function flagDependencies(dependencies: readonly Dependency[]): DependencyFlag[] {
  const bySeverity: Record<Severity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };

  const found = new Map<string, DependencyFlag>();

  for (const dependency of dependencies) {
    const lowerName = dependency.name.toLowerCase();

    for (const rule of FLAG_RULES) {
      if (rule.ecosystem !== dependency.ecosystem) continue;
      if (rule.name !== lowerName) continue;

      const escalated = rule.criticalRanges?.some((fragment) =>
        dependency.range.includes(fragment),
      );

      const flag: DependencyFlag = {
        name: dependency.name,
        reason: rule.reason,
        severity: escalated ? 'critical' : rule.severity,
        ...(rule.replacement === undefined ? {} : { replacement: rule.replacement }),
      };

      const existing = found.get(lowerName);
      // Keep the worst verdict when the same package is declared twice with
      // different ranges — one sabotaged pin is enough to matter.
      if (!existing || bySeverity[flag.severity] < bySeverity[existing.severity]) {
        found.set(lowerName, flag);
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => bySeverity[a.severity] - bySeverity[b.severity] || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(content) as unknown);
  } catch {
    // A malformed manifest is a fact about the repo, not a reason to abort the
    // whole analysis. Callers see zero dependencies from this file and every
    // other manifest still contributes.
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Strip a trailing line comment, ignoring markers inside quoted strings. */
function stripLineComment(line: string, marker: string): string {
  let quote: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (line.startsWith(marker, i)) return line.slice(0, i);
  }

  return line;
}

interface TomlEntry {
  readonly section: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Flatten a TOML document into `(section, key, raw value)` triples.
 *
 * This is not a TOML implementation: it handles exactly the constructs that
 * appear in dependency manifests — table headers, `key = value` pairs, inline
 * tables, and arrays that wrap across lines. Array-of-tables headers
 * (`[[bin]]`) are recognised only so their contents are not misattributed to
 * the previous table.
 */
function parseTomlEntries(content: string): TomlEntry[] {
  const entries: TomlEntry[] = [];
  const lines = toLines(content);

  let section = '';
  let pendingKey: string | null = null;
  let buffer = '';

  for (const rawLine of lines) {
    const line = stripLineComment(rawLine, '#').trim();

    if (pendingKey !== null) {
      buffer += ` ${line}`;
      if (isBalanced(buffer)) {
        entries.push({ section, key: pendingKey, value: buffer.trim() });
        pendingKey = null;
        buffer = '';
      }
      continue;
    }

    if (!line) continue;

    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      section = (header[1] ?? '').replace(/["']/g, '');
      continue;
    }

    const eq = indexOfTopLevelEquals(line);
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim().replace(/["']/g, '');
    const value = line.slice(eq + 1).trim();
    if (!key) continue;

    if (!isBalanced(value)) {
      pendingKey = key;
      buffer = value;
      continue;
    }

    entries.push({ section, key, value });
  }

  // An unterminated array at end-of-file still carries usable names.
  if (pendingKey !== null) entries.push({ section, key: pendingKey, value: buffer.trim() });

  return entries;
}

/** Position of the `=` that separates key from value, ignoring quoted keys. */
function indexOfTopLevelEquals(line: string): number {
  let quote: string | null = null;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '=') return i;
  }

  return -1;
}

/** True when every `[` and `{` opened in the text is also closed. */
function isBalanced(value: string): boolean {
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
  }

  return depth <= 0;
}

/** Extract the string items of a TOML array literal. */
function tomlArrayItems(value: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'/g;

  let match = pattern.exec(value);
  while (match) {
    const item = match[1] ?? match[2] ?? '';
    if (item.trim()) out.push(item.trim());
    match = pattern.exec(value);
  }

  return out;
}

/**
 * Reduce a TOML dependency value to its version requirement.
 *
 * Cargo and Poetry both accept either a bare string (`"1.0"`) or an inline
 * table (`{ version = "1.0", features = [...] }`). A table without a `version`
 * key — a path, git or workspace dependency — has no requirement to show, so it
 * yields an empty range, which the unpinned check then reports.
 */
function tomlVersionOf(value: string): string {
  const trimmed = value.trim();

  if (trimmed.startsWith('{')) {
    const version = /\bversion\s*=\s*["']([^"']*)["']/.exec(trimmed);
    if (version?.[1] !== undefined) return version[1];

    // `{ workspace = true }` inherits the range from the workspace root; say so
    // rather than reporting it as an unpinned dependency.
    if (/\bworkspace\s*=\s*true\b/.test(trimmed)) return 'workspace';
    if (/\b(path|git)\s*=/.test(trimmed)) return 'local';
    return '';
  }

  const quoted = /^["']([\s\S]*)["']$/.exec(trimmed);
  return (quoted?.[1] ?? trimmed).trim();
}
