'use client';

import { ArrowUp, Eraser, Sparkles, Square, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { CitationList } from '@/features/knowledge/citation-list';
import { fileHref } from '@/features/knowledge/knowledge-browser';
import { cn } from '@/lib/cn';
import { useChat, type ChatTurn } from './use-chat';

const STARTERS = [
  'What does this project do?',
  'Where is authentication implemented?',
  'What starts the application?',
  'How do I run this locally?',
  'Explain the data flow',
  'What are the biggest risks in this codebase?',
];

export function ChatPanel({ analysisId, repoName }: { analysisId: string; repoName: string }) {
  const { turns, busy, provider, send, stop, clear } = useChat(analysisId);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Follow the stream, but only when the user is already near the bottom —
  // yanking the viewport while they are reading an earlier answer is hostile.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    if (nearBottom) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft.trim() || busy) return;
    void send(draft);
    setDraft('');
    // Reset the autosized height along with the value.
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline — the convention every
    // developer already has in their fingers.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="glass rounded-panel mt-6 flex h-[min(70vh,44rem)] flex-col overflow-hidden">
      {/* Header --------------------------------------------------------- */}
      <div className="border-line flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="text-ink-subtle flex min-w-0 items-center gap-2 text-xs">
          <Sparkles className="text-jade size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {provider
              ? provider.generative
                ? `Answering with ${provider.label}`
                : 'Answering from local analysis — no model configured'
              : `Ask anything about ${repoName}`}
          </span>
        </div>

        {turns.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clear} className="shrink-0">
            <Eraser className="size-3.5" aria-hidden="true" />
            <span className="sr-only sm:not-sr-only">Clear</span>
          </Button>
        )}
      </div>

      {/* Transcript ------------------------------------------------------ */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-5"
        role="log"
        aria-live="polite"
      >
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-ink-muted max-w-md text-sm leading-relaxed">
              Every answer is grounded in this repository’s indexed source and cites the files it
              used. Start with one of these:
            </p>
            <div className="mt-5 flex max-w-lg flex-wrap justify-center gap-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => void send(starter)}
                  className="border-line text-ink-subtle hover:border-jade/40 hover:bg-surface hover:text-ink rounded-full border px-3 py-1.5 text-xs transition-colors"
                >
                  {starter}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="space-y-6">
            {turns.map((turn) => (
              <li key={turn.id}>
                <Turn turn={turn} analysisId={analysisId} />
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Composer -------------------------------------------------------- */}
      <form onSubmit={submit} className="border-line border-t p-3">
        <div className="border-line bg-surface/60 focus-within:border-jade/50 flex items-end gap-2 rounded-xl border px-3 py-2">
          <label htmlFor="chat-input" className="sr-only">
            Ask a question about this repository
          </label>
          <textarea
            id="chat-input"
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              const el = event.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask about this codebase…"
            className="text-ink placeholder:text-ink-faint max-h-40 min-h-6 w-full resize-none bg-transparent text-sm focus:outline-none"
          />

          {busy ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={stop}
              aria-label="Stop generating"
            >
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!draft.trim()} aria-label="Send question">
              <ArrowUp className="size-4" aria-hidden="true" />
            </Button>
          )}
        </div>
        <p className="text-ink-faint mt-1.5 px-1 text-[11px]">
          Enter to send · Shift + Enter for a new line
        </p>
      </form>
    </div>
  );
}

function Turn({ turn, analysisId }: { turn: ChatTurn; analysisId: string }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="border-line bg-surface text-ink max-w-[85%] rounded-2xl rounded-br-md border px-3.5 py-2.5 text-sm whitespace-pre-wrap">
          {turn.content}
        </p>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {turn.citations.length > 0 && (
        <CitationList analysisId={analysisId} citations={turn.citations} className="mb-4" />
      )}

      {turn.content ? (
        <Markdown fileHref={(path, line) => fileHref(analysisId, path, line)}>
          {turn.content}
        </Markdown>
      ) : (
        !turn.error && (
          <span className="text-ink-faint inline-flex items-center gap-1.5 text-sm">
            <span className="bg-jade size-1.5 animate-pulse rounded-full" aria-hidden="true" />
            Reading the repository…
          </span>
        )
      )}

      {turn.streaming && turn.content && (
        <span
          className="bg-jade ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm"
          aria-hidden="true"
        />
      )}

      {turn.error && (
        <p
          className={cn(
            'border-bad/30 bg-bad/10 text-ink mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
          )}
          role="alert"
        >
          <TriangleAlert className="text-bad mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {turn.error}
        </p>
      )}
    </div>
  );
}
