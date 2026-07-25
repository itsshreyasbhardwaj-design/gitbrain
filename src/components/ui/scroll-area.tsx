'use client';

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type * as React from 'react';

import { cn } from '@/lib/cn';

export interface ScrollAreaProps extends React.ComponentProps<typeof ScrollAreaPrimitive.Root> {
  /** Class names applied to the scrolling viewport rather than the wrapper. */
  viewportClassName?: string;
  orientation?: 'vertical' | 'horizontal' | 'both';
}

/**
 * The viewport keeps a real focus outline (no `overflow` clipping surprises)
 * and stays keyboard scrollable, so long panes work without a mouse.
 */
export function ScrollArea({
  className,
  viewportClassName,
  orientation = 'vertical',
  children,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      scrollHideDelay={400}
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn(
          'size-full rounded-[inherit]',
          'focus-visible:outline-jade focus-visible:outline-2 focus-visible:outline-offset-[-2px]',
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {orientation !== 'horizontal' ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== 'vertical' ? <ScrollBar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export type ScrollBarProps = React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>;

export function ScrollBar({ className, orientation = 'vertical', ...props }: ScrollBarProps) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation={orientation}
      className={cn(
        'flex touch-none p-0.5 transition-opacity duration-200 ease-(--ease-out-quint) select-none',
        'data-[state=hidden]:opacity-0',
        orientation === 'vertical' ? 'h-full w-2.5 border-l border-l-transparent' : '',
        orientation === 'horizontal' ? 'h-2.5 flex-col border-t border-t-transparent' : '',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-white/12 transition-colors hover:bg-white/20" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}
