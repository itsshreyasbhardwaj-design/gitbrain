/**
 * Quality documents: where the code will hurt under load, where it is exposed,
 * and what to fix first.
 *
 * The performance document is the easiest one in the whole engine to fake, so
 * it is deliberately restricted to signals that a static scan can actually
 * observe — file size, nesting, fan-in, duplication, asset weight — and says so
 * out loud rather than implying it profiled anything.
 */

import type { KnowledgeDoc, Severity, Suggestion } from '../../types';
import {
  citationsFor,
  ensureCitations,
  repoName,
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
  note,
  numberedList,
  section,
  severityLabel,
  severityRank,
  table,
} from '../format';

// ---------------------------------------------------------------------------
// Performance bottlenecks
// ---------------------------------------------------------------------------

export function performanceBottlenecks(context: KnowledgeContext): KnowledgeDoc {
  const complexity = context.complexity;
  const bySize = complexity.files.slice().sort((a, b) => b.loc - a.loc);
  const byNesting = complexity.files.slice().sort((a, b) => b.maxNesting - a.maxNesting);
  const byBranching = complexity.files.slice().sort((a, b) => b.cyclomatic - a.cyclomatic);

  const fanIn = context.graph.nodes
    .slice()
    .sort((a, b) => b.inDegree - a.inDegree || b.loc - a.loc)
    .filter((node) => node.inDegree >= 3)
    .slice(0, 8);

  const largeAssets = context.security.largeFiles.slice().sort((a, b) => b.size - a.size);
  const duplicates = context.debt.duplicates
    .slice()
    .sort((a, b) => b.lineCount * b.occurrences.length - a.lineCount * a.occurrences.length);

  const runtimeDeps = context.dependencies.counts.runtime;
  const externals = context.graph.externals.slice().sort((a, b) => b.count - a.count);

  const findings: {
    readonly signal: string;
    readonly observation: string;
    readonly why: string;
  }[] = [];

  const biggest = bySize[0];
  if (biggest) {
    const topThree = bySize.slice(0, 3);
    const share = topThree.reduce((sum, file) => sum + file.loc, 0);
    findings.push({
      signal: 'Module size',
      observation: `${fileRef(biggest.path)} is ${countLabel(biggest.loc, 'line')}; the three largest files hold ${formatPercent(share, Math.max(complexity.totalLoc, 1))} of all measured lines.`,
      why: 'Large modules are slow to parse, impossible to tree-shake partially, and force every importer to pull in code it does not use.',
    });
  }

  const deepest = byNesting[0];
  if (deepest && deepest.maxNesting >= 4) {
    findings.push({
      signal: 'Nesting depth',
      observation: `${fileRef(deepest.path)} nests ${countLabel(deepest.maxNesting, 'level')} deep.`,
      why: 'Deep nesting usually means loops inside loops or conditionals inside conditionals — the shape that turns linear work into quadratic work.',
    });
  }

  const branchiest = byBranching[0];
  if (branchiest && branchiest.cyclomatic > 0) {
    findings.push({
      signal: 'Branch density',
      observation: `${fileRef(branchiest.path)} has a cyclomatic complexity of ${formatNumber(branchiest.cyclomatic)} across ${countLabel(branchiest.functions, 'function')}.`,
      why: 'Every branch is a path that has to be predicted, tested and kept warm; dense branching is where cache-hostile control flow lives.',
    });
  }

  const hub = fanIn[0];
  if (hub) {
    findings.push({
      signal: 'Fan-in',
      observation: `${fileRef(hub.path)} is imported by ${countLabel(hub.inDegree, 'module')}.`,
      why: 'A module on this many import paths is loaded early and often. Anything expensive at its top level runs before almost everything else.',
    });
  }

  if (duplicates.length > 0) {
    const duplicatedLines = duplicates.reduce(
      (sum, block) => sum + block.lineCount * Math.max(block.occurrences.length - 1, 0),
      0,
    );
    findings.push({
      signal: 'Duplication',
      observation: `${countLabel(duplicates.length, 'duplicated block')} account for roughly ${countLabel(duplicatedLines, 'redundant line')}.`,
      why: 'Duplicated code is duplicated bytes in every bundle that includes it, and duplicated work whenever both copies run.',
    });
  }

  if (largeAssets.length > 0) {
    const total = largeAssets.reduce((sum, file) => sum + file.size, 0);
    findings.push({
      signal: 'Asset weight',
      observation: `${countLabel(largeAssets.length, 'file')} exceed GitBrain's large-file threshold, totalling ${formatBytes(total)}. The largest is ${fileRef(largeAssets[0]?.path ?? '')} at ${formatBytes(largeAssets[0]?.size ?? 0)}.`,
      why: 'Large committed files slow clones and CI checkouts, and if any of them are served to a browser they dominate page weight.',
    });
  }

  if (runtimeDeps > 0) {
    findings.push({
      signal: 'Dependency surface',
      observation: `${countLabel(runtimeDeps, 'runtime dependency')} are declared${externals[0] ? `, and the most-imported external package is ${code(externals[0].name)} across ${countLabel(externals[0].count, 'file')}` : ''}.`,
      why: 'Runtime dependencies are code that ships. Each one adds install time, cold-start time and, for browser targets, bytes.',
    });
  }

  if (context.graph.cycles.length > 0) {
    findings.push({
      signal: 'Import cycles',
      observation: `${countLabel(context.graph.cycles.length, 'cycle')} in the module graph.`,
      why: 'Cyclic modules defeat lazy initialisation and static analysis, so bundlers ship them eagerly and whole.',
    });
  }

  const markdown = section(
    heading(1, 'Performance Bottlenecks'),
    note(
      'This is static analysis. GitBrain has not executed, profiled or benchmarked anything. What follows are structural signals that correlate with performance problems — they are places to measure, not measurements.',
    ),
    findings.length === 0
      ? `No structural performance signals stood out in ${code(repoName(context))}. The codebase is small enough, shallow enough and light enough that none of the usual static indicators fired.`
      : `${countLabel(findings.length, 'structural signal')} are worth investigating with a profiler.`,
    findings.length > 0
      ? table(
          ['Signal', 'What was observed', 'Why it matters'],
          findings.map((finding) => [finding.signal, finding.observation, finding.why]),
        )
      : null,
    bySize.length > 0
      ? section(
          heading(2, 'Largest modules'),
          table(
            ['File', 'LOC', 'SLOC', 'Max nesting', 'Functions'],
            bySize
              .slice(0, 10)
              .map((file) => [
                code(file.path),
                formatNumber(file.loc),
                formatNumber(file.sloc),
                formatNumber(file.maxNesting),
                formatNumber(file.functions),
              ]),
          ),
        )
      : null,
    fanIn.length > 0
      ? section(
          heading(2, 'Modules on the most import paths'),
          'Work done at the top level of these files happens on almost every code path through the system.',
          table(
            ['Module', 'Imported by', 'LOC'],
            fanIn.map((node) => [
              code(node.path),
              formatNumber(node.inDegree),
              formatNumber(node.loc),
            ]),
          ),
        )
      : null,
    largeAssets.length > 0
      ? section(
          heading(2, 'Large files in the repository'),
          table(
            ['File', 'Size'],
            largeAssets.slice(0, 12).map((file) => [code(file.path), formatBytes(file.size)]),
          ),
        )
      : null,
    section(
      heading(2, 'What this document cannot tell you'),
      bulletList([
        'Actual latency, throughput or memory use — nothing was run.',
        'Database query plans, N+1 patterns or index coverage.',
        'Network waterfalls, cache hit rates or cold-start times.',
        'Algorithmic complexity: a 10-line function can be the bottleneck and will not appear above.',
      ]),
    ),
  );

  const refs: CitationRef[] = [
    ...bySize.slice(0, 5).map((file) => ({ file: file.path })),
    ...fanIn.slice(0, 4).map((node) => ({ file: node.path })),
    ...largeAssets.slice(0, 3).map((file) => ({ file: file.path })),
    ...duplicates.slice(0, 2).flatMap((block) =>
      block.occurrences.slice(0, 1).map((occurrence) => ({
        file: occurrence.file,
        startLine: occurrence.startLine,
      })),
    ),
  ];

  return makeDoc(
    'performance-bottlenecks',
    'Performance Bottlenecks',
    findings.length === 0
      ? 'No structural performance signals were detected by static analysis.'
      : `${countLabel(findings.length, 'structural signal')} worth profiling, led by ${findings[0]?.signal.toLowerCase() ?? 'module size'}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 10)),
  );
}

// ---------------------------------------------------------------------------
// Security risks
// ---------------------------------------------------------------------------

export function securityRisks(context: KnowledgeContext): KnowledgeDoc {
  const report = context.security;
  const risks = report.risks
    .slice()
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const secrets = report.secrets
    .slice()
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const clean =
    risks.length === 0 &&
    secrets.length === 0 &&
    report.flaggedDependencies.length === 0 &&
    report.undocumentedEnvVars.length === 0;

  const bySeverity = new Map<Severity, number>();
  for (const risk of risks) {
    bySeverity.set(risk.severity, (bySeverity.get(risk.severity) ?? 0) + 1);
  }

  const markdown = section(
    heading(1, 'Security Risks'),
    `${code(repoName(context))} scores **${report.score}/100** on GitBrain's static security check, where 100 means nothing was found.`,
    clean
      ? section(
          'No hard-coded secrets, no flagged dependencies, no undocumented configuration and no pattern-matched risks were found.',
          'That is a genuine result for the checks GitBrain runs — pattern-based secret scanning, a curated unsafe-dependency list, environment-variable documentation coverage, and a set of source-level risk patterns. It is not a penetration test, a dependency CVE audit, or a review of authorization logic.',
        )
      : `${countLabel(risks.length, 'risk')}${secrets.length > 0 ? `, ${countLabel(secrets.length, 'secret candidate')}` : ''}${report.flaggedDependencies.length > 0 ? `, ${countLabel(report.flaggedDependencies.length, 'flagged dependency', 'flagged dependencies')}` : ''}${report.undocumentedEnvVars.length > 0 ? ` and ${countLabel(report.undocumentedEnvVars.length, 'undocumented environment variable')}` : ''} were found.`,
    bySeverity.size > 0
      ? table(
          ['Severity', 'Risks'],
          [...bySeverity.entries()]
            .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
            .map(([severity, count]) => [severityLabel(severity), formatNumber(count)]),
        )
      : null,
    secrets.length > 0
      ? section(
          heading(2, `Secret candidates (${formatNumber(secrets.length)})`),
          'Every value below is redacted — GitBrain never stores or renders a usable credential. Treat each one as compromised: rotate it first, then remove it from the source and from the git history.',
          table(
            ['Rule', 'Location', 'Preview', 'Severity', 'Entropy'],
            secrets
              .slice(0, 25)
              .map((secret) => [
                secret.rule,
                fileRef(secret.file, secret.line),
                code(secret.preview),
                severityLabel(secret.severity),
                secret.entropy === undefined ? '—' : secret.entropy.toFixed(2),
              ]),
          ),
        )
      : null,
    risks.length > 0
      ? section(
          heading(2, `Risks (${formatNumber(risks.length)})`),
          risks
            .slice(0, 15)
            .map((risk) =>
              section(
                heading(3, `${severityLabel(risk.severity)} · ${risk.title}`),
                risk.detail,
                bulletList(
                  [
                    `Recommendation: ${risk.recommendation}`,
                    risk.reference ? `Reference: ${code(risk.reference)}` : '',
                    risk.files.length > 0
                      ? `Affected: ${risk.files
                          .slice(0, 6)
                          .map((file) => fileRef(file))
                          .join(
                            ', ',
                          )}${risk.files.length > 6 ? ` (+${risk.files.length - 6} more)` : ''}`
                      : '',
                  ].filter(Boolean),
                ),
              ),
            )
            .join('\n\n'),
        )
      : null,
    report.flaggedDependencies.length > 0
      ? section(
          heading(2, `Flagged dependencies (${formatNumber(report.flaggedDependencies.length)})`),
          table(
            ['Package', 'Severity', 'Reason', 'Replacement'],
            report.flaggedDependencies
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
      : null,
    report.undocumentedEnvVars.length > 0
      ? section(
          heading(
            2,
            `Undocumented configuration (${formatNumber(report.undocumentedEnvVars.length)})`,
          ),
          `These variables are read by the code but appear in no committed template: ${joinWords(report.undocumentedEnvVars.slice(0, 20).map((name) => code(name)))}. Undocumented configuration is a security problem as well as an operational one — nobody can review a value they do not know is required.`,
        )
      : null,
    report.largeFiles.length > 0
      ? section(
          heading(2, 'Large committed files'),
          `${countLabel(report.largeFiles.length, 'file')} exceed the large-file threshold. Large binaries in a repository are worth a look: build outputs, database dumps and archives are the usual way credentials and customer data end up in version control.`,
          table(
            ['File', 'Size'],
            report.largeFiles
              .slice()
              .sort((a, b) => b.size - a.size)
              .slice(0, 10)
              .map((file) => [code(file.path), formatBytes(file.size)]),
          ),
        )
      : null,
    note(
      'Scope: pattern-based secret detection, a curated unsafe-dependency list, environment documentation coverage and source-level risk patterns. Not covered: CVE lookup against a vulnerability database, authorization logic review, runtime configuration, or anything outside this repository.',
    ),
  );

  const refs: CitationRef[] = [
    ...secrets.slice(0, 8).map((secret) => ({ file: secret.file, startLine: secret.line })),
    ...risks.slice(0, 8).flatMap((risk) => risk.files.slice(0, 2).map((file) => ({ file }))),
    ...report.largeFiles.slice(0, 3).map((file) => ({ file: file.path })),
  ];

  const worst = risks[0];

  return makeDoc(
    'security-risks',
    'Security Risks',
    clean
      ? `No secrets, flagged dependencies or pattern-matched risks were found; the static security score is ${report.score}/100.`
      : `${report.score}/100 with ${countLabel(risks.length, 'risk')} and ${countLabel(secrets.length, 'secret candidate')}${worst ? `, worst of which is "${worst.title}"` : ''}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}

// ---------------------------------------------------------------------------
// Suggested improvements
// ---------------------------------------------------------------------------

const IMPACT_RANK = { high: 0, medium: 1, low: 2 } as const;
const EFFORT_RANK = { low: 0, medium: 1, high: 2 } as const;

interface RankedAction {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly impact: 'high' | 'medium' | 'low';
  readonly effort: 'high' | 'medium' | 'low';
  readonly files: readonly string[];
  readonly origin: string;
}

export function suggestedImprovements(context: KnowledgeContext): KnowledgeDoc {
  const fromHealth: RankedAction[] = context.health.topSuggestions.map((suggestion) => ({
    ...toAction(suggestion),
    origin: 'Health score',
  }));

  const seen = new Set(fromHealth.map((action) => action.title.toLowerCase()));

  const fromDimensions: RankedAction[] = context.health.scores
    .flatMap((score) => score.suggestions.map((suggestion) => ({ suggestion, label: score.label })))
    .filter((entry) => !seen.has(entry.suggestion.title.toLowerCase()))
    .map((entry) => {
      seen.add(entry.suggestion.title.toLowerCase());
      return { ...toAction(entry.suggestion), origin: entry.label };
    });

  const fromDebt: RankedAction[] = context.debt.items
    .filter((item) => !seen.has(item.title.toLowerCase()))
    .map((item) => {
      seen.add(item.title.toLowerCase());
      return {
        id: item.id,
        title: item.title,
        detail: item.detail,
        impact: severityToImpact(item.severity),
        effort: hoursToEffort(item.estimatedHours),
        files: item.files,
        origin: `Technical debt · ${item.category}`,
      };
    });

  const actions = [...fromHealth, ...fromDimensions, ...fromDebt].sort(
    (a, b) =>
      IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
      EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort] ||
      a.title.localeCompare(b.title),
  );

  if (actions.length === 0) {
    const markdown = section(
      heading(1, 'Suggested Improvements'),
      `Neither the health scorer nor the debt analyzer produced an actionable suggestion for ${code(repoName(context))}. Overall health is ${context.health.grade} (${context.health.overall}/100).`,
      context.health.scores.length > 0
        ? section(
            heading(2, 'Where the score comes from'),
            table(
              ['Dimension', 'Score', 'Grade'],
              context.health.scores
                .slice()
                .sort((a, b) => a.score - b.score)
                .map((score) => [score.label, `${score.score}/100`, score.grade]),
            ),
          )
        : null,
    );

    return makeDoc(
      'suggested-improvements',
      'Suggested Improvements',
      `No actionable suggestions were produced; overall health is ${context.health.grade} (${context.health.overall}/100).`,
      markdown,
      ensureCitations(context, []),
    );
  }

  const quickWins = actions.filter((action) => action.effort === 'low' && action.impact !== 'low');

  const markdown = section(
    heading(1, 'Suggested Improvements'),
    `${countLabel(actions.length, 'improvement')} ranked by impact, then by how little effort each takes. Overall health is currently ${context.health.grade} (${context.health.overall}/100).`,
    section(
      heading(2, 'Ranked'),
      table(
        ['#', 'Improvement', 'Impact', 'Effort', 'Source', 'Files to touch'],
        actions.slice(0, 20).map((action, index) => [
          String(index + 1),
          action.title,
          action.impact,
          action.effort,
          action.origin,
          action.files.length === 0
            ? '—'
            : `${action.files
                .slice(0, 3)
                .map((file) => code(file))
                .join(', ')}${action.files.length > 3 ? ` (+${action.files.length - 3})` : ''}`,
        ]),
      ),
    ),
    quickWins.length > 0
      ? section(
          heading(2, 'Do these first'),
          'High or medium impact for low effort — the best return available in this repository right now.',
          numberedList(
            quickWins
              .slice(0, 6)
              .map(
                (action) =>
                  `**${action.title}** — ${action.detail}${action.files.length > 0 ? ` Touch ${joinWords(action.files.slice(0, 3).map((file) => fileRef(file)))}.` : ''}`,
              ),
          ),
        )
      : null,
    section(
      heading(2, 'Detail'),
      actions
        .slice(0, 12)
        .map((action, index) =>
          section(
            heading(3, `${index + 1}. ${action.title}`),
            action.detail,
            bulletList(
              [
                `Impact: **${action.impact}** · Effort: **${action.effort}**`,
                `Identified by: ${action.origin}`,
                action.files.length > 0
                  ? `Files: ${action.files
                      .slice(0, 6)
                      .map((file) => fileRef(file))
                      .join(
                        ', ',
                      )}${action.files.length > 6 ? ` (+${action.files.length - 6} more)` : ''}`
                  : '',
              ].filter(Boolean),
            ),
          ),
        )
        .join('\n\n'),
    ),
    context.health.scores.length > 0
      ? section(
          heading(2, 'Health dimensions, weakest first'),
          table(
            ['Dimension', 'Score', 'Grade', 'Why'],
            context.health.scores
              .slice()
              .sort((a, b) => a.score - b.score)
              .map((score) => [
                score.label,
                `${score.score}/100`,
                score.grade,
                score.rationale[0] ?? '—',
              ]),
          ),
        )
      : null,
    context.debt.totalEstimatedHours > 0
      ? note(
          `Working through every debt item is estimated at ${countLabel(context.debt.totalEstimatedHours, 'engineer-hour')}. The ranking above exists so you do not have to.`,
        )
      : null,
  );

  const refs: CitationRef[] = actions
    .slice(0, 12)
    .flatMap((action) => action.files.slice(0, 2).map((file) => ({ file })));

  const top = actions[0];

  return makeDoc(
    'suggested-improvements',
    'Suggested Improvements',
    top
      ? `${countLabel(actions.length, 'ranked improvement')}; start with "${top.title}" (${top.impact} impact, ${top.effort} effort).`
      : `${countLabel(actions.length, 'ranked improvement')}.`,
    markdown,
    ensureCitations(context, citationsFor(context, refs, 12)),
  );
}

function toAction(suggestion: Suggestion): Omit<RankedAction, 'origin'> {
  return {
    id: suggestion.id,
    title: suggestion.title,
    detail: suggestion.detail,
    impact: suggestion.impact,
    effort: suggestion.effort,
    files: suggestion.files,
  };
}

function severityToImpact(severity: Severity): 'high' | 'medium' | 'low' {
  if (severity === 'critical' || severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

function hoursToEffort(hours: number): 'high' | 'medium' | 'low' {
  if (hours <= 4) return 'low';
  if (hours <= 16) return 'medium';
  return 'high';
}
