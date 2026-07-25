import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/cn';

/**
 * Severity and grade badges. Every tone is a tinted wash plus a hairline in the
 * same hue — never a solid fill, which would out-shout the data next to it.
 */
export const badgeVariants = cva(
  [
    'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5',
    'text-[0.6875rem] leading-4 font-medium whitespace-nowrap',
    '[&_svg]:size-3 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        neutral: 'border-line-strong bg-surface text-ink-muted',
        jade: 'border-jade/30 bg-jade/12 text-jade-200',
        good: 'border-good/30 bg-good/12 text-good',
        fair: 'border-fair/30 bg-fair/12 text-fair',
        warn: 'border-warn/30 bg-warn/12 text-warn',
        bad: 'border-bad/35 bg-bad/12 text-bad',
        critical: 'border-critical/40 bg-critical/15 text-critical',
        info: 'border-info/30 bg-info/12 text-info',
        outline: 'border-line-strong bg-transparent text-ink-subtle',
      },
      uppercase: {
        true: 'text-eyebrow uppercase',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'neutral',
      uppercase: false,
    },
  },
);

export interface BadgeProps
  extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, uppercase, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, uppercase }), className)} {...props} />;
}
