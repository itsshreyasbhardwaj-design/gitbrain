import Link from 'next/link';
import {
  Boxes,
  Code2,
  FileCode2,
  FlaskConical,
  FolderTree,
  Layers,
  type LucideIcon,
  Package,
  Repeat,
  Rocket,
} from 'lucide-react';

import type { Confidence, Detection, StackDetection, TreeNode } from '@/core/types';
import { Markdown } from '@/components/markdown';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { LanguageBar } from '@/features/report/charts';
import { formatBytes, formatCount, formatDuration, type Tone } from '@/features/report/grade';
import { loadAnalysis } from '@/features/report/load';
import { Section } from '@/features/report/section';
import { StatTile } from '@/features/report/stat-tile';

/**
 * Overview tab.
 *
 * The layout above (`layout.tsx`) already states what the repository *is* —
 * name, ref, size, primary language, health grade. This page answers the next
 * question a reader asks: what is it made of, and can I trust the numbers.
 * Hence the transparency footnote at the bottom; a report that hides what it
 * skipped is worth less than one that admits it.
 */

// ---------------------------------------------------------------------------
// Banding helpers
// ---------------------------------------------------------------------------

interface Banded {
  readonly tone: Tone;
  /** Always rendered next to the figure — colour is never the only signal. */
  readonly hint: string;
}

/**
 * `testRatio` is tests / (tests + source), so one test file per three source
 * files lands at 0.25. That is roughly where a suite starts covering the
 * surface area of a codebase; under 0.05 there is effectively nothing to run,
 * and exactly 0 is a different statement entirely, so it gets its own band.
 */
function bandTestRatio(ratio: number, testFiles: number): Banded {
  const percent = Math.round(ratio * 100);
  if (testFiles === 0) return { tone: 'critical', hint: 'No test files found' };
  if (ratio >= 0.25) return { tone: 'good', hint: `${percent}% of source files` };
  if (ratio >= 0.15) return { tone: 'fair', hint: `${percent}% of source files` };
  if (ratio >= 0.05) return { tone: 'warn', hint: `${percent}% of source files — thin` };
  return { tone: 'bad', hint: `${percent}% of source files — very thin` };
}

/**
 * Import cycles are binary in spirit — none is a property worth protecting —
 * but a handful in a large repo is a refactor, not an emergency. The bands say
 * so in words as well as colour.
 */
function bandCycles(count: number): Banded {
  if (count === 0) return { tone: 'good', hint: 'No import cycles' };
  if (count <= 2) return { tone: 'warn', hint: 'Small cycles to untangle' };
  if (count <= 8) return { tone: 'bad', hint: 'Widespread circular imports' };
  return { tone: 'critical', hint: 'Pervasive circular imports' };
}

// ---------------------------------------------------------------------------
// Stack presentation
// ---------------------------------------------------------------------------

const CONFIDENCE_VARIANT: Record<Confidence, BadgeProps['variant']> = {
  high: 'jade',
  medium: 'neutral',
  low: 'outline',
};

/** Keys of `StackDetection` that hold a plain list of detections. */
type DetectionGroup = {
  [K in keyof StackDetection]: StackDetection[K] extends readonly Detection[] ? K : never;
}[keyof StackDetection];

const STACK_SECTIONS: readonly {
  readonly key: DetectionGroup;
  readonly title: string;
  readonly empty: string;
}[] = [
  { key: 'frameworks', title: 'Frameworks', empty: 'No application framework detected.' },
  { key: 'runtimes', title: 'Runtimes', empty: 'No runtime marker found.' },
  { key: 'packageManagers', title: 'Package managers', empty: 'No package manager declared.' },
  { key: 'testing', title: 'Testing', empty: 'No test runner detected.' },
  { key: 'databases', title: 'Databases', empty: 'No database client or schema detected.' },
  { key: 'ci', title: 'Continuous integration', empty: 'No CI configuration committed.' },
  { key: 'deployment', title: 'Deployment', empty: 'No deployment target detected.' },
];

