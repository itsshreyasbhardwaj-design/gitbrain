/**
 * Code-level documents: what the project depends on, where the complexity is
 * concentrated, what debt it carries, where execution begins, and how data
 * moves between the two.
 *
 * Every number here comes from the metrics, dependency and graph reports — the
 * generators only decide what is worth saying and how to say it.
 */

import type { DebtItem, GraphNode, KnowledgeDoc } from '../../types';
import {
  citationsFor,
  ensureCitations,
  detectionLabel,
  repoName,
  type CitationRef,
  type KnowledgeContext,
} from '../context';
import {
  bulletList,
  code,
  countLabel,
  fileRef,
  formatNumber,
  formatPercent,
  heading,
  joinWords,
  makeDoc,
  mermaid,
  mermaidId,
  mermaidLabel,
  note,
  section,
  severityLabel,
  severityRank,
  table,
} from '../format';

// ---------------------------------------------------------------------------
// Dependency analysis
// ---------------------------------------------------------------------------

export function dependencyAnalysis(context: KnowledgeContext): KnowledgeDoc {
  const report = context.dependencies;
  const total = report.dependencies.length;

  if (total === 0 && report.manifests.length === 0) {
    const markdown = section(
      heading(1, 'Dependency Analysis'),
      `No dependency manifest was found in ${code(repoName(context))}. GitBrain looks for ${joinWords(
        [
          'package.json',
          'requirements.txt',
          'pyproject.toml',
          'go.mod',
          'Cargo.toml',
          'Gemfile',
          'composer.json',
          'pom.xml',
          'build.gradle',
        ].map((name) => code(name)),
      )}; none of them are present.`,
      'That means one of three things: the project has no third-party dependencies, its dependencies are vendored into the tree, or the manifest lives outside the analyzed snapshot.',
      context.graph.externals.length > 0
        ? section(
            heading(2, 'Packages imported by the code anyway'),
            'The import parser still found bare specifiers that resolve outside the repository. Without a manifest, none of them are declared, pinned or reproducible.',
            table(
              ['Package', 'Imported by'],
              context.graph.externals
                .slice()
                .sort((a, b) => b.count - a.count)
                .slice(0, 20)
                .map((external) => [
                  code(external.name),
                  `${formatNumber(external.count)} ${external.count === 1 ? 'file' : 'files'}`,
                ]),
            ),
          )
        : null,
    );

    return makeDoc(
      'dependency-analysis',
      'Dependency Analysis',
      'No dependency manifest was found, so the project declares no third-party dependencies.',
      markdown,
      ensureCitations(context, []),
    );
  }

  const ecosystems = [...new Set(report.dependencies.map((dependency) => dependency.ecosystem))];
  const runtime = report.dependencies
    .filter((dependency) => dependency.kind === 'runtime')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const undeclared = context.graph.externals.filter((external) => external.undeclared);

  const summaryTable = table(
    ['Kind', 'Count'],
    [
      ['Runtime', formatNumber(report.counts.runtime)],
      ['Development', formatNumber(report.counts.dev)],
      ['Peer', formatNumber(report.counts.peer)],
      ['Optional', formatNumber(report.counts.optional)],
    ],
  );

  const markdown = section(
    heading(1, 'Dependency Analysis'),
    `${code(repoName(context))} declares ${countLabel(total, 'dependency', 'dependencies')} across ${countLabel(report.manifests.length, 'manifest')} (${joinWords(report.manifests.map((manifest) => code(manifest)))}) in ${countLabel(ecosystems.length, 'ecosystem')} (${joinWords(ecosystems)}). ${
      report.hasLockfile
        ? 'A lockfile is committed, so installs are reproducible.'
        : '**No lockfile is committed**, so two installs a week apart can resolve to different versions of the same declared range. This is the single cheapest reproducibility fix available.'
    }`,
    summaryTable,
    report.flagged.length > 0
      ? section(
          heading(2, `Flagged dependencies (${formatNumber(report.flagged.length)})`),
          "These matched GitBrain's curated list of deprecated, unmaintained or unsafe packages.",
          table(
            ['Package', 'Severity', 'Reason', 'Replacement'],
            report.flagged
              .slice()
              .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
              .map((flag) => [
                code(flag.name),
                severityLabel(flag.severity),
                flag.reason,
                flag.replacement ? code(flag.replacement) : '—',
              ]),
          ),
        )
      : section(
          heading(2, 'Flagged dependencies'),
          "None. No declared dependency matched GitBrain's deprecated or unsafe package list.",
        ),
    report.unpinned.length > 0
      ? section(
          heading(2, `Unpinned ranges (${formatNumber(report.unpinned.length)})`),
          `These are declared with a range so loose that the installed version is whatever exists on the day of the install: ${joinWords(report.unpinned.slice(0, 25).map((name) => code(name)))}.`,
        )
      : null,
    undeclared.length > 0
      ? section(
          heading(2, `Undeclared imports (${formatNumber(undeclared.length)})`),
          'The code imports these packages but no manifest declares them. Each one is a runtime failure waiting for a clean install.',
          table(
            ['Package', 'Imported by', 'First importer'],
            undeclared
              .slice()
              .sort((a, b) => b.count - a.count)
              .slice(0, 20)
              .map((external) => [
                code(external.name),
                `${formatNumber(external.count)} ${external.count === 1 ? 'file' : 'files'}`,
                external.importers[0] ? code(external.importers[0]) : '—',
              ]),
          ),
        )
      : null,
    runtime.length > 0
      ? section(
          heading(2, `Runtime dependencies (${formatNumber(runtime.length)})`),
          'These ship with the application; every one of them is code you are responsible for at runtime.',
          table(
            ['Package', 'Range', 'Declared in', 'Ecosystem'],
            runtime
              .slice(0, 60)
              .map((dependency) => [
                code(dependency.name),
                code(dependency.range),
                code(dependency.manifest),
                dependency.ecosystem,
              ]),
          ),
          runtime.length > 60
            ? `…and ${countLabel(runtime.length - 60, 'more runtime dependency', 'more runtime dependencies')}.`
            : null,
        )
      : null,
  );

  const refs: CitationRef[] = report.manifests.map((manifest) => ({ file: manifest }));
  for (const external of undeclared.slice(0, 6)) {
    const importer = external.importers[0];
    if (importer) refs.push({ file: importer });
  }

  return makeDoc(
    'dependency-analysis',
    'Dependency Analysis',
    `${countLabel(total, 'declared dependency', 'declared dependencies')} across ${countLabel(report.manifests.length, 'manifest')}, lockfile ${report.hasLockfile ? 'present' : 'missing'}, ${formatNumber(report.flagged.length)} flagged.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 10)),
  );
}

// ---------------------------------------------------------------------------
// Code complexity
// ---------------------------------------------------------------------------

export function codeComplexity(context: KnowledgeContext): KnowledgeDoc {
  const report = context.complexity;

  if (report.files.length === 0) {
    const markdown = section(
      heading(1, 'Code Complexity'),
      `No file in ${code(repoName(context))} was measured for complexity. GitBrain measures languages it can parse structurally; this snapshot contains none of them, or contains only generated and vendored code, which is excluded by design.`,
    );

    return makeDoc(
      'code-complexity',
      'Code Complexity',
      'No files were eligible for complexity measurement in this repository.',
      markdown,
      ensureCitations(context, []),
    );
  }

  const bySize = report.files.slice().sort((a, b) => b.loc - a.loc);
  const topThree = bySize.slice(0, 3);
  const topThreeLoc = topThree.reduce((sum, file) => sum + file.loc, 0);
  const hotspots = report.hotspots.length > 0 ? report.hotspots : bySize.slice(0, 10);
  const deepest = report.files.slice().sort((a, b) => b.maxNesting - a.maxNesting)[0];
  const branchiest = report.files.slice().sort((a, b) => b.cyclomatic - a.cyclomatic)[0];
  const commentDensity = Math.round(context.stats.commentRatio * 100);

  const highRisk = report.files.filter((file) => file.riskScore >= 70);

  const markdown = section(
    heading(1, 'Code Complexity'),
    `${countLabel(report.files.length, 'file')} were measured, totalling ${countLabel(report.totalLoc, 'line')} of which ${formatNumber(report.totalSloc)} (${formatPercent(report.totalSloc, report.totalLoc)}) are executable source. Average cyclomatic complexity is ${formatNumber(report.averageComplexity)} per file.`,
    topThree.length === 3
      ? `Size is concentrated: the three largest files — ${joinWords(topThree.map((file) => `${code(file.path)} (${formatNumber(file.loc)} LOC)`))} — account for ${formatPercent(topThreeLoc, report.totalLoc)} of all measured lines.`
      : null,
    highRisk.length > 0
      ? `${countLabel(highRisk.length, 'file')} score 70 or above on the composite risk index, meaning length, branching and nesting all point the same way.`
      : 'No file scores above 70 on the composite risk index; complexity is spread rather than concentrated in a few unmaintainable modules.',
    report.distribution.length > 0
      ? section(
          heading(2, 'Complexity distribution'),
          table(
            ['Bucket', 'Files', 'Share'],
            report.distribution.map((bucket) => [
              bucket.bucket,
              formatNumber(bucket.count),
              formatPercent(bucket.count, report.files.length),
            ]),
          ),
        )
      : null,
    section(
      heading(2, 'Hotspots'),
      'Ranked by the composite risk score, which combines length, branch density, nesting depth and function count.',
      table(
        ['File', 'LOC', 'SLOC', 'Cyclomatic', 'Max nesting', 'Functions', 'Risk'],
        hotspots
          .slice(0, 15)
          .map((file) => [
            code(file.path),
            formatNumber(file.loc),
            formatNumber(file.sloc),
            formatNumber(file.cyclomatic),
            formatNumber(file.maxNesting),
            formatNumber(file.functions),
            `${formatNumber(file.riskScore)}/100`,
          ]),
      ),
    ),
    section(
      heading(2, 'What stands out'),
      bulletList(
        [
          branchiest
            ? `${fileRef(branchiest.path)} has the highest branch density at a cyclomatic complexity of ${formatNumber(branchiest.cyclomatic)} across ${countLabel(branchiest.functions, 'function')} — roughly ${formatNumber(branchiest.cyclomatic / Math.max(branchiest.functions, 1))} decision points per function.`
            : '',
          deepest
            ? `${fileRef(deepest.path)} is the most deeply nested at ${countLabel(deepest.maxNesting, 'level')}. Anything past four levels is usually a missing early return or an extracted helper.`
            : '',
          `Comment density across the repository is ${commentDensity}% of source files carrying a leading doc comment.`,
          context.graph.cycles.length > 0
            ? `${countLabel(context.graph.cycles.length, 'import cycle')} compound the above: cyclic modules cannot be reasoned about, or tested, one at a time.`
            : '',
        ].filter(Boolean),
      ),
    ),
  );

  const refs: CitationRef[] = hotspots.slice(0, 8).map((file) => ({ file: file.path }));
  if (deepest) refs.push({ file: deepest.path });
  if (branchiest) refs.push({ file: branchiest.path });

  const worst = hotspots[0];

  return makeDoc(
    'code-complexity',
    'Code Complexity',
    worst
      ? `${countLabel(report.totalLoc, 'line')} measured, average complexity ${formatNumber(report.averageComplexity)}; the riskiest file is ${worst.path} at ${formatNumber(worst.riskScore)}/100.`
      : `${countLabel(report.totalLoc, 'line')} measured with an average complexity of ${formatNumber(report.averageComplexity)}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 10)),
  );
}

