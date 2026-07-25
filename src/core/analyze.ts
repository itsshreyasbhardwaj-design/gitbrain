/**
 * The analysis pipeline.
 *
 * Takes an ingested snapshot and produces a complete `Analysis`. Every stage is
 * pure and deterministic: the same snapshot always yields the same report,
 * which is what makes the results trustworthy and the tests meaningful.
 *
 * Stage order is a genuine dependency graph, not an arbitrary sequence:
 * dependencies inform stack detection, stack detection informs entry points,
 * entry points inform the module graph's orphan analysis, and everything
 * informs health scoring and the knowledge base.
 */

import type { Analysis, ProgressReporter, RepoSnapshot } from './types';
import { computeStats } from './stats';
import { computeLanguages, analyzeDependencies, detectStack, findEntryPoints } from './detect';
import { buildModuleGraph, buildTree } from './graph';
import { analyzeComplexity, analyzeTechDebt, findDuplicates } from './metrics';
import { analyzeSecurity } from './security';
import { analyzeReadme } from './readme';
import { computeHealth } from './health';
import { buildKnowledgeBase } from './knowledge';
import { buildSearchIndex } from './search';
import { hashString } from './shared/text';

export interface AnalyzeOptions {
  readonly onProgress?: ProgressReporter;
  /** Overrides the generated id. Used by tests for stable snapshots. */
  readonly id?: string;
  /** Overrides the timestamp. Used by tests for stable snapshots. */
  readonly now?: () => Date;
}

/**
 * Identifier for an analysis.
 *
 * Derived from the source plus a timestamp so it is short, URL-safe, and
 * recognisable in logs, while still allowing the same repository to be
 * analyzed repeatedly without collisions.
 */
function generateId(snapshot: RepoSnapshot, timestamp: number): string {
  const seed =
    snapshot.source.kind === 'github'
      ? `${snapshot.source.owner}/${snapshot.source.repo}@${snapshot.source.ref}`
      : snapshot.source.filename;

  return `${hashString(seed)}${hashString(`${seed}:${timestamp}`)}`;
}

export function analyzeSnapshot(snapshot: RepoSnapshot, options: AnalyzeOptions = {}): Analysis {
  const started = Date.now();
  const report = options.onProgress;
  const now = options.now?.() ?? new Date();

  report?.({ stage: 'scanning', percent: 42, message: 'Reading the file tree…' });
  const stats = computeStats(snapshot);
  const languages = computeLanguages(snapshot.files);
  const tree = buildTree(snapshot.files);

  report?.({ stage: 'detecting', percent: 52, message: 'Detecting frameworks and tooling…' });
  const dependencies = analyzeDependencies(snapshot);
  const stack = detectStack(snapshot, dependencies);
  const entryPoints = findEntryPoints(snapshot, stack);

  report?.({ stage: 'graphing', percent: 62, message: 'Building the module graph…' });
  const graph = buildModuleGraph(snapshot, dependencies, entryPoints);

  report?.({ stage: 'measuring', percent: 72, message: 'Measuring complexity…' });
  const complexity = analyzeComplexity(snapshot);
  const duplicates = findDuplicates(snapshot);
  const debt = analyzeTechDebt(snapshot, complexity, duplicates, dependencies, stats);

  report?.({ stage: 'securing', percent: 80, message: 'Scanning for secrets and risks…' });
  const security = analyzeSecurity(snapshot, dependencies);

  report?.({ stage: 'scoring', percent: 86, message: 'Scoring repository health…' });
  const readme = analyzeReadme(snapshot);
  const health = computeHealth({
    stats,
    languages,
    stack,
    dependencies,
    graph,
    complexity,
    debt,
    security,
    readme,
  });

  report?.({ stage: 'indexing', percent: 92, message: 'Indexing code for search…' });
  const search = buildSearchIndex(snapshot);

  report?.({ stage: 'synthesizing', percent: 96, message: 'Writing the knowledge base…' });
  const knowledge = buildKnowledgeBase({
    source: snapshot.source,
    stats,
    languages,
    stack,
    dependencies,
    tree,
    graph,
    entryPoints,
    complexity,
    debt,
    security,
    readme,
    health,
    search,
    files: snapshot.files,
  });

  report?.({ stage: 'done', percent: 100, message: 'Analysis complete.' });

  return {
    id: options.id ?? generateId(snapshot, now.getTime()),
    createdAt: now.toISOString(),
    source: snapshot.source,
    stats,
    languages,
    stack,
    dependencies,
    tree,
    graph,
    entryPoints,
    complexity,
    debt,
    security,
    readme,
    health,
    knowledge,
    search,
    snapshot: {
      truncated: snapshot.truncated,
      skipped: snapshot.skipped,
      ingestMs: snapshot.ingestMs,
    },
    analysisMs: Date.now() - started,
  };
}
