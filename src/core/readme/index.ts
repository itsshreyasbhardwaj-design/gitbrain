/**
 * README analysis and generation.
 *
 * A README is the only artefact in a repository that every visitor reads, so
 * GitBrain treats it as a first-class quality signal rather than a checkbox.
 * The analyzer answers three questions:
 *
 *  1. *Which sections exist?* — decided from heading synonyms **and** content
 *     signals. Judging headings alone punishes good READMEs that show an
 *     `npm install` block under a heading named "Get going", and rewards bad
 *     ones that carry an empty `## Installation` heading. A section counts when
 *     either signal fires, because either one genuinely helps a reader.
 *  2. *How good is it?* — a weighted presence score with a small, documented
 *     set of bonuses and penalties (see `scoreReadme`).
 *  3. *What is missing, and what should replace it?* — every missing section
 *     comes back as ready-to-paste Markdown that already knows the repository's
 *     name, owner, clone URL, package manager, scripts, licence and env
 *     template. Generic scaffolding gets deleted; scaffolding that already has
 *     the right `git clone` line in it gets kept.
 *
 * The module is pure: it reads a `RepoSnapshot` and returns a `ReadmeReport`.
 * No filesystem, no network, no framework.
 */

import type { ReadmeReport, ReadmeSection, RepoFile, RepoSnapshot } from '../types';
import { basename } from '../shared/paths';
import { clamp, lineAtOffset } from '../shared/text';

// ---------------------------------------------------------------------------
// Locating the README
// ---------------------------------------------------------------------------

/**
 * Root README filenames in preference order.
 *
 * Only the repository root counts: `docs/README.md` documents a folder, not the
 * project, and GitHub does not render it on the repository home page.
 */
const README_CANDIDATES: readonly string[] = [
  'readme.md',
  'readme.markdown',
  'readme.mdx',
  'readme.rst',
  'readme.txt',
  'readme',
];

function findReadme(snapshot: RepoSnapshot): RepoFile | null {
  let best: RepoFile | null = null;
  let bestRank = Number.POSITIVE_INFINITY;

  for (const file of snapshot.files) {
    if (file.path.includes('/')) continue;
    const rank = README_CANDIDATES.indexOf(file.path.toLowerCase());
    if (rank === -1) continue;
    if (rank < bestRank) {
      best = file;
      bestRank = rank;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface CodeBlock {
  readonly lang: string;
  readonly code: string;
}

interface Heading {
  readonly level: number;
  /** Lowercased, stripped of emphasis, links, emoji and punctuation. */
  readonly text: string;
}

interface ImageRef {
  readonly url: string;
  /** 1-indexed line within the prose (code blocks removed). */
  readonly line: number;
}

interface ParsedReadme {
  readonly prose: string;
  readonly headings: readonly Heading[];
  readonly codeBlocks: readonly CodeBlock[];
  readonly wordCount: number;
  readonly images: readonly ImageRef[];
  readonly badges: readonly ImageRef[];
  readonly bulletItems: number;
  readonly taskItems: number;
  readonly tableRows: number;
}

/**
 * Split a document into fenced code blocks and prose.
 *
 * Fences are tracked by their opening character so a ``` block containing ~~~
 * (or the reverse) does not terminate early. An unterminated fence still yields
 * its block — truncated READMEs are common and their code is still evidence.
 */
function splitFences(raw: string): { prose: string; codeBlocks: CodeBlock[] } {
  const lines = raw.split(/\r?\n/);
  const codeBlocks: CodeBlock[] = [];
  const proseLines: string[] = [];

  let closeRe: RegExp | null = null;
  let lang = '';
  let buffer: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (closeRe === null) {
      const open = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)/.exec(trimmed);
      if (open) {
        closeRe = (open[1] ?? '```').startsWith('`') ? /^`{3,}\s*$/ : /^~{3,}\s*$/;
        lang = (open[2] ?? '').toLowerCase();
        buffer = [];
        continue;
      }
      proseLines.push(line);
      continue;
    }

    if (closeRe.test(trimmed)) {
      codeBlocks.push({ lang, code: buffer.join('\n') });
      closeRe = null;
      lang = '';
      buffer = [];
      continue;
    }

    buffer.push(line);
  }

  if (closeRe !== null) codeBlocks.push({ lang, code: buffer.join('\n') });

  return { prose: proseLines.join('\n'), codeBlocks };
}

/** Normalise heading text so `## 🚀 **Getting Started**` matches `getting started`. */
function cleanHeading(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s/&+.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const LIST_ITEM = /^\s{0,4}([-*+]|\d+[.)])\s+\S/;

/**
 * Collect ATX (`## Usage`) and Setext (`Usage\n-----`) headings.
 *
 * Setext support is what makes `.rst` READMEs analysable at all — reStructured-
 * Text has no `#` syntax. To keep horizontal rules and YAML front matter from
 * masquerading as headings, the underline must be at least three characters and
 * the title line must be short, non-empty, and not a list item or table row.
 */
function collectHeadings(prose: string): Heading[] {
  const lines = prose.split('\n');
  const headings: Heading[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      const text = cleanHeading(atx[2] ?? '');
      if (text) headings.push({ level: (atx[1] ?? '#').length, text });
      continue;
    }

    const title = line.trim();
    const next = lines[i + 1];
    if (next === undefined) continue;
    if (!title || title.length > 80) continue;
    if (LIST_ITEM.test(line) || title.startsWith('|') || title.startsWith('>')) continue;

    const underline = /^\s{0,3}([=\-~^*#+"']{3,})\s*$/.exec(next);
    if (!underline) continue;

    const text = cleanHeading(title);
    if (!text) continue;
    headings.push({ level: (underline[1] ?? '=').startsWith('=') ? 1 : 2, text });
  }

  return headings;
}

/**
 * Word count over prose only.
 *
 * Code blocks are already gone; inline code, HTML tags, image syntax, link
 * targets and Markdown punctuation are stripped here. A "word" is any run of
 * non-whitespace that contains at least one letter or digit, so `-`, `|` and
 * `##` never inflate the number.
 */
function countWords(prose: string): number {
  const cleaned = prose
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}[-*+=_]{3,}\s*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>|*_~[\]()]/g, ' ');

  let count = 0;
  for (const token of cleaned.split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) count++;
  }
  return count;
}

/**
 * URLs that identify a status badge rather than a screenshot.
 *
 * Covers the shields.io family plus the CI providers that serve their own
 * `badge.svg` (GitHub Actions, Travis, CircleCI, Codecov, Coveralls).
 */
const BADGE_URL =
  /shields\.io|badgen\.net|badge\.fury\.io|coveralls\.io|codecov\.io|circleci\.com|travis-ci|badge\.svg|badges?\b|\/badge\//i;

/** How far down the document a badge still counts as "near the top". */
const BADGE_ZONE_LINES = 30;

function collectImages(prose: string): { images: ImageRef[]; badges: ImageRef[] } {
  const images: ImageRef[] = [];

  for (const match of prose.matchAll(/!\[[^\]]*\]\(\s*<?([^)>\s]+)/g)) {
    images.push({ url: match[1] ?? '', line: lineAtOffset(prose, match.index ?? 0) });
  }
  for (const match of prose.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    images.push({ url: match[1] ?? '', line: lineAtOffset(prose, match.index ?? 0) });
  }

  const badges = images.filter(
    (image) => image.line <= BADGE_ZONE_LINES && BADGE_URL.test(image.url),
  );

  return { images, badges };
}

function parseReadme(raw: string): ParsedReadme {
  const { prose, codeBlocks } = splitFences(raw);
  const { images, badges } = collectImages(prose);

  const lines = prose.split('\n');
  let bulletItems = 0;
  let taskItems = 0;
  let tableRows = 0;

  for (const line of lines) {
    if (LIST_ITEM.test(line)) bulletItems++;
    if (/^\s{0,4}[-*+]\s+\[[ xX]\]/.test(line)) taskItems++;
    if ((line.match(/\|/g)?.length ?? 0) >= 2) tableRows++;
  }

  return {
    prose,
    headings: collectHeadings(prose),
    codeBlocks,
    wordCount: countWords(prose),
    images,
    badges,
    bulletItems,
    taskItems,
    tableRows,
  };
}

// ---------------------------------------------------------------------------
// Repository context — what makes the generated Markdown repo-aware
// ---------------------------------------------------------------------------

type Ecosystem = 'npm' | 'python' | 'cargo' | 'go' | 'ruby' | 'jvm' | 'php' | 'unknown';

interface RepoContext {
  readonly name: string;
  readonly owner: string | null;
  readonly repoUrl: string | null;
  readonly ownerUrl: string | null;
  readonly issuesUrl: string | null;
  readonly discussionsUrl: string | null;
  readonly securityUrl: string | null;
  readonly cloneCommand: string;
  readonly ref: string;
  readonly description: string | null;
  readonly ecosystem: Ecosystem;
  readonly ecosystemLabel: string;
  readonly install: string | null;
  readonly run: string | null;
  readonly test: string | null;
  readonly build: string | null;
  readonly extraScripts: readonly string[];
  readonly langTag: string;
  readonly importExample: string;
  readonly license: string | null;
  readonly runtimeRequirement: string;
  readonly toolingRequirement: string | null;
  readonly hasDocker: boolean;
  readonly hasCi: boolean;
  readonly hasTypeScript: boolean;
  readonly hasDocsDir: boolean;
  readonly testFileCount: number;
  readonly envNames: readonly string[];
  readonly hasEnvTemplate: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function rootFile(snapshot: RepoSnapshot, name: string): RepoFile | undefined {
  return snapshot.files.find((file) => file.path.toLowerCase() === name);
}

function anyPath(snapshot: RepoSnapshot, pattern: RegExp): boolean {
  return snapshot.files.some((file) => pattern.test(file.path));
}

interface ManifestFacts {
  readonly name: string | null;
  readonly description: string | null;
  readonly license: string | null;
  readonly node: string | null;
  readonly scripts: ReadonlyMap<string, string>;
}

/** Parse `package.json` defensively — a malformed manifest must not throw. */
function readPackageJson(file: RepoFile | undefined): ManifestFacts {
  const empty: ManifestFacts = {
    name: null,
    description: null,
    license: null,
    node: null,
    scripts: new Map(),
  };
  if (!file?.content) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return empty;
  }

  const root = asRecord(parsed);
  if (!root) return empty;

  const scripts = new Map<string, string>();
  const rawScripts = asRecord(root.scripts);
  if (rawScripts) {
    for (const [key, value] of Object.entries(rawScripts)) {
      const command = asString(value);
      if (command) scripts.set(key, command);
    }
  }

  return {
    name: asString(root.name),
    description: asString(root.description),
    license: asString(root.license),
    node: asString(asRecord(root.engines)?.node),
    scripts,
  };
}

const LICENSE_SIGNATURES: readonly (readonly [RegExp, string])[] = [
  [/\bMIT License\b/i, 'MIT'],
  [/Apache License[\s\S]{0,120}Version 2\.0/i, 'Apache-2.0'],
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'AGPL-3.0'],
  [/GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 3/i, 'GPL-3.0'],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL-3.0'],
  [/BSD 3-Clause/i, 'BSD-3-Clause'],
  [/BSD 2-Clause/i, 'BSD-2-Clause'],
  [/Mozilla Public License[\s\S]{0,120}2\.0/i, 'MPL-2.0'],
  [/\bISC License\b/i, 'ISC'],
  [/\bThe Unlicense\b|\bUnlicense\b/i, 'Unlicense'],
];

