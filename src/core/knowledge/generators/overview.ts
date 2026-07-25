/**
 * Orientation documents: what this repository is, why it exists, how it is laid
 * out, and how its modules fit together.
 *
 * These four are the first thing a new engineer reads, so they lead with facts
 * — real counts, real paths, real detected technologies — and say plainly when
 * a fact could not be established.
 */

import type { KnowledgeDoc, TreeNode } from '../../types';
import { search } from '../../search';
import {
  citationsFor,
  detectionLabel,
  detectionRefs,
  ensureCitations,
  findFile,
  primaryLanguage,
  rankDetections,
  readManifest,
  repoName,
  repoUrl,
  topDetection,
  topLevelDirectories,
  type CitationRef,
  type KnowledgeContext,
} from '../context';
import {
  bulletList,
  code,
  countLabel,
  fileRef,
  formatBytes,
  formatNumber,
  formatPercent,
  heading,
  joinWords,
  makeDoc,
  mermaid,
  mermaidId,
  mermaidLabel,
  numberedList,
  section,
  table,
} from '../format';

// ---------------------------------------------------------------------------
// Executive summary
// ---------------------------------------------------------------------------

export function executiveSummary(context: KnowledgeContext): KnowledgeDoc {
  const name = repoName(context);
  const { stats, health, graph } = context;
  const primary = primaryLanguage(context);
  const framework = topDetection(context.stack.frameworks);
  const manifest = readManifest(context);
  const architecture = context.stack.architecture;

  const languageMix = context.languages
    .slice(0, 4)
    .map((language) => `${language.language} ${language.percent}%`);

  const identity = [
    `${code(name)} is a ${formatNumber(stats.files)}-file repository containing ${countLabel(stats.linesOfCode, 'line')} of code across ${countLabel(context.languages.length, 'language')}${languageMix.length > 0 ? ` (${joinWords(languageMix)})` : ''}.`,
    manifest?.description
      ? `Its manifest describes it as "${manifest.description}".`
      : context.readme.exists
        ? `Its README runs to ${countLabel(context.readme.wordCount, 'word')} and scores ${context.readme.score}/100 against GitBrain's documentation checklist.`
        : 'It ships no README, so its own description of itself is unavailable.',
    framework
      ? `The dominant technology is ${detectionLabel(framework)}, detected with ${framework.confidence} confidence${framework.evidence[0] ? ` from ${framework.evidence[0]}` : ''}.`
      : 'No application framework was detected, which is typical of a library, a CLI or a plain-language project.',
  ].join(' ');

  const shape = [
    `GitBrain classifies the codebase as a ${code(architecture.style)} with ${architecture.confidence} confidence${architecture.evidence[0] ? `: ${architecture.evidence[0].toLowerCase()}` : ''}.`,
    graph.nodes.length > 0
      ? `The module graph holds ${countLabel(graph.nodes.length, 'file')} joined by ${countLabel(graph.edges.length, 'import edge')}, ${graph.cycles.length === 0 ? 'with no circular dependencies' : `including ${countLabel(graph.cycles.length, 'dependency cycle')}`}, and ${countLabel(graph.orphans.length, 'orphaned module')} that nothing imports.`
      : 'No import graph could be built, so cross-module relationships are unknown.',
    context.entryPoints.length > 0
      ? `Execution starts at ${joinWords(context.entryPoints.slice(0, 3).map((entry) => code(entry.path)))}.`
      : 'No entry point could be identified from manifests or conventional filenames.',
  ].join(' ');

  const weakest = context.health.scores.slice().sort((a, b) => a.score - b.score)[0];

  const condition = [
    `Overall health is ${health.grade} (${health.overall}/100).`,
    weakest
      ? `The weakest dimension is ${weakest.label} at ${weakest.score}/100${weakest.rationale[0] ? ` — ${weakest.rationale[0].toLowerCase()}` : ''}.`
      : 'No health dimensions were scored.',
    `Technical debt is estimated at ${countLabel(context.debt.totalEstimatedHours, 'engineer-hour')} across ${countLabel(context.debt.items.length, 'item')}, and the security scan returned ${context.security.score}/100 with ${countLabel(context.security.risks.length, 'open risk')}.`,
  ].join(' ');

  const facts = table(
    ['Fact', 'Value'],
    [
      ['Repository', repoUrl(context) ? `[${name}](${repoUrl(context)})` : name],
      [
        'Primary language',
        primary
          ? `${primary.language} — ${primary.percent}% of analyzed source bytes`
          : 'Not determined',
      ],
      [
        'Framework',
        framework
          ? `${detectionLabel(framework)} (${framework.confidence} confidence)`
          : 'None detected',
      ],
      ['Architecture', `${architecture.style} (${architecture.confidence} confidence)`],
      [
        'Size',
        `${formatNumber(stats.files)} files · ${formatNumber(stats.linesOfCode)} LOC · ${formatBytes(stats.totalBytes)}`,
      ],
      [
        'Tests',
        stats.testFiles === 0
          ? 'None found'
          : `${formatNumber(stats.testFiles)} test files (${Math.round(stats.testRatio * 100)}% of source files)`,
      ],
      [
        'Dependencies',
        context.dependencies.dependencies.length === 0
          ? 'None declared'
          : `${formatNumber(context.dependencies.counts.runtime)} runtime · ${formatNumber(context.dependencies.counts.dev)} dev · lockfile ${context.dependencies.hasLockfile ? 'present' : 'missing'}`,
      ],
      ['Health grade', `${health.grade} (${health.overall}/100)`],
      ['Security score', `${context.security.score}/100`],
    ],
  );

  const hub = graph.nodes
    .slice()
    .sort((a, b) => b.inDegree - a.inDegree || b.loc - a.loc)
    .find((node) => node.inDegree > 0);

  const hotspot = context.complexity.hotspots[0] ?? context.complexity.files[0];
  const priority =
    health.topSuggestions[0] ??
    context.debt.items.slice().sort((a, b) => b.estimatedHours - a.estimatedHours)[0];

  const mustKnow: string[] = [];
  if (context.entryPoints[0]) {
    const entry = context.entryPoints[0];
    mustKnow.push(
      `**Start reading at ${fileRef(entry.path)}.** It is the repository's ${entry.kind} entry point — ${entry.reason}.`,
    );
  } else if (hotspot) {
    mustKnow.push(
      `**There is no declared entry point.** The largest module, ${fileRef(hotspot.path)} at ${countLabel(hotspot.loc, 'line')}, is the most useful place to start reading.`,
    );
  }
  if (hub) {
    mustKnow.push(
      `**${fileRef(hub.path)} is the busiest module**, imported by ${countLabel(hub.inDegree, 'file')} and importing ${formatNumber(hub.outDegree)}. Changes there propagate widely.`,
    );
  } else if (context.dependencies.dependencies.length > 0) {
    mustKnow.push(
      `**The project leans on ${countLabel(context.dependencies.dependencies.length, 'declared dependency')}** across ${joinWords(context.dependencies.manifests.map((path) => code(path)))}; the dependency surface, not the internal graph, is where most behaviour lives.`,
    );
  }
  if (priority && 'title' in priority) {
    const files = priority.files.slice(0, 2).map((file) => fileRef(file));
    mustKnow.push(
      `**The highest-value fix is "${priority.title}"**${files.length > 0 ? ` — touch ${joinWords(files)}` : ''}. See *Suggested Improvements* for the ranked list.`,
    );
  }
  if (mustKnow.length === 0) {
    mustKnow.push(
      'GitBrain found no entry points, no module graph and no debt items — the snapshot is too small or too unusual for a confident orientation.',
    );
  }

  const markdown = section(
    heading(1, 'Executive Summary'),
    identity,
    shape,
    condition,
    heading(2, 'At a glance'),
    facts,
    heading(2, 'Three things a new engineer should know'),
    numberedList(mustKnow.slice(0, 3)),
  );

  const refs: CitationRef[] = [];
  if (manifest) refs.push({ file: manifest.path });
  if (context.readme.path) refs.push({ file: context.readme.path });
  if (context.entryPoints[0]) refs.push({ file: context.entryPoints[0].path });
  if (hub) refs.push({ file: hub.path });
  if (hotspot) refs.push({ file: hotspot.path });
  refs.push(...detectionRefs(context.stack.frameworks));

  return makeDoc(
    'executive-summary',
    'Executive Summary',
    `${name} is a ${formatNumber(stats.files)}-file ${primary?.language ?? 'multi-language'} ${architecture.style} scoring ${health.grade} (${health.overall}/100) for overall health.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 8)),
  );
}

// ---------------------------------------------------------------------------
// Project purpose
// ---------------------------------------------------------------------------

/** Directory names that describe engineering layers rather than a problem domain. */
const STRUCTURAL_DIR_NAMES = new Set([
  'src',
  'lib',
  'libs',
  'app',
  'apps',
  'pages',
  'components',
  'ui',
  'utils',
  'util',
  'helpers',
  'config',
  'configs',
  'scripts',
  'script',
  'test',
  'tests',
  'spec',
  'specs',
  'e2e',
  'public',
  'static',
  'assets',
  'styles',
  'css',
  'types',
  'typings',
  'hooks',
  'dist',
  'build',
  'out',
  'bin',
  'docs',
  'doc',
  'examples',
  'example',
  'packages',
  'modules',
  'internal',
  'common',
  'shared',
  'core',
  'pkg',
  'cmd',
  'tools',
  'tooling',
  'vendor',
  'node_modules',
  'api',
  'server',
  'client',
  'web',
  'www',
  'main',
  'include',
  'target',
  'fixtures',
  'mocks',
  '__tests__',
  '__mocks__',
  'migrations',
  'constants',
  'interfaces',
  'models',
  'services',
  'store',
]);

export function projectPurpose(context: KnowledgeContext): KnowledgeDoc {
  const name = repoName(context);
  const manifest = readManifest(context);
  const readmeTitle = firstReadmeHeading(context);
  const intro = readmeIntro(context);
  const domainNouns = domainVocabulary(context);
  const framework = topDetection(context.stack.frameworks);
  const evidence: string[] = [];
  const refs: CitationRef[] = [];

  if (manifest) {
    const parts = [
      manifest.name ? `${code('name')} is ${code(manifest.name)}` : null,
      manifest.description ? `${code('description')} reads "${manifest.description}"` : null,
      manifest.version ? `version ${code(manifest.version)}` : null,
      manifest.license ? `licensed ${code(manifest.license)}` : null,
    ].filter((part): part is string => part !== null);
    if (parts.length > 0) {
      evidence.push(`${fileRef(manifest.path)}: ${joinWords(parts)}.`);
      refs.push({ file: manifest.path });
    }
  }

  if (intro) {
    evidence.push(
      `${fileRef(intro.file, intro.line)}: the README's opening paragraph — "${intro.text}"`,
    );
    refs.push({ file: intro.file, startLine: intro.line, excerpt: intro.text });
  } else if (context.readme.exists && context.readme.path) {
    evidence.push(
      `${fileRef(context.readme.path)} exists but has no prose introduction before its first section.`,
    );
    refs.push({ file: context.readme.path });
  } else {
    evidence.push('No README was found, so the project does not state its own purpose in prose.');
  }

  if (domainNouns.length > 0) {
    evidence.push(
      `Directory names that are not generic engineering layers: ${joinWords(domainNouns.map((noun) => code(noun)))}.`,
    );
  }

  if (framework) {
    evidence.push(
      `Detected stack: ${joinWords(
        rankDetections(context.stack.frameworks)
          .slice(0, 4)
          .map((detection) => detectionLabel(detection)),
      )}, which constrains what kind of product this can be.`,
    );
    refs.push(...detectionRefs([framework]));
  }

  if (context.entryPoints.length > 0) {
    const kinds = [...new Set(context.entryPoints.map((entry) => entry.kind))];
    evidence.push(
      `Entry points of kind ${joinWords(kinds.map((kind) => code(kind)))} — see *Entry Points* for the full list.`,
    );
  }

  // Lexical search grounds the inference in code that actually mentions the
  // project's own vocabulary, rather than in the file names alone.
  const probe = [manifest?.name ?? '', name.split('/')[1] ?? '', ...domainNouns.slice(0, 3)]
    .filter(Boolean)
    .join(' ');
  const hits = probe.trim().length > 0 ? search(context.search, probe, 3) : [];
  for (const hit of hits) {
    refs.push({
      file: hit.document.file,
      startLine: hit.document.startLine,
      endLine: hit.document.endLine,
    });
  }

  const claim = statedPurpose(manifest?.description ?? null, intro?.text ?? null, readmeTitle);
  const inference = inferredPurpose(context, domainNouns);

  const verdict = claim
    ? `The project states its own purpose: ${claim}`
    : `The project never states its purpose in a manifest or a README, so the description below is inferred from structure alone. ${inference}`;

  const confidence = claim
    ? "High — taken from the project's own words and corroborated by the detected stack."
    : domainNouns.length > 0 || context.stack.frameworks.length > 0
      ? 'Medium — inferred from directory vocabulary, detected frameworks and entry points. Treat it as a starting hypothesis, not a specification.'
      : 'Low — there is no README, no manifest description and no domain-specific directory naming to reason from.';

  const markdown = section(
    heading(1, 'Project Purpose'),
    verdict,
    claim ? inference : null,
    heading(2, 'Evidence used'),
    bulletList(evidence),
    heading(2, 'Confidence'),
    confidence,
    hits.length > 0
      ? section(
          heading(2, 'Code that best matches the project vocabulary'),
          bulletList(
            hits.map(
              (hit) =>
                `${fileRef(hit.document.file, hit.document.startLine, hit.document.endLine)} — ${
                  hit.document.symbols
                    .slice(0, 5)
                    .map((symbol) => code(symbol))
                    .join(', ') || 'no declared symbols in this chunk'
                }`,
            ),
          ),
        )
      : null,
  );

  return makeDoc(
    'project-purpose',
    'Project Purpose',
    claim
      ? `${name} describes itself as: ${truncateSentence(claim, 140)}`
      : `No stated purpose was found for ${name}; the description is inferred from its structure and stack.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 8)),
  );
}

function statedPurpose(
  description: string | null,
  intro: string | null,
  title: string | null,
): string | null {
  if (description) return `"${description}"`;
  if (intro) return `"${truncateSentence(intro, 240)}"`;
  if (title)
    return `its README is titled "${title}", which is the only self-description available.`;
  return null;
}

function inferredPurpose(context: KnowledgeContext, domainNouns: readonly string[]): string {
  const framework = topDetection(context.stack.frameworks);
  const api = context.stack.api;
  const databases = context.stack.databases;
  const style = context.stack.architecture.style;

  const parts: string[] = [];

  parts.push(
    framework
      ? `Structurally it behaves like a ${detectionLabel(framework)} ${style === 'unknown' ? 'application' : style}`
      : `Structurally it behaves like a ${style === 'unknown' ? 'general-purpose codebase' : style}`,
  );

  if (api.style !== 'none' && api.style !== 'unknown') {
    parts.push(
      `it exposes a ${api.style.toUpperCase()} interface with ${countLabel(api.endpoints.length, 'detected endpoint')}`,
    );
  }
  if (databases.length > 0) {
    parts.push(`it persists data via ${joinWords(databases.map((db) => detectionLabel(db)))}`);
  }
  if (domainNouns.length > 0) {
    parts.push(`and its domain vocabulary centres on ${joinWords(domainNouns.slice(0, 5))}`);
  }

  return `${parts.join(', ')}.`;
}

/** Directory names across the tree that read like domain concepts. */
function domainVocabulary(context: KnowledgeContext): readonly string[] {
  const counts = new Map<string, number>();

  const visit = (node: TreeNode, depth: number): void => {
    if (depth > 3) return;
    for (const child of node.children ?? []) {
      if (child.type !== 'dir') continue;
      const lower = child.name.toLowerCase();
      if (!STRUCTURAL_DIR_NAMES.has(lower) && !lower.startsWith('.') && lower.length > 2) {
        counts.set(lower, (counts.get(lower) ?? 0) + child.fileCount);
      }
      visit(child, depth + 1);
    }
  };

  visit(context.tree, 0);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([nameOfDir]) => nameOfDir);
}

function firstReadmeHeading(context: KnowledgeContext): string | null {
  const path = context.readme.path;
  if (!path) return null;
  const file = findFile(context, path);
  if (!file?.content) return null;

  for (const line of file.content.split(/\r?\n/).slice(0, 40)) {
    const match = /^#\s+(.+?)\s*#*$/.exec(line);
    if (match?.[1]) return match[1].replace(/[[\]()]/g, '').trim();
  }
  return null;
}

/** The README's first real prose paragraph, skipping headings and badge rows. */
function readmeIntro(
  context: KnowledgeContext,
): { readonly file: string; readonly line: number; readonly text: string } | null {
  const path = context.readme.path;
  if (!path) return null;
  const file = findFile(context, path);
  if (!file?.content) return null;

  const lines = file.content.split(/\r?\n/);
  const buffer: string[] = [];
  let startLine = 0;

  for (let index = 0; index < Math.min(lines.length, 200); index += 1) {
    const raw = (lines[index] ?? '').trim();

    const isSkippable =
      raw.length === 0 ||
      raw.startsWith('#') ||
      raw.startsWith('<') ||
      raw.startsWith('---') ||
      raw.startsWith('===') ||
      raw.startsWith('```') ||
      raw.startsWith('|') ||
      /^\[!\[/.test(raw) ||
      /^!\[/.test(raw);

    if (isSkippable) {
      if (buffer.length > 0) break;
      continue;
    }

    if (buffer.length === 0) startLine = index + 1;
    buffer.push(raw);
    if (buffer.join(' ').length > 400) break;
  }

  if (buffer.length === 0) return null;

  const text = truncateSentence(buffer.join(' ').replace(/\s+/g, ' '), 320);
  return { file: path, line: startLine, text };
}

/** Truncate on a sentence boundary when possible, otherwise on a word. */
function truncateSentence(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > maxLength * 0.5) return cut.slice(0, stop + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxLength * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Folder explanation
// ---------------------------------------------------------------------------

export function folderExplanation(context: KnowledgeContext): KnowledgeDoc {
  const topLevel = topLevelDirectories(context);
  const rootFiles = (context.tree.children ?? []).filter((node) => node.type === 'file');
  const totalFiles = Math.max(context.stats.files, 1);

  if (topLevel.length === 0) {
    const markdown = section(
      heading(1, 'Folder Structure'),
      `${code(repoName(context))} is completely flat: all ${countLabel(context.stats.files, 'file')} sit at the repository root, with no directories at all.`,
      rootFiles.length > 0
        ? section(
            heading(2, 'Root files'),
            table(
              ['File', 'Size'],
              rootFiles
                .slice()
                .sort((a, b) => b.size - a.size)
                .slice(0, 25)
                .map((node) => [code(node.path), formatBytes(node.size)]),
            ),
          )
        : null,
    );

    return makeDoc(
      'folder-explanation',
      'Folder Structure',
      `The repository is flat — ${countLabel(context.stats.files, 'file')} at the root with no directories.`,
      markdown,
      ensureCitations(
        context,
        citationsFor(
          context,
          rootFiles.map((node) => ({ file: node.path })),
          6,
        ),
      ),
    );
  }

  const topRows = topLevel.map((node) => [
    code(`${node.path}/`),
    node.purpose ?? inferDirectoryPurpose(node),
    `${formatNumber(node.fileCount)} (${formatPercent(node.fileCount, totalFiles)})`,
    node.language ?? '—',
    formatBytes(node.size),
  ]);

  // Second-level directories are only worth listing where the top-level entry is
  // large enough that "src/" on its own tells the reader nothing.
  const notable = topLevel
    .filter((node) => node.fileCount >= 3)
    .flatMap((parent) =>
      (parent.children ?? [])
        .filter((child) => child.type === 'dir' && child.fileCount >= 2)
        .slice()
        .sort((a, b) => b.fileCount - a.fileCount)
        .slice(0, 6),
    )
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 18);

  const diagram = mermaid(
    [
      'flowchart TD',
      `  root["${mermaidLabel(repoName(context))}"]`,
      ...topLevel.slice(0, 10).flatMap((node, index) => {
        const id = mermaidId('dir', index);
        return [
          `  ${id}["${mermaidLabel(`${node.name}/`)}<br/>${formatNumber(node.fileCount)} files"]`,
          `  root --> ${id}`,
        ];
      }),
    ].join('\n'),
  );

  const deepest = context.stats.maxDepth;

  const markdown = section(
    heading(1, 'Folder Structure'),
    `${code(repoName(context))} organises ${countLabel(context.stats.files, 'file')} into ${countLabel(topLevel.length, 'top-level directory')}, nesting up to ${countLabel(deepest, 'level')} deep. ${describeConcentration(topLevel, totalFiles)}`,
    diagram,
    heading(2, 'Top-level directories'),
    table(['Directory', 'Purpose', 'Files', 'Dominant language', 'Size'], topRows),
    rootFiles.length > 0
      ? section(
          heading(2, 'Root files'),
          `${countLabel(rootFiles.length, 'file')} sits at the root: ${joinWords(rootFiles.slice(0, 12).map((node) => code(node.name)))}.`,
        )
      : null,
    notable.length > 0
      ? section(
          heading(2, 'Notable second-level directories'),
          table(
            ['Directory', 'Purpose', 'Files'],
            notable.map((node) => [
              code(`${node.path}/`),
              node.purpose ?? inferDirectoryPurpose(node),
              formatNumber(node.fileCount),
            ]),
          ),
        )
      : null,
  );

  const refs: CitationRef[] = [];
  for (const node of [...topLevel, ...notable]) {
    const sample = context.files.find((file) => file.path.startsWith(`${node.path}/`));
    if (sample) refs.push({ file: sample.path });
  }
  for (const node of rootFiles.slice(0, 4)) refs.push({ file: node.path });

  const largest = topLevel[0];

  return makeDoc(
    'folder-explanation',
    'Folder Structure',
    largest
      ? `${countLabel(topLevel.length, 'top-level directory')}, dominated by ${largest.path}/ with ${formatPercent(largest.fileCount, totalFiles)} of all files.`
      : `${countLabel(topLevel.length, 'top-level directory')} organising ${countLabel(context.stats.files, 'file')}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 10)),
  );
}

function describeConcentration(directories: readonly TreeNode[], totalFiles: number): string {
  const largest = directories[0];
  if (!largest) return '';

  const topThree = directories.slice(0, 3);
  const share = topThree.reduce((sum, node) => sum + node.fileCount, 0);

  if (directories.length <= 3) {
    return `${code(`${largest.path}/`)} holds ${formatPercent(largest.fileCount, totalFiles)} of all files.`;
  }
  return `The three largest directories — ${joinWords(topThree.map((node) => code(`${node.path}/`)))} — account for ${formatPercent(share, totalFiles)} of all files.`;
}

/** Fallback when the tree builder did not attach a purpose to a directory. */
function inferDirectoryPurpose(node: TreeNode): string {
  const parts = [
    node.language ? `${node.language} sources` : 'Mixed content',
    `${formatNumber(node.fileCount)} ${node.fileCount === 1 ? 'file' : 'files'}`,
  ];
  return `${parts.join(', ')} (purpose not classified)`;
}

// ---------------------------------------------------------------------------
// Architecture overview
// ---------------------------------------------------------------------------

export function architectureOverview(context: KnowledgeContext): KnowledgeDoc {
  const { graph, stack } = context;
  const architecture = stack.architecture;
  const groups = groupGraph(context);

  const hubs = graph.nodes
    .slice()
    .sort((a, b) => b.inDegree - a.inDegree || b.loc - a.loc)
    .filter((node) => node.inDegree > 0)
    .slice(0, 8);

  const unstable = graph.nodes
    .slice()
    .filter((node) => node.outDegree >= 3)
    .sort((a, b) => b.instability - a.instability || b.outDegree - a.outDegree)
    .slice(0, 5);

  const externals = graph.externals
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const diagram =
    groups.edges.length > 0
      ? mermaid(
          [
            'flowchart LR',
            ...groups.nodes.map(
              (group, index) => `  ${mermaidId('m', index)}["${mermaidLabel(group)}"]`,
            ),
            ...groups.edges.map((edge) => {
              const from = mermaidId('m', groups.nodes.indexOf(edge.from));
              const to = mermaidId('m', groups.nodes.indexOf(edge.to));
              return `  ${from} -->|${edge.weight}| ${to}`;
            }),
          ].join('\n'),
        )
      : null;

  const layerTable =
    groups.sizes.length > 0
      ? table(
          ['Module group', 'Files', 'Imports out', 'Imported by'],
          groups.sizes.map((group) => [
            code(group.name),
            formatNumber(group.files),
            formatNumber(group.out),
            formatNumber(group.in),
          ]),
        )
      : null;

  const cycleList =
    graph.cycles.length > 0
      ? bulletList(
          graph.cycles.slice(0, 6).map(
            (cycle) =>
              `${cycle
                .slice(0, 4)
                .map((path) => code(path))
                .join(' → ')}${cycle.length > 4 ? ` → … (${cycle.length} modules)` : ' → …'}`,
          ),
        )
      : null;

  const markdown = section(
    heading(1, 'Architecture Overview'),
    `GitBrain classifies ${code(repoName(context))} as a **${architecture.style}** with ${architecture.confidence} confidence.${architecture.evidence.length > 0 ? '' : ' No corroborating evidence was recorded for that classification, so treat it as a weak signal.'}`,
    architecture.evidence.length > 0
      ? section(
          heading(2, 'Why this classification'),
          bulletList(architecture.evidence.slice(0, 8)),
        )
      : null,
    graph.nodes.length === 0
      ? 'No module graph was produced for this repository — either the languages present are not parsed for imports, or every file stands alone. Everything below that depends on import relationships is therefore unavailable.'
      : `The import graph contains ${countLabel(graph.nodes.length, 'module')} and ${countLabel(graph.edges.length, 'edge')}, averaging ${formatNumber(graph.edges.length / Math.max(graph.nodes.length, 1))} imports per module.`,
    diagram
      ? section(
          heading(2, 'How the module groups depend on each other'),
          'Edges are real imports, aggregated to the directory level; the number on each edge is how many individual imports it represents.',
          diagram,
        )
      : null,
    layerTable ? section(heading(2, 'Module groups'), layerTable) : null,
    hubs.length > 0
      ? section(
          heading(2, 'Most depended-upon modules'),
          'These are the files whose interfaces are hardest to change, because everything else already relies on them.',
          table(
            ['Module', 'Imported by', 'Imports', 'LOC', 'Instability'],
            hubs.map((node) => [
              code(node.path),
              formatNumber(node.inDegree),
              formatNumber(node.outDegree),
              formatNumber(node.loc),
              node.instability.toFixed(2),
            ]),
          ),
        )
      : null,
    unstable.length > 0
      ? section(
          heading(2, 'Most volatile modules'),
          `Instability I = out / (in + out); a module close to 1.0 depends on many things and is depended on by few, so it absorbs change rather than causing it. ${joinWords(unstable.map((node) => `${code(node.path)} (${node.instability.toFixed(2)})`))}.`,
        )
      : null,
    cycleList
      ? section(
          heading(2, `Circular dependencies (${formatNumber(graph.cycles.length)})`),
          'Each cycle below is a group of modules that cannot be loaded, tested or extracted independently.',
          cycleList,
        )
      : graph.nodes.length > 0
        ? section(heading(2, 'Circular dependencies'), 'None. The import graph is acyclic.')
        : null,
    externals.length > 0
      ? section(
          heading(2, 'External surface'),
          table(
            ['Package', 'Imported by', 'Declared in a manifest'],
            externals.map((external) => [
              code(external.name),
              `${formatNumber(external.count)} ${external.count === 1 ? 'file' : 'files'}`,
              external.undeclared ? '**No — undeclared**' : 'Yes',
            ]),
          ),
        )
      : null,
    stack.api.style !== 'none' && stack.api.style !== 'unknown'
      ? `The system speaks ${stack.api.style.toUpperCase()} at its boundary (${countLabel(stack.api.endpoints.length, 'endpoint')} detected) — see *API Overview*.`
      : null,
  );

  const refs: CitationRef[] = [
    ...hubs.map((node) => ({ file: node.path })),
    ...unstable.map((node) => ({ file: node.path })),
    ...detectionRefs([...stack.frameworks, ...stack.runtimes]),
  ];

  return makeDoc(
    'architecture-overview',
    'Architecture Overview',
    `A ${architecture.style} of ${countLabel(graph.nodes.length, 'module')} and ${countLabel(graph.edges.length, 'import edge')}, with ${graph.cycles.length === 0 ? 'no dependency cycles' : countLabel(graph.cycles.length, 'dependency cycle')}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 10)),
  );
}

