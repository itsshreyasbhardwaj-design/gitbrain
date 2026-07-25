'use client';

import { Network, Search, X } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';

import type { LanguageBreakdown, ModuleGraph } from '@/core/types';
import { basename } from '@/core/shared/paths';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCount } from '@/features/report/grade';
import { cn } from '@/lib/cn';
import { GraphCanvas, type LayoutMode } from './graph-canvas';

export function GraphExplorer({
  graph,
  languages,
}: {
  graph: ModuleGraph;
  languages: readonly LanguageBreakdown[];
}) {
  const [filter, setFilter] = useState('');
  const [language, setLanguage] = useState('all');
  const [layout, setLayout] = useState<LayoutMode>('layered');
  const [cyclesOnly, setCyclesOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Layout is the expensive part; deferring the filter keeps typing smooth.
  const deferredFilter = useDeferredValue(filter);

  const cyclicPaths = useMemo(() => {
    const set = new Set<string>();
    for (const cycle of graph.cycles) for (const path of cycle) set.add(path);
    return set;
  }, [graph.cycles]);

  const filtered = useMemo<ModuleGraph>(() => {
    const query = deferredFilter.trim().toLowerCase();

    const nodes = graph.nodes.filter((node) => {
      if (query && !node.path.toLowerCase().includes(query)) return false;
      if (language !== 'all' && node.language !== language) return false;
      if (cyclesOnly && !cyclicPaths.has(node.id)) return false;
      return true;
    });

    const ids = new Set(nodes.map((node) => node.id));
    return {
      ...graph,
      nodes,
      edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    };
  }, [graph, deferredFilter, language, cyclesOnly, cyclicPaths]);

  const selected = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );

  const relations = useMemo(() => {
    if (!selectedId) return { importers: [], imports: [] };
    return {
      importers: graph.edges.filter((edge) => edge.to === selectedId).map((edge) => edge.from),
      imports: graph.edges.filter((edge) => edge.from === selectedId).map((edge) => edge.to),
    };
  }, [graph.edges, selectedId]);

  const availableLanguages = useMemo(
    () => [...new Set(graph.nodes.map((node) => node.language))].sort(),
    [graph.nodes],
  );

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        className="mt-6"
        icon={<Network />}
        title="No import relationships were resolved"
        description="GitBrain parses imports for TypeScript, JavaScript, Python, Go, Rust, Ruby, PHP, Java and Kotlin. A repository written in another language, or one whose modules are wired together at runtime rather than by import statements, will produce an empty graph."
      />
    );
  }

  return (
    <div className="mt-6">
      {/* Summary --------------------------------------------------------- */}
      <dl className="flex flex-wrap gap-2">
        {[
          { label: 'modules', value: graph.nodes.length },
          { label: 'imports', value: graph.edges.length },
          { label: 'circular chains', value: graph.cycles.length, warn: graph.cycles.length > 0 },
          { label: 'orphans', value: graph.orphans.length },
          { label: 'external packages', value: graph.externals.length },
        ].map((stat) => (
          <div
            key={stat.label}
            className={cn(
              'border-line bg-surface/50 rounded-lg border px-3 py-1.5',
              stat.warn && 'border-bad/30 bg-bad/10',
            )}
          >
            <dt className="sr-only">{stat.label}</dt>
            <dd className="text-ink text-sm">
              <span className={cn('font-semibold tabular-nums', stat.warn && 'text-bad')}>
                {formatCount(stat.value)}
              </span>
              <span className="text-ink-subtle ml-1.5 text-xs">{stat.label}</span>
            </dd>
          </div>
        ))}
      </dl>

      {/* Toolbar --------------------------------------------------------- */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search
            className="text-ink-faint pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by path…"
            aria-label="Filter modules by path"
            className="border-line bg-surface text-ink placeholder:text-ink-faint focus:border-jade/50 h-9 w-full rounded-lg border pr-3 pl-9 text-sm focus:outline-none"
          />
        </div>

        <label className="sr-only" htmlFor="graph-language">
          Filter by language
        </label>
        <select
          id="graph-language"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
          className="border-line bg-surface text-ink focus:border-jade/50 h-9 rounded-lg border px-2.5 text-sm focus:outline-none"
        >
          <option value="all">All languages</option>
          {availableLanguages.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <div className="border-line flex rounded-lg border p-0.5" role="group" aria-label="Layout">
          {(['layered', 'force'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setLayout(mode)}
              aria-pressed={layout === mode}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs capitalize transition-colors',
                layout === mode ? 'bg-surface text-ink' : 'text-ink-subtle hover:text-ink',
              )}
            >
              {mode}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setCyclesOnly((value) => !value)}
          aria-pressed={cyclesOnly}
          disabled={graph.cycles.length === 0}
          className={cn(
            'h-9 rounded-lg border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
            cyclesOnly
              ? 'border-bad/40 bg-bad/10 text-bad'
              : 'border-line text-ink-subtle hover:text-ink',
          )}
        >
          Cycles only
        </button>
      </div>

      {/* Canvas + details ------------------------------------------------ */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="glass rounded-panel h-[32rem] overflow-hidden lg:h-[38rem]">
          {filtered.nodes.length === 0 ? (
            <div className="text-ink-subtle flex h-full items-center justify-center px-6 text-center text-sm">
              No modules match these filters.
            </div>
          ) : (
            <GraphCanvas
              graph={filtered}
              languages={languages}
              layout={layout}
              selectedId={selectedId}
              onSelect={setSelectedId}
              className="h-full"
            />
          )}
        </div>

        <aside className="glass rounded-panel p-4">
          {selected ? (
            <div>
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-ink min-w-0 font-mono text-[13px] break-all">
                  {selected.path}
                </h3>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="text-ink-faint hover:text-ink shrink-0 rounded-md p-0.5"
                  aria-label="Clear selection"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-ink-faint text-[11px]">Language</dt>
                  <dd className="text-ink">{selected.language}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint text-[11px]">Lines</dt>
                  <dd className="text-ink tabular-nums">{formatCount(selected.loc)}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint text-[11px]">Imported by</dt>
                  <dd className="text-ink tabular-nums">{selected.inDegree}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint text-[11px]">Imports</dt>
                  <dd className="text-ink tabular-nums">{selected.outDegree}</dd>
                </div>
              </dl>

              <div className="border-line mt-4 border-t pt-3">
                <p className="text-ink-faint text-[11px]">Instability</p>
                <p className="text-ink mt-0.5 tabular-nums">{selected.instability.toFixed(2)}</p>
                <p className="text-ink-subtle mt-1 text-[11px] leading-relaxed">
                  0 means nothing here depends on anything else — stable, safe to depend on. 1 means
                  it only depends outward, so it is cheap to change.
                </p>
              </div>

              {(selected.isEntry || selected.isOrphan || cyclicPaths.has(selected.id)) && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {selected.isEntry && (
                    <span className="border-jade/30 bg-jade/10 text-jade rounded border px-1.5 py-0.5 text-[11px]">
                      entry point
                    </span>
                  )}
                  {selected.isOrphan && (
                    <span className="border-line text-ink-subtle rounded border px-1.5 py-0.5 text-[11px]">
                      orphan
                    </span>
                  )}
                  {cyclicPaths.has(selected.id) && (
                    <span className="border-bad/30 bg-bad/10 text-bad rounded border px-1.5 py-0.5 text-[11px]">
                      in a cycle
                    </span>
                  )}
                </div>
              )}

              <RelationList
                title="Imported by"
                paths={relations.importers}
                onSelect={setSelectedId}
              />
              <RelationList title="Imports" paths={relations.imports} onSelect={setSelectedId} />
            </div>
          ) : (
            <p className="text-ink-subtle text-sm leading-relaxed">
              Select a module to see what depends on it, what it depends on, and how stable it is.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

function RelationList({
  title,
  paths,
  onSelect,
}: {
  title: string;
  paths: readonly string[];
  onSelect: (id: string) => void;
}) {
  if (paths.length === 0) return null;

  return (
    <div className="border-line mt-4 border-t pt-3">
      <p className="text-ink-faint text-[11px]">
        {title} ({paths.length})
      </p>
      <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
        {paths.slice(0, 40).map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => onSelect(path)}
              title={path}
              className="text-ink-subtle hover:bg-surface hover:text-jade block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[11px] transition-colors"
            >
              {basename(path)}
            </button>
          </li>
        ))}
      </ul>
      {paths.length > 40 && (
        <p className="text-ink-faint mt-1 text-[11px]">and {paths.length - 40} more</p>
      )}
    </div>
  );
}
