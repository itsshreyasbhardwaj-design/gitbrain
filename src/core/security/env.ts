/**
 * Environment-variable usage and documentation coverage.
 *
 * The question this answers is the one that breaks every first deployment:
 * *which variables does this code read that nobody wrote down?* Answering it
 * needs both halves — a usage scan across ten ecosystems' accessor syntaxes, and
 * a documentation scan across the places teams actually record them.
 *
 * Two deliberate choices:
 *
 * - **Documentation files are not scanned for usage.** A variable mentioned only
 *   in a README is documented, not used, and counting the README as a "usage
 *   site" would make every documented variable look like a code reference.
 *
 * - **`NODE_ENV` is excluded outright.** It is set by the toolchain everywhere,
 *   documented nowhere, and reporting it as undocumented in every JavaScript
 *   repository would train readers to skim past this section.
 */

import type { EnvVarUsage, RepoSnapshot } from '../types';
import { isDocumentationFile, isGeneratedFile, isTestFile, isVendored } from '../shared/classify';
import { basename } from '../shared/paths';
import { toLines } from '../shared/text';

/** Accessor syntaxes, one per ecosystem. Group 1 is always the variable name. */
const USAGE_PATTERNS: readonly RegExp[] = [
  // JavaScript / TypeScript
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bprocess\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bDeno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  // Python
  /\bos\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\bos\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /\bos\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  // Ruby
  /\bENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\bENV\.fetch\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  // Java / Kotlin / Scala
  /\bSystem\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  // Rust
  /\bstd::env::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  // Go
  /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  // PHP
  /\$_ENV\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\$_SERVER\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /\bgetenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
];

/** `${VAR}`, `${VAR:-default}`, `${VAR?error}` inside Compose files and Dockerfiles. */
const SHELL_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?+][^}]*)?\}/g;

/** `ENV KEY=value` / `ARG KEY=value` declarations in a Dockerfile. */
const DOCKERFILE_DECLARATION = /^\s*(?:ENV|ARG)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[= ]/gim;

/** `KEY=value`, optionally exported and optionally commented out, in an env template. */
const TEMPLATE_ASSIGNMENT = /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Set by tooling everywhere, documented nowhere. Reporting it is pure noise. */
const IGNORED_NAMES = new Set(['NODE_ENV']);

/**
 * Supplied by the runtime, the platform or the CI provider.
 *
 * These are still *listed* — "this service reads `PORT`" is useful to know —
 * but they are never counted as undocumented, because there is nothing for a
 * contributor to put in `.env.example`. Hosting platforms inject them, and
 * code that reads them almost always supplies a default.
 */
const PLATFORM_PROVIDED = new Set([
  'CI',
  'PORT',
  'HOME',
  'PATH',
  'PWD',
  'TZ',
  'LANG',
  'TERM',
  'USER',
  'SHELL',
  'TMPDIR',
  'HOSTNAME',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'VERCEL_REGION',
  'NEXT_RUNTIME',
  'GITHUB_ACTIONS',
  'GITHUB_TOKEN',
  'RAILWAY_ENVIRONMENT',
  'RENDER',
  'DYNO',
  'AWS_REGION',
  'AWS_LAMBDA_FUNCTION_NAME',
]);

function isEnvTemplate(path: string): boolean {
  const base = basename(path).toLowerCase();
  return (
    base === '.env.example' ||
    base === '.env.sample' ||
    base === '.env.template' ||
    base === '.env.defaults' ||
    base === '.env.default' ||
    base === 'env.example' ||
    base === 'env.sample' ||
    base === 'env.template'
  );
}

