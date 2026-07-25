'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

/**
 * Mermaid diagram renderer.
 *
 * Mermaid is large, so it is imported dynamically on first use — the landing
 * page and every non-diagram tab never pay for it. It is also the only place
 * in the product that turns generated text into DOM, so `securityLevel` is
 * pinned to `strict`, which makes Mermaid sanitize its own output and refuse
 * click handlers embedded in diagram source.
 */

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid() {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
      themeVariables: {
        background: 'transparent',
        primaryColor: '#1b2a26',
        primaryTextColor: '#e8eaed',
        primaryBorderColor: '#2fbf94',
        lineColor: '#5b6470',
        secondaryColor: '#1c2030',
        tertiaryColor: '#191c24',
        mainBkg: '#1b2a26',
        nodeBorder: '#2fbf94',
        clusterBkg: '#15181f',
        clusterBorder: '#2a2f3a',
        titleColor: '#e8eaed',
        edgeLabelBackground: '#12151b',
        actorBkg: '#1b2a26',
        actorBorder: '#2fbf94',
        actorTextColor: '#e8eaed',
        signalColor: '#a8b0bb',
        signalTextColor: '#d4d8de',
        labelBoxBkgColor: '#1b2a26',
        labelBoxBorderColor: '#2fbf94',
        noteBkgColor: '#1c2030',
        noteTextColor: '#d4d8de',
        noteBorderColor: '#2a2f3a',
      },
    });
    return mermaid;
  });

  return mermaidReady;
}

export function Mermaid({ chart, className }: { chart: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  // Mermaid requires a DOM-id-safe string; React's useId contains colons.
  const domId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg: rendered } = await mermaid.render(domId, chart);
        if (!cancelled) setSvg(rendered);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Diagram could not be rendered.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chart, domId]);

  // A malformed diagram must not hide the information — fall back to source.
  if (error) {
    return (
      <figure className={cn('border-line overflow-hidden rounded-lg border', className)}>
        <figcaption className="border-line text-ink-faint border-b px-3 py-1.5 text-[11px]">
          Diagram source (could not be rendered)
        </figcaption>
        <pre className="text-ink-muted overflow-auto p-3 font-mono text-[12px]">{chart}</pre>
      </figure>
    );
  }

  if (!svg) {
    return (
      <div
        className={cn('animate-shimmer border-line bg-surface h-48 rounded-lg border', className)}
        role="status"
        aria-label="Rendering diagram"
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'border-line bg-canvas-raised overflow-x-auto rounded-lg border p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full',
        className,
      )}
      role="img"
      aria-label="Generated architecture diagram"
      // Mermaid sanitizes its own output under securityLevel: 'strict'.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
