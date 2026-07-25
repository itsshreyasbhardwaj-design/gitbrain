/**
 * Analysis persistence contract.
 *
 * Two implementations sit behind this: an in-process LRU that requires no
 * configuration, and a Supabase-backed store used when credentials exist.
 * Routes depend on this interface only, so adding Redis or S3 later is a new
 * file rather than a refactor.
 */

import type { Analysis, AnalysisSummary } from '@/core/types';

export interface AnalysisStore {
  readonly kind: 'memory' | 'supabase';
  /** True when data survives a server restart. Surfaced in the UI. */
  readonly durable: boolean;

  save(analysis: Analysis, ownerId: string | null): Promise<void>;
  get(id: string, ownerId: string | null): Promise<Analysis | null>;
  list(ownerId: string | null, limit?: number): Promise<AnalysisSummary[]>;
  delete(id: string, ownerId: string | null): Promise<boolean>;
}

/** Project the heavy Analysis down to a list row. */
export function toSummary(analysis: Analysis): AnalysisSummary {
  const name =
    analysis.source.kind === 'github'
      ? `${analysis.source.owner}/${analysis.source.repo}`
      : analysis.source.filename.replace(/\.zip$/i, '');

  return {
    id: analysis.id,
    createdAt: analysis.createdAt,
    source: analysis.source,
    name,
    primaryLanguage: analysis.languages[0]?.language ?? null,
    overallScore: analysis.health.overall,
    files: analysis.stats.files,
    linesOfCode: analysis.stats.linesOfCode,
  };
}
