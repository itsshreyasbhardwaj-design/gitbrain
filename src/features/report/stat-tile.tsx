import type * as React from 'react';

import { cn } from '@/lib/cn';
import { TONE_TEXT, type Tone } from './grade';

export interface StatTileProps {
  /** Short noun, e.g. "Files". Sentence case, never a sentence. */
  label: string;
  /** Pre-formatted figure. Formatting belongs to the caller so the tile stays dumb. */
  value: string;
  /**
   * Secondary line. When `tone` is set this is not optional in spirit: colour
   * alone must never carry meaning, so the hint is what a screen reader — or a
   * reader who cannot distinguish amber from red — actually gets.
   */
  hint?: string;
  tone?: Tone;
  /** Decorative lucide glyph. Never the sole carrier of meaning. */
  icon?: React.ReactNode;
}

/**
 * One figure in the overview grid.
 *
 * Deliberately not a `Card`: forty of these on a page, each with a blur and a
 * drop shadow, turns a dashboard into soup. A hairline and a flat surface is
 * enough separation at this density.
 */
export function StatTile({ label, value, hint, tone = 'neutral', icon }: StatTileProps) {
  return (
    <div className="border-line bg-surface/40 flex flex-col gap-1 rounded-xl border p-3.5">
      <div className="text-ink-faint flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wide uppercase">
        {icon ? (
          <span aria-hidden="true" className="[&_svg]:size-3.5">
            {icon}
          </span>
        ) : null}
        <span className="truncate">{label}</span>
      </div>

      <p
        className={cn(
          'text-2xl leading-none font-semibold -tracking-[0.02em] tabular-nums',
          tone === 'neutral' ? 'text-ink' : TONE_TEXT[tone],
        )}
      >
        {value}
      </p>

      {hint ? (
        <p
          className={cn(
            'text-xs leading-snug',
            tone === 'neutral' ? 'text-ink-faint' : TONE_TEXT[tone],
          )}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
