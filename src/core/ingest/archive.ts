/**
 * ZIP archive -> virtual file system.
 *
 * This is the single ingestion chokepoint. A pasted GitHub URL becomes a
 * zipball and an uploaded repository is already a ZIP, so both arrive here and
 * are subject to exactly the same limits, ignore rules and binary detection.
 * One code path means one place to test and one place to enforce safety.
 */

import { unzip, type Unzipped } from 'fflate';

import type { IngestLimits, RepoFile, SkippedSummary } from '../types';
import { extensionOf } from '../shared/languages';
import { normalizePath, stripArchiveRoot } from '../shared/paths';
import { hasBinaryExtension, isContentSkipped, isIgnoredPath, looksBinary } from './ignore';

/** Defaults sized so a large real-world repository still completes quickly. */
export const DEFAULT_LIMITS: IngestLimits = {
  /** Compressed archive ceiling. Most repositories are far under this. */
  maxArchiveBytes: 80 * 1024 * 1024,
  /** Per-file text ceiling. Beyond this a file is data, not code. */
  maxFileBytes: 1024 * 1024,
  /** Total decoded text budget, which bounds peak memory and analysis time. */
  maxTotalTextBytes: 48 * 1024 * 1024,
  maxFiles: 20_000,
};

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ExtractResult {
  readonly files: RepoFile[];
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly skipped: SkippedSummary;
}

/** Promise wrapper over fflate's callback-based async inflate. */
function unzipAsync(bytes: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, result) => {
      if (error) reject(new ArchiveError(`The archive could not be read: ${error.message}`));
      else resolve(result);
    });
  });
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Decode and classify every entry in a ZIP archive.
 *
 * Ordering matters for fairness: entries are sorted shortest-path-first so
 * that if the file budget runs out, what survives is the top-level source
 * tree rather than an arbitrary slice of some deeply nested fixture directory.
 */
export async function extractArchive(
  bytes: Uint8Array,
  limits: IngestLimits = DEFAULT_LIMITS,
): Promise<ExtractResult> {
  if (bytes.length === 0) throw new ArchiveError('The archive is empty.');
  if (bytes.length > limits.maxArchiveBytes) {
    throw new ArchiveError(
      `The archive is ${mb(bytes.length)}, over the ${mb(limits.maxArchiveBytes)} limit.`,
    );
  }
  if (!isZip(bytes)) {
    throw new ArchiveError('That file is not a ZIP archive.');
  }

  const unzipped = await unzipAsync(bytes);
  const entryPaths = Object.keys(unzipped);
  if (entryPaths.length === 0) throw new ArchiveError('The archive contains no files.');

  // GitHub wraps everything in `owner-repo-<sha>/`. Uploaded ZIPs usually have
  // a wrapping folder too. Strip it so paths read like repository paths.
  const strip = stripArchiveRoot(entryPaths);

  const skipped = { ignored: 0, binary: 0, tooLarge: 0, overBudget: 0 };
  const files: RepoFile[] = [];
  let totalBytes = 0;
  let textBudget = limits.maxTotalTextBytes;
  let truncated = false;

  const sorted = [...entryPaths].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );

  for (const entryPath of sorted) {
    const raw = unzipped[entryPath];
    if (!raw) continue;

    const path = normalizePath(strip(entryPath));
    // A zero-length path is the stripped root directory entry itself.
    if (!path) continue;

    // Defence in depth: `normalizePath` already collapses traversal, but an
    // archive claiming to write outside its root is malicious, not merely odd.
    if (path.startsWith('../') || path.includes('/../')) {
      skipped.ignored++;
      continue;
    }

    if (isIgnoredPath(entryPath) || isIgnoredPath(path)) {
      skipped.ignored++;
      continue;
    }

    if (files.length >= limits.maxFiles) {
      skipped.overBudget++;
      truncated = true;
      continue;
    }

    const size = raw.length;
    totalBytes += size;

    // Directory entries survive as zero-byte records in some ZIP writers.
    if (size === 0 && !extensionOf(path)) continue;

    if (isContentSkipped(path)) {
      // Keep the tree entry — its presence is a signal — but not the body.
      files.push({ path, size, ext: extensionOf(path), isBinary: false, content: null, lines: 0 });
      continue;
    }

    if (hasBinaryExtension(path) || looksBinary(raw)) {
      skipped.binary++;
      files.push({ path, size, ext: extensionOf(path), isBinary: true, content: null, lines: 0 });
      continue;
    }

    if (size > limits.maxFileBytes) {
      skipped.tooLarge++;
      truncated = true;
      files.push({ path, size, ext: extensionOf(path), isBinary: false, content: null, lines: 0 });
      continue;
    }

    if (size > textBudget) {
      skipped.overBudget++;
      truncated = true;
      files.push({ path, size, ext: extensionOf(path), isBinary: false, content: null, lines: 0 });
      continue;
    }

    textBudget -= size;
    const content = decoder.decode(raw);

    files.push({
      path,
      size,
      ext: extensionOf(path),
      isBinary: false,
      content,
      lines: content.length === 0 ? 0 : content.split('\n').length,
    });
  }

  if (files.length === 0) {
    throw new ArchiveError('No analyzable source files were found in the archive.');
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return { files, totalBytes, truncated, skipped };
}

/** ZIP local-file-header magic: `PK\x03\x04`. Empty archives use `PK\x05\x06`. */
function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const [b0, b1, b2, b3] = [bytes[0], bytes[1], bytes[2], bytes[3]];
  if (b0 !== 0x50 || b1 !== 0x4b) return false;
  return (
    (b2 === 0x03 && b3 === 0x04) || (b2 === 0x05 && b3 === 0x06) || (b2 === 0x07 && b3 === 0x08)
  );
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
}
