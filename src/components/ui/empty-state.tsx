import type * as React from 'react';

import { cn } from '@/lib/cn';

export interface EmptyStateProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  /** Decorative glyph, usually a lucide icon. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary recovery action, typically a `<Button>`. */
  action?: React.ReactNode;
}

/**
 * The one place the hero grid is reused: an empty pane should still feel like
 * part of the product rather than a hole in it.
 */
export function EmptyState({
  className,
  icon,
  title,
  description,
  action,
  children,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'grid-backdrop rounded-panel border-line relative flex flex-col items-center justify-center',
        'gap-3 border border-dashed px-6 py-14 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="border-line bg-surface text-ink-faint mb-1 flex size-11 items-center justify-center rounded-xl border [&_svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <p className="text-ink text-[0.9375rem] font-semibold -tracking-[0.01em]">{title}</p>
      {description ? (
        <p className="text-ink-subtle max-w-sm text-sm leading-relaxed text-balance">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2 flex items-center gap-2">{action}</div> : null}
      {children}
    </div>
  );
}
