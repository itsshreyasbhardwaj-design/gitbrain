/**
 * Supabase-backed analysis store.
 *
 * Talks to PostgREST directly over `fetch` rather than depending on
 * `@supabase/supabase-js`. The SDK is ~200 KB and bundles realtime and auth
 * clients this store never uses; four REST calls do not justify that weight in
 * an integration most self-hosters will leave switched off.
 *
 * Schema lives in `supabase/migrations/`. Row Level Security is enabled there,
 * and this client uses the service role key from the server only.
 */

import type { Analysis, AnalysisSummary } from '@/core/types';
import { serverEnv } from '@/lib/env';
import { toSummary, type AnalysisStore } from './types';

interface AnalysisRow {
  id: string;
  owner_id: string | null;
  created_at: string;
  name: string;
  source: unknown;
  summary: unknown;
  payload: unknown;
}

export class SupabaseStore implements AnalysisStore {
  readonly kind = 'supabase' as const;
  readonly durable = true;

  private readonly url: string;
  private readonly key: string;

  constructor(url: string, serviceRoleKey: string) {
    this.url = url.replace(/\/$/, '');
    this.key = serviceRoleKey;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private endpoint(query = ''): string {
    return `${this.url}/rest/v1/analyses${query}`;
  }

  async save(analysis: Analysis, ownerId: string | null): Promise<void> {
    const summary = toSummary(analysis);

    const response = await fetch(this.endpoint(), {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({
        id: analysis.id,
        owner_id: ownerId,
        created_at: analysis.createdAt,
        name: summary.name,
        source: analysis.source,
        summary,
        payload: analysis,
      }),
    });

    if (!response.ok) {
      throw new Error(`Supabase save failed (${response.status}): ${await safeText(response)}`);
    }
  }

  async get(id: string, ownerId: string | null): Promise<Analysis | null> {
    const query = `?id=eq.${encodeURIComponent(id)}&${ownerFilter(ownerId)}&select=payload&limit=1`;
    const response = await fetch(this.endpoint(query), { headers: this.headers() });

    if (!response.ok) return null;

    const rows = (await response.json()) as { payload?: unknown }[];
    const payload = rows[0]?.payload;

    // The payload column is jsonb, so this round-trips as the original object.
    return payload ? (payload as Analysis) : null;
  }

  async list(ownerId: string | null, limit = 20): Promise<AnalysisSummary[]> {
    const query = `?${ownerFilter(ownerId)}&select=summary&order=created_at.desc&limit=${Math.min(limit, 100)}`;
    const response = await fetch(this.endpoint(query), { headers: this.headers() });

    if (!response.ok) return [];

    const rows = (await response.json()) as { summary?: unknown }[];
    return rows
      .map((row) => row.summary)
      .filter((summary): summary is AnalysisSummary => Boolean(summary));
  }

  async delete(id: string, ownerId: string | null): Promise<boolean> {
    const query = `?id=eq.${encodeURIComponent(id)}&${ownerFilter(ownerId)}`;
    const response = await fetch(this.endpoint(query), {
      method: 'DELETE',
      headers: this.headers({ Prefer: 'return=representation' }),
    });

    if (!response.ok) return false;
    const rows = (await response.json()) as AnalysisRow[];
    return rows.length > 0;
  }
}

/**
 * Ownership filter.
 *
 * Anonymous analyses stay readable by everyone, which is what makes a shared
 * report URL work. Owned rows are visible only to their owner.
 */
function ownerFilter(ownerId: string | null): string {
  return ownerId
    ? `or=(owner_id.is.null,owner_id.eq.${encodeURIComponent(ownerId)})`
    : 'owner_id.is.null';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '<no body>';
  }
}

/** Build a Supabase store when credentials exist, otherwise `null`. */
export function tryCreateSupabaseStore(): SupabaseStore | null {
  const env = serverEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return new SupabaseStore(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}
