/**
 * Specifier resolution.
 *
 * The single question this module answers is: *does this import point at a file
 * inside the repository, and if so which one?* A `null` answer means "external"
 * — a package, a runtime built-in, or something we cannot see — and the graph
 * builder turns those into `ExternalImport` rows instead of edges.
 *
 * Resolution is done purely against the set of paths in the snapshot. We never
 * touch a filesystem, and we never guess at files we cannot see: if the target
 * is not in the snapshot the answer is `null`. That is the honest answer for a
 * truncated ingest too, and it keeps the graph free of phantom nodes.
 *
 * The rules mirror what each toolchain actually does, in the order it does it:
 * exact path, then extension inference, then directory index files. Getting the
 * *order* right matters — Node resolves `./utils` to `utils.ts` in preference to
 * `utils/index.ts`, and inverting that silently rewires the graph.
 */

import {
  ancestors,
  basename,
  dirname,
  joinPath,
  normalizePath,
  resolveRelative,
} from '../shared/paths';
import { extensionOf } from '../shared/languages';

/** Extensions tried when a specifier omits one, in resolution priority order. */
const CANDIDATE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.py',
  '.go',
  '.rs',
  // Trailing entries: only reachable when nothing above matched, which keeps a
  // JavaScript `./foo` from ever binding to a same-named Ruby file.
  '.rb',
  '.php',
];

/** Files that make a directory importable by its own name. */
const INDEX_FILES: readonly string[] = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  '__init__.py',
  'mod.rs',
];

/**
 * TypeScript's ESM output keeps the `.js` specifier the author wrote even though
 * the source file is `.ts`. Without this rewrite every `./x.js` import in a
 * modern TS codebase would look external.
 */
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

interface AliasRule {
  /** Text before the `*`, or the whole pattern for an exact alias. */
  readonly prefix: string;
  /** Target prefixes, repo-relative, `*` already stripped. */
  readonly targets: readonly string[];
  readonly wildcard: boolean;
}

/**
 * Build a resolver closed over one snapshot's file list.
 *
 * Returned as a closure rather than a class because callers use it in a hot
 * loop, one call per import, and the precomputed indexes must be shared.
 */
