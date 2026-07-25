/**
 * GET /api/search — ranked code search over an analyzed repository.
 *
 * Returns hits with file, line range, excerpt and highlight ranges so the UI
 * can render a citation without a second round trip.
 */

import { z } from 'zod';

import { groupHitsByFile, search } from '@/core/search';
import { handleError, jsonResponse, PublicError } from '@/lib/api';
import { currentOwnerId } from '@/lib/auth';
import { clientKey, rateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { resolveStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  id: z.string().min(1).max(128),
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export async function GET(request: Request): Promise<Response> {
  const limit = rateLimit(clientKey(request, 'search'), { limit: 90, windowMs: 60_000 });

  if (!limit.allowed) {
    return jsonResponse(
      { error: { message: 'Too many searches.', code: 'rate_limited' } },
      { status: 429, headers: rateLimitHeaders(limit) },
    );
  }

  try {
    const url = new URL(request.url);
    const params = querySchema.parse({
      id: url.searchParams.get('id'),
      q: url.searchParams.get('q'),
      limit: url.searchParams.get('limit') ?? undefined,
    });

    const analysis = await resolveStore().get(params.id, await currentOwnerId());
    if (!analysis) throw new PublicError('Analysis not found.', 404, 'analysis_not_found');

    const hits = search(analysis.search, params.q, params.limit);

    return jsonResponse(
      {
        query: params.q,
        total: hits.length,
        groups: groupHitsByFile(hits).map((group) => ({
          file: group.file,
          score: Math.round(group.score * 1000) / 1000,
          matches: group.hits.map((hit) => ({
            startLine: hit.document.startLine,
            endLine: hit.document.endLine,
            language: hit.document.language,
            text: hit.document.text,
            highlights: hit.highlights,
            score: Math.round(hit.score * 1000) / 1000,
          })),
        })),
      },
      { headers: rateLimitHeaders(limit) },
    );
  } catch (error) {
    return handleError(error);
  }
}
