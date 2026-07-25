import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { SearchPanel } from '@/features/search/search-panel';
import { loadAnalysis } from '@/features/report/load';
import { formatCount } from '@/features/report/grade';

export default async function SearchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);

  return (
    <section className="mt-8">
      <h2 className="text-heading text-ink">Smart search</h2>
      <p className="text-ink-muted mt-1.5 max-w-2xl text-sm leading-relaxed">
        {formatCount(analysis.search.totalDocuments)} code chunks indexed with BM25 ranking and
        symbol boosting, so a function name finds its definition before its call sites.
      </p>

      {/* useSearchParams requires a Suspense boundary during prerender. */}
      <Suspense fallback={<Skeleton className="rounded-panel mt-6 h-14 w-full" />}>
        <SearchPanel analysisId={id} />
      </Suspense>
    </section>
  );
}
