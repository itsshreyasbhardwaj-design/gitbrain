import * as SeparatorPrimitive from '@radix-ui/react-separator';
import type * as React from 'react';

import { cn } from '@/lib/cn';

export type SeparatorProps = React.ComponentProps<typeof SeparatorPrimitive.Root>;

/**
 * Decorative by default, so screen readers skip it. Pass `decorative={false}`
 * when the rule genuinely separates two regions of meaning.
 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: SeparatorProps) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      decorative={decorative}
      className={cn(
        'bg-line shrink-0',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
