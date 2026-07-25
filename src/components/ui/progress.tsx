import * as ProgressPrimitive from '@radix-ui/react-progress';
import type * as React from 'react';

import { cn } from '@/lib/cn';

export type ProgressTone = 'jade' | 'good' | 'fair' | 'warn' | 'bad';

const TONE_CLASS: Record<ProgressTone, string> = {
  jade: 'bg-jade',
  good: 'bg-good',
  fair: 'bg-fair',
  warn: 'bg-warn',
  bad: 'bg-bad',
};

export interface ProgressProps extends React.ComponentProps<typeof ProgressPrimitive.Root> {
  /** Colour of the filled portion. Defaults to the product accent. */
  tone?: ProgressTone;
  /**
   * Accessible name. Required unless the bar is already labelled by adjacent
   * text through `aria-labelledby`.
   */
  'aria-label'?: string;
}

/**
 * Radix emits `role="progressbar"` with the correct `aria-valuenow` /
 * `aria-valuemax`, including the indeterminate case when `value` is `null`.
 * The bar is a `scaleX` transform so the browser can composite the transition.
 */
export function Progress({ className, value, max = 100, tone = 'jade', ...props }: ProgressProps) {
  const percent = value == null ? null : Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <ProgressPrimitive.Root
      value={value}
      max={max}
      className={cn('bg-surface relative h-1.5 w-full overflow-hidden rounded-full', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full w-full origin-left rounded-full',
          'transition-transform duration-500 ease-(--ease-out-quint)',
          TONE_CLASS[tone],
          percent == null && 'animate-shimmer',
        )}
        style={{ transform: `scaleX(${(percent ?? 100) / 100})` }}
      />
    </ProgressPrimitive.Root>
  );
}