// ---------------------------------------------------------------------------
// Technical debt
// ---------------------------------------------------------------------------

export function technicalDebt(context: KnowledgeContext): KnowledgeDoc {
  const report = context.debt;
  const nothingFound =
    report.items.length === 0 && report.markers.length === 0 && report.duplicates.length === 0;

  if (nothingFound) {
    const markdown = section(
      heading(1, 'Technical Debt'),
      `GitBrain found no debt items, no ${code('TODO')}/${code('FIXME')}/${code('HACK')}/${code('XXX')} markers and no duplicated blocks in ${code(repoName(context))}.`,
      'That is a real result, not a gap in the scan — but it only covers what static analysis can see. Missing abstractions, wrong models and undocumented decisions leave no textual trace.',
    );

    return makeDoc(
      'technical-debt',
      'Technical Debt',
      'No debt items, code markers or duplicated blocks were detected.',
      markdown,
      ensureCitations(context, []),
    );
  }

  const items = report.items
    .slice()
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) || b.estimatedHours - a.estimatedHours,
    );

  const byCategory = new Map<string, { count: number; hours: number }>();
  for (const item of items) {
    const current = byCategory.get(item.category) ?? { count: 0, hours: 0 };
    byCategory.set(item.category, {
      count: current.count + 1,
      hours: current.hours + item.estimatedHours,
    });
  }

  const markersByKind = new Map<string, number>();
  for (const marker of report.markers) {
    markersByKind.set(marker.kind, (markersByKind.get(marker.kind) ?? 0) + 1);
  }

  const duplicatedLines = report.duplicates.reduce(
    (sum, block) => sum + block.lineCount * Math.max(block.occurrences.length - 1, 0),
    0,
  );

  const markdown = section(
    heading(1, 'Technical Debt'),
    `${countLabel(items.length, 'debt item')} totalling an estimated ${countLabel(report.totalEstimatedHours, 'engineer-hour')}${report.markers.length > 0 ? `, plus ${countLabel(report.markers.length, 'in-code marker')}` : ''}${report.duplicates.length > 0 ? ` and ${countLabel(report.duplicates.length, 'duplicated block')} covering roughly ${countLabel(duplicatedLines, 'redundant line')}` : ''}. Hour estimates are heuristic — they are useful for ranking work, not for planning a sprint.`,
    byCategory.size > 0
      ? section(
          heading(2, 'By category'),
          table(
            ['Category', 'Items', 'Estimated hours'],
            [...byCategory.entries()]
              .sort((a, b) => b[1].hours - a[1].hours)
              .map(([category, totals]) => [
                category,
                formatNumber(totals.count),
                formatNumber(totals.hours),
              ]),
          ),
        )
      : null,
    items.length > 0
      ? section(
          heading(2, 'Items, worst first'),
          items
            .slice(0, 12)
            .map((item) => renderDebtItem(item))
            .join('\n\n'),
          items.length > 12 ? `…and ${countLabel(items.length - 12, 'further item')}.` : null,
        )
      : null,
    report.markers.length > 0
      ? section(
          heading(2, `In-code markers (${formatNumber(report.markers.length)})`),
          `Breakdown: ${joinWords([...markersByKind.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${formatNumber(count)} ${code(kind)}`))}.`,
          table(
            ['Location', 'Kind', 'Note'],
            report.markers
              .slice(0, 25)
              .map((marker) => [
                fileRef(marker.file, marker.line),
                marker.kind,
                marker.text.slice(0, 140),
              ]),
          ),
          report.markers.length > 25
            ? `…and ${countLabel(report.markers.length - 25, 'more marker')}.`
            : null,
        )
      : null,
    report.duplicates.length > 0
      ? section(
          heading(2, `Duplicated blocks (${formatNumber(report.duplicates.length)})`),
          table(
            ['Lines', 'Copies', 'Locations'],
            report.duplicates
              .slice()
              .sort(
                (a, b) => b.lineCount * b.occurrences.length - a.lineCount * a.occurrences.length,
              )
              .slice(0, 15)
              .map((block) => [
                formatNumber(block.lineCount),
                formatNumber(block.occurrences.length),
                block.occurrences
                  .slice(0, 4)
                  .map((occurrence) => fileRef(occurrence.file, occurrence.startLine))
                  .join(', '),
              ]),
          ),
        )
      : null,
  );

  const refs: CitationRef[] = [
    ...items.slice(0, 6).flatMap((item) => item.files.slice(0, 2).map((file) => ({ file }))),
    ...report.markers.slice(0, 8).map((marker) => ({
      file: marker.file,
      startLine: marker.line,
      excerpt: marker.text,
    })),
    ...report.duplicates
      .slice(0, 4)
      .flatMap((block) =>
        block.occurrences
          .slice(0, 2)
          .map((occurrence) => ({ file: occurrence.file, startLine: occurrence.startLine })),
      ),
  ];

  return makeDoc(
    'technical-debt',
    'Technical Debt',
    `${countLabel(items.length, 'debt item')} estimated at ${countLabel(report.totalEstimatedHours, 'engineer-hour')}, with ${formatNumber(report.markers.length)} in-code markers and ${formatNumber(report.duplicates.length)} duplicated blocks.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}

