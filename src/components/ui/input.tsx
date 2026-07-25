import type * as React from 'react';

import { cn } from '@/lib/cn';

export interface InputProps extends React.ComponentProps<'input'> {
  /**
   * Decorative glyph rendered inside the field. It is marked `aria-hidden`
   * because it never carries information the label does not already give.
   */
  icon?: React.ReactNode;
  /** Class names for the wrapper, when an `icon` creates one. */
  containerClassName?: string;
}

export function Input({ className, icon, containerClassName, ...props }: InputProps) {
  const field = (
    <input
      className={cn(
        'border-line bg-canvas-raised text-ink h-9 w-full rounded-lg border px-3 text-sm',
        'placeholder:text-ink-faint',
        'transition-[border-color,box-shadow,background-color] duration-150 ease-(--ease-out-quint)',
        'hover:border-line-strong',
        'focus-visible:border-jade/60 focus-visible:outline-jade focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'aria-[invalid=true]:border-bad/70 aria-[invalid=true]:focus-visible:outline-bad',
        icon ? 'pl-9' : undefined,
        className,
      )}
      {...props}
    />
  );

  if (!icon) return field;

  return (
    <div className={cn('relative w-full', containerClassName)}>
      <span
        aria-hidden="true"
        className="text-ink-faint pointer-events-none absolute inset-y-0 left-3 flex items-center [&_svg]:size-4"
      >
        {icon}
      </span>
      {field}
    </div>
  );
}