function detectLicense(snapshot: RepoSnapshot, manifest: ManifestFacts): string | null {
  const file = snapshot.files.find(
    (candidate) =>
      !candidate.path.includes('/') && /^licen[cs]e(\.[a-z]+)?$/i.test(basename(candidate.path)),
  );

  const content = file?.content ?? '';
  for (const [pattern, name] of LICENSE_SIGNATURES) {
    if (pattern.test(content)) return name;
  }

  if (manifest.license) return manifest.license;
  return file ? 'the licence committed in this repository' : null;
}

const ENV_TEMPLATE_NAMES: readonly string[] = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
];

function readEnvTemplate(snapshot: RepoSnapshot): { names: string[]; present: boolean } {
  for (const candidate of ENV_TEMPLATE_NAMES) {
    const file = rootFile(snapshot, candidate);
    if (!file) continue;

    const names: string[] = [];
    for (const line of (file.content ?? '').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=/.exec(line);
      const name = match?.[1];
      if (name && !names.includes(name)) names.push(name);
    }
    return { names, present: true };
  }
  return { names: [], present: false };
}

/** Slug a repository name out of an uploaded archive filename. */
function nameFromArchive(filename: string): string {
  return (
    filename
      .replace(/\.(zip|tgz|tar\.gz|tar\.bz2|tar|gz)$/i, '')
      .replace(/-(main|master|develop|trunk)$/i, '')
      .replace(/-[0-9a-f]{7,40}$/i, '')
      .trim() || 'this-project'
  );
}

/**
 * Detect the ecosystem, package manager and canonical commands.
 *
 * Everything here comes from files that are actually committed, which is what
 * makes the generated Markdown trustworthy: the `Installation` block prints the
 * package manager whose lockfile is in the tree, and the `Tests` block prints
 * the scripts that really exist in `package.json`.
 */
