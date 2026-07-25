import type * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * The panel every surface in GitBrain is built from. `.glass` supplies the
 * translucent fill, blur and lit top edge; this only adds geometry.
 */
export function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('glass rounded-panel overflow-hidden', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 px-5 pt-5 pb-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return (
    <h3
      className={cn(
        'text-ink text-[0.9375rem] leading-tight font-semibold -tracking-[0.01em]',
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-ink-subtle text-sm leading-relaxed', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('border-line flex items-center gap-2 border-t px-5 py-3.5', className)}
      {...props}
    />
  );
}