function DetectionList({ items, empty }: { items: readonly Detection[]; empty: string }) {
  if (items.length === 0) {
    return <p className="text-ink-faint text-sm">{empty}</p>;
  }

  return (
    <ul className="space-y-3">
      {items.map((detection) => (
        <li key={detection.name}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink text-sm font-medium">{detection.name}</span>
            {detection.version ? (
              <span className="text-ink-faint font-mono text-xs">{detection.version}</span>
            ) : null}
            <Badge variant={CONFIDENCE_VARIANT[detection.confidence]}>
              {detection.confidence} confidence
            </Badge>
          </div>
          {detection.evidence[0] ? (
            <p className="text-ink-subtle mt-1 text-xs leading-relaxed">{detection.evidence[0]}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function OverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);

  const { stats, languages, stack, dependencies, graph, entryPoints, snapshot } = analysis;

  const tests = bandTestRatio(stats.testRatio, stats.testFiles);
  const cycles = bandCycles(graph.cycles.length);

  const summaryDoc = analysis.knowledge.docs.find((doc) => doc.id === 'executive-summary');

  const topLevel = (analysis.tree.children ?? []).filter(
    (node): node is TreeNode => node.type === 'dir',
  );
  const topLevelFiles = (analysis.tree.children ?? []).filter((node) => node.type === 'file');

  const skippedTotal =
    snapshot.skipped.ignored +
    snapshot.skipped.binary +
    snapshot.skipped.tooLarge +
    snapshot.skipped.overBudget;

  return (
    <>
      {/* Figures ------------------------------------------------------------ */}
      <Section
        title="At a glance"
        description="Counted from the files GitBrain actually indexed — vendored, generated and binary files are excluded."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <StatTile
            label="Files"
            value={formatCount(stats.files)}
            hint={formatBytes(stats.totalBytes)}
            icon={<FileCode2 />}
          />
          <StatTile
            label="Lines of code"
            value={formatCount(stats.linesOfCode)}
            hint={`${formatCount(stats.documentationFiles)} doc files`}
            icon={<Code2 />}
          />
          <StatTile
            label="Directories"
            value={formatCount(stats.directories)}
            hint={`${formatCount(stats.configFiles)} config files`}
            icon={<FolderTree />}
          />
          <StatTile
            label="Max depth"
            value={formatCount(stats.maxDepth)}
            hint={stats.maxDepth === 1 ? 'Flat layout' : 'Levels below the root'}
            icon={<Layers />}
          />
          <StatTile
            label="Test files"
            value={formatCount(stats.testFiles)}
            hint={tests.hint}
            tone={tests.tone}
            icon={<FlaskConical />}
          />
          <StatTile
            label="Dependencies"
            value={formatCount(dependencies.dependencies.length)}
            hint={
              dependencies.manifests.length === 0
                ? 'No manifest found'
                : `${formatCount(dependencies.manifests.length)} ${dependencies.manifests.length === 1 ? 'manifest' : 'manifests'} · ${dependencies.hasLockfile ? 'lockfile present' : 'no lockfile'}`
            }
            tone={
              dependencies.manifests.length > 0 && !dependencies.hasLockfile ? 'warn' : 'neutral'
            }
            icon={<Package />}
          />
          <StatTile
            label="Modules in graph"
            value={formatCount(graph.nodes.length)}
            hint={`${formatCount(graph.edges.length)} import ${graph.edges.length === 1 ? 'edge' : 'edges'}`}
            icon={<Boxes />}
          />
          <StatTile
            label="Circular chains"
            value={formatCount(graph.cycles.length)}
            hint={cycles.hint}
            tone={cycles.tone}
            icon={<Repeat />}
          />
        </div>
      </Section>

      {/* Executive summary -------------------------------------------------- */}
      <Section
        title="Executive summary"
        description={summaryDoc?.summary}
        action={
          <Link
            href={`/r/${id}/knowledge`}
            className="text-jade hover:text-jade-200 text-sm transition-colors"
          >
            All {formatCount(analysis.knowledge.docs.length)} documents →
          </Link>
        }
      >
        <Card>
          <CardContent className="pt-5">
            {summaryDoc ? (
              <Markdown>{summaryDoc.markdown}</Markdown>
            ) : (
              <p className="text-ink-subtle text-sm">
                No executive summary was generated for this analysis. The remaining sections on this
                page are computed directly from the snapshot and are unaffected.
              </p>
            )}
          </CardContent>
        </Card>
      </Section>

      {/* Languages ---------------------------------------------------------- */}
      <Section
        title="Languages"
        description="Share of analyzed source bytes. Percentages are per language, not per file."
      >
        <Card>
          <CardContent className="pt-5">
            <LanguageBar languages={languages} />
          </CardContent>
        </Card>
      </Section>

      {/* Stack -------------------------------------------------------------- */}
      <Section
        title="Detected stack"
        description="Each detection carries the evidence that produced it. Nothing here is inferred from the repository name."
        action={
          stack.architecture.style === 'unknown' ? undefined : (
            <Badge variant="outline">{stack.architecture.style} architecture</Badge>
          )
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {STACK_SECTIONS.map((section) => (
            <Card key={section.key}>
              <CardHeader className="pb-3">
                <CardTitle>{section.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <DetectionList items={stack[section.key]} empty={section.empty} />
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      {/* Entry points ------------------------------------------------------- */}
      <Section
        title="Entry points"
        description="Where execution starts. Read these first when the repository is unfamiliar."
      >
        {entryPoints.length === 0 ? (
          <EmptyState
            icon={<Rocket />}
            title="No entry points identified"
            description="No manifest field, framework convention or executable script pointed at a starting file. This is normal for a library consumed purely as source."
          />
        ) : (
          <Card>
            <ul className="divide-line divide-y">
              {entryPoints.map((entry) => (
                <li
                  key={`${entry.kind}:${entry.path}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3.5"
                >
                  <code className="text-ink min-w-0 flex-1 font-mono text-sm break-all">
                    {entry.path}
                  </code>
                  <Badge variant="neutral">{entry.kind}</Badge>
                  <p className="text-ink-subtle w-full text-xs leading-relaxed">{entry.reason}</p>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>

      {/* Structure ---------------------------------------------------------- */}
      <Section
        title="Top-level structure"
        description="What lives where, one level down from the repository root."
      >
        {topLevel.length === 0 ? (
          <EmptyState
            icon={<FolderTree />}
            title="Everything is at the root"
            description={`This repository has no top-level directories — all ${formatCount(topLevelFiles.length)} indexed files sit directly in the root.`}
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {topLevel.map((node) => (
                <div
                  key={node.path}
                  className="border-line bg-surface/40 rounded-xl border px-4 py-3.5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <code className="text-ink truncate font-mono text-sm">{node.name}/</code>
                    <span className="text-ink-faint shrink-0 text-xs tabular-nums">
                      {formatCount(node.fileCount)} {node.fileCount === 1 ? 'file' : 'files'} ·{' '}
                      {formatBytes(node.size)}
                    </span>
                  </div>
                  <p className="text-ink-subtle mt-1.5 text-xs leading-relaxed">
                    {node.purpose ?? 'No conventional role recognised for this directory.'}
                  </p>
                </div>
              ))}
            </div>
            {topLevelFiles.length > 0 ? (
              <p className="text-ink-faint mt-3 text-xs">
                Plus {formatCount(topLevelFiles.length)} loose{' '}
                {topLevelFiles.length === 1 ? 'file' : 'files'} at the root.
              </p>
            ) : null}
          </>
        )}
      </Section>

      {/* Provenance --------------------------------------------------------- */}
      <footer className="border-line text-ink-faint mt-10 border-t pt-5 text-xs leading-relaxed">
        <p>
          Ingested in {formatDuration(snapshot.ingestMs)} and analyzed in{' '}
          {formatDuration(analysis.analysisMs)}.{' '}
          {skippedTotal === 0
            ? 'Every file in the repository was indexed.'
            : `${formatCount(skippedTotal)} files were not indexed: ${formatCount(snapshot.skipped.ignored)} ignored by rule, ${formatCount(snapshot.skipped.binary)} binary, ${formatCount(snapshot.skipped.tooLarge)} over the per-file size limit, ${formatCount(snapshot.skipped.overBudget)} beyond the snapshot budget.`}
        </p>
        <p className="mt-1">
          Analyzed {new Date(analysis.createdAt).toISOString().replace('T', ' ').slice(0, 16)} UTC.
          Every figure on this page describes the indexed subset only.
        </p>
      </footer>
    </>
  );
}

/** Kept honest: unused imports are a lint error, so this asserts intent. */
export type OverviewIcon = LucideIcon;
