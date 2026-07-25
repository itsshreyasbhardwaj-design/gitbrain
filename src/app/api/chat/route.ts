/**
 * POST /api/chat — ask a question about an analyzed repository.
 *
 * Streams NDJSON chunks from whichever reasoning provider is configured. The
 * response shape is identical for the local reasoner and for an LLM, so the
 * client has exactly one code path.
 */

import { z } from 'zod';

import { resolveProvider } from '@/lib/ai';
import { handleError, PublicError, parseJson, securityHeaders } from '@/lib/api';
import { currentOwnerId } from '@/lib/auth';
import { clientKey, rateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { resolveStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const bodySchema = z.object({
  analysisId: z.string().min(1).max(128),
  question: z.string().min(1, 'Ask a question.').max(2000, 'That question is too long.'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(8000),
      }),
    )
    .max(20)
    .default([]),
});

export async function POST(request: Request): Promise<Response> {
  const limit = rateLimit(clientKey(request, 'chat'), { limit: 30, windowMs: 60_000 });

  if (!limit.allowed) {
    return new Response(
      JSON.stringify({
        error: { message: `Too many messages. Wait ${limit.retryAfter}s.`, code: 'rate_limited' },
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
    const body = await parseJson(request, bodySchema);
    const ownerId = await currentOwnerId();
    const analysis = await resolveStore().get(body.analysisId, ownerId);

    if (!analysis) {
      throw new PublicError(
        'That analysis is no longer available. Run it again to keep chatting.',
        404,
        'analysis_not_found',
      );
    }

    const provider = resolveProvider();
    const encoder = new TextEncoder();

    // Abort generation if the client disconnects, so we stop paying for
    // tokens nobody will ever read.
    const controller = new AbortController();
    request.signal.addEventListener('abort', () => controller.abort());

    const stream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        try {
          streamController.enqueue(
            encoder.encode(
              `${JSON.stringify({ type: 'provider', id: provider.id, label: provider.label, generative: provider.isGenerative })}\n`,
            ),
          );

          for await (const chunk of provider.answer({
            question: body.question,
            history: body.history,
            analysis,
            signal: controller.signal,
          })) {
            streamController.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error('[gitbrain] chat stream failed:', error);
            streamController.enqueue(
              encoder.encode(
                `${JSON.stringify({ type: 'error', message: 'The answer could not be generated.' })}\n`,
              ),
            );
          }
        } finally {
          streamController.close();
        }
      },
      cancel() {
        controller.abort();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        ...securityHeaders(),
        ...rateLimitHeaders(limit),
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
