/**
 * Entry-point discovery.
 *
 * "Where do I start reading?" is the first question anyone asks of an
 * unfamiliar repository, and it is the one question a file tree cannot answer.
 * The list this module produces is ordered by that question, not by path or by
 * confidence: the file a newcomer should open first comes first.
 *
 * Two rules keep the list honest.
 *
 * **Declared beats conventional.** A `bin` field or a Dockerfile `CMD` is the
 * repository stating its own entry point. `src/index.ts` is a convention that
 * is usually right — hence `medium`, not `high`.
 *
 * **A cited path must exist.** Manifests routinely point at build output
 * (`dist/index.js`) that no snapshot contains, because ingestion ignores build
 * directories. Rather than emit a path the reader cannot open, the declaration
 * is reported against the manifest that made it, with the declared target named
 * in the reason. The citation stays clickable and the claim stays true.
 */

import type { EntryPoint, RepoFile, RepoSnapshot, StackDetection } from '../types';
import { basename, dirname, normalizePath } from '../shared/paths';
import { squish, toLines, truncate } from '../shared/text';
import { isVendored } from '../shared/classify';

interface Draft {
  readonly path: string;
  readonly reason: string;
  readonly kind: EntryPoint['kind'];
  readonly confidence: EntryPoint['confidence'];
}

/**
 * Find and rank the repository's entry points.
 *
 * `stack` is consulted rather than re-derived: whether `app/page.tsx` is a
 * Next.js route or an incidental file named `page.tsx` is exactly the question
 * the framework detector already answered, and asking it twice invites the two
 * answers to disagree.
 */
export function findEntryPoints(snapshot: RepoSnapshot, stack: StackDetection): EntryPoint[] {
  const files = snapshot.files.filter((file) => !isVendored(file.path));
  const paths = new Set(files.map((file) => file.path));
  const drafts: Draft[] = [];

  const pkg = rootPackageJson(files);
  const hasFramework = (name: string): boolean =>
    stack.frameworks.some((detection) => detection.name === name);

  // 1. Framework application shells. These are the files that define what the
  //    user sees, so they lead the list whenever a framework confirms them.
  collectNextEntries(files, drafts, hasFramework('Next.js'));

  // 2. The command that actually starts the thing.
  if (pkg) collectStartScript(pkg, paths, drafts);

  // 3. Executables the package installs onto a user's PATH. Promoted above the
  //    application shell for a repo the architecture detector calls a CLI.
  if (pkg) collectBinEntries(pkg, paths, drafts, stack.architecture.style === 'cli');

  // 4. Conventional program bootstraps, per ecosystem.
  collectConventionalEntries(files, paths, drafts);

  // 5. Declared library surface: what consumers import.
  if (pkg) collectLibraryEntries(pkg, paths, drafts, stack.architecture.style === 'library');

  // 6. How the container starts, and how the project builds.
  collectDockerEntries(files, paths, drafts);
  collectMakefileEntries(files, drafts);

  return rank(drafts, stack);
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

interface RootPackage {
  readonly path: string;
  readonly json: Record<string, unknown>;
}

function rootPackageJson(files: readonly RepoFile[]): RootPackage | null {
  const candidates = files
    .filter((file) => basename(file.path) === 'package.json')
    .sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
    );

  for (const file of candidates) {
    const json = readJson(file);
    if (json) return { path: file.path, json };
  }

  return null;
}

/**
 * `scripts.start` names the production process.
 *
 * The script is a shell command, so the referenced file is recovered by looking
 * for the first token that looks like a path. `next start` and `nest start`
 * name no file at all, which is itself informative and reported against the
 * manifest.
 */
function collectStartScript(pkg: RootPackage, paths: ReadonlySet<string>, out: Draft[]): void {
  const scripts = asRecord(pkg.json['scripts']);
  const start = scripts?.['start'];
  if (typeof start !== 'string' || !start.trim()) return;

  const resolved = resolveDeclared(start, pkg.path, paths);

  out.push({
    path: resolved ?? pkg.path,
    reason: resolved
      ? `package.json \`scripts.start\` runs \`${truncate(squish(start), 60)}\``
      : `package.json \`scripts.start\`: \`${truncate(squish(start), 60)}\``,
    kind: 'server',
    confidence: 'high',
  });
}

