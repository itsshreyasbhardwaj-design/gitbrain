import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, FolderGit2 } from 'lucide-react';

import { EmptyState } from '@/components/ui/empty-state';
import { formatCount, gradeTone, TONE_SURFACE, TONE_TEXT } from '@/features/report/grade';
import { currentOwnerId } from '@/lib/auth';
import { capabilities } from '@/lib/env';
import { resolveStore } from '@/lib/store';

export const metadata: Metadata = {
  title: 'Analyses',
  description: 'Repositories you have analyzed with GitBrain.',
};

export const dynamic = 'force-dynamic';

function grade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export default async function DashboardPage() {
  const store = resolveStore();
  const analyses = await store.list(await currentOwnerId(), 50);
  const { persistence } = capabilities();

  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title text-ink">Analyses</h1>
          <p className="text-ink-muted mt-1.5 text-sm">
            {analyses.length === 0
              ? 'Nothing analyzed yet.'
              : `${analyses.length} ${analyses.length === 1 ? 'repository' : 'repositories'} analyzed.`}
          </p>
        </div>

        <Link
          href="/"
          className="bg-jade text-canvas inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
        >
          Analyze a repository
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </header>

      {!persistence && (
        <p className="border-line bg-surface/50 text-ink-subtle mt-6 rounded-lg border px-3.5 py-2.5 text-xs">
          Analyses are held in memory on this server and are cleared on restart. Configure Supabase
          to store them durably.
        </p>
      )}

      {analyses.length === 0 ? (
        <EmptyState
          className="mt-12"
          icon={<FolderGit2 />}
          title="No analyses yet"
          description="Paste a GitHub repository URL on the home page, or drop in a ZIP of a local project, and it will show up here."
        />
      ) : (
        <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {analyses.map((analysis) => {
            const tone = gradeTone(grade(analysis.overallScore));

            return (
              <li key={analysis.id}>
                <Link
                  href={`/r/${analysis.id}`}
                  className="glass group rounded-panel hover:border-line-strong flex h-full flex-col p-5 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-ink min-w-0 text-[15px] font-semibold tracking-tight break-all">
                      {analysis.name}
                    </h2>
                    <span
                      className={`flex size-8 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold ${TONE_SURFACE[tone]} ${TONE_TEXT[tone]}`}
                      aria-label={`Health grade ${grade(analysis.overallScore)}`}
                    >
                      {grade(analysis.overallScore)}
                    </span>
                  </div>

                  <dl className="text-ink-subtle mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {analysis.primaryLanguage && (
                      <div>
                        <dt className="sr-only">Primary language</dt>
                        <dd>{analysis.primaryLanguage}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="sr-only">Files</dt>
                      <dd>{formatCount(analysis.files)} files</dd>
                    </div>
                    <div>
                      <dt className="sr-only">Lines of code</dt>
                      <dd>{formatCount(analysis.linesOfCode)} lines</dd>
                    </div>
                  </dl>

                  <p className="text-ink-faint mt-auto pt-4 text-[11px]">
                    <time dateTime={analysis.createdAt}>
                      {new Date(analysis.createdAt).toLocaleString('en-US', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
