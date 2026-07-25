'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';
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

const surfaceClasses = [
  'glass rounded-panel z-50 min-w-44 overflow-hidden p-1',
  'data-[state=open]:animate-[gb-pop-in_150ms_var(--ease-out-quint)]',
  'data-[state=closed]:animate-[gb-pop-out_120ms_var(--ease-out-quint)]',
];

const itemClasses = [
  'text-ink-muted relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm',
  'transition-colors duration-100 ease-(--ease-out-quint) outline-none select-none',
  'data-highlighted:bg-surface-hover data-highlighted:text-ink',
  'data-disabled:pointer-events-none data-disabled:opacity-45',
  '[&_svg]:size-4 [&_svg]:shrink-0',
];

export type DropdownMenuProps = React.ComponentProps<typeof DropdownMenuPrimitive.Root>;

export function DropdownMenu({ children, ...props }: DropdownMenuProps) {
  return (
    <DropdownMenuPrimitive.Root {...props}>
      <OverlayMotionStyles />
      {children}
    </DropdownMenuPrimitive.Root>
  );
}

export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export type DropdownMenuContentProps = React.ComponentProps<typeof DropdownMenuPrimitive.Content>;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: DropdownMenuContentProps) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          surfaceClasses,
          'origin-(--radix-dropdown-menu-content-transform-origin)',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export interface DropdownMenuItemProps extends React.ComponentProps<
  typeof DropdownMenuPrimitive.Item
> {
  /** Adds left padding so the label lines up with checkbox/radio rows. */
  inset?: boolean;
  /** Renders the row in the destructive tone. */
  destructive?: boolean;
}

export function DropdownMenuItem({
  className,
  inset,
  destructive,
  ...props
}: DropdownMenuItemProps) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        itemClasses,
        inset && 'pl-8',
        destructive && 'text-bad data-highlighted:bg-bad/12 data-highlighted:text-bad',
        className,
      )}
      {...props}
    />
  );
}

export type DropdownMenuCheckboxItemProps = React.ComponentProps<
  typeof DropdownMenuPrimitive.CheckboxItem
>;

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: DropdownMenuCheckboxItemProps) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn(itemClasses, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="text-jade size-3.5" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export type DropdownMenuRadioItemProps = React.ComponentProps<
  typeof DropdownMenuPrimitive.RadioItem
>;

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: DropdownMenuRadioItemProps) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(itemClasses, 'pl-8', className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle aria-hidden="true" className="fill-jade text-jade size-2" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export interface DropdownMenuLabelProps extends React.ComponentProps<
  typeof DropdownMenuPrimitive.Label
> {
  inset?: boolean;
}

export function DropdownMenuLabel({ className, inset, ...props }: DropdownMenuLabelProps) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        'text-ink-faint text-eyebrow px-2 pt-2 pb-1 uppercase',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  );
}

export type DropdownMenuSeparatorProps = React.ComponentProps<
  typeof DropdownMenuPrimitive.Separator
>;

export function DropdownMenuSeparator({ className, ...props }: DropdownMenuSeparatorProps) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('bg-line -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('text-ink-faint ml-auto font-mono text-xs tracking-widest', className)}
      {...props}
    />
  );
}

export interface DropdownMenuSubTriggerProps extends React.ComponentProps<
  typeof DropdownMenuPrimitive.SubTrigger
> {
  inset?: boolean;
}

export function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: DropdownMenuSubTriggerProps) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(itemClasses, 'data-[state=open]:bg-surface-hover', inset && 'pl-8', className)}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="text-ink-faint ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export type DropdownMenuSubContentProps = React.ComponentProps<
  typeof DropdownMenuPrimitive.SubContent
>;

export function DropdownMenuSubContent({ className, ...props }: DropdownMenuSubContentProps) {
  return (
    <DropdownMenuPrimitive.SubContent
      className={cn(
        surfaceClasses,
        'origin-(--radix-dropdown-menu-content-transform-origin)',
        className,
      )}
      {...props}
    />
  );
}