interface GroupedGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly weight: number;
  }[];
  readonly sizes: readonly {
    readonly name: string;
    readonly files: number;
    readonly in: number;
    readonly out: number;
  }[];
}

/**
 * Collapse the file-level import graph to directory groups.
 *
 * A per-file diagram is unreadable past about thirty modules, and the question
 * an architecture document answers is "which parts of the tree depend on which",
 * not "which file imports which".
 */
function groupGraph(context: KnowledgeContext): GroupedGraph {
  const pathById = new Map(context.graph.nodes.map((node) => [node.id, node.path] as const));

  const groupOf = (path: string): string => {
    const parts = path.split('/');
    if (parts.length <= 1) return '(root)';
    return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
  };

  const fileCounts = new Map<string, number>();
  for (const node of context.graph.nodes) {
    const group = groupOf(node.path);
    fileCounts.set(group, (fileCounts.get(group) ?? 0) + 1);
  }

  // Group pairs are keyed on U+241F, a character that cannot occur in a
  // repository path, so directory names containing spaces survive the round-trip.
  const weights = new Map<string, number>();
  for (const edge of context.graph.edges) {
    const from = pathById.get(edge.from);
    const to = pathById.get(edge.to);
    if (!from || !to) continue;

    const a = groupOf(from);
    const b = groupOf(to);
    if (a === b) continue;
    weights.set(`${a}\u241F${b}`, (weights.get(`${a}\u241F${b}`) ?? 0) + 1);
  }

  const edges = [...weights.entries()]
    .map(([key, weight]) => {
      const [from = '', to = ''] = key.split('\u241F');
      return { from, to, weight };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 14);

  const nodes = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];

  const outByGroup = new Map<string, number>();
  const inByGroup = new Map<string, number>();
  for (const edge of weights.entries()) {
    const [key, weight] = edge;
    const [from = '', to = ''] = key.split('\u241F');
    outByGroup.set(from, (outByGroup.get(from) ?? 0) + weight);
    inByGroup.set(to, (inByGroup.get(to) ?? 0) + weight);
  }

  const sizes = [...fileCounts.entries()]
    .map(([name, files]) => ({
      name,
      files,
      in: inByGroup.get(name) ?? 0,
      out: outByGroup.get(name) ?? 0,
    }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    .slice(0, 12);

  return { nodes, edges, sizes };
}
