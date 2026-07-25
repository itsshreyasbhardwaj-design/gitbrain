'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { FileText, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Markdown } from '@/components/markdown';
import { CitationList } from '@/features/knowledge/citation-list';
import type { KnowledgeDoc } from '@/core/types';
import { cn } from '@/lib/cn';

/**
 * Two-pane document browser.
 *
 * A list-plus-detail layout rather than one long scroll: eighteen documents is
 * too many to skim linearly, and a developer usually arrives wanting exactly
 * one of them ("how do I run this").
 */
export function KnowledgeBrowser({
  analysisId,
  docs,
}: {
  analysisId: string;
  docs: readonly KnowledgeDoc[];
}) {
  const [activeId, setActiveId] = useState(docs[0]?.id ?? '');
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return docs;
    return docs.filter(
      (doc) =>
        doc.title.toLowerCase().includes(query) ||
        doc.summary.toLowerCase().includes(query) ||
        doc.markdown.toLowerCase().includes(query),
    );
  }, [docs, filter]);

  const active = docs.find((doc) => doc.id === activeId) ?? filtered[0] ?? docs[0];

  if (!active) {
    return <p className="text-ink-subtle mt-8 text-sm">No knowledge documents were generated.</p>;
  }

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      {/* Document list ------------------------------------------------- */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="relative">
          <Search
            className="text-ink-faint pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter documents"
            aria-label="Filter knowledge documents"
            className="border-line bg-surface text-ink placeholder:text-ink-faint focus:border-jade/50 h-9 w-full rounded-lg border pr-3 pl-9 text-sm focus:outline-none"
          />
        </div>

        <nav aria-label="Knowledge documents" className="mt-3 lg:max-h-[70vh] lg:overflow-y-auto">
          <ul className="space-y-0.5 pr-1">
            {filtered.map((doc) => {
              const isActive = doc.id === active.id;
              return (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(doc.id)}
                    aria-current={isActive ? 'true' : undefined}
                    className={cn(
                      'w-full rounded-lg px-3 py-2 text-left transition-colors',
                      isActive
                        ? 'bg-surface text-ink'
                        : 'text-ink-subtle hover:bg-surface/60 hover:text-ink-muted',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {isActive && (
                        <span
                          className="bg-jade size-1.5 shrink-0 rounded-full"
                          aria-hidden="true"
                        />
                      )}
                      <span className="truncate">{doc.title}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {filtered.length === 0 && (
            <p className="text-ink-faint px-3 py-4 text-sm">No documents match “{filter}”.</p>
          )}
        </nav>
      </aside>

      {/* Document body -------------------------------------------------- */}
      <AnimatePresence mode="wait">
        <motion.article
          key={active.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="glass rounded-panel min-w-0 p-6 sm:p-8"
        >
          <header className="border-line border-b pb-5">
            <div className="text-ink-faint flex items-center gap-2">
              <FileText className="size-4" aria-hidden="true" />
              <span className="text-eyebrow uppercase">
                {active.provenance === 'ai' ? 'AI enriched' : 'Derived from analysis'}
              </span>
            </div>
            <h3 className="text-ink mt-2.5 text-2xl font-semibold tracking-tight">
              {active.title}
            </h3>
            <p className="text-ink-muted mt-1.5 text-sm">{active.summary}</p>
          </header>

          <div className="mt-6">
            <Markdown fileHref={(path, line) => fileHref(analysisId, path, line)}>
              {active.markdown}
            </Markdown>
          </div>

          {active.citations.length > 0 && (
            <CitationList
              analysisId={analysisId}
              citations={active.citations}
              className="border-line mt-8 border-t pt-6"
            />
          )}
        </motion.article>
      </AnimatePresence>
    </div>
  );
}

/** Deep link into the search tab, pre-filtered to a file. */
export function fileHref(analysisId: string, path: string, line?: number): string {
  const params = new URLSearchParams({ q: path });
  if (line !== undefined) params.set('line', String(line));
  return `/r/${analysisId}/search?${params.toString()}`;
}
