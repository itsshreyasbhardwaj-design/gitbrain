import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge has no way to know about the custom scales declared in
 * `globals.css` via `@theme`, so it guesses — and guesses wrong in ways that
 * silently delete styles. Two concrete failures without this config:
 *
 *   cn('text-display', 'text-ink')   -> 'text-ink'   (font size dropped)
 *   cn('rounded-panel', 'rounded-lg') -> both kept    (no override)
 *
 * Teaching it our theme keys makes conflict resolution correct for every
 * token GitBrain actually ships.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['display', 'title', 'heading', 'eyebrow'],
      radius: ['panel'],
      shadow: ['lifted', 'glow'],
      ease: ['out-quint', 'spring'],
      color: [
        'canvas',
        'canvas-raised',
        'surface',
        'surface-hover',
        'line',
        'line-strong',
        'ink',
        'ink-muted',
        'ink-subtle',
        'ink-faint',
        'jade',
        'jade-50',
        'jade-200',
        'jade-400',
        'jade-600',
        'jade-900',
        'cyan-accent',
        'violet-accent',
        'good',
        'fair',
        'warn',
        'bad',
        'critical',
        'info',
      ],
    },
  },
});

/**
 * Compose class names, resolving Tailwind conflicts left-to-right so a
 * consumer's `className` always wins over a component's defaults.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
