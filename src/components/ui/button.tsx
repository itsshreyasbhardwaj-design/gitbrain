'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * Buttons are the only place in the product where jade is used as a fill
 * rather than as an accent, which is what makes a primary action unmistakable.
 * Everything else is a hairline on a translucent surface.
 */
export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap',
    'rounded-lg border font-medium select-none',
    'transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-(--ease-out-quint)',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-jade',
    'disabled:pointer-events-none disabled:opacity-45',
    'aria-disabled:pointer-events-none aria-disabled:opacity-45',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'border-jade-600/50 bg-jade text-canvas hover:bg-jade-400 hover:shadow-glow active:bg-jade-600',
        secondary:
          'border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-hover active:bg-surface',
        ghost: 'border-transparent bg-transparent text-ink-muted hover:bg-surface hover:text-ink',
        outline:
          'border-line-strong bg-transparent text-ink hover:border-jade/60 hover:bg-jade/5 hover:text-jade-200',
        danger: 'border-bad/50 bg-bad/12 text-bad hover:border-bad/70 hover:bg-bad/20',
      },
      size: {
        sm: 'h-8 gap-1.5 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-9 px-3.5 text-sm [&_svg]:size-4',
        lg: 'h-11 px-5 text-[0.9375rem] [&_svg]:size-[1.125rem]',
        icon: 'size-9 p-0 [&_svg]:size-4',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Render the child element instead of a `<button>`, keeping all styling. */
  asChild?: boolean;
  /**
   * Shows a spinner, disables the control and marks it `aria-busy`. The label
   * stays in place so the button does not resize mid-action.
   */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  const isDisabled = Boolean(disabled) || loading;

  return (
    <Comp
      // `asChild` hands styling to an arbitrary element (often an anchor) which
      // has no `disabled`, so express the state with ARIA there instead.
      {...(asChild ? { 'aria-disabled': isDisabled || undefined } : { disabled: isDisabled })}
      aria-busy={loading || undefined}
      data-loading={loading ? '' : undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
          {children}
        </>
      )}
    </Comp>
  );
}
