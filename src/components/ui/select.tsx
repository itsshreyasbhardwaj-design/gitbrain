'use client';

import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
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

export type SelectProps = React.ComponentProps<typeof SelectPrimitive.Root>;

export function Select({ children, ...props }: SelectProps) {
  return (
    <SelectPrimitive.Root {...props}>
      <OverlayMotionStyles />
      {children}
    </SelectPrimitive.Root>
  );
}

export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export type SelectTriggerProps = React.ComponentProps<typeof SelectPrimitive.Trigger>;

export function SelectTrigger({ className, children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'border-line bg-canvas-raised text-ink flex h-9 w-full items-center justify-between gap-2',
        'rounded-lg border px-3 text-sm whitespace-nowrap',
        'transition-[border-color,background-color] duration-150 ease-(--ease-out-quint)',
        'hover:border-line-strong',
        'focus-visible:border-jade/60 focus-visible:outline-jade focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'data-placeholder:text-ink-faint',
        'aria-[invalid=true]:border-bad/70',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden="true" className="text-ink-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export type SelectContentProps = React.ComponentProps<typeof SelectPrimitive.Content>;

export function SelectContent({
  className,
  children,
  position = 'popper',
  sideOffset = 6,
  ...props
}: SelectContentProps) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={sideOffset}
        className={cn(
          'glass rounded-panel z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden',
          'origin-(--radix-select-content-transform-origin)',
          'data-[state=open]:animate-[gb-pop-in_150ms_var(--ease-out-quint)]',
          'data-[state=closed]:animate-[gb-pop-out_120ms_var(--ease-out-quint)]',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="text-ink-faint flex h-6 items-center justify-center">
          <ChevronUp aria-hidden="true" className="size-3.5" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="max-h-72 p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="text-ink-faint flex h-6 items-center justify-center">
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export type SelectLabelProps = React.ComponentProps<typeof SelectPrimitive.Label>;

export function SelectLabel({ className, ...props }: SelectLabelProps) {
  return (
    <SelectPrimitive.Label
      className={cn('text-ink-faint text-eyebrow px-2 pt-2 pb-1 uppercase', className)}
      {...props}
    />
  );
}

export type SelectItemProps = React.ComponentProps<typeof SelectPrimitive.Item>;

export function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'text-ink-muted relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-7 pl-2 text-sm',
        'transition-colors duration-100 ease-(--ease-out-quint) outline-none select-none',
        'data-highlighted:bg-surface-hover data-highlighted:text-ink',
        'data-[state=checked]:text-ink',
        'data-disabled:pointer-events-none data-disabled:opacity-45',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="text-jade size-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

export type SelectSeparatorProps = React.ComponentProps<typeof SelectPrimitive.Separator>;

export function SelectSeparator({ className, ...props }: SelectSeparatorProps) {
  return (
    <SelectPrimitive.Separator className={cn('bg-line -mx-1 my-1 h-px', className)} {...props} />
  );
}
