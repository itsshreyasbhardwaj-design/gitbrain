'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/cn';

/** See the note in `tooltip.tsx`; React dedupes this by `href`. */
const OVERLAY_MOTION_HREF = 'gitbrain-overlay-motion';
const OVERLAY_MOTION_KEYFRAMES = `
@keyframes gb-pop-in { from { opacity: 0; transform: scale(0.96) } to { opacity: 1; transform: none } }
@keyframes gb-pop-out { from { opacity: 1; transform: none } to { opacity: 0; transform: scale(0.96) } }
@keyframes gb-fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes gb-fade-out { from { opacity: 1 } to { opacity: 0 } }
`;

function OverlayMotionStyles() {
  return (
    <style href={OVERLAY_MOTION_HREF} precedence="medium">
      {OVERLAY_MOTION_KEYFRAMES}
    </style>
  );
}

export type DialogProps = React.ComponentProps<typeof DialogPrimitive.Root>;

export function Dialog({ children, ...props }: DialogProps) {
  return (
    <DialogPrimitive.Root {...props}>
      <OverlayMotionStyles />
      {children}
    </DialogPrimitive.Root>
  );
}

export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export type DialogOverlayProps = React.ComponentProps<typeof DialogPrimitive.Overlay>;

export function DialogOverlay({ className, ...props }: DialogOverlayProps) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/65 backdrop-blur-sm',
        'data-[state=open]:animate-[gb-fade-in_180ms_var(--ease-out-quint)]',
        'data-[state=closed]:animate-[gb-fade-out_140ms_var(--ease-out-quint)]',
        className,
      )}
      {...props}
    />
  );
}

export interface DialogContentProps extends React.ComponentProps<typeof DialogPrimitive.Content> {
  /**
   * Render the built-in close affordance. Turn it off only when the dialog
   * supplies its own — never to make the dialog unclosable.
   */
  showClose?: boolean;
  /** Accessible name for the close button. */
  closeLabel?: string;
}

/**
 * Radix handles focus trapping, focus restoration, `Escape`, outside-click
 * dismissal and `aria-modal` wiring. Everything below is presentation.
 */
export function DialogContent({
  className,
  children,
  showClose = true,
  closeLabel = 'Close dialog',
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'glass rounded-panel fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'flex w-[calc(100vw-2rem)] max-w-lg flex-col gap-4 p-6',
          'max-h-[calc(100dvh-4rem)] overflow-y-auto',
          'focus-visible:outline-none',
          'data-[state=open]:animate-[gb-pop-in_180ms_var(--ease-out-quint)]',
          'data-[state=closed]:animate-[gb-pop-out_140ms_var(--ease-out-quint)]',
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className={cn(
              'text-ink-subtle absolute top-4 right-4 inline-flex size-8 items-center justify-center rounded-md',
              'transition-colors duration-150 ease-(--ease-out-quint)',
              'hover:bg-surface-hover hover:text-ink',
              'focus-visible:outline-jade focus-visible:outline-2 focus-visible:outline-offset-2',
            )}
          >
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 pr-10', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export type DialogTitleProps = React.ComponentProps<typeof DialogPrimitive.Title>;

export function DialogTitle({ className, ...props }: DialogTitleProps) {
  return <DialogPrimitive.Title className={cn('text-ink text-heading', className)} {...props} />;
}

export type DialogDescriptionProps = React.ComponentProps<typeof DialogPrimitive.Description>;

export function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description
      className={cn('text-ink-subtle text-sm leading-relaxed', className)}
      {...props}
    />
  );
}
