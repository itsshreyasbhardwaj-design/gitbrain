/**
 * POSIX path helpers.
 *
 * Deliberately not `node:path` — the analysis engine must run unchanged in the
 * browser, in edge runtimes and in tests. Every repo path in GitBrain is POSIX,
 * relative, and free of `./` or leading `/`.
 */

/** Collapse `.` / `..` segments and duplicate slashes. Never escapes the root. */
export function normalizePath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  const out: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }

  return out.join('/');
}

/** Directory portion of a path, or `''` for a top-level file. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** Final segment of a path. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Filename without its extension. */
export function stem(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

/** Join segments and normalize. Empty segments are ignored. */
export function joinPath(...segments: string[]): string {
  return normalizePath(segments.filter(Boolean).join('/'));
}

/**
 * Resolve `specifier` relative to the directory containing `fromFile`.
 *
 * Only for relative specifiers (`./x`, `../x`). Bare specifiers are package
 * imports and must be handled by the caller.
 */
export function resolveRelative(fromFile: string, specifier: string): string {
  return normalizePath(`${dirname(fromFile)}/${specifier}`);
}

/** Depth of a path, where a top-level file is depth 1. */
export function depthOf(path: string): number {
  if (!path) return 0;
  return path.split('/').length;
}

/** All ancestor directories of a path, shallowest first, excluding the root. */
export function ancestors(path: string): string[] {
  const parts = dirname(path).split('/').filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    out.push(current);
  }
  return out;
}

/** True when `path` sits at or beneath `dir`. */
export function isUnder(path: string, dir: string): boolean {
  if (!dir) return true;
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Strip the single wrapping directory that GitHub archives add
 * (`owner-repo-<sha>/src/index.ts` -> `src/index.ts`).
 *
 * Returns the input unchanged when entries do not share one root directory.
 */
export function stripArchiveRoot(paths: readonly string[]): (path: string) => string {
  let root: string | null = null;

  for (const path of paths) {
    const slash = path.indexOf('/');
    if (slash === -1) return (p) => p; // A top-level file means no common root.
    const candidate = path.slice(0, slash);
    if (root === null) root = candidate;
    else if (root !== candidate) return (p) => p;
  }

  if (root === null) return (p) => p;
  const prefix = `${root}/`;
  return (p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
}
