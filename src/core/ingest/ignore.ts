/**
 * Ingestion ignore rules.
 *
 * The goal is to analyze *what the team wrote*, not what their tools produced.
 * Dependencies, build output, lockfiles and binary assets are excluded up
 * front so every downstream metric — LOC, complexity, health — describes the
 * actual codebase rather than a vendored copy of the npm registry.
 *
 * Every exclusion is counted and surfaced in `SkippedSummary`, so the UI can
 * be honest about what was left out instead of silently under-reporting.
 */

import { basename } from '../shared/paths';
import { extensionOf } from '../shared/languages';

/** Directory names dropped wherever they appear in the tree. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  // Version control & tooling metadata
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.vs',
  '.fleet',
  '.history',
  // Dependencies
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'vendors',
  'third_party',
  'thirdparty',
  '.pnpm',
  '.yarn',
  '.venv',
  'venv',
  'env',
  'virtualenv',
  'site-packages',
  '.bundle',
  'Pods',
  '.gradle',
  '.m2',
  // Build output
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.output',
  '.vercel',
  '.netlify',
  '.serverless',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.docusaurus',
  '_site',
  'public/build',
  // Test & tooling artifacts
  'coverage',
  '.nyc_output',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
  '.tox',
  'htmlcov',
  'playwright-report',
  'test-results',
  '.terraform',
  '.dart_tool',
  '.expo',
  'DerivedData',
  // OS noise
  '.Trash',
  '$RECYCLE.BIN',
]);

/** Exact filenames that carry no analytical value. */
const IGNORED_FILENAMES: ReadonlySet<string> = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.gitkeep',
  '.keep',
]);

/**
 * Files kept as tree entries but stripped of their contents.
 *
 * A lockfile's *presence* is a strong reproducibility signal, so the entry has
 * to survive ingestion for the dependency analyzer to see it. Its *contents*
 * are hundreds of kilobytes of machine-generated noise that would distort LOC,
 * duplication and language statistics. Keeping the path and dropping the body
 * gets the signal without the cost.
 */
const CONTENT_SKIPPED_FILENAMES: ReadonlySet<string> = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'bun.lockb',
  'bun.lock',
  'poetry.lock',
  'pdm.lock',
  'uv.lock',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
  'pipfile.lock',
  'go.sum',
  'flake.lock',
  'packages.lock.json',
  'mix.lock',
]);

/**
 * True when the file should appear in the tree with `content: null`.
 *
 * Callers must still count its `size`, because "this repo has a 900 KB
 * lockfile" is a fact worth reporting.
 */
export function isContentSkipped(path: string): boolean {
  return CONTENT_SKIPPED_FILENAMES.has(basename(path).toLowerCase());
}

/**
 * Extensions treated as binary without inspecting bytes.
 *
 * A fast path: these are never text, so we skip the decode attempt entirely.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images & media
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'icns',
  'webp',
  'avif',
  'tiff',
  'tif',
  'heic',
  'psd',
  'ai',
  'sketch',
  'fig',
  'xcf',
  'mp3',
  'mp4',
  'wav',
  'ogg',
  'flac',
  'aac',
  'm4a',
  'avi',
  'mov',
  'mkv',
  'webm',
  'wmv',
  'flv',
  // Fonts
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  // Archives
  'zip',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  '7z',
  'rar',
  'jar',
  'war',
  'ear',
  'apk',
  'ipa',
  'dmg',
  'iso',
  // Compiled artifacts
  'exe',
  'dll',
  'so',
  'dylib',
  'a',
  'o',
  'obj',
  'lib',
  'class',
  'pyc',
  'pyo',
  'pyd',
  'wasm',
  'bin',
  'dat',
  'db',
  'sqlite',
  'sqlite3',
  'mdb',
  'rlib',
  'rmeta',
  'node',
  // Documents & other
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'ttc',
  'pack',
  'idx',
  'bundle',
  'map',
  'pb',
  'onnx',
  'h5',
  'pkl',
  'npy',
  'npz',
  'parquet',
  'safetensors',
  'ckpt',
  'pt',
  'pth',
  'tflite',
  'mlmodel',
]);

/** Path fragments that indicate minified or bundled output. */
const MINIFIED_PATTERN = /\.(min|bundle|chunk)\.(js|css|mjs)$/i;

/** Source maps: large, generated, and useless for understanding a codebase. */
const SOURCEMAP_PATTERN = /\.(js|css|mjs|cjs)\.map$/i;

/**
 * True when the path should never enter the snapshot.
 *
 * Checked against every path segment so `packages/web/node_modules/x` is
 * excluded just as reliably as a top-level `node_modules`.
 */
export function isIgnoredPath(path: string): boolean {
  // A directory entry inside the archive, not a file.
  if (path.endsWith('/')) return true;

  const segments = path.split('/');

  // Every segment except the last is a directory on this path.
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (segment && IGNORED_DIRECTORIES.has(segment)) return true;
  }

  const file = basename(path).toLowerCase();
  if (IGNORED_FILENAMES.has(file)) return true;
  if (MINIFIED_PATTERN.test(path)) return true;
  if (SOURCEMAP_PATTERN.test(path)) return true;

  return false;
}

/** True when the extension is known-binary and decoding should be skipped. */
export function hasBinaryExtension(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(path));
}

/**
 * Sniff whether a byte buffer is binary.
 *
 * Uses the same heuristic as `git`: a NUL byte in the first 8 KiB means
 * binary. We additionally reject buffers where control characters dominate,
 * which catches UTF-16 and other encodings we cannot index as UTF-8 text.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  if (limit === 0) return false;

  let control = 0;
  for (let i = 0; i < limit; i++) {
    const byte = bytes[i];
    if (byte === undefined) break;
    if (byte === 0) return true;
    // Allow tab (9), LF (10), CR (13), FF (12) and everything printable.
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }

  return control / limit > 0.3;
}

/**
 * Lockfile names, exposed so the dependency analyzer can report reproducibility
 * from the surviving tree entries without re-deriving the list.
 */
export const LOCKFILE_NAMES: readonly string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'mix.lock',
];
