import type * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * A loading placeholder. It is `aria-hidden` and paired with a `sr-only` status
 * message so assistive tech hears "loading" once instead of reading a wall of
 * empty boxes — the shimmer alone must never be the only signal.
 */
export interface SkeletonProps extends React.ComponentProps<'div'> {
  /** Announced to screen readers while the placeholder is visible. */
  label?: string;
}

export function Skeleton({ className, label, ...props }: SkeletonProps) {
  return (
    <>
      {label ? (
        <span role="status" className="sr-only">
          {label}
        </span>
      ) : null}
      <div
        aria-hidden="true"
        className={cn('bg-surface animate-shimmer h-4 w-full rounded-md', className)}
        {...props}
      />
    </>
  );
}
