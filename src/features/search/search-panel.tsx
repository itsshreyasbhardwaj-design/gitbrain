'use client';

import { Loader2, Search as SearchIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CodeBlock } from '@/components/code-block';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/cn';

interface Match {
  startLine: number;
  endLine: number;
  language: string;
  text: string;
  highlights: [number, number][];
  score: number;
}

interface Group {
  file: string;
  score: number;
  matches: Match[];
}

const SUGGESTIONS = [
  'Where is authentication implemented?',
  'Explain routing',
  'What starts the application?',
  'Where is user validation?',
  'How is the database configured?',
  'Where are errors handled?',
];

export function SearchPanel({ analysisId }: { analysisId: string }) {
  const params = useSearchParams();
  const initial = params.get('q') ?? '';

  const [query, setQuery] = useState(initial);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setGroups(null);
        setError(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/search?id=${encodeURIComponent(analysisId)}&q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(body?.error?.message ?? `Search failed (${response.status}).`);
          setGroups(null);
          return;
        }

        const data = (await response.json()) as { groups: Group[] };
        setGroups(data.groups);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Search failed.');
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    },
    [analysisId],
  );

  // Debounce so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void run(query), query === initial ? 0 : 220);
    return () => clearTimeout(timer);
  }, [query, initial, run]);

  const totalMatches = groups?.reduce((sum, group) => sum + group.matches.length, 0) ?? 0;

  return (
    <div className="mt-6">
      <div className="glass rounded-panel flex items-center gap-2.5 px-4 py-3">
        {loading ? (
          <Loader2 className="text-jade size-4 shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <SearchIcon className="text-ink-faint size-4 shrink-0" aria-hidden="true" />
        )}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Ask a question, or search for a symbol…"
          aria-label="Search the repository"
          autoComplete="off"
          spellCheck={false}
          className="text-ink placeholder:text-ink-faint h-6 w-full bg-transparent text-[15px] focus:outline-none"
        />
      </div>

      {!query.trim() && (
        <div className="mt-5 flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setQuery(suggestion)}
              className="border-line text-ink-subtle hover:border-line-strong hover:bg-surface hover:text-ink rounded-full border px-3 py-1.5 text-xs transition-colors"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="border-bad/30 bg-bad/10 mt-5 rounded-lg border px-3.5 py-3 text-sm"
        >
          {error}
        </p>
      )}

      {groups && (
        <div className="mt-6">
          <p className="text-ink-subtle text-sm" role="status" aria-live="polite">
            {totalMatches === 0
              ? `No matches for “${query.trim()}”.`
              : `${totalMatches} ${totalMatches === 1 ? 'match' : 'matches'} across ${groups.length} ${groups.length === 1 ? 'file' : 'files'}.`}
          </p>

          {groups.length === 0 && (
            <EmptyState
              className="mt-6"
              icon={<SearchIcon />}
              title="Nothing matched"
              description="Try a symbol name, a file path, or a broader phrase. Search is lexical, so exact identifiers work best."
            />
          )}

          <ol className="mt-4 space-y-5">
            {groups.map((group) => (
              <li key={group.file}>
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-ink min-w-0 font-mono text-[13px]">
                    <span className="truncate">{group.file}</span>
                  </h3>
                  <span className="text-ink-faint shrink-0 text-[11px] tabular-nums">
                    {group.matches.length} {group.matches.length === 1 ? 'match' : 'matches'}
                  </span>
                </div>

                <div className="mt-2 space-y-2">
                  {group.matches.slice(0, 3).map((match) => (
                    <CodeBlock
                      key={`${group.file}:${match.startLine}`}
                      code={match.text}
                      language={match.language}
                      startLine={match.startLine}
                      maxHeight="20rem"
                    />
                  ))}
                </div>

                {group.matches.length > 3 && (
                  <p className={cn('text-ink-faint mt-1.5 text-[11px]')}>
                    {group.matches.length - 3} further{' '}
                    {group.matches.length - 3 === 1 ? 'match' : 'matches'} in this file.
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
