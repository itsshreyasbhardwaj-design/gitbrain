/**
 * Test fixture builders.
 *
 * Shipped in `src/core` rather than `tests/` so every analyzer's colocated
 * unit tests construct snapshots the same way. Excluded from coverage.
 */

import type { RepoFile, RepoSnapshot, RepoSource } from '../types';
import { detectLanguage, extensionOf } from '../shared/languages';

/** Build a text `RepoFile` from a path and its contents. */
export function makeFile(path: string, content: string): RepoFile {
  return {
    path,
    size: content.length,
    ext: extensionOf(path),
    isBinary: false,
    content,
    lines: content.length === 0 ? 0 : content.split('\n').length,
  };
}

/** Build a binary `RepoFile` placeholder of a given size. */
export function makeBinaryFile(path: string, size: number): RepoFile {
  return {
    path,
    size,
    ext: extensionOf(path),
    isBinary: true,
    content: null,
    lines: 0,
  };
}

export const DEFAULT_SOURCE: RepoSource = {
  kind: 'github',
  owner: 'acme',
  repo: 'demo',
  ref: 'main',
  url: 'https://github.com/acme/demo',
};

/**
 * Build a snapshot from a `path -> content` map.
 *
 * Paths are used verbatim, so tests read as a miniature file tree.
 */
export function makeSnapshot(
  files: Record<string, string>,
  source: RepoSource = DEFAULT_SOURCE,
): RepoSnapshot {
  const built = Object.entries(files).map(([path, content]) => makeFile(path, content));

  return {
    source,
    files: built,
    totalBytes: built.reduce((sum, file) => sum + file.size, 0),
    truncated: false,
    skipped: { ignored: 0, binary: 0, tooLarge: 0, overBudget: 0 },
    ingestMs: 0,
  };
}

/** Convenience for asserting on language detection in tests. */
export function languageOf(path: string): string {
  return detectLanguage(path).name;
}
