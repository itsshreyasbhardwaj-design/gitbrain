'use client';

import { useCallback, useRef, useState } from 'react';

import type { Citation } from '@/core/types';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  /** True while this assistant turn is still receiving tokens. */
  streaming: boolean;
  error?: string;
}

interface ProviderFrame {
  type: 'provider';
  id: string;
  label: string;
  generative: boolean;
}

type Frame =
  | ProviderFrame
  | { type: 'citations'; citations: Citation[] }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

let turnCounter = 0;
const nextId = () => `turn-${++turnCounter}`;

/**
 * Chat state machine over the NDJSON stream.
 *
 * The assistant turn is created empty and mutated in place as frames arrive,
 * so the UI can render a cursor and citations before the first token — which
 * makes the wait feel like work rather than a hang.
 */
export function useChat(analysisId: string) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderFrame | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setTurns((current) =>
      current.map((turn) => (turn.streaming ? { ...turn, streaming: false } : turn)),
    );
  }, []);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || busy) return;

      const userTurn: ChatTurn = {
        id: nextId(),
        role: 'user',
        content: trimmed,
        citations: [],
        streaming: false,
      };
      const assistantId = nextId();
      const assistantTurn: ChatTurn = {
        id: assistantId,
        role: 'assistant',
        content: '',
        citations: [],
        streaming: true,
      };

      // Capture history before this exchange; the server does not persist it.
      const history = turns
        .filter((turn) => !turn.error)
        .map((turn) => ({ role: turn.role, content: turn.content }));

      setTurns((current) => [...current, userTurn, assistantTurn]);
      setBusy(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const patch = (updater: (turn: ChatTurn) => ChatTurn) => {
        setTurns((current) =>
          current.map((turn) => (turn.id === assistantId ? updater(turn) : turn)),
        );
      };

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ analysisId, question: trimmed, history }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          patch((turn) => ({
            ...turn,
            streaming: false,
            error: body?.error?.message ?? `The server responded with ${response.status}.`,
          }));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;

            let frame: Frame;
            try {
              frame = JSON.parse(line) as Frame;
            } catch {
              continue;
            }

            switch (frame.type) {
              case 'provider':
                setProvider(frame);
                break;
              case 'citations':
                patch((turn) => ({ ...turn, citations: frame.citations }));
                break;
              case 'text':
                patch((turn) => ({ ...turn, content: turn.content + frame.text }));
                break;
              case 'error':
                patch((turn) => ({ ...turn, streaming: false, error: frame.message }));
                break;
              case 'done':
                patch((turn) => ({ ...turn, streaming: false }));
                break;
            }
          }
        }

        patch((turn) => ({ ...turn, streaming: false }));
      } catch (cause) {
        if (!controller.signal.aborted) {
          patch((turn) => ({
            ...turn,
            streaming: false,
            error: cause instanceof Error ? cause.message : 'The request failed.',
          }));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      }
    },
    [analysisId, busy, turns],
  );

  const clear = useCallback(() => {
    stop();
    setTurns([]);
  }, [stop]);

  return { turns, busy, provider, send, stop, clear };
}