function renderDebtItem(item: DebtItem): string {
  const files =
    item.files.length > 0
      ? `Files: ${item.files
          .slice(0, 5)
          .map((file) => fileRef(file))
          .join(', ')}${item.files.length > 5 ? ` (+${item.files.length - 5} more)` : ''}`
      : 'No specific files attached.';

  return section(
    heading(3, `${severityLabel(item.severity)} · ${item.title}`),
    item.detail,
    bulletList([
      `Category: ${code(item.category)}`,
      `Estimated effort: ${countLabel(item.estimatedHours, 'hour')}`,
      files,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const ENTRY_KIND_ORDER: readonly string[] = [
  'app',
  'server',
  'cli',
  'library',
  'build',
  'test',
  'config',
];

const ENTRY_KIND_BLURB: Readonly<Record<string, string>> = {
  app: 'User-facing application roots — where the UI or the framework starts rendering.',
  server: 'Long-running processes that bind a port and accept requests.',
  cli: 'Executables invoked from a terminal, usually declared in a manifest `bin` field.',
  library: 'Public module surfaces that other packages import.',
  build: 'Bundler, compiler and toolchain configuration that shapes the build.',
  test: 'Test runners and suite roots.',
  config: 'Configuration read at startup.',
};

export function entryPoints(context: KnowledgeContext): KnowledgeDoc {
  const points = context.entryPoints;

  if (points.length === 0) {
    const markdown = section(
      heading(1, 'Entry Points'),
      `GitBrain identified no entry point in ${code(repoName(context))}.`,
      'It looks for manifest declarations (`main`, `module`, `exports`, `bin`, `scripts`), framework conventions (`app/`, `pages/`, `src/index.*`, `main.*`, `__main__.py`, `cmd/*/main.go`), and files that are imported by nothing but import others. None of those matched.',
      context.graph.orphans.length > 0
        ? `The graph does contain ${countLabel(context.graph.orphans.length, 'module')} that nothing imports — ${joinWords(context.graph.orphans.slice(0, 5).map((path) => code(path)))} — which is where execution would have to begin if it begins anywhere in this snapshot.`
        : 'The snapshot may be a fragment of a larger repository, or a pure library consumed entirely from outside.',
    );

    return makeDoc(
      'entry-points',
      'Entry Points',
      'No entry point could be identified from manifests, conventions or the import graph.',
      markdown,
      ensureCitations(context, []),
    );
  }

  const grouped = ENTRY_KIND_ORDER.map((kind) => ({
    kind,
    entries: points.filter((point) => point.kind === kind),
  })).filter((group) => group.entries.length > 0);

  const nodeByPath = new Map(context.graph.nodes.map((node) => [node.path, node] as const));

  const markdown = section(
    heading(1, 'Entry Points'),
    `${countLabel(points.length, 'entry point')} in ${countLabel(grouped.length, 'category')}. These are the places where control enters the system; everything else is reached from one of them.`,
    section(
      heading(2, 'All entry points'),
      table(
        ['Path', 'Kind', 'Why', 'Confidence', 'Imports'],
        points
          .slice()
          .sort(
            (a, b) =>
              ENTRY_KIND_ORDER.indexOf(a.kind) - ENTRY_KIND_ORDER.indexOf(b.kind) ||
              a.path.localeCompare(b.path),
          )
          .map((point) => [
            code(point.path),
            point.kind,
            point.reason,
            point.confidence,
            formatNumber(nodeByPath.get(point.path)?.outDegree ?? 0),
          ]),
      ),
    ),
    ...grouped.map((group) =>
      section(
        heading(2, `${group.kind} (${formatNumber(group.entries.length)})`),
        ENTRY_KIND_BLURB[group.kind] ?? '',
        bulletList(
          group.entries.map((entry) => {
            const node = nodeByPath.get(entry.path);
            const shape = node
              ? ` — ${countLabel(node.loc, 'line')}, imports ${formatNumber(node.outDegree)} ${node.outDegree === 1 ? 'module' : 'modules'}`
              : '';
            return `${fileRef(entry.path)}: ${entry.reason} (${entry.confidence} confidence)${shape}`;
          }),
        ),
      ),
    ),
  );

  const refs: CitationRef[] = points.map((point) => ({ file: point.path }));
  const primary = points[0];

  return makeDoc(
    'entry-points',
    'Entry Points',
    primary
      ? `${countLabel(points.length, 'entry point')}, starting with ${primary.path} (${primary.kind}).`
      : `${countLabel(points.length, 'entry point')}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}

// ---------------------------------------------------------------------------
// Data flow
// ---------------------------------------------------------------------------

export function dataFlow(context: KnowledgeContext): KnowledgeDoc {
  const { graph } = context;

  if (graph.nodes.length === 0) {
    const markdown = section(
      heading(1, 'Data Flow'),
      `No import graph could be built for ${code(repoName(context))}, so GitBrain cannot trace how data moves between modules.`,
      'The graph is built by parsing import and require statements in languages GitBrain understands. This snapshot contains none of them, or contains only files that import nothing.',
      context.security.envVars.length > 0
        ? `The one input that is visible is configuration: ${countLabel(context.security.envVars.length, 'environment variable')} are read at runtime. See *Environment Variables*.`
        : null,
    );

    return makeDoc(
      'data-flow',
      'Data Flow',
      'No import graph is available, so module-to-module data flow could not be traced.',
      markdown,
      ensureCitations(context, []),
    );
  }

  const entryPaths = new Set(context.entryPoints.map((point) => point.path));
  const ranked = graph.nodes
    .slice()
    .sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree) || b.loc - a.loc);

  const selected: GraphNode[] = [];
  for (const node of graph.nodes) {
    if (entryPaths.has(node.path) && selected.length < 5) selected.push(node);
  }
  for (const node of ranked) {
    if (selected.length >= 12) break;
    if (!selected.some((existing) => existing.id === node.id)) selected.push(node);
  }

  const selectedIds = new Set(selected.map((node) => node.id));
  const idIndex = new Map(selected.map((node, index) => [node.id, index] as const));

  const internalEdges = graph.edges.filter(
    (edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to) && edge.from !== edge.to,
  );

  // Sinks and sources are only drawn when a *selected* module is the one that
  // actually references them, so no arrow in the diagram is invented.
  const dbDetection = context.stack.databases[0];
  const dbFiles = new Set(context.stack.databases.flatMap((detection) => detection.files));
  const dbLinked = selected.filter((node) => dbFiles.has(node.path));

  const envFiles = new Set(context.security.envVars.flatMap((usage) => usage.files));
  const envLinked = selected.filter((node) => envFiles.has(node.path));

  const apiFiles = new Set(context.stack.api.endpoints.map((endpoint) => endpoint.file));
  const apiLinked = selected.filter((node) => apiFiles.has(node.path));

  const lines: string[] = ['flowchart LR'];
  for (const [index, node] of selected.entries()) {
    lines.push(`  ${mermaidId('f', index)}["${mermaidLabel(node.path)}"]`);
  }
  if (envLinked.length > 0) lines.push('  env[/"Environment config"/]');
  if (apiLinked.length > 0) {
    lines.push(`  client(["HTTP clients"])`);
  }
  if (dbLinked.length > 0 && dbDetection) {
    lines.push(`  db[("${mermaidLabel(detectionLabel(dbDetection))}")]`);
  }

  for (const node of envLinked) {
    const index = idIndex.get(node.id);
    if (index !== undefined) lines.push(`  env --> ${mermaidId('f', index)}`);
  }
  for (const node of apiLinked) {
    const index = idIndex.get(node.id);
    if (index !== undefined) lines.push(`  client --> ${mermaidId('f', index)}`);
  }
  for (const edge of internalEdges.slice(0, 24)) {
    const from = idIndex.get(edge.from);
    const to = idIndex.get(edge.to);
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${mermaidId('f', from)} --> ${mermaidId('f', to)}`);
  }
  for (const node of dbLinked) {
    const index = idIndex.get(node.id);
    if (index !== undefined) lines.push(`  ${mermaidId('f', index)} --> db`);
  }

  const drawable = internalEdges.length > 0 || envLinked.length > 0 || dbLinked.length > 0;

  const sources: string[] = [];
  if (apiLinked.length > 0) {
    sources.push(
      `**Inbound requests** reach ${countLabel(context.stack.api.endpoints.length, 'detected endpoint')} declared across ${countLabel(new Set(context.stack.api.endpoints.map((endpoint) => endpoint.file)).size, 'file')}.`,
    );
  }
  if (context.security.envVars.length > 0) {
    sources.push(
      `**Configuration** enters through ${countLabel(context.security.envVars.length, 'environment variable')}, read in ${countLabel(new Set(context.security.envVars.flatMap((usage) => usage.files)).size, 'file')}.`,
    );
  }
  if (context.entryPoints.length > 0) {
    sources.push(
      `**Process start** happens at ${joinWords(context.entryPoints.slice(0, 3).map((point) => fileRef(point.path)))}.`,
    );
  }
  if (sources.length === 0) {
    sources.push(
      'No inbound request handlers, configuration reads or entry points were detected — the only inputs are whatever a caller passes directly into the modules below.',
    );
  }

  const sinks: string[] = [];
  if (context.stack.databases.length > 0) {
    sinks.push(
      `**Persistence** via ${joinWords(context.stack.databases.map((detection) => detectionLabel(detection)))}, referenced from ${joinWords([...dbFiles].slice(0, 4).map((file) => fileRef(file)))}.`,
    );
  }
  const httpClients = graph.externals.filter((external) =>
    /^(axios|node-fetch|got|undici|ky|superagent|requests|httpx|reqwest)$/.test(external.name),
  );
  if (httpClients.length > 0) {
    sinks.push(
      `**Outbound HTTP** through ${joinWords(httpClients.map((external) => `${code(external.name)} (${formatNumber(external.count)} importers)`))}.`,
    );
  }
  if (sinks.length === 0) {
    sinks.push(
      'No database clients or HTTP client libraries were detected, so no external side effects are visible to static analysis.',
    );
  }

  const hubs = ranked.filter((node) => node.inDegree >= 2).slice(0, 6);

  const markdown = section(
    heading(1, 'Data Flow'),
    `This traces the paths static analysis can actually see: import edges between modules, configuration reads, detected request handlers and detected database clients. Runtime message passing, dynamic imports and network calls made through string-built URLs are invisible here.`,
    drawable
      ? section(
          heading(2, 'Traced paths'),
          'Every edge below is a real import, configuration read or database reference found in the code.',
          mermaid(lines.join('\n')),
        )
      : null,
    section(heading(2, 'Where data enters'), bulletList(sources)),
    hubs.length > 0
      ? section(
          heading(2, 'Where it passes through'),
          'Modules with the most inbound imports carry the most traffic in the dependency sense — most call paths cross them.',
          table(
            ['Module', 'Imported by', 'Imports', 'LOC'],
            hubs.map((node) => [
              code(node.path),
              formatNumber(node.inDegree),
              formatNumber(node.outDegree),
              formatNumber(node.loc),
            ]),
          ),
        )
      : null,
    section(heading(2, 'Where it leaves'), bulletList(sinks)),
    note(
      'Static analysis only. GitBrain reads imports and literal patterns; it does not execute the code, so any flow assembled at runtime is absent from this document.',
    ),
  );

  const refs: CitationRef[] = [
    ...selected.slice(0, 6).map((node) => ({ file: node.path })),
    ...[...dbFiles].slice(0, 3).map((file) => ({ file })),
    ...context.stack.api.endpoints.slice(0, 3).map((endpoint) => ({
      file: endpoint.file,
      startLine: endpoint.line,
    })),
  ];

  return makeDoc(
    'data-flow',
    'Data Flow',
    `${countLabel(internalEdges.length, 'traced import edge')} between the ${formatNumber(selected.length)} busiest modules, ${context.stack.databases.length > 0 ? 'terminating in a detected datastore' : 'with no detected datastore'}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 10)),
  );
}
