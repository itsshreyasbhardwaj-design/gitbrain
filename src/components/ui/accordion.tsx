'use client';

import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * Radix measures the panel and exposes `--radix-accordion-content-height`, but
 * it only defers unmount for a real CSS *animation* — a transition would make
 * the collapse snap. `globals.css` is not edited from here, so the frames ship
 * with the component as a React 19 hoisted stylesheet (deduped by `href`).
 * `prefers-reduced-motion` in globals.css already collapses the duration.
 */
const COLLAPSE_MOTION_HREF = 'gitbrain-collapse-motion';
const COLLAPSE_MOTION_KEYFRAMES = `
@keyframes gb-collapse-down { from { height: 0 } to { height: var(--radix-accordion-content-height) } }
@keyframes gb-collapse-up { from { height: var(--radix-accordion-content-height) } to { height: 0 } }
`;

function CollapseMotionStyles() {
  return (
    <style href={COLLAPSE_MOTION_HREF} precedence="medium">
      {COLLAPSE_MOTION_KEYFRAMES}
    </style>
  );
}

export type AccordionProps = React.ComponentProps<typeof AccordionPrimitive.Root>;

export function Accordion({ className, children, ...props }: AccordionProps) {
  return (
    <AccordionPrimitive.Root className={cn('w-full', className)} {...props}>
      <CollapseMotionStyles />
      {children}
    </AccordionPrimitive.Root>
  );
}

export type AccordionItemProps = React.ComponentProps<typeof AccordionPrimitive.Item>;

export function AccordionItem({ className, ...props }: AccordionItemProps) {
  return <AccordionPrimitive.Item className={cn('border-line border-b', className)} {...props} />;
}

export type AccordionTriggerProps = React.ComponentProps<typeof AccordionPrimitive.Trigger>;

export function AccordionTrigger({ className, children, ...props }: AccordionTriggerProps) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          'group text-ink flex flex-1 items-center justify-between gap-3 py-3.5 text-left text-sm font-medium',
          'transition-colors duration-150 ease-(--ease-out-quint)',
          'hover:text-jade-200',
          'focus-visible:outline-jade focus-visible:outline-2 focus-visible:outline-offset-2',
          'disabled:pointer-events-none disabled:opacity-45',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-ink-faint size-4 shrink-0',
            'transition-transform duration-200 ease-(--ease-out-quint)',
            'group-data-[state=open]:rotate-180',
          )}
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export type AccordionContentProps = React.ComponentProps<typeof AccordionPrimitive.Content>;

export function AccordionContent({ className, children, ...props }: AccordionContentProps) {
  return (
    <AccordionPrimitive.Content
      className={cn(
        'overflow-hidden',
        'data-[state=open]:animate-[gb-collapse-down_200ms_var(--ease-out-quint)]',
        'data-[state=closed]:animate-[gb-collapse-up_180ms_var(--ease-out-quint)]',
      )}
      {...props}
    >
      <div className={cn('text-ink-subtle pb-4 text-sm leading-relaxed', className)}>
        {children}
      </div>
    </AccordionPrimitive.Content>
  );
}