function collectBinEntries(
  pkg: RootPackage,
  paths: ReadonlySet<string>,
  out: Draft[],
  promote: boolean,
): void {
  const bin = pkg.json['bin'];
  if (bin === undefined) return;

  // `bin` is either a bare string (the package name is the command) or a map of
  // command name to script. Both forms are common enough to handle.
  const entries: [string, unknown][] =
    typeof bin === 'string'
      ? [[stringOr(pkg.json['name'], 'cli'), bin]]
      : Object.entries(asRecord(bin) ?? {});

  for (const [command, target] of entries) {
    if (typeof target !== 'string') continue;
    const resolved = resolveDeclared(target, pkg.path, paths);

    out.push({
      path: resolved ?? pkg.path,
      reason: resolved
        ? `package.json \`bin\` installs it as \`${command}\``
        : `package.json \`bin.${command}\` points to ${target}`,
      kind: 'cli',
      confidence: promote ? 'high' : 'medium',
    });
  }
}

const LIBRARY_FIELDS = ['exports', 'main', 'module'] as const;

function collectLibraryEntries(
  pkg: RootPackage,
  paths: ReadonlySet<string>,
  out: Draft[],
  promote: boolean,
): void {
  for (const field of LIBRARY_FIELDS) {
    const value = pkg.json[field];
    const target = field === 'exports' ? firstExportTarget(value) : stringOrNull(value);
    if (!target) continue;

    const resolved = resolveDeclared(target, pkg.path, paths);

    out.push({
      path: resolved ?? pkg.path,
      reason: `package.json \`${field}\` field${resolved ? '' : ` points to ${target}`}`,
      kind: 'library',
      confidence: promote ? 'high' : 'medium',
    });
  }
}

/**
 * The first concrete target in an `exports` map.
 *
 * `exports` is a nested tree of conditions (`import`, `require`, `types`, …)
 * that all resolve to the same module in the overwhelming majority of
 * packages, so the first string found is representative. A depth limit keeps a
 * pathological manifest from driving unbounded recursion.
 */