export function createResolver(
  paths: readonly string[],
  tsconfigAliases?: Readonly<Record<string, readonly string[]>>,
): (fromFile: string, specifier: string) => string | null {
  const files = new Set(paths);
  const rules = compileAliases(tsconfigAliases ?? {});

  // Go imports name a *package*, which is a directory, so Go needs a directory
  // index that the other languages do not.
  const goFilesByDir = new Map<string, string[]>();
  for (const path of paths) {
    if (!path.endsWith('.go') || path.endsWith('_test.go')) continue;
    const dir = dirname(path);
    const bucket = goFilesByDir.get(dir);
    if (bucket) bucket.push(path);
    else goFilesByDir.set(dir, [path]);
  }
  for (const bucket of goFilesByDir.values()) bucket.sort();

  /** Exact file, then extension inference, then directory index. */
  const tryFile = (base: string): string | null => {
    if (!base) return null;
    if (files.has(base)) return base;

    for (const ext of CANDIDATE_EXTENSIONS) {
      if (files.has(base + ext)) return base + ext;
    }

    const currentExt = `.${extensionOf(base)}`;
    const rewrites = JS_TO_TS[currentExt];
    if (rewrites) {
      const stemPath = base.slice(0, base.length - currentExt.length);
      for (const ext of rewrites) {
        if (files.has(stemPath + ext)) return stemPath + ext;
      }
    }

    for (const index of INDEX_FILES) {
      const candidate = `${base}/${index}`;
      if (files.has(candidate)) return candidate;
    }

    return null;
  };

  const tryAlias = (specifier: string): string | null => {
    for (const rule of rules) {
      if (rule.wildcard) {
        if (!specifier.startsWith(rule.prefix)) continue;
        const rest = specifier.slice(rule.prefix.length);
        for (const target of rule.targets) {
          const hit = tryFile(normalizePath(target + rest));
          if (hit) return hit;
        }
      } else if (specifier === rule.prefix) {
        for (const target of rule.targets) {
          const hit = tryFile(normalizePath(target));
          if (hit) return hit;
        }
      }
    }
    return null;
  };

  const tryPython = (base: string): string | null => {
    if (!base) return null;
    for (const suffix of ['.py', '.pyi', '/__init__.py', '/__init__.pyi']) {
      if (files.has(base + suffix)) return base + suffix;
    }
    return null;
  };

  const resolvePython = (fromFile: string, specifier: string): string | null => {
    const dots = /^\.*/.exec(specifier)?.[0].length ?? 0;

    if (dots > 0) {
      // One dot is the current package, each extra dot walks one level up.
      let base = dirname(fromFile);
      for (let level = 1; level < dots; level++) base = dirname(base);
      const rest = specifier.slice(dots).split('.').filter(Boolean);
      return tryPython(joinPath(base, ...rest));
    }

    // Absolute Python imports are relative to *a* source root, and the repo may
    // put that root anywhere (`.`, `src/`, `backend/`). Try the repo root first,
    // then every ancestor of the importing file, shallowest first.
    const segments = specifier.split('.').filter(Boolean);
    if (segments.length === 0) return null;

    for (const root of ['', ...ancestors(fromFile)]) {
      const hit = tryPython(joinPath(root, ...segments));
      if (hit) return hit;
    }
    return null;
  };

  const resolveGo = (specifier: string): string | null => {
    // A Go import path is prefixed with the module path from `go.mod`, which we
    // do not parse. Matching the longest *suffix* that names a real package
    // directory handles `github.com/acme/demo/internal/store` without it.
    const segments = specifier.split('/').filter(Boolean);
    for (let start = 0; start < segments.length; start++) {
      const dir = segments.slice(start).join('/');
      const bucket = goFilesByDir.get(dir);
      const representative = bucket?.[0];
      if (representative) return representative;
    }
    return null;
  };

  const resolveRust = (fromFile: string, specifier: string): string | null => {
    const segments = specifier.split('::').filter(Boolean);
    const head = segments[0];
    if (head === undefined) return null;

    // `mod x;` arrives here as a bare identifier. A module declared inside
    // `foo.rs` lives in `foo/`, so both siblings are candidates.
    if (segments.length === 1 && head !== 'crate' && head !== 'self' && head !== 'super') {
      const dir = dirname(fromFile);
      const own = joinPath(dir, basename(fromFile).replace(/\.rs$/, ''));
      return tryRustModule(files, joinPath(dir, head)) ?? tryRustModule(files, joinPath(own, head));
    }

    let base: string;
    let rest: string[];

    if (head === 'crate') {
      base = crateRoot(files, fromFile);
      rest = segments.slice(1);
    } else if (head === 'self') {
      base = dirname(fromFile);
      rest = segments.slice(1);
    } else if (head === 'super') {
      base = dirname(dirname(fromFile));
      rest = segments.slice(1);
    } else {
      // `std::`, `serde::` and friends: an external crate.
      return null;
    }

    // The final segment is often an *item* (a struct or function) rather than a
    // module, so try the full path and then the path without its last segment.
    for (let drop = 0; drop <= 1 && rest.length - drop > 0; drop++) {
      const hit = tryRustModule(files, joinPath(base, ...rest.slice(0, rest.length - drop)));
      if (hit) return hit;
    }
    return tryRustModule(files, base);
  };

  return (fromFile: string, specifier: string): string | null => {
    if (!specifier) return null;

    const ext = extensionOf(fromFile);

    if (ext === 'py' || ext === 'pyi') return resolvePython(fromFile, specifier);
    if (ext === 'go') return resolveGo(specifier);
    if (ext === 'rs') return resolveRust(fromFile, specifier);

    if (isRelativeSpecifier(specifier)) {
      return tryFile(resolveRelative(fromFile, specifier));
    }

    const aliased = tryAlias(specifier);
    if (aliased) return aliased;

    // Ruby's `require_relative 'x'` and PHP's `include 'lib/x.php'` are written
    // without a leading `./`, so a directory-relative attempt is required.
    if (ext === 'rb' || ext === 'php') {
      const sibling = tryFile(joinPath(dirname(fromFile), specifier));
      if (sibling) return sibling;
    }

    // `baseUrl`-style root-relative imports (`import x from 'src/lib/x'`). Only
    // multi-segment specifiers qualify: a single bare word is overwhelmingly a
    // package name, and matching it against a same-named directory would invent
    // edges that do not exist.
    if (specifier.includes('/') && !specifier.startsWith('@')) {
      const fromRoot = tryFile(normalizePath(specifier));
      if (fromRoot) return fromRoot;
    }

    return null;
  };
}