function isComposeFile(path: string): boolean {
  const base = basename(path).toLowerCase();
  return /^(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/.test(base);
}

function isDockerfile(path: string): boolean {
  const base = basename(path).toLowerCase();
  return base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile');
}

function isReadme(path: string): boolean {
  return /^readme(\.|$)/i.test(basename(path));
}

/**
 * Collect every environment variable the code reads, and whether it is written
 * down anywhere a new contributor would look.
 */
export function analyzeEnvVars(snapshot: RepoSnapshot): {
  envVars: EnvVarUsage[];
  undocumented: string[];
} {
  const usage = new Map<string, Set<string>>();
  const documented = new Set<string>();

  const record = (name: string, path: string): void => {
    if (IGNORED_NAMES.has(name)) return;
    // A single-character name is never a real variable. It comes from prose:
    // documentation and comments explaining the patterns themselves write
    // `process.env.X` as a stand-in, and the scanner would otherwise report
    // "X" as configuration a contributor has to supply.
    if (name.length < 2) return;
    const files = usage.get(name);
    if (files) files.add(path);
    else usage.set(name, new Set([path]));
  };

  for (const file of snapshot.files) {
    if (file.isBinary || file.content === null) continue;
    if (isVendored(file.path) || isGeneratedFile(file.path, file.content)) continue;

    const content = file.content;

    // --- documentation sources ---
    if (isEnvTemplate(file.path)) {
      for (const line of toLines(content)) {
        const match = TEMPLATE_ASSIGNMENT.exec(line);
        if (match?.[1]) documented.add(match[1]);
      }
      continue; // A template documents; it does not use.
    }

    if (isReadme(file.path)) {
      for (const name of readmeMentions(content)) documented.add(name);
    }

    if (isComposeFile(file.path)) {
      for (const name of composeEnvironmentKeys(content)) documented.add(name);
    }

    if (isDockerfile(file.path)) {
      for (const match of content.matchAll(DOCKERFILE_DECLARATION)) {
        if (match[1]) documented.add(match[1]);
      }
    }

    // --- usage sources ---
    if (isDocumentationFile(file.path)) continue;

    for (const pattern of USAGE_PATTERNS) {
      for (const match of content.matchAll(pattern)) {
        if (match[1]) record(match[1], file.path);
      }
    }

    if (isComposeFile(file.path) || isDockerfile(file.path)) {
      for (const match of content.matchAll(SHELL_INTERPOLATION)) {
        if (match[1]) record(match[1], file.path);
      }
    }
  }

  const envVars: EnvVarUsage[] = [...usage.entries()]
    .map(([name, files]) => ({
      name,
      files: [...files].sort(),
      documented: documented.has(name),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    envVars,
    // Two exclusions, both about actionability rather than detection:
    //
    // - A variable referenced ONLY from test files is not project config. Test
    //   suites routinely stub `DATABASE_URL` to exercise a branch; demanding it
    //   appear in `.env.example` sends a contributor hunting for a setting that
    //   does not exist.
    // - Platform-provided variables have nothing for anyone to configure.
    //
    // Both remain in `envVars`, with their usage sites. They are simply not on
    // the "you must set this before the app runs" list.
    undocumented: envVars
      .filter(
        (entry) =>
          !entry.documented && !PLATFORM_PROVIDED.has(entry.name) && !entry.files.every(isTestFile),
      )
      .map((entry) => entry.name),
  };
}

/**
 * Variable names a README plausibly documents.
 *
 * Matching every uppercase word would let prose like "the API returns JSON"
 * document a variable named `API`. Requiring an underscore or a digit, or a
 * `KEY=`/`KEY:` shape, keeps this to things that actually look like env names.
 */
function readmeMentions(content: string): string[] {
  const names = new Set<string>();

  for (const match of content.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of content.matchAll(/^\s*(?:[-*]\s*)?`?([A-Z][A-Z0-9_]{2,})`?\s*[=:]/gm)) {
    if (match[1]) names.add(match[1]);
  }

  return [...names];
}

/**
 * Keys declared in a Compose `environment:` block.
 *
 * Handles the mapping form (`KEY: value`), the list form (`- KEY=value`) and the
 * pass-through form (`- KEY`). The block ends at the first line indented no
 * further than `environment:` itself, which is how YAML nesting works and is
 * enough without pulling in a parser.
 */
function composeEnvironmentKeys(content: string): string[] {
  const names = new Set<string>();
  const lines = toLines(content);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const header = /^(\s*)environment:\s*(\[.*\])?\s*$/.exec(line);
    if (!header) continue;

    // Inline flow sequence: `environment: [FOO=bar, BAZ]`.
    const inline = header[2];
    if (inline) {
      for (const entry of inline.slice(1, -1).split(',')) {
        const name = /^\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/.exec(entry)?.[1];
        if (name) names.add(name);
      }
      continue;
    }

    const baseIndent = (header[1] ?? '').length;
    for (let j = i + 1; j < lines.length; j++) {
      const entry = lines[j] ?? '';
      if (entry.trim() === '') continue;

      const indent = entry.length - entry.trimStart().length;
      if (indent <= baseIndent) break;

      const name = /^\s*(?:-\s*)?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*[:=]?/.exec(entry)?.[1];
      if (name) names.add(name);
    }
  }

  return [...names];
}
