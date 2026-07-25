import Link from 'next/link';
import { FileCode2 } from 'lucide-react';

import type { Citation } from '@/core/types';
import { cn } from '@/lib/cn';

/**
 * Source chips.
 *
 * Every generated document carries the files it drew from. Making them
 * clickable is the whole point: the fastest way to trust a generated claim is
 * to jump straight to the code that produced it.
 */
export function CitationList({
  analysisId,
  citations,
  className,
}: {
  analysisId: string;
  citations: readonly Citation[];
  className?: string;
}) {
  if (citations.length === 0) return null;

  return (
    <section className={cn(className)} aria-labelledby={`sources-${analysisId}`}>
      <h4 id={`sources-${analysisId}`} className="text-eyebrow text-ink-faint uppercase">
        Sources ({citations.length})
      </h4>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {citations.map((citation, index) => {
          const params = new URLSearchParams({ q: citation.file });
          if (citation.startLine !== undefined) params.set('line', String(citation.startLine));

          const range =
            citation.startLine !== undefined
              ? citation.endLine !== undefined && citation.endLine !== citation.startLine
                ? `:${citation.startLine}–${citation.endLine}`
                : `:${citation.startLine}`
              : '';

          return (
            <li key={`${citation.file}-${citation.startLine ?? 0}-${index}`}>
              <Link
                href={`/r/${analysisId}/search?${params.toString()}`}
                title={citation.excerpt ?? `${citation.file}${range}`}
                className="group border-line bg-surface/60 text-ink-subtle hover:border-jade/40 hover:text-jade inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors"
              >
                <FileCode2 className="size-3 shrink-0 opacity-60" aria-hidden="true" />
                <span className="truncate">{citation.file}</span>
                {range && <span className="shrink-0 opacity-70">{range}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
