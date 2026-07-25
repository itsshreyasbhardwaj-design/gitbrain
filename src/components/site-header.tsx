import Link from 'next/link';
import { Github } from 'lucide-react';

import { Wordmark } from '@/components/logo';
import { capabilities } from '@/lib/env';

const REPOSITORY_URL = 'https://github.com/itsshreyasbhardwaj-design/gitbrain';

/**
 * Site header.
 *
 * A server component: it reads which integrations are configured so the
 * capability pill reflects the actual deployment rather than a guess.
 */
export function SiteHeader() {
  const { ai } = capabilities();

  return (
    <header className="border-line bg-canvas/70 sticky top-0 z-40 border-b backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="shrink-0 rounded-md" aria-label="GitBrain home">
          <Wordmark />
        </Link>

        <nav className="ml-2 hidden items-center gap-1 sm:flex" aria-label="Main">
          <Link
            href="/dashboard"
            className="text-ink-muted hover:bg-surface hover:text-ink rounded-md px-3 py-1.5 text-sm transition-colors"
          >
            Analyses
          </Link>
          <a
            href="#how-it-works"
            className="text-ink-muted hover:bg-surface hover:text-ink rounded-md px-3 py-1.5 text-sm transition-colors"
          >
            How it works
          </a>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="border-line text-ink-subtle hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] md:inline-flex"
            title={
              ai
                ? 'An OpenRouter model is configured for chat and knowledge enrichment.'
                : 'Running fully locally. Set OPENROUTER_API_KEY to enable LLM answers.'
            }
          >
            <span
              className={`size-1.5 rounded-full ${ai ? 'bg-jade' : 'bg-ink-faint'}`}
              aria-hidden="true"
            />
            {ai ? 'AI enabled' : 'Local mode'}
          </span>

          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-muted hover:bg-surface hover:text-ink inline-flex size-8 items-center justify-center rounded-md transition-colors"
            aria-label="GitBrain on GitHub"
          >
            <Github className="size-4" aria-hidden="true" />
          </a>
        </div>
      </div>
    </header>
  );
}
