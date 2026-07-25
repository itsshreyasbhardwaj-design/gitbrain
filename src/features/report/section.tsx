import type * as React from 'react';

import { cn } from '@/lib/cn';

export interface SectionProps {
  title: string;
  /** One line explaining what the reader is looking at, in facts not adjectives. */
  description?: React.ReactNode;
  /** Trailing control — a link to a deeper tab, a badge, a count. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /**
   * Anchor id. Defaults to a slug of `title`, which is stable across renders and
   * needs no hook — `useId` is unavailable in a Server Component. Pass one
   * explicitly if two sections on the same page share a title.
   */
  id?: string;
}

/** `Complexity hotspots` -> `complexity-hotspots`. */
function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

/**
 * The rhythm every report page shares.
 *
 * Three pages rendering headings by hand drift within a week — different
 * margins, different heading levels, different colours for the same kind of
 * label. Funnelling them through one wrapper also guarantees each block is a
 * real landmark: `<section>` labelled by its own heading, so a screen-reader
 * rotor lists the report the way the eye reads it.
 */
export function Section({ title, description, action, children, className, id }: SectionProps) {
  const headingId = `${id ?? slugify(title)}-heading`;

  return (
    <section
      id={id ?? slugify(title)}
      aria-labelledby={headingId}
      className={cn('mt-10 scroll-mt-24 first:mt-8', className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="max-w-2xl min-w-0">
          <h2 id={headingId} className="text-ink text-lg font-semibold -tracking-[0.02em]">
            {title}
          </h2>
          {description ? (
            <p className="text-ink-subtle mt-1 text-sm leading-relaxed">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>

      <div className="mt-4">{children}</div>
    </section>
  );
}
