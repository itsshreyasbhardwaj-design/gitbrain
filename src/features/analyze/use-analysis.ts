'use client';

import { useCallback, useRef, useState } from 'react';

import type { AnalysisStage, ProgressEvent } from '@/core/types';

/** A terminal `result` frame carrying the id to navigate to. */
interface ResultEvent {
  readonly stage: 'result';
  readonly id: string;
}

type StreamEvent = ProgressEvent | ResultEvent;

function isResult(event: StreamEvent): event is ResultEvent {
  return event.stage === 'result';
}

export interface AnalysisState {
  readonly status: 'idle' | 'running' | 'error' | 'done';
  readonly stage: AnalysisStage;
  readonly percent: number;
  readonly message: string;
  readonly error: string | null;
  readonly id: string | null;
}

const IDLE: AnalysisState = {
  status: 'idle',
  stage: 'queued',
  percent: 0,
  message: '',
  error: null,
  id: null,
};

/**
 * Drives an analysis run against the NDJSON progress stream.
 *
 * The endpoint answers 200 immediately and reports failure inside the stream,
 * because once bytes are on the wire an HTTP status can no longer change. So
 * this hook treats a terminal `error` stage as the real failure signal and
 * only falls back to HTTP status for failures that happen before the stream
 * opens (rate limiting, validation).
 */
export function useAnalysis() {
  const [state, setState] = useState<AnalysisState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  const run = useCallback(async (init: RequestInit): Promise<string | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({
      status: 'running',
      stage: 'queued',
      percent: 2,
      message: 'Starting analysis…',
      error: null,
      id: null,
    });

    try {
      const response = await fetch('/api/analyze', { ...init, signal: controller.signal });

      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => null);
        const message =
          (body as { error?: { message?: string } } | null)?.error?.message ??
          `The server responded with ${response.status}.`;
        setState({ ...IDLE, status: 'error', stage: 'error', error: message, percent: 100 });
        return null;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let resolvedId: string | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // The final element may be a partial line; keep it for the next read.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(line) as StreamEvent;
          } catch {
            continue;
          }

          if (isResult(event)) {
            resolvedId = event.id;
            setState({
              status: 'done',
              stage: 'done',
              percent: 100,
              message: 'Analysis complete.',
              error: null,
              id: event.id,
            });
            continue;
          }

          if (event.stage === 'error') {
            setState({
              status: 'error',
              stage: 'error',
              percent: 100,
              message: '',
              error: event.message,
              id: null,
            });
            return null;
          }

          setState((current) => ({
            ...current,
            status: 'running',
            stage: event.stage,
            // Progress must never move backwards; out-of-order frames would
            // otherwise make the bar visibly stutter.
            percent: Math.max(current.percent, event.percent),
            message: event.message,
          }));
        }
      }

      return resolvedId;
    } catch (error) {
      if (controller.signal.aborted) {
        setState(IDLE);
        return null;
      }

      setState({
        ...IDLE,
        status: 'error',
        stage: 'error',
        percent: 100,
        error:
          error instanceof Error
            ? `Could not reach the server: ${error.message}`
            : 'Could not reach the server.',
      });
      return null;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const analyzeUrl = useCallback(
    (url: string) =>
      run({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }),
    [run],
  );

  const analyzeFile = useCallback(
    (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return run({ method: 'POST', body: form });
    },
    [run],
  );

  return { state, analyzeUrl, analyzeFile, reset };
}

/** Human-readable label for each pipeline stage. */
export const STAGE_LABELS: Record<AnalysisStage, string> = {
  queued: 'Queued',
  fetching: 'Fetching repository',
  unpacking: 'Unpacking archive',
  scanning: 'Reading file tree',
  detecting: 'Detecting stack',
  graphing: 'Building module graph',
  measuring: 'Measuring complexity',
  securing: 'Scanning for risks',
  scoring: 'Scoring health',
  synthesizing: 'Writing knowledge base',
  indexing: 'Indexing for search',
  done: 'Complete',
  error: 'Failed',
};

/** Ordered stages, used to render the progress checklist. */
export const STAGE_ORDER: readonly AnalysisStage[] = [
  'fetching',
  'unpacking',
  'scanning',
  'detecting',
  'graphing',
  'measuring',
  'securing',
  'scoring',
  'indexing',
  'synthesizing',
];
