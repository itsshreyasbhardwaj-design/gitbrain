import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink, FileCode2, GitBranch, Upload } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ReportTabs } from '@/features/report/report-tabs';
import { analysisName, loadAnalysis } from '@/features/report/load';
import { formatCount, gradeTone, TONE_SURFACE, TONE_TEXT } from '@/features/report/grade';

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: LayoutProps): Promise<Metadata> {
  const { id } = await params;

  try {
    const analysis = await loadAnalysis(id);
    return {
      title: analysisName(analysis),
      description: analysis.knowledge.docs[0]?.summary ?? 'Repository analysis by GitBrain.',
    };
  } catch {
    return { title: 'Analysis' };
  }
}

export default async function ReportLayout({ children, params }: LayoutProps) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);

  const name = analysisName(analysis);
  const tone = gradeTone(analysis.health.grade);
  const primary = analysis.languages[0];

  return (
    <div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6 lg:px-8">
      {/* Repository header ---------------------------------------------- */}
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="text-ink-faint flex flex-wrap items-center gap-2 text-xs">
            {analysis.source.kind === 'github' ? (
              <>
                <GitBranch className="size-3.5" aria-hidden="true" />
                <span className="font-mono">{analysis.source.ref}</span>
              </>
            ) : (
              <>
                <Upload className="size-3.5" aria-hidden="true" />
                <span>Uploaded archive</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>
              <FileCode2 className="mr-1 inline size-3.5" aria-hidden="true" />
              {formatCount(analysis.stats.files)} files
            </span>
            <span aria-hidden="true">·</span>
            <span>{formatCount(analysis.stats.linesOfCode)} lines</span>
          </div>

          <h1 className="text-ink mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            <span className="break-all">{name}</span>
            {analysis.source.kind === 'github' && (
              <a
                href={analysis.source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-ink-faint hover:text-jade transition-colors"
                aria-label={`Open ${name} on GitHub`}
              >
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            )}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {primary && (
              <span className="border-line text-ink-muted inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: primary.color }}
                  aria-hidden="true"
                />
                {primary.language} {primary.percent}%
              </span>
            )}
            {/* Only high-confidence detections earn a headline badge.
                A badge next to the repository name reads as "this IS a
                Next.js app", so it needs decisive evidence — a shipped
                dependency or a framework config file. Everything else is
                still listed, with its evidence and confidence, on the
                Overview tab, which is where nuance belongs. */}
            {analysis.stack.frameworks
              .filter((framework) => framework.confidence === 'high')
              .slice(0, 3)
              .map((framework) => (
                <Badge key={framework.name} variant="neutral">
                  {framework.name}
                </Badge>
              ))}
            {analysis.stack.architecture.style !== 'unknown' && (
              <Badge variant="outline">{analysis.stack.architecture.style}</Badge>
            )}
          </div>
        </div>

        {/* Overall grade -------------------------------------------------- */}
        <Link
          href={`/r/${id}/health`}
          className={`glass rounded-panel flex shrink-0 items-center gap-4 border px-5 py-4 transition-transform hover:scale-[1.02] ${TONE_SURFACE[tone]}`}
        >
          <div className="text-right">
            <p className="text-eyebrow text-ink-faint uppercase">Health</p>
            <p className={`mt-1 text-3xl font-semibold tabular-nums ${TONE_TEXT[tone]}`}>
              {analysis.health.overall}
              <span className="text-ink-faint text-base">/100</span>
            </p>
          </div>
          <span
            className={`flex size-12 items-center justify-center rounded-xl border text-xl font-semibold ${TONE_SURFACE[tone]} ${TONE_TEXT[tone]}`}
            aria-label={`Grade ${analysis.health.grade}`}
          >
            {analysis.health.grade}
          </span>
        </Link>
      </header>

      {/* Truncation notice ---------------------------------------------- */}
      {analysis.snapshot.truncated && (
        <p
          role="status"
          className="border-warn/25 bg-warn/10 text-ink-muted mt-6 rounded-lg border px-3.5 py-2.5 text-sm"
        >
          This repository exceeded GitBrain’s ingestion budget, so some files were not indexed.
          Metrics below describe the {formatCount(analysis.stats.files)} files that were analyzed.
        </p>
      )}

      <ReportTabs id={id} />

      <div className="pb-16">{children}</div>
    </div>
  );
}
