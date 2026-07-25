/**
 * POST /api/analyze — analyze a repository, streaming progress.
 *
 * Analysis of a real repository takes seconds, not milliseconds. Rather than
 * hold a request open behind a spinner, this endpoint streams newline-delimited
 * JSON progress events and finishes with the analysis id. The client renders
 * each stage as it arrives, which turns dead waiting time into visible work.
 *
 * NDJSON is used rather than SSE because the payload is consumed by `fetch`
 * and a reader, not `EventSource`, and NDJSON survives proxies that mangle
 * SSE framing.
 */

import { z } from 'zod';

import { analyzeSnapshot } from '@/core/analyze';
import { ingestGitHubRepository, ingestUploadedArchive, parseRepositoryUrl } from '@/core/ingest';
import type { ProgressEvent } from '@/core/types';
import { handleError, PublicError, securityHeaders } from '@/lib/api';
import { currentOwnerId } from '@/lib/auth';
import { serverEnv } from '@/lib/env';
import { clientKey, rateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { resolveStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Analysis of a large repository can legitimately take a while. */
export const maxDuration = 120;

const urlSchema = z.object({
  url: z.string().min(1).max(2048),
});

/** Uploaded archives are capped well below the ingest limit to fail fast. */
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const limit = rateLimit(clientKey(request, 'analyze'), { limit: 8, windowMs: 60_000 });

  if (!limit.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Too many analyses. Try again in ${limit.retryAfter} seconds.`,
          code: 'rate_limited',
        },
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          ...securityHeaders(),
          ...rateLimitHeaders(limit),
        },
      },
    );
  }

  try {
    const contentType = request.headers.get('content-type') ?? '';
    const ownerId = await currentOwnerId();
    const env = serverEnv();

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');

      if (!(file instanceof File)) {
        throw new PublicError('Attach a .zip archive in the `file` field.', 400, 'missing_file');
      }
      if (file.size === 0) {
        throw new PublicError('That file is empty.', 400, 'empty_file');
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new PublicError(
          `That archive is ${(file.size / 1_048_576).toFixed(0)} MB, over the 60 MB limit.`,
          413,
          'file_too_large',
        );
      }
      if (!/\.zip$/i.test(file.name)) {
        throw new PublicError('Only .zip archives are supported.', 415, 'unsupported_type');
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      return streamAnalysis(
        async (report) => {
          const snapshot = await ingestUploadedArchive(bytes, file.name, { onProgress: report });
          return snapshot;
        },
        ownerId,
        rateLimitHeaders(limit),
      );
    }

    const { url } = urlSchema.parse(await request.json());

    // Validate the URL BEFORE opening the stream.
    //
    // Once the first byte is written the status line is fixed at 200, and a
    // failure can only be reported as an in-band event. That is the right
    // trade-off for a failure discovered mid-analysis, but a malformed or
    // non-GitHub URL is knowable up front — and answering 200 to an SSRF
    // attempt is both a worse API and a worse security signal. Parsing here
    // throws `InvalidRepositoryUrlError`, which `handleError` maps to 400.
    parseRepositoryUrl(url);

    return streamAnalysis(
      async (report) => {
        const { snapshot } = await ingestGitHubRepository(url, {
          token: env.GITHUB_TOKEN,
          onProgress: report,
        });
        return snapshot;
      },
      ownerId,
      rateLimitHeaders(limit),
    );
  } catch (error) {
    return handleError(error);
  }
}

type SnapshotFactory = (
  report: (event: ProgressEvent) => void,
) => Promise<Awaited<ReturnType<typeof ingestUploadedArchive>>>;

/**
 * Run ingest + analysis, streaming progress as NDJSON.
 *
 * Errors after the stream has opened cannot use an HTTP status code, so they
 * are emitted as a terminal `{ stage: 'error' }` event and the client surfaces
 * the message. The stream is always closed exactly once.
 */
function streamAnalysis(
  factory: SnapshotFactory,
  ownerId: string | null,
  headers: Record<string, string>,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: ProgressEvent | { stage: 'result'; id: string }) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        send({ stage: 'queued', percent: 0, message: 'Starting analysis…' });

        const snapshot = await factory((event) => send(event));
        const analysis = analyzeSnapshot(snapshot, { onProgress: (event) => send(event) });

        await resolveStore().save(analysis, ownerId);

        send({ stage: 'result', id: analysis.id });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Analysis failed for an unknown reason.';
        send({ stage: 'error', percent: 100, message });

        if (!(error instanceof Error) || !isExpected(error)) {
          console.error('[gitbrain] analysis failed:', error);
        }
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      // Disable proxy buffering so progress events arrive as they are produced.
      'X-Accel-Buffering': 'no',
      ...securityHeaders(),
      ...headers,
    },
  });
}

/** Errors that represent user input problems rather than defects. */
function isExpected(error: Error): boolean {
  return ['InvalidRepositoryUrlError', 'ArchiveError', 'RepositoryFetchError'].includes(error.name);
}
