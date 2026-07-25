import { cache } from 'react';
import { notFound } from 'next/navigation';

import type { Analysis } from '@/core/types';
import { currentOwnerId } from '@/lib/auth';
import { resolveStore } from '@/lib/store';

/**
 * Load an analysis for a report route.
 *
 * Wrapped in React's `cache` so that a layout and its page — which render in
 * the same request — share a single store read instead of fetching the same
 * multi-megabyte object twice.
 */
export const loadAnalysis = cache(async (id: string): Promise<Analysis> => {
  const analysis = await resolveStore().get(id, await currentOwnerId());
  if (!analysis) notFound();
  return analysis;
});

/** Display name for a repository, used in headings and page titles. */
export function analysisName(analysis: Analysis): string {
  return analysis.source.kind === 'github'
    ? `${analysis.source.owner}/${analysis.source.repo}`
    : analysis.source.filename.replace(/\.zip$/i, '');
}
