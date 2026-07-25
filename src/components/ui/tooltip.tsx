'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * Radix unmounts floating content only once its exit *animation* finishes, so a
 * CSS transition is not enough — real `@keyframes` are required. `globals.css`
 * is the design system's shared contract and is not edited from here, so each
 * overlay module declares the frames it needs as a React 19 hoisted stylesheet.
 * React dedupes by `href`, so the byte-identical block in dialog / select /
 * dropdown-menu yields exactly one `<style>` element in the document.
 */
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

/** Shared enter/exit choreography for every floating surface. */
const overlayMotion = [
  'data-[state=open]:animate-[gb-pop-in_150ms_var(--ease-out-quint)]',
  'data-[state=delayed-open]:animate-[gb-pop-in_150ms_var(--ease-out-quint)]',
  'data-[state=closed]:animate-[gb-pop-out_120ms_var(--ease-out-quint)]',
];

export type TooltipProviderProps = React.ComponentProps<typeof TooltipPrimitive.Provider>;

export function TooltipProvider({ delayDuration = 250, children, ...props }: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} {...props}>
      <OverlayMotionStyles />
      {children}
    </TooltipPrimitive.Provider>
  );
}

export type TooltipProps = React.ComponentProps<typeof TooltipPrimitive.Root>;

export function Tooltip(props: TooltipProps) {
  return <TooltipPrimitive.Root {...props} />;
}

export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;

export interface TooltipContentProps extends React.ComponentProps<typeof TooltipPrimitive.Content> {
  /** Render the small arrow pointing back at the trigger. */
  withArrow?: boolean;
}

export function TooltipContent({
  className,
  sideOffset = 6,
  withArrow = false,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'glass text-ink z-50 max-w-72 rounded-lg px-2.5 py-1.5',
          'text-xs leading-relaxed text-balance',
          'origin-(--radix-tooltip-content-transform-origin)',
          overlayMotion,
          className,
        )}
        {...props}
      >
        {children}
        {withArrow ? (
          <TooltipPrimitive.Arrow className="fill-canvas-raised" width={10} height={5} />
        ) : null}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
