import { Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { KnowledgeBrowser } from '@/features/knowledge/knowledge-browser';
import { loadAnalysis } from '@/features/report/load';

export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-heading text-ink">Knowledge base</h2>
          <p className="text-ink-muted mt-1.5 text-sm leading-relaxed">
            {analysis.knowledge.docs.length} documents generated from this repository’s measured
            structure. Every claim traces back to a file you can open.
          </p>
        </div>

        <Badge variant={analysis.knowledge.model ? 'jade' : 'neutral'}>
          <Sparkles className="size-3" aria-hidden="true" />
          {analysis.knowledge.model ? `Enriched by ${analysis.knowledge.model}` : 'Static analysis'}
        </Badge>
      </div>

      <KnowledgeBrowser analysisId={id} docs={analysis.knowledge.docs} />
    </section>
  );
}
