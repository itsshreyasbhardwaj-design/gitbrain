'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { motion } from 'framer-motion';
import * as React from 'react';

import { cn } from '@/lib/cn';

interface TabsContextValue {
  /** The currently selected tab value, mirrored so triggers can render the rail. */
  readonly value: string | undefined;
  /** Unique per `<Tabs>` instance so two tab bars never share a layout animation. */
  readonly layoutId: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error('Tabs compound components must be rendered inside <Tabs>.');
  }
  return context;
}

export type TabsProps = React.ComponentProps<typeof TabsPrimitive.Root>;

/**
 * Radix owns selection and keyboard behaviour; we only mirror the active value
 * into context so the animated rail knows which trigger to fly to.
 */
export function Tabs({ className, value, defaultValue, onValueChange, ...props }: TabsProps) {
  const layoutId = React.useId();
  const [uncontrolled, setUncontrolled] = React.useState<string | undefined>(defaultValue);

  const handleValueChange = React.useCallback(
    (next: string) => {
      setUncontrolled(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  const current = value ?? uncontrolled;
  const context = React.useMemo<TabsContextValue>(
    () => ({ value: current, layoutId }),
    [current, layoutId],
  );

  return (
    <TabsContext.Provider value={context}>
      <TabsPrimitive.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleValueChange}
        className={cn('flex flex-col gap-5', className)}
        {...props}
      />
    </TabsContext.Provider>
  );
}

export type TabsListProps = React.ComponentProps<typeof TabsPrimitive.List>;

/**
 * The list scrolls horizontally on narrow viewports. The 4px padding is load
 * bearing: a scroll container cannot show overflow on its cross axis, so
 * without it the 2px focus outline (plus its 2px offset) would be clipped.
 * The baseline hairline is drawn by the wrapper at that same inset so it still
 * lines up with the bottom edge of the triggers.
 */
export function TabsList({ className, ...props }: TabsListProps) {
  return (
    <div className="relative">
      <span aria-hidden="true" className="bg-line absolute inset-x-0 bottom-1 block h-px" />
      <TabsPrimitive.List
        className={cn(
          'relative flex items-stretch gap-1 overflow-x-auto overscroll-x-contain p-1',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export type TabsTriggerProps = React.ComponentProps<typeof TabsPrimitive.Trigger>;

export function TabsTrigger({ className, children, value, ...props }: TabsTriggerProps) {
  const { value: activeValue, layoutId } = useTabsContext();
  const isActive = activeValue === value;

  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        'relative inline-flex shrink-0 items-center gap-2 rounded-t-md px-3 pt-1.5 pb-2.5',
        'text-ink-subtle text-sm font-medium whitespace-nowrap',
        'transition-colors duration-150 ease-(--ease-out-quint)',
        'hover:text-ink-muted data-[state=active]:text-ink',
        'focus-visible:outline-jade focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:pointer-events-none disabled:opacity-45',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {children}
      {isActive ? (
        <motion.span
          aria-hidden="true"
          layoutId={layoutId}
          className="bg-jade absolute inset-x-0 bottom-0 block h-[2px] rounded-full"
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        />
      ) : null}
    </TabsPrimitive.Trigger>
  );
}

export type TabsContentProps = React.ComponentProps<typeof TabsPrimitive.Content>;

export function TabsContent({ className, ...props }: TabsContentProps) {
  return (
    <TabsPrimitive.Content
      className={cn(
        'focus-visible:outline-jade focus-visible:outline-2 focus-visible:outline-offset-2',
        className,
      )}
      {...props}
    />
  );
}
