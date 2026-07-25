'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, ArrowRight, Check, Loader2, Search, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { STAGE_LABELS, STAGE_ORDER, useAnalysis } from './use-analysis';

const EXAMPLES = [
  { label: 'honojs/hono', url: 'https://github.com/honojs/hono' },
  { label: 'colinhacks/zod', url: 'https://github.com/colinhacks/zod' },
  { label: 'pallets/flask', url: 'https://github.com/pallets/flask' },
  { label: 'sindresorhus/ky', url: 'https://github.com/sindresorhus/ky' },
];

export function AnalyzeForm() {
  const router = useRouter();
  const { state, analyzeUrl, analyzeFile, reset } = useAnalysis();

  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const running = state.status === 'running';

  const go = useCallback(
    async (promise: Promise<string | null>) => {
      const id = await promise;
      if (id) router.push(`/r/${id}`);
    },
    [router],
  );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setFileError(null);
    if (!url.trim() || running) return;
    void go(analyzeUrl(url.trim()));
  };

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setFileError(null);

      if (!/\.zip$/i.test(file.name)) {
        setFileError('Only .zip archives are supported.');
        return;
      }
      if (file.size > 60 * 1024 * 1024) {
        setFileError(
          `That archive is ${(file.size / 1_048_576).toFixed(0)} MB. The limit is 60 MB.`,
        );
        return;
      }

      void go(analyzeFile(file));
    },
    [analyzeFile, go],
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (running) return;
    onFile(event.dataTransfer.files[0]);
  };

  return (
    <div
      className="w-full"
      onDragOver={(event) => {
        event.preventDefault();
        if (!running) setDragging(true);
      }}
      onDragLeave={(event) => {
        // Only clear when the pointer actually leaves the drop zone, not when
        // it crosses onto a child element.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <form onSubmit={onSubmit} className="w-full">
        <label htmlFor={inputId} className="sr-only">
          GitHub repository URL
        </label>

        <div
          className={cn(
            'glass rounded-panel flex flex-col gap-2 p-2 transition-all duration-200 sm:flex-row sm:items-center',
            dragging && 'border-jade shadow-glow',
          )}
        >
          <div className="flex flex-1 items-center gap-2.5 px-2">
            <Search className="text-ink-faint size-4 shrink-0" aria-hidden="true" />
            <input
              id={inputId}
              type="text"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={running}
              placeholder="github.com/owner/repo"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby={`${inputId}-hint`}
              className="text-ink placeholder:text-ink-faint h-10 w-full min-w-0 bg-transparent text-[15px] focus:outline-none disabled:opacity-50"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              onChange={(event) => onFile(event.target.files?.[0])}
              tabIndex={-1}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={running}
              onClick={() => fileInputRef.current?.click()}
              className="shrink-0"
            >
              <Upload className="size-4" aria-hidden="true" />
              <span className="sm:sr-only lg:not-sr-only">Upload ZIP</span>
            </Button>

            <Button
              type="submit"
              disabled={running || !url.trim()}
              loading={running}
              className="shrink-0"
            >
              Analyze
              {!running && <ArrowRight className="size-4" aria-hidden="true" />}
            </Button>
          </div>
        </div>
      </form>

      <p id={`${inputId}-hint`} className="text-ink-faint mt-3 px-1 text-xs">
        Public repositories only. Or drop a <code className="font-mono">.zip</code> anywhere on this
        panel to analyze a local project — nothing is uploaded to a third party.
      </p>

      {/* Examples ------------------------------------------------------- */}
      {!running && state.status !== 'done' && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-ink-faint text-xs">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.url}
              type="button"
              onClick={() => {
                setUrl(example.url);
                void go(analyzeUrl(example.url));
              }}
              className="border-line text-ink-subtle hover:border-line-strong hover:bg-surface hover:text-ink rounded-full border px-2.5 py-1 font-mono text-xs transition-colors"
            >
              {example.label}
            </button>
          ))}
        </div>
      )}

      {/* Errors ---------------------------------------------------------- */}
      <AnimatePresence>
        {(state.error || fileError) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            role="alert"
            className="border-bad/30 bg-bad/10 mt-4 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm"
          >
            <AlertCircle className="text-bad mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-ink">{state.error ?? fileError}</p>
              {state.error && (
                <button
                  type="button"
                  onClick={reset}
                  className="text-ink-subtle hover:text-ink mt-1.5 text-xs underline underline-offset-2"
                >
                  Dismiss
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Progress -------------------------------------------------------- */}
      <AnimatePresence>{running && <ProgressPanel state={state} />}</AnimatePresence>
    </div>
  );
}

function ProgressPanel({ state }: { state: ReturnType<typeof useAnalysis>['state'] }) {
  const currentIndex = STAGE_ORDER.indexOf(state.stage);

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="mt-5 overflow-hidden"
    >
      <div className="glass rounded-panel p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <Loader2 className="text-jade size-4 shrink-0 animate-spin" aria-hidden="true" />
            <span className="text-ink truncate text-sm">{state.message || 'Working…'}</span>
          </div>
          <span className="text-ink-subtle shrink-0 font-mono text-xs tabular-nums">
            {Math.round(state.percent)}%
          </span>
        </div>

        <div
          className="bg-surface mt-3.5 h-1 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuenow={Math.round(state.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Analysis progress"
        >
          <motion.div
            className="from-jade-600 to-jade h-full rounded-full bg-gradient-to-r"
            animate={{ width: `${state.percent}%` }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>

        <ol className="mt-4 grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-5">
          {STAGE_ORDER.map((stage, index) => {
            const done = currentIndex > index;
            const active = currentIndex === index;

            return (
              <li
                key={stage}
                className={cn(
                  'flex items-center gap-1.5 text-[11px] transition-colors',
                  done && 'text-ink-subtle',
                  active && 'text-jade',
                  !done && !active && 'text-ink-faint',
                )}
              >
                {done ? (
                  <Check className="size-3 shrink-0" aria-hidden="true" />
                ) : (
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      active ? 'bg-jade animate-pulse' : 'bg-ink-faint/40',
                    )}
                    aria-hidden="true"
                  />
                )}
                <span className="truncate">{STAGE_LABELS[stage]}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </motion.div>
  );
}
