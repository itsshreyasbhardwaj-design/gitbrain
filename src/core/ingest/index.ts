/**
 * Ingestion entry points.
 *
 * Both paths converge on `extractArchive`, so a GitHub repository and an
 * uploaded ZIP produce structurally identical snapshots. Downstream analyzers
 * cannot tell — and must not care — which one they were given.
 */

import type { IngestLimits, ProgressReporter, RepoSnapshot } from '../types';
import { DEFAULT_LIMITS, extractArchive } from './archive';
import {
  fetchRepositoryMetadata,
  fetchZipball,
  parseRepositoryUrl,
  repositoryUrl,
  type RepositoryMetadata,
} from './github';

export * from './archive';
export * from './github';
export * from './ignore';

export interface IngestOptions {
  readonly limits?: IngestLimits;
  readonly token?: string | undefined;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressReporter;
}

export interface GitHubIngestResult {
  readonly snapshot: RepoSnapshot;
  /** `null` when metadata could not be fetched (rate limit) but the zip worked. */
  readonly metadata: RepositoryMetadata | null;
}

/**
 * Ingest a public GitHub repository from any URL shape a user might paste.
 *
 * Metadata is fetched opportunistically: it gives us the default branch name
 * and repository description, but a rate-limited metadata call must not block
 * the analysis, because the zipball itself is served without a rate limit.
 */
export async function ingestGitHubRepository(
  input: string,
  options: IngestOptions = {},
): Promise<GitHubIngestResult> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const started = Date.now();
  const ref = parseRepositoryUrl(input);

  options.onProgress?.({
    stage: 'fetching',
    percent: 5,
    message: `Resolving ${ref.owner}/${ref.repo}…`,
  });

  let metadata: RepositoryMetadata | null = null;
  try {
    metadata = await fetchRepositoryMetadata(ref, {
      token: options.token,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    // Non-fatal by design. The zipball fetch below is the real gate, and it
    // will produce a precise error if the repository truly is unreachable.
  }

  options.onProgress?.({
    stage: 'fetching',
    percent: 15,
    message: 'Downloading repository archive…',
  });

  const bytes = await fetchZipball(ref, {
    maxBytes: limits.maxArchiveBytes,
    token: options.token,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  options.onProgress?.({ stage: 'unpacking', percent: 35, message: 'Unpacking archive…' });

  const extracted = await extractArchive(bytes, limits);

  return {
    snapshot: {
      source: {
        kind: 'github',
        owner: ref.owner,
        repo: ref.repo,
        ref: ref.ref ?? metadata?.defaultBranch ?? 'HEAD',
        url: repositoryUrl(ref),
      },
      files: extracted.files,
      totalBytes: extracted.totalBytes,
      truncated: extracted.truncated,
      skipped: extracted.skipped,
      ingestMs: Date.now() - started,
    },
    metadata,
  };
}

/** Ingest an uploaded ZIP archive. */
export async function ingestUploadedArchive(
  bytes: Uint8Array,
  filename: string,
  options: IngestOptions = {},
): Promise<RepoSnapshot> {
  const started = Date.now();
  options.onProgress?.({ stage: 'unpacking', percent: 20, message: 'Unpacking archive…' });

  const extracted = await extractArchive(bytes, options.limits ?? DEFAULT_LIMITS);

  return {
    source: { kind: 'upload', filename },
    files: extracted.files,
    totalBytes: extracted.totalBytes,
    truncated: extracted.truncated,
    skipped: extracted.skipped,
    ingestMs: Date.now() - started,
  };
}