function describeRepo(snapshot: RepoSnapshot): RepoContext {
  const source = snapshot.source;
  const pkg = readPackageJson(rootFile(snapshot, 'package.json'));

  const owner = source.kind === 'github' ? source.owner : null;
  const repoUrl = source.kind === 'github' ? source.url.replace(/\/+$/, '') : null;
  const ref = source.kind === 'github' ? source.ref : 'main';
  const name =
    source.kind === 'github' ? source.repo : (pkg.name ?? nameFromArchive(source.filename));

  const hasTypeScript = anyPath(snapshot, /^tsconfig(\.[a-z]+)?\.json$/i);
  const hasDocker = anyPath(snapshot, /^(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i);
  const hasCi = anyPath(snapshot, /^\.github\/workflows\/|^\.gitlab-ci\.ya?ml$|^\.circleci\//i);
  const hasDocsDir = anyPath(snapshot, /^(docs|doc|documentation)\//i);
  const testFileCount = snapshot.files.filter((file) =>
    /(\.(test|spec)\.[cm]?[jt]sx?|_test\.go|_test\.py|test_[^/]+\.py|_spec\.rb)$/i.test(file.path),
  ).length;

  const env = readEnvTemplate(snapshot);
  const license = detectLicense(snapshot, pkg);

  const commands = resolveCommands(snapshot, pkg);

  return {
    name,
    owner,
    repoUrl,
    ownerUrl: owner ? `https://github.com/${owner}` : null,
    issuesUrl: repoUrl ? `${repoUrl}/issues` : null,
    discussionsUrl: repoUrl ? `${repoUrl}/discussions` : null,
    securityUrl: repoUrl ? `${repoUrl}/security/advisories/new` : null,
    cloneCommand: repoUrl ? `git clone ${repoUrl}.git` : `git clone <this-repository>`,
    ref,
    description: pkg.description,
    ...commands,
    license,
    hasDocker,
    hasCi,
    hasTypeScript,
    hasDocsDir,
    testFileCount,
    envNames: env.names,
    hasEnvTemplate: env.present,
    importExample: buildImportExample(commands.ecosystem, name, owner),
  };
}

interface CommandSet {
  readonly ecosystem: Ecosystem;
  readonly ecosystemLabel: string;
  readonly install: string | null;
  readonly run: string | null;
  readonly test: string | null;
  readonly build: string | null;
  readonly extraScripts: readonly string[];
  readonly langTag: string;
  readonly runtimeRequirement: string;
  readonly toolingRequirement: string | null;
}

function resolveCommands(snapshot: RepoSnapshot, pkg: ManifestFacts): CommandSet {
  const hasTypeScript = anyPath(snapshot, /^tsconfig(\.[a-z]+)?\.json$/i);

  if (rootFile(snapshot, 'package.json')) {
    const pm = rootFile(snapshot, 'pnpm-lock.yaml')
      ? 'pnpm'
      : rootFile(snapshot, 'yarn.lock')
        ? 'yarn'
        : rootFile(snapshot, 'bun.lockb') || rootFile(snapshot, 'bun.lock')
          ? 'bun'
          : 'npm';

    const has = (script: string): boolean => pkg.scripts.has(script);
    const extras = ['lint', 'typecheck', 'format', 'test:coverage', 'test:e2e', 'verify'].filter(
      has,
    );

    return {
      ecosystem: 'npm',
      ecosystemLabel: hasTypeScript ? 'TypeScript' : 'JavaScript',
      install: `${pm} install`,
      run: has('dev') ? `${pm} run dev` : has('start') ? `${pm} start` : `${pm} run dev`,
      test: `${pm} test`,
      build: has('build') ? `${pm} run build` : null,
      extraScripts: extras.map((script) => `${pm} run ${script}`),
      langTag: hasTypeScript ? 'ts' : 'js',
      runtimeRequirement: pkg.node ? `Node.js ${pkg.node}` : 'Node.js 20.11 or newer',
      toolingRequirement: pm === 'npm' ? null : `${pm} (the repository commits a ${pm} lockfile)`,
    };
  }

  if (
    rootFile(snapshot, 'pyproject.toml') ||
    rootFile(snapshot, 'requirements.txt') ||
    rootFile(snapshot, 'setup.py')
  ) {
    const requirements = Boolean(rootFile(snapshot, 'requirements.txt'));
    return {
      ecosystem: 'python',
      ecosystemLabel: 'Python',
      install: requirements ? 'pip install -r requirements.txt' : 'pip install -e ".[dev]"',
      run: rootFile(snapshot, 'main.py') ? 'python main.py' : 'python -m app',
      test: 'pytest',
      build: rootFile(snapshot, 'pyproject.toml') ? 'python -m build' : null,
      extraScripts: [],
      langTag: 'python',
      runtimeRequirement: 'Python 3.10 or newer',
      toolingRequirement: 'A virtual environment (`python -m venv .venv`)',
    };
  }

  if (rootFile(snapshot, 'cargo.toml')) {
    return {
      ecosystem: 'cargo',
      ecosystemLabel: 'Rust',
      install: 'cargo build',
      run: 'cargo run',
      test: 'cargo test',
      build: 'cargo build --release',
      extraScripts: ['cargo clippy --all-targets', 'cargo fmt --check'],
      langTag: 'rust',
      runtimeRequirement: 'Rust 1.75 or newer (stable toolchain)',
      toolingRequirement: null,
    };
  }

  if (rootFile(snapshot, 'go.mod')) {
    return {
      ecosystem: 'go',
      ecosystemLabel: 'Go',
      install: 'go mod download',
      run: 'go run .',
      test: 'go test ./...',
      build: 'go build ./...',
      extraScripts: ['go vet ./...'],
      langTag: 'go',
      runtimeRequirement: 'Go 1.22 or newer',
      toolingRequirement: null,
    };
  }

  if (rootFile(snapshot, 'gemfile')) {
    return {
      ecosystem: 'ruby',
      ecosystemLabel: 'Ruby',
      install: 'bundle install',
      run: 'bundle exec rake',
      test: 'bundle exec rspec',
      build: 'gem build *.gemspec',
      extraScripts: ['bundle exec rubocop'],
      langTag: 'ruby',
      runtimeRequirement: 'Ruby 3.2 or newer',
      toolingRequirement: 'Bundler (`gem install bundler`)',
    };
  }

  if (rootFile(snapshot, 'pom.xml')) {
    return {
      ecosystem: 'jvm',
      ecosystemLabel: 'Java',
      install: 'mvn install -DskipTests',
      run: 'mvn spring-boot:run',
      test: 'mvn test',
      build: 'mvn package',
      extraScripts: [],
      langTag: 'java',
      runtimeRequirement: 'JDK 21 or newer',
      toolingRequirement: 'Maven 3.9 or newer',
    };
  }

  if (rootFile(snapshot, 'build.gradle') || rootFile(snapshot, 'build.gradle.kts')) {
    return {
      ecosystem: 'jvm',
      ecosystemLabel: 'Java',
      install: './gradlew build -x test',
      run: './gradlew run',
      test: './gradlew test',
      build: './gradlew build',
      extraScripts: [],
      langTag: 'java',
      runtimeRequirement: 'JDK 21 or newer',
      toolingRequirement: null,
    };
  }

  if (rootFile(snapshot, 'composer.json')) {
    return {
      ecosystem: 'php',
      ecosystemLabel: 'PHP',
      install: 'composer install',
      run: 'php -S localhost:8000 -t public',
      test: 'vendor/bin/phpunit',
      build: null,
      extraScripts: [],
      langTag: 'php',
      runtimeRequirement: 'PHP 8.2 or newer',
      toolingRequirement: 'Composer 2',
    };
  }

  const hasMake = Boolean(rootFile(snapshot, 'makefile'));
  return {
    ecosystem: 'unknown',
    ecosystemLabel: 'software',
    install: hasMake ? 'make install' : null,
    run: hasMake ? 'make run' : null,
    test: hasMake ? 'make test' : null,
    build: hasMake ? 'make' : null,
    extraScripts: [],
    langTag: 'bash',
    runtimeRequirement: 'The toolchain this repository builds with',
    toolingRequirement: null,
  };
}

function buildImportExample(ecosystem: Ecosystem, name: string, owner: string | null): string {
  const identifier = name.replace(/[^A-Za-z0-9]+(.)/g, (_all, char: string) => char.toUpperCase());
  switch (ecosystem) {
    case 'npm':
      return `import { ${identifier} } from '${name}';`;
    case 'python':
      return `from ${name.replace(/-/g, '_')} import main`;
    case 'go':
      return `import "github.com/${owner ?? 'your-org'}/${name}"`;
    case 'cargo':
      return `use ${name.replace(/-/g, '_')}::prelude::*;`;
    case 'ruby':
      return `require "${name.replace(/-/g, '_')}"`;
    case 'jvm':
      return `import com.${(owner ?? 'example').toLowerCase()}.${identifier.toLowerCase()}.Client;`;
    case 'php':
      return `use ${identifier}\\Client;`;
    default:
      return `# load ${name} the way your toolchain expects`;
  }
}

// ---------------------------------------------------------------------------
// Section catalogue
// ---------------------------------------------------------------------------

/**
 * Weights. They sum to exactly 1.0 and encode one opinion: a README exists to
 * get a stranger from "found the repo" to "ran the code" and then to
 * "contributed safely".
 *
 * - Description, Installation and Usage carry 0.12 each. Without them the
 *   README fails at its only job, so they dominate the score.
 * - Title (0.08) is cheap but load-bearing; GitHub renders it as the page title.
 * - Features (0.07) and API (0.07) are what turn a runnable project into an
 *   adoptable one.
 * - Configuration (0.06), Contributing (0.06) and License (0.06) are the
 *   difference between "I ran it" and "I can deploy, extend and legally use it".
 *   License is deliberately weighted the same as Contributing: an unlicensed
 *   repository is legally unusable, which is a documentation failure.
 * - Requirements (0.05) and Tests (0.05) prevent the most common failed setup.
 * - Screenshots (0.04) and Support (0.04) matter for adoption, not for use.
 * - Badges (0.03) and Roadmap (0.03) are the smallest: nice signals, but no one
 *   is blocked by their absence.
 */
const SECTION_WEIGHTS = {
  Title: 0.08,
  Description: 0.12,
  Badges: 0.03,
  Installation: 0.12,
  Usage: 0.12,
  Features: 0.07,
  Configuration: 0.06,
  API: 0.07,
  Screenshots: 0.04,
  Requirements: 0.05,
  Contributing: 0.06,
  License: 0.06,
  Tests: 0.05,
  Roadmap: 0.03,
  Support: 0.04,
} as const;

export type ReadmeSectionName = keyof typeof SECTION_WEIGHTS;

/** Section names in evaluation order, exported so callers can render a checklist. */
export const README_SECTION_NAMES: readonly ReadmeSectionName[] = Object.keys(
  SECTION_WEIGHTS,
) as ReadmeSectionName[];

interface SectionSpec {
  readonly name: ReadmeSectionName;
  readonly synonyms: readonly string[];
  /** Content-level evidence that the section exists under a different heading. */
  readonly signal: (doc: ParsedReadme) => boolean;
  readonly suggestion: (ctx: RepoContext) => string;
  readonly generate: (ctx: RepoContext) => string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary match against already-lowercased heading text. */
function matchesTerm(text: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`).test(text);
}

/**
 * Headings that can name a *section*.
 *
 * The document's opening level-1 heading is the project title, not a section,
 * so it is excluded. Without this, a repository literally called `demo` would
 * have its `# demo` title satisfy the Screenshots synonym "demo" — the kind of
 * false positive that quietly inflates every score.
 */
function sectionHeadings(doc: ParsedReadme): readonly Heading[] {
  return doc.headings[0]?.level === 1 ? doc.headings.slice(1) : doc.headings;
}

function hasHeading(doc: ParsedReadme, synonyms: readonly string[]): boolean {
  return sectionHeadings(doc).some((heading) =>
    synonyms.some((term) => matchesTerm(heading.text, term)),
  );
}

function codeMatches(doc: ParsedReadme, pattern: RegExp): boolean {
  return doc.codeBlocks.some((block) => pattern.test(block.code));
}

const INSTALL_COMMAND =
  /\b(npm\s+(i|install|ci)|pnpm\s+(i|install|add)|yarn\s+(add|install)|bun\s+(add|install)|pip3?\s+install|poetry\s+(add|install)|uv\s+(pip\s+)?(add|install|sync)|cargo\s+(add|install)|go\s+(get|install)|composer\s+(require|install)|gem\s+install|bundle\s+install|brew\s+install|apt-get\s+install|mvn\s+install|gradlew?\s+build|make\s+install|docker\s+(pull|compose\s+up))\b/;

const TEST_COMMAND =
  /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test|pytest|vitest|jest|mocha|go\s+test|cargo\s+test|rspec|phpunit|tox|mvn\s+test|gradlew?\s+test|make\s+test)\b/;

/** Fence languages that indicate a real code example rather than a shell recipe. */
const EXAMPLE_LANGS: ReadonlySet<string> = new Set([
  'js',
  'javascript',
  'jsx',
  'ts',
  'typescript',
  'tsx',
  'py',
  'python',
  'go',
  'golang',
  'rust',
  'rs',
  'java',
  'kotlin',
  'kt',
  'ruby',
  'rb',
  'php',
  'c',
  'cpp',
  'cs',
  'csharp',
  'swift',
  'scala',
  'elixir',
  'ex',
  'html',
  'vue',
  'svelte',
  'graphql',
  'sql',
]);

const SECTIONS: readonly SectionSpec[] = [
  {
    name: 'Title',
    synonyms: [],
    // A level-1 heading is the title. Nothing else in a README is.
    signal: (doc) => doc.headings.some((heading) => heading.level === 1),
    suggestion: (ctx) =>
      `Open the README with a level-1 heading — "# ${ctx.name}" — so GitHub, npm and search engines all show the same project name.`,
    generate: (ctx) => generateTitle(ctx),
  },
  {
    name: 'Description',
    synonyms: [
      'description',
      'overview',
      'about',
      'introduction',
      'intro',
      'what is it',
      'summary',
      'motivation',
      'why',
    ],
    // A substantial paragraph of prose is a description even when unlabelled —
    // most good READMEs put the pitch directly under the title with no heading.
    signal: (doc) => hasIntroParagraph(doc),
    suggestion: (ctx) =>
      `Add a one-paragraph Overview under the title saying what ${ctx.name} does, who it is for, and why it exists.`,
    generate: (ctx) => generateDescription(ctx),
  },
  {
    name: 'Badges',
    synonyms: ['badges', 'status', 'build status'],
    signal: (doc) => doc.badges.length > 0,
    suggestion: (ctx) =>
      ctx.hasCi
        ? `Add build, coverage and licence badges under the title — this repository already runs CI, so the workflow badge is live.`
        : `Add licence and version badges under the title so the project's status is visible without scrolling.`,
    generate: (ctx) => generateBadges(ctx),
  },
  {
    name: 'Installation',
    synonyms: [
      'installation',
      'install',
      'installing',
      'setup',
      'set up',
      'getting started',
      'get started',
      'quickstart',
      'quick start',
    ],
    signal: (doc) => codeMatches(doc, INSTALL_COMMAND),
    suggestion: (ctx) =>
      `Add an Installation section with a copyable block: \`${ctx.cloneCommand}\`${
        ctx.install ? `, then \`${ctx.install}\`` : ''
      }.`,
    generate: (ctx) => generateInstallation(ctx),
  },
  {
    name: 'Usage',
    synonyms: [
      'usage',
      'using',
      'how to use',
      'quick start',
      'quickstart',
      'getting started',
      'example',
      'examples',
      'basic usage',
      'running',
      'run',
      'demo usage',
    ],
    signal: (doc) => doc.codeBlocks.some((block) => EXAMPLE_LANGS.has(block.lang)),
    suggestion: (ctx) =>
      `Add a Usage section with the shortest program that does something real — start with \`${ctx.importExample}\`.`,
    generate: (ctx) => generateUsage(ctx),
  },
  {
    name: 'Features',
    synonyms: [
      'features',
      'feature',
      'highlights',
      'capabilities',
      'what you get',
      'whats included',
      'key features',
    ],
    // Four or more bullets is a feature list in everything but name.
    signal: (doc) => doc.bulletItems >= 4,
    suggestion: (ctx) =>
      `Add a Features list — three to six bullets naming what ${ctx.name} does that alternatives do not.`,
    generate: (ctx) => generateFeatures(ctx),
  },
  {
    name: 'Configuration',
    synonyms: [
      'configuration',
      'config',
      'configuring',
      'options',
      'settings',
      'environment',
      'environment variables',
      'env',
      'customization',
      'customisation',
    ],
    signal: (doc) => /\.env\b|process\.env|environment variable|os\.environ/i.test(doc.prose),
    suggestion: (ctx) =>
      ctx.hasEnvTemplate
        ? `Add a Configuration section documenting the ${ctx.envNames.length} variables already listed in the committed env template.`
        : `Add a Configuration section with a table of every environment variable, its default and whether it is required.`,
    generate: (ctx) => generateConfiguration(ctx),
  },
  {
    name: 'API',
    synonyms: [
      'api',
      'api reference',
      'reference',
      'documentation',
      'docs',
      'methods',
      'endpoints',
      'cli',
      'commands',
      'options reference',
    ],
    // A Markdown table plus a code example is, in practice, an API reference.
    signal: (doc) =>
      doc.tableRows >= 3 && doc.codeBlocks.some((block) => EXAMPLE_LANGS.has(block.lang)),
    suggestion: (ctx) =>
      ctx.hasDocsDir
        ? `Add an API section that summarises the public surface and links to the existing \`docs/\` folder.`
        : `Add an API section documenting each public export: signature, parameters, return value and one runnable example.`,
    generate: (ctx) => generateApi(ctx),
  },
  {
    name: 'Screenshots',
    synonyms: ['screenshot', 'screenshots', 'demo', 'preview', 'gallery', 'video', 'in action'],
    // Any non-badge image is a screenshot, a diagram or a demo GIF.
    signal: (doc) => doc.images.length > doc.badges.length,
    suggestion: (ctx) =>
      `Add a Screenshots or Demo section — a single image or GIF communicates what ${ctx.name} does faster than three paragraphs.`,
    generate: (ctx) => generateScreenshots(ctx),
  },
  {
    name: 'Requirements',
    synonyms: [
      'requirements',
      'requirement',
      'prerequisites',
      'prerequisite',
      'dependencies',
      'before you begin',
      'system requirements',
      'compatibility',
      'supported versions',
    ],
    signal: (doc) =>
      /\b(node(\.js)?|python|go|rust|ruby|php|java|jdk|docker)\b[^\n]{0,24}(>=|≥|\bv?\d+(\.\d+)?)/i.test(
        doc.prose,
      ),
    suggestion: (ctx) =>
      `Add a Requirements section stating the minimum toolchain — this repository needs ${ctx.runtimeRequirement}.`,
    generate: (ctx) => generateRequirements(ctx),
  },
  {
    name: 'Contributing',
    synonyms: [
      'contributing',
      'contribute',
      'contributors',
      'development',
      'developing',
      'pull requests',
      'pull request',
      'code of conduct',
      'hacking',
    ],
    signal: (doc) => /contributing(\.md)?\b/i.test(doc.prose),
    suggestion: (ctx) =>
      `Add a Contributing section with the exact branch, install and test commands a first-time contributor to ${ctx.name} should run.`,
    generate: (ctx) => generateContributing(ctx),
  },
  {
    name: 'License',
    synonyms: ['license', 'licence', 'licensing', 'legal', 'copyright'],
    signal: (doc) => /licen[cs]ed?\s+under|\bLICEN[CS]E(\.md|\.txt)?\b/i.test(doc.prose),
    suggestion: (ctx) =>
      ctx.license
        ? `Add a License section stating the terms (${ctx.license}) and linking to the LICENSE file.`
        : `Add a License section — this repository has no detectable licence, so by default nobody may legally reuse it.`,
    generate: (ctx) => generateLicense(ctx),
  },
  {
    name: 'Tests',
    synonyms: [
      'test',
      'tests',
      'testing',
      'running tests',
      'test suite',
      'coverage',
      'quality',
      'ci',
    ],
    signal: (doc) => codeMatches(doc, TEST_COMMAND),
    suggestion: (ctx) =>
      ctx.test
        ? `Add a Tests section showing how to run the suite (\`${ctx.test}\`) so contributors can verify a change before opening a PR.`
        : `Add a Tests section describing how the project is verified before a change is merged.`,
    generate: (ctx) => generateTests(ctx),
  },
  {
    name: 'Roadmap',
    synonyms: [
      'roadmap',
      'todo',
      'to do',
      'future',
      'upcoming',
      'whats next',
      'next steps',
      'milestones',
      'plans',
      'planned',
      'changelog',
    ],
    signal: (doc) => doc.taskItems >= 2,
    suggestion: (ctx) =>
      `Add a Roadmap checklist so readers can see where ${ctx.name} is going and where they could help.`,
    generate: (ctx) => generateRoadmap(ctx),
  },
  {
    name: 'Support',
    synonyms: [
      'support',
      'contact',
      'help',
      'questions',
      'community',
      'feedback',
      'get in touch',
      'issues',
      'discussions',
      'security',
      'acknowledgements',
    ],
    signal: (doc) =>
      /mailto:|\/issues\b|\/discussions\b|discord\.gg|slack\.com\/join/i.test(doc.prose),
    suggestion: (ctx) =>
      ctx.issuesUrl
        ? `Add a Support section pointing bug reports at ${ctx.issuesUrl} and telling people where NOT to report security issues.`
        : `Add a Support section naming exactly one channel for bugs, one for questions and one for security reports.`,
    generate: (ctx) => generateSupport(ctx),
  },
];

/**
 * True when the README carries an unlabelled pitch paragraph.
 *
 * Looks for a prose line of at least eight words that is not a heading, list
 * item, table row, blockquote badge strip or bare image — the shape of the
 * sentence a maintainer writes immediately under the title.
 */
function hasIntroParagraph(doc: ParsedReadme): boolean {
  for (const rawLine of doc.prose.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('|') || line.startsWith('>')) continue;
    if (LIST_ITEM.test(rawLine)) continue;
    if (/^\s*[=\-~^*#+"']{3,}\s*$/.test(line)) continue;
    if (/^(!\[|<img|<p|<div|<h\d|<a\b|\[!\[)/i.test(line)) continue;

    const words = countWords(line);
    if (words >= 8) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Markdown generators
// ---------------------------------------------------------------------------

function joinBlock(lines: readonly string[]): string {
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function fence(lang: string, body: readonly string[]): string[] {
  return ['```' + lang, ...body, '```'];
}

function generateTitle(ctx: RepoContext): string {
  const tagline =
    ctx.description ??
    `A ${ctx.ecosystemLabel} project${ctx.owner ? ` maintained by ${ctx.owner}` : ''}.`;

  return joinBlock([`# ${ctx.name}`, '', `> ${tagline}`]);
}

function generateDescription(ctx: RepoContext): string {
  const facts: string[] = [
    `- **What it is** — ${ctx.description ?? `a ${ctx.ecosystemLabel} project`} living in ${
      ctx.owner ? `\`${ctx.owner}/${ctx.name}\`` : `the \`${ctx.name}\` repository`
    }.`,
  ];
  if (ctx.install) facts.push(`- **How you set it up** — \`${ctx.install}\`.`);
  if (ctx.run) facts.push(`- **How you run it** — \`${ctx.run}\`.`);
  if (ctx.test) facts.push(`- **How you verify it** — \`${ctx.test}\`.`);

  return joinBlock([
    '## Overview',
    '',
    `${ctx.name} is ${ctx.description ? `${lowerFirst(ctx.description)}` : `a ${ctx.ecosystemLabel} project`}.`,
    '',
    ...facts,
    '',
    'Expand the paragraph above into the pitch you would give a teammate who has',
    'never seen this repository: the problem it solves, the approach it takes, and',
    'the outcome someone gets by adopting it. Two or three sentences is the right',
    'length — anything longer belongs in the docs, not the README.',
  ]);
}

function generateBadges(ctx: RepoContext): string {
  const lines: string[] = [];

  if (ctx.repoUrl && ctx.hasCi) {
    lines.push(
      `[![CI](${ctx.repoUrl}/actions/workflows/ci.yml/badge.svg)](${ctx.repoUrl}/actions/workflows/ci.yml)`,
    );
  }
  if (ctx.repoUrl) {
    const label = encodeURIComponent(ctx.license ?? 'unlicensed');
    lines.push(
      `[![License](https://img.shields.io/badge/license-${label}-blue.svg)](${ctx.repoUrl}/blob/${ctx.ref}/LICENSE)`,
    );
    lines.push(
      `[![Issues](https://img.shields.io/github/issues/${ctx.owner}/${ctx.name}.svg)](${ctx.repoUrl}/issues)`,
    );
  }
  if (ctx.ecosystem === 'npm') {
    lines.push(
      `[![npm](https://img.shields.io/npm/v/${ctx.name}.svg)](https://www.npmjs.com/package/${ctx.name})`,
    );
  }
  if (lines.length === 0) {
    lines.push(
      `![License](https://img.shields.io/badge/license-${encodeURIComponent(ctx.license ?? 'unlicensed')}-blue.svg)`,
    );
  }

  return joinBlock([
    ...lines,
    '',
    'Paste this strip directly beneath the title. Badges belong above the fold —',
    'they are the fastest way for a reader to judge whether the project is alive.',
  ]);
}

function generateInstallation(ctx: RepoContext): string {
  const steps = [ctx.cloneCommand, `cd ${ctx.name}`];
  if (ctx.install) steps.push(ctx.install);

  const body: string[] = ['## Installation', ''];

  if (ctx.toolingRequirement) {
    body.push(`Requires ${ctx.runtimeRequirement} and ${lowerFirst(ctx.toolingRequirement)}.`, '');
  } else {
    body.push(`Requires ${ctx.runtimeRequirement}.`, '');
  }

  body.push(...fence('bash', steps), '');

  if (ctx.ecosystem === 'npm') {
    body.push(
      `To use ${ctx.name} as a dependency in another project instead:`,
      '',
      ...fence('bash', [`npm install ${ctx.name}`]),
      '',
    );
  }
  if (ctx.hasDocker) {
    body.push(
      'A Dockerfile is committed, so the container path works too:',
      '',
      ...fence('bash', [`docker build -t ${ctx.name} .`, `docker run --rm ${ctx.name}`]),
      '',
    );
  }

  return joinBlock(body);
}

function generateUsage(ctx: RepoContext): string {
  const body: string[] = ['## Quick Start', ''];

  const shell: string[] = [];
  if (ctx.install) shell.push(ctx.install);
  if (ctx.run) shell.push(ctx.run);

  if (shell.length > 0) {
    body.push('Run it locally:', '', ...fence('bash', shell), '');
  }

  body.push(
    'Use it from your own code:',
    '',
    ...fence(ctx.langTag, [
      ctx.importExample,
      '',
      `// Replace this call with the smallest example that produces a real result.`,
      `// A README example that cannot be pasted into a file and run is decoration.`,
    ]),
    '',
    `Every example here should be runnable against a fresh clone of ${ctx.name}.`,
  );

  return joinBlock(body);
}

function generateFeatures(ctx: RepoContext): string {
  const bullets: string[] = [];

  if (ctx.hasTypeScript) {
    bullets.push(
      '- **Typed end to end** — the codebase is TypeScript, so editors and CI catch contract breaks before review.',
    );
  }
  if (ctx.testFileCount > 0 && ctx.test) {
    bullets.push(
      `- **Verified by ${ctx.testFileCount} test file${ctx.testFileCount === 1 ? '' : 's'}** — run the whole suite with \`${ctx.test}\`.`,
    );
  }
  if (ctx.hasCi) {
    bullets.push(
      '- **Checked on every push** — CI workflows are committed, so main stays releasable.',
    );
  }
  if (ctx.hasDocker) {
    bullets.push(
      `- **Runs anywhere** — a committed Dockerfile reproduces the runtime exactly (\`docker build -t ${ctx.name} .\`).`,
    );
  }
  if (ctx.install && ctx.run) {
    bullets.push(
      `- **Two-command start** — \`${ctx.install}\` then \`${ctx.run}\`, with no global setup.`,
    );
  }
  if (ctx.hasDocsDir) {
    bullets.push('- **Documented beyond the README** — longer guides live in `docs/`.');
  }

  if (bullets.length === 0) {
    bullets.push(
      `- **Small surface** — ${ctx.name} does one thing, which keeps it easy to reason about.`,
    );
  }

  return joinBlock([
    '## Features',
    '',
    ...bullets,
    '',
    'The bullets above are drawn from what this repository actually contains. Add',
    'the two or three capabilities that make it worth choosing over the',
    'alternatives, and keep every bullet to a single line.',
  ]);
}

function generateConfiguration(ctx: RepoContext): string {
  const rows =
    ctx.envNames.length > 0
      ? ctx.envNames.map(
          (name) => `| \`${name}\` | yes | — | Documented in the committed env template. |`,
        )
      : [
          '| `PORT` | no | `3000` | Port the local server binds to. |',
          '| `LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, `error`. |',
          '| `DATABASE_URL` | yes | — | Connection string for the primary datastore. |',
        ];

  const intro = ctx.hasEnvTemplate
    ? [
        `${ctx.name} is configured through environment variables. Start from the`,
        'committed template:',
        '',
        ...fence('bash', ['cp .env.example .env']),
      ]
    : [
        `${ctx.name} has no committed environment template yet. Create \`.env.example\`,`,
        'commit it with safe placeholder values, and keep this table in step with it:',
        '',
        ...fence('bash', ['cp .env.example .env']),
      ];

  return joinBlock([
    '## Configuration',
    '',
    ...intro,
    '',
    '| Variable | Required | Default | Description |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    'Never commit a real secret to `.env.example` — placeholders only.',
  ]);
}

function generateApi(ctx: RepoContext): string {
  const body: string[] = ['## API', ''];

  if (ctx.hasDocsDir && ctx.repoUrl) {
    body.push(
      `Long-form documentation lives in [\`docs/\`](${ctx.repoUrl}/tree/${ctx.ref}/docs). This`,
      'section is the summary a reader needs before they open it.',
      '',
    );
  }

  body.push(
    '| Export | Signature | Description |',
    '| --- | --- | --- |',
    '| `createClient` | `(options: Options) => Client` | Builds a configured client. |',
    '| `Client.run` | `(input: Input) => Promise<Result>` | Executes one request and resolves with the result. |',
    '',
    '### `createClient(options)`',
    '',
    ...fence(ctx.langTag, [ctx.importExample, '', `// One runnable call per documented export.`]),
    '',
    'Replace the rows above with the real public surface of',
    `${ctx.owner ? `${ctx.owner}/${ctx.name}` : ctx.name}. Document each export the same way:`,
    'signature, parameters, return value, errors it can throw, and one example a',
    'reader can paste into a file and run.',
  );

  return joinBlock(body);
}

function generateScreenshots(ctx: RepoContext): string {
  return joinBlock([
    '## Screenshots',
    '',
    '| View | Preview |',
    '| --- | --- |',
    '| Main screen | ![Main screen](docs/images/main.png) |',
    '| Result view | ![Result view](docs/images/result.png) |',
    '',
    'Commit the images under `docs/images/` and reference them with **relative**',
    'paths, so they render on GitHub, in forks and in offline clones alike.',
    ctx.repoUrl
      ? `Absolute links back to ${ctx.repoUrl} break the moment someone forks the project.`
      : 'Absolute links to a single host break the moment someone forks the project.',
    '',
    'A ten-second GIF of the tool doing its job outperforms every paragraph in',
    'this README.',
  ]);
}

function generateRequirements(ctx: RepoContext): string {
  const bullets = [`- ${ctx.runtimeRequirement}`];
  if (ctx.toolingRequirement) bullets.push(`- ${ctx.toolingRequirement}`);
  if (ctx.hasDocker)
    bullets.push('- Docker 24 or newer — only if you use the committed Dockerfile');
  if (ctx.hasEnvTemplate) {
    bullets.push('- A populated `.env` file — copy the committed template before first run');
  }
  bullets.push('- Git');

  return joinBlock([
    '## Requirements',
    '',
    ...bullets,
    '',
    'These are the versions the project is developed and tested against. Pin them',
    'in CI so "works on my machine" stops being a valid explanation.',
  ]);
}

function generateContributing(ctx: RepoContext): string {
  const steps: string[] = [
    ctx.owner
      ? `1. Fork \`${ctx.owner}/${ctx.name}\` and branch from \`${ctx.ref}\`: \`git checkout -b feat/short-description\`.`
      : `1. Branch from \`${ctx.ref}\`: \`git checkout -b feat/short-description\`.`,
  ];
  if (ctx.install) steps.push(`2. Install dependencies: \`${ctx.install}\`.`);
  if (ctx.test) steps.push(`${steps.length + 1}. Keep the suite green: \`${ctx.test}\`.`);
  if (ctx.extraScripts.length > 0) {
    steps.push(
      `${steps.length + 1}. Run the repository's other checks: ${ctx.extraScripts
        .map((script) => `\`${script}\``)
        .join(', ')}.`,
    );
  }
  steps.push(
    `${steps.length + 1}. Commit in small, reviewable pieces with a message that explains **why**.`,
  );
  steps.push(
    ctx.repoUrl
      ? `${steps.length + 1}. Open a pull request against \`${ctx.ref}\` and link the issue it closes.`
      : `${steps.length + 1}. Open a pull request against \`${ctx.ref}\` and link the issue it closes.`,
  );

  return joinBlock([
    '## Contributing',
    '',
    'Contributions are welcome.',
    '',
    ...steps,
    '',
    ctx.issuesUrl
      ? `For anything larger than a bug fix, open an issue at ${ctx.issuesUrl} first so the`
      : 'For anything larger than a bug fix, open an issue first so the',
    'design can be agreed before the code is written.',
  ]);
}

function generateLicense(ctx: RepoContext): string {
  if (ctx.license) {
    const link = ctx.repoUrl ? `${ctx.repoUrl}/blob/${ctx.ref}/LICENSE` : 'LICENSE';
    return joinBlock([
      '## License',
      '',
      `Released under the ${ctx.license} license. See [LICENSE](${link}) for the full text.`,
    ]);
  }

  return joinBlock([
    '## License',
    '',
    `${ctx.name} does not declare a license, which means default copyright applies`,
    'and nobody may legally copy, modify or redistribute it — including people who',
    'have already cloned it.',
    '',
    'Add a `LICENSE` file at the repository root, then state the terms here:',
    '',
    '- **MIT** — maximum adoption, minimum obligation. The default for libraries.',
    '- **Apache-2.0** — MIT plus an explicit patent grant. Preferred by companies.',
    '- **AGPL-3.0** — requires network users to receive the source. Use deliberately.',
    '',
    'Then replace this section with: "Released under the MIT license. See [LICENSE](LICENSE)."',
  ]);
}

function generateTests(ctx: RepoContext): string {
  const commands: string[] = [];
  if (ctx.test) commands.push(ctx.test);
  for (const script of ctx.extraScripts) commands.push(script);
  if (commands.length === 0) commands.push('# document the command that verifies a change here');

  return joinBlock([
    '## Tests',
    '',
    ctx.testFileCount > 0
      ? `The repository contains ${ctx.testFileCount} test file${ctx.testFileCount === 1 ? '' : 's'}. Run them with:`
      : 'The repository has no test files yet. Once it does, run them with:',
    '',
    ...fence('bash', commands),
    '',
    ctx.hasCi
      ? 'CI runs the same commands on every push, so a green local run predicts a green pipeline.'
      : 'Wire these same commands into CI so every pull request is checked automatically.',
  ]);
}

function generateRoadmap(ctx: RepoContext): string {
  const done: string[] = [];
  if (ctx.testFileCount > 0) done.push('- [x] Automated test suite');
  if (ctx.hasCi) done.push('- [x] Continuous integration on every push');
  if (ctx.hasDocker) done.push('- [x] Containerised build');
  if (ctx.license) done.push(`- [x] Licensed under ${ctx.license}`);

  const todo: string[] = [];
  if (!ctx.license) todo.push('- [ ] Choose and commit a license');
  if (ctx.testFileCount === 0) todo.push('- [ ] Add an automated test suite');
  if (!ctx.hasCi) todo.push('- [ ] Run tests in CI on every pull request');
  if (!ctx.hasDocsDir) todo.push('- [ ] Publish reference documentation under `docs/`');
  todo.push('- [ ] Ship a documented `1.0.0` release');

  return joinBlock([
    '## Roadmap',
    '',
    ...done,
    ...todo,
    '',
    ctx.issuesUrl
      ? `Track anything larger than a checkbox as an issue at ${ctx.issuesUrl} and link it`
      : 'Track anything larger than a checkbox as an issue and link it',
    'from this list, so the roadmap never drifts away from reality.',
  ]);
}

function generateSupport(ctx: RepoContext): string {
  const bullets: string[] = [];

  bullets.push(
    ctx.issuesUrl
      ? `- **Bugs and feature requests** — open an issue: ${ctx.issuesUrl}`
      : '- **Bugs and feature requests** — open an issue in this repository.',
  );
  bullets.push(
    ctx.discussionsUrl
      ? `- **Questions and ideas** — start a discussion: ${ctx.discussionsUrl}`
      : '- **Questions and ideas** — start a discussion rather than filing a bug.',
  );
  bullets.push(
    ctx.securityUrl
      ? `- **Security reports** — do **not** open a public issue. Use the private advisory form: ${ctx.securityUrl}`
      : '- **Security reports** — do **not** open a public issue. Contact the maintainers privately.',
  );

  return joinBlock([
    '## Support',
    '',
    ...bullets,
    '',
    'Naming one channel per purpose is what keeps the issue tracker usable: it',
    'stops questions from being filed as bugs and stops vulnerabilities from being',
    'disclosed in public.',
  ]);
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Below this many words a README is a stub, not documentation. */
const MIN_USEFUL_WORDS = 100;
/** Maximum points removed for a stub-length README. */
const MAX_LENGTH_PENALTY = 18;
const BADGE_BONUS = 3;
const CODE_EXAMPLE_BONUS = 5;

/**
 * Turn section presence into a 0–100 score.
 *
 * The base is the weighted share of present sections, so the curve is linear in
 * exactly the thing being measured and trivially explainable to a user: "you
 * have 71% of the weight, you scored 71".
 *
 * Three adjustments sit on top:
 *
 * - **Length penalty (0 to −18).** Under {@link MIN_USEFUL_WORDS} words the
 *   penalty scales linearly to its maximum at zero words. This exists because
 *   section detection is *presence*-based: a README of fifteen words can tick
 *   Title, Description and License and still tell a reader nothing. There is no
 *   symmetric penalty for long READMEs — length is a weak negative signal at
 *   worst, and penalising thorough documentation would be perverse.
 * - **Badge bonus (+3).** Small on purpose: badges are a status signal, not
 *   documentation. Badges also already earn their own 0.03 section weight, so
 *   the bonus is a nudge, not a second helping.
 * - **Code example bonus (+5).** Larger than the badge bonus because a runnable
 *   example is the single strongest predictor that a reader will succeed.
 *
 * The result is clamped to 0–100, so a README with every section still lands on
 * 100 rather than 108.
 */
function scoreReadme(sections: readonly ReadmeSection[], doc: ParsedReadme): number {
  let base = 0;
  for (const section of sections) {
    if (section.present) base += section.weight;
  }

  const lengthPenalty =
    doc.wordCount >= MIN_USEFUL_WORDS
      ? 0
      : Math.round(MAX_LENGTH_PENALTY * (1 - doc.wordCount / MIN_USEFUL_WORDS));

  const bonus =
    (doc.badges.length > 0 ? BADGE_BONUS : 0) +
    (doc.codeBlocks.length > 0 ? CODE_EXAMPLE_BONUS : 0);

  return clamp(Math.round(base * 100 + bonus - lengthPenalty), 0, 100);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse the repository's root README.
 *
 * When no README exists the report is not empty: `score` is 0 and
 * `generatedSections` carries a complete starter README, already filled in with
 * this repository's name, clone URL, package manager and scripts.
 */
export function analyzeReadme(snapshot: RepoSnapshot): ReadmeReport {
  const ctx = describeRepo(snapshot);
  const file = findReadme(snapshot);

  if (!file) {
    const sections: ReadmeSection[] = SECTIONS.map((spec) => ({
      name: spec.name,
      present: false,
      weight: SECTION_WEIGHTS[spec.name],
      suggestion: spec.suggestion(ctx),
    }));

    return {
      exists: false,
      path: null,
      wordCount: 0,
      score: 0,
      sections,
      missingSections: SECTIONS.map((spec) => spec.name),
      suggestions: [
        `Create a README.md at the repository root — ${ctx.name} currently has none, so GitHub shows an empty project page.`,
        ...sections.map((section) => section.suggestion ?? ''),
      ].filter(Boolean),
      hasBadges: false,
      hasCodeExamples: false,
      hasImages: false,
      generatedSections: SECTIONS.map((spec) => ({
        name: spec.name,
        markdown: spec.generate(ctx),
      })),
    };
  }

  const doc = parseReadme(file.content ?? '');

  const sections: ReadmeSection[] = SECTIONS.map((spec) => {
    const present = hasHeading(doc, spec.synonyms) || spec.signal(doc);
    return {
      name: spec.name,
      present,
      weight: SECTION_WEIGHTS[spec.name],
      ...(present ? {} : { suggestion: spec.suggestion(ctx) }),
    };
  });

  const missing = SECTIONS.filter((_spec, index) => sections[index]?.present !== true);

  const suggestions: string[] = [];
  for (const spec of [...missing].sort(
    (a, b) => SECTION_WEIGHTS[b.name] - SECTION_WEIGHTS[a.name],
  )) {
    suggestions.push(spec.suggestion(ctx));
  }
  if (doc.wordCount < MIN_USEFUL_WORDS) {
    suggestions.push(
      `Expand the README — it is ${doc.wordCount} words, below the ${MIN_USEFUL_WORDS}-word floor where a reader can actually get started.`,
    );
  }
  if (doc.codeBlocks.length === 0) {
    suggestions.push(
      'Add at least one fenced code block — a README with no copyable command or example forces every reader to guess.',
    );
  }
  if (doc.badges.length === 0) {
    suggestions.push(
      'Add status badges (build, coverage, licence) directly under the title so the project state is visible without scrolling.',
    );
  }

  return {
    exists: true,
    path: file.path,
    wordCount: doc.wordCount,
    score: scoreReadme(sections, doc),
    sections,
    missingSections: missing.map((spec) => spec.name),
    suggestions,
    hasBadges: doc.badges.length > 0,
    hasCodeExamples: doc.codeBlocks.length > 0,
    hasImages: doc.images.length > 0,
    generatedSections: missing.map((spec) => ({
      name: spec.name,
      markdown: spec.generate(ctx),
    })),
  };
}
