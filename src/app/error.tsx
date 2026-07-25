'use client';

import { useEffect } from 'react';
import { RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[gitbrain] render error:', error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-32 text-center">
      <h1 className="text-title text-ink">Something broke while rendering this page</h1>
      <p className="text-ink-muted mt-3 text-sm leading-relaxed">
        This is a bug in GitBrain, not something you did. If it keeps happening, please open an
        issue with the digest below.
      </p>

      {error.digest && (
        <code className="border-line bg-surface text-ink-subtle mt-4 rounded-md border px-2.5 py-1.5 font-mono text-xs">
          {error.digest}
        </code>
      )}

      <Button onClick={reset} className="mt-7">
        <RotateCcw className="size-4" aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}