function firstExportTarget(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') return value;
  if (depth > 4) return null;

  const record = asRecord(value);
  if (!record) return null;

  for (const nested of Object.values(record)) {
    const found = firstExportTarget(nested, depth + 1);
    if (found) return found;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Framework and convention entries
// ---------------------------------------------------------------------------

const NEXT_LAYOUT = /(^|\/)app\/layout\.[jt]sx?$/;
const NEXT_PAGE = /(^|\/)app\/page\.[jt]sx?$/;

/**
 * Next.js App Router roots.
 *
 * `app/layout.tsx` outranks `app/page.tsx`: the layout wraps every route and
 * holds the providers, fonts and metadata, so it explains more of the
 * application than the home page does.
 */
function collectNextEntries(files: readonly RepoFile[], out: Draft[], confirmed: boolean): void {
  const confidence: EntryPoint['confidence'] = confirmed ? 'high' : 'medium';

  const layout = files.find((file) => NEXT_LAYOUT.test(file.path));
  if (layout) {
    out.push({
      path: layout.path,
      reason: 'Next.js App Router root layout',
      kind: 'app',
      confidence,
    });
  }

  const page = files.find((file) => NEXT_PAGE.test(file.path));
  if (page) {
    out.push({
      path: page.path,
      reason: 'Next.js App Router home page',
      kind: 'app',
      confidence,
    });
  }
}

interface ConventionRule {
  readonly pattern: RegExp;
  readonly reason: string;
  readonly kind: EntryPoint['kind'];
  readonly confidence: EntryPoint['confidence'];
}

/**
 * Per-ecosystem bootstrap conventions.
 *
 * `main` and `index` are deliberately given different kinds. A `main.*` is a
 * program that starts something; an `index.*` is a barrel that re-exports a
 * module's public surface. Conflating them would tell a reader to start at the
 * wrong file in roughly half of all repositories.
 */
const CONVENTION_RULES: readonly ConventionRule[] = [
  {
    pattern: /^src\/main\.[cm]?[jt]sx?$/,
    reason: 'conventional application bootstrap',
    kind: 'app',
    confidence: 'medium',
  },
  {
    pattern: /^src\/server\.[cm]?[jt]s$/,
    reason: 'conventional server bootstrap',
    kind: 'server',
    confidence: 'medium',
  },
  {
    pattern: /^src\/index\.[cm]?[jt]sx?$/,
    reason: 'conventional module entry point',
    kind: 'library',
    confidence: 'medium',
  },
  {
    pattern: /^index\.[cm]?[jt]sx?$/,
    reason: 'conventional module entry point at the repository root',
    kind: 'library',
    confidence: 'medium',
  },
  {
    pattern: /(^|\/)manage\.py$/,
    reason: 'Django management command entry point',
    kind: 'cli',
    confidence: 'high',
  },
  {
    pattern: /(^|\/)__main__\.py$/,
    reason: 'Python package executed with `python -m`',
    kind: 'cli',
    confidence: 'high',
  },
  {
    pattern: /(^|\/)(wsgi|asgi)\.py$/,
    reason: 'WSGI/ASGI application object served in production',
    kind: 'server',
    confidence: 'high',
  },
  {
    pattern: /(^|\/)main\.py$/,
    reason: 'conventional Python application bootstrap',
    kind: 'app',
    confidence: 'medium',
  },
  {
    pattern: /^cmd\/[^/]+\/main\.go$/,
    reason: 'Go `cmd/` executable package',
    kind: 'cli',
    confidence: 'high',
  },
  {
    pattern: /(^|\/)main\.go$/,
    reason: 'Go `main` package',
    kind: 'app',
    confidence: 'medium',
  },
  {
    pattern: /^src\/bin\/[^/]+\.rs$/,
    reason: 'Cargo binary target',
    kind: 'cli',
    confidence: 'high',
  },
  {
    pattern: /^src\/main\.rs$/,
    reason: 'Cargo default binary target',
    kind: 'app',
    confidence: 'high',
  },
];

/**
 * Apply the convention rules, most specific first.
 *
 * A file can satisfy several rules — `cmd/server/main.go` is both a Go `cmd/`
 * executable and a `main` package — and the first rule to claim it wins.
 * Without that, the generic rule's kind would sometimes outrank the specific
 * one during sorting and the file would be described by the vaguer of two true
 * statements.
 */
function collectConventionalEntries(
  files: readonly RepoFile[],
  paths: ReadonlySet<string>,
  out: Draft[],
): void {
  const claimed = new Set<string>();

  for (const rule of CONVENTION_RULES) {
    for (const file of files) {
      if (!rule.pattern.test(file.path)) continue;
      if (!paths.has(file.path) || claimed.has(file.path)) continue;
      claimed.add(file.path);
      out.push({
        path: file.path,
        reason: rule.reason,
        kind: rule.kind,
        confidence: rule.confidence,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Dockerfile and Makefile
// ---------------------------------------------------------------------------

const DOCKER_START = /^\s*(CMD|ENTRYPOINT)\s+(.+)$/i;

/**
 * The container's start command.
 *
 * The *last* `CMD`/`ENTRYPOINT` wins, matching Docker's own semantics for
 * multi-stage builds where earlier stages set their own. Both the JSON-array
 * (`CMD ["node", "server.js"]`) and shell (`CMD node server.js`) forms appear
 * in the wild, so the argument list is scanned for the first token that looks
 * like a file rather than parsed as one syntax.
 */
function collectDockerEntries(
  files: readonly RepoFile[],
  paths: ReadonlySet<string>,
  out: Draft[],
): void {
  for (const file of files) {
    if (!/(^|\/)Dockerfile[^/]*$/.test(file.path) || file.content === null) continue;

    let command: string | null = null;
    let directive = 'CMD';

    for (const line of toLines(file.content)) {
      const match = DOCKER_START.exec(line);
      if (!match?.[2]) continue;
      directive = (match[1] ?? 'CMD').toUpperCase();
      command = match[2].trim();
    }

    if (!command) continue;

    const target = firstPathLikeToken(command);
    const resolved = target ? resolveDeclared(target, file.path, paths) : null;

    // When the command resolves to a file in the repository it *is* the server
    // entry point. When it does not — `CMD ["/app/server"]` naming a compiled
    // binary, or `next start` naming no file at all — the only citable thing is
    // the Dockerfile, which documents how the image runs rather than where the
    // program begins. Calling that `build` keeps it below real code entries in
    // the ordering instead of pushing the actual `main.go` down the list.
    out.push({
      path: resolved ?? file.path,
      reason: `Dockerfile ${directive} \`${truncate(squish(command), 60)}\``,
      kind: resolved ? 'server' : 'build',
      confidence: resolved ? 'medium' : 'high',
    });
  }
}

const MAKE_TARGET = /^([A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*:(?!=)/;

/**
 * A Makefile's default goal — what bare `make` does.
 *
 * GNU Make uses the first target in the file unless `.DEFAULT_GOAL` overrides
 * it, so both are checked and the explicit override wins. Special targets
 * (`.PHONY`, `.SUFFIXES`) are skipped because they configure Make rather than
 * building anything.
 */
function collectMakefileEntries(files: readonly RepoFile[], out: Draft[]): void {
  for (const file of files) {
    if (basename(file.path).toLowerCase() !== 'makefile' || file.content === null) continue;

    const override = /^\s*\.DEFAULT_GOAL\s*:?=\s*(\S+)/m.exec(file.content)?.[1];
    let target = override ?? null;

    if (!target) {
      for (const line of toLines(file.content)) {
        if (line.startsWith('\t') || line.startsWith('.')) continue;
        const match = MAKE_TARGET.exec(line);
        if (match?.[1]) {
          target = match[1];
          break;
        }
      }
    }

    if (!target) continue;

    out.push({
      path: file.path,
      reason: `Makefile default target \`${target}\``,
      kind: 'build',
      confidence: override ? 'high' : 'medium',
    });
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Importance order for the kinds.
 *
 * An application shell explains the most to a newcomer, a server explains how
 * it runs, a CLI explains how it is invoked, and build/config files explain the
 * scaffolding — useful, but never the thing to read first.
 */
const KIND_RANK: Readonly<Record<EntryPoint['kind'], number>> = {
  app: 0,
  server: 1,
  cli: 2,
  library: 3,
  build: 4,
  test: 5,
  config: 6,
};

const CONFIDENCE_RANK: Readonly<Record<EntryPoint['confidence'], number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Order the drafts and collapse duplicates.
 *
 * Deduplication is by path and keeps the first draft, so a file discovered both
 * as a declared `bin` and as a conventional `src/index.ts` keeps the declared
 * reason — the stronger claim. Sorting happens before deduplication so that
 * "first" means "highest ranked", not "first emitted".
 *
 * A repository whose architecture is a library inverts the top of the order:
 * for a package nobody runs, the exported surface *is* the entry point.
 */
function rank(drafts: readonly Draft[], stack: StackDetection): EntryPoint[] {
  const libraryFirst = stack.architecture.style === 'library';

  const scored = drafts.map((draft, index) => ({
    draft,
    index,
    score:
      (libraryFirst && draft.kind === 'library' ? -1 : KIND_RANK[draft.kind]) * 10 +
      CONFIDENCE_RANK[draft.confidence],
  }));

  scored.sort((a, b) => a.score - b.score || a.index - b.index);

  const seen = new Set<string>();
  const out: EntryPoint[] = [];

  for (const { draft } of scored) {
    if (seen.has(draft.path)) continue;
    seen.add(draft.path);
    out.push({
      path: draft.path,
      reason: draft.reason,
      kind: draft.kind,
      confidence: draft.confidence,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a manifest-declared target to a path that exists in the snapshot.
 *
 * Targets are written relative to the manifest, so a nested workspace manifest
 * resolves against its own directory. `./` prefixes and `node`/`python`
 * launcher prefixes are stripped by the caller.
 */
function resolveDeclared(
  declared: string,
  manifestPath: string,
  paths: ReadonlySet<string>,
): string | null {
  const token = firstPathLikeToken(declared) ?? declared.trim();
  if (!token) return null;

  const base = dirname(manifestPath);
  const candidate = normalizePath(base ? `${base}/${token}` : token);

  if (paths.has(candidate)) return candidate;
  if (paths.has(token)) return token;

  return null;
}

const LAUNCHERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'npx',
  'pnpm',
  'yarn',
  'npm',
  'ts-node',
  'tsx',
  'run',
  'exec',
  'sh',
  '-c',
]);

/**
 * The first argument in a command line that names a file.
 *
 * Flags, launchers and bare subcommands are skipped. Requiring either a dot or
 * a slash is what separates `server.js` and `./bin/cli` from `start`, `build`
 * and other subcommand words that name no file at all.
 */
function firstPathLikeToken(command: string): string | null {
  const cleaned = command.replace(/[[\]",]/g, ' ');

  for (const raw of cleaned.split(/\s+/)) {
    const token = raw.trim();
    if (!token || token.startsWith('-')) continue;
    if (LAUNCHERS.has(token)) continue;
    if (!token.includes('.') && !token.includes('/')) continue;
    return token.replace(/^\.\//, '');
  }

  return null;
}

function readJson(file: RepoFile): Record<string, unknown> | null {
  if (file.content === null) return null;
  try {
    return asRecord(JSON.parse(file.content) as unknown);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
  return stringOrNull(value) ?? fallback;
}
