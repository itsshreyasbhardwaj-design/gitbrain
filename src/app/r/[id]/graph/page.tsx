import { CyclesPanel } from '@/features/graph/cycles-panel';
import { GraphExplorer } from '@/features/graph/graph-explorer';
import { TreeMap } from '@/features/graph/tree-map';
import { loadAnalysis } from '@/features/report/load';

export default async function GraphPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);

  return (
    <section className="mt-8 space-y-12">
      <div>
        <h2 className="text-heading text-ink">Module graph</h2>
        <p className="text-ink-muted mt-1.5 max-w-2xl text-sm leading-relaxed">
          Every resolved import in the repository. Node size follows lines of code, colour follows
          language, and circular chains are highlighted.
        </p>
        <GraphExplorer graph={analysis.graph} languages={analysis.languages} />
      </div>

      <div>
        <h2 className="text-heading text-ink">Circular dependencies</h2>
        <p className="text-ink-muted mt-1.5 max-w-2xl text-sm leading-relaxed">
          Strongly connected components found with Tarjan’s algorithm. Each chain is a group of
          modules that cannot be loaded, tested or reasoned about independently.
        </p>
        <CyclesPanel cycles={analysis.graph.cycles} />
      </div>

      <div>
        <h2 className="text-heading text-ink">Repository treemap</h2>
        <p className="text-ink-muted mt-1.5 max-w-2xl text-sm leading-relaxed">
          Where the bulk of this codebase actually lives. Area is bytes; colour is the dominant
          language. Click a directory to zoom in.
        </p>
        <TreeMap tree={analysis.tree} />
      </div>
    </section>
  );
}