/** True for `./x`, `../x`, `.` and `..`. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || /^\.\.?\//.test(specifier);
}

function tryRustModule(files: ReadonlySet<string>, base: string): string | null {
  if (!base) return null;
  if (files.has(`${base}.rs`)) return `${base}.rs`;
  if (files.has(`${base}/mod.rs`)) return `${base}/mod.rs`;
  return null;
}

/**
 * Directory that `crate::` refers to: the nearest ancestor holding `main.rs` or
 * `lib.rs`, falling back to the outermost `src/` on the path.
 */
function crateRoot(files: ReadonlySet<string>, fromFile: string): string {
  const chain = ancestors(fromFile);
  for (let i = chain.length - 1; i >= 0; i--) {
    const dir = chain[i];
    if (dir === undefined) continue;
    if (files.has(`${dir}/main.rs`) || files.has(`${dir}/lib.rs`)) return dir;
  }
  for (const dir of chain) {
    if (basename(dir) === 'src') return dir;
  }
  return chain[0] ?? '';
}

function compileAliases(aliases: Readonly<Record<string, readonly string[]>>): AliasRule[] {
  const rules: AliasRule[] = [];

  for (const [pattern, targets] of Object.entries(aliases)) {
    const star = pattern.indexOf('*');
    const wildcard = star !== -1;
    const prefix = wildcard ? pattern.slice(0, star) : pattern;

    const normalizedTargets = targets
      .map((target) => {
        const targetStar = target.indexOf('*');
        const head = targetStar === -1 ? target : target.slice(0, targetStar);
        return head.replace(/^\.\//, '');
      })
      // A wildcard target may legitimately be empty (`"@/*": ["./*"]` maps to
      // the repository root); an exact alias pointing nowhere is meaningless.
      .filter((target) => wildcard || target.length > 0);

    if (normalizedTargets.length === 0) continue;
    rules.push({ prefix, targets: normalizedTargets, wildcard });
  }

  // Longest prefix first: `@/components/*` must beat `@/*`.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  return rules;
}

// ---------------------------------------------------------------------------
// tsconfig parsing
// ---------------------------------------------------------------------------

/**
 * Read `compilerOptions.paths` out of a tsconfig, tolerating JSONC.
 *
 * `tsconfig.json` is JSON *with comments and trailing commas* — `JSON.parse`
 * rejects the majority of real-world tsconfigs. Rather than take a dependency
 * on a JSONC parser we strip the two extensions with a scanner that understands
 * string literals, so a `//` inside a path value survives.
 *
 * Returns `{}` on any malformed input: a broken tsconfig should degrade the
 * graph's alias support, never fail the analysis.
 */
export function parseTsconfigAliases(tsconfigContent: string): Record<string, string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(tsconfigContent));
  } catch {
    return {};
  }

  const compilerOptions = readObject(parsed, 'compilerOptions');
  const paths = readObject(compilerOptions, 'paths');
  if (!paths) return {};

  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(paths)) {
    if (!Array.isArray(value)) continue;
    const targets = value.filter((entry): entry is string => typeof entry === 'string');
    if (targets.length > 0) out[key] = targets;
  }
  return out;
}

function readObject(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return null;
  return child as Record<string, unknown>;
}

/** Remove `//` and block comments plus trailing commas, preserving strings. */
function stripJsonc(content: string): string {
  const chars = content.split('');
  let i = 0;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < chars.length; k++) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
  };

  while (i < content.length) {
    const ch = content.charAt(i);

    if (ch === '"') {
      i++;
      while (i < content.length) {
        const c = content.charAt(i);
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (content.startsWith('//', i)) {
      const eol = content.indexOf('\n', i);
      const end = eol === -1 ? content.length : eol;
      blank(i, end);
      i = end;
      continue;
    }

    if (content.startsWith('/*', i)) {
      const close = content.indexOf('*/', i + 2);
      const end = close === -1 ? content.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }

    i++;
  }

  return chars.join('').replace(/,(\s*[}\]])/g, '$1');
}
