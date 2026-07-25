import { CheckCircle2 } from 'lucide-react';

import { basename } from '@/core/shared/paths';

/**
 * Circular dependency chains.
 *
 * Severity is a function of chain length: a two-module cycle is usually an
 * accident that can be broken by moving one symbol, while a six-module cycle
 * means a layer boundary is missing and the fix is architectural.
 */
function severityFor(length: number): { label: string; className: string; note: string } {
  if (length >= 5) {
    return {
      label: 'High',
      className: 'border-bad/30 bg-bad/10 text-bad',
      note: 'A chain this long usually means a missing layer boundary rather than one bad import.',
    };
  }
  if (length >= 3) {
    return {
      label: 'Medium',
      className: 'border-warn/30 bg-warn/10 text-warn',
      note: 'Extracting the shared types or constants into their own module normally breaks this.',
    };
  }
  return {
    label: 'Low',
    className: 'border-fair/30 bg-fair/10 text-fair',
    note: 'A mutual import between two modules — usually fixed by moving a single symbol.',
  };
}

export function CyclesPanel({ cycles }: { cycles: readonly (readonly string[])[] }) {
  if (cycles.length === 0) {
    return (
      <div className="glass rounded-panel mt-6 flex items-center gap-3 p-5">
        <CheckCircle2 className="text-good size-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-ink text-sm font-medium">No circular dependencies</p>
          <p className="text-ink-muted mt-0.5 text-sm">
            Every module in this repository can be loaded, tested and reasoned about on its own.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ol className="mt-6 space-y-3">
      {cycles.map((cycle, index) => {
        const severity = severityFor(cycle.length);

        return (
          <li key={cycle.join('>')} className="glass rounded-panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink-faint font-mono text-xs">#{index + 1}</span>
              <span className={`rounded border px-1.5 py-0.5 text-[11px] ${severity.className}`}>
                {severity.label}
              </span>
              <span className="text-ink-subtle text-xs">{cycle.length} modules</span>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              {cycle.map((path, position) => (
                <span key={path} className="flex items-center gap-1.5">
                  <code
                    className="border-line bg-surface text-ink rounded border px-1.5 py-0.5 font-mono text-[11px]"
                    title={path}
                  >
                    {basename(path)}
                  </code>
                  <span className="text-ink-faint" aria-hidden="true">
                    →
                  </span>
                  {/* Close the loop visually on the last hop. */}
                  {position === cycle.length - 1 && (
                    <code className="border-line bg-surface text-ink-subtle rounded border px-1.5 py-0.5 font-mono text-[11px]">
                      {basename(cycle[0] ?? '')}
                    </code>
                  )}
                </span>
              ))}
            </div>

            <p className="text-ink-subtle mt-2.5 text-xs leading-relaxed">{severity.note}</p>

            <details className="mt-2">
              <summary className="text-ink-faint hover:text-ink-subtle cursor-pointer text-[11px]">
                Full paths
              </summary>
              <ul className="mt-1.5 space-y-0.5">
                {cycle.map((path) => (
                  <li key={path} className="text-ink-subtle font-mono text-[11px] break-all">
                    {path}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
