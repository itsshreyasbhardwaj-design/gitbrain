import Link from 'next/link';
import { CheckCircle2, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Markdown } from '@/components/markdown';
import { Section } from '@/features/report/section';
import {
  formatBytes,
  formatCount,
  scoreTone,
  severityTone,
  TONE_SURFACE,
  TONE_TEXT,
} from '@/features/report/grade';
import { loadAnalysis } from '@/features/report/load';
import type { Severity } from '@/core/types';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export default async function SecurityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  const { security, dependencies, debt, graph, knowledge } = analysis;

  const doc = knowledge.docs.find((entry) => entry.id === 'security-risks');
  const tone = scoreTone(security.score);

  const secrets = [...security.secrets].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const risks = [...security.risks].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return (
    <div className="mt-8 space-y-12">
      {/* Score ------------------------------------------------------------ */}
      <section
        className={`glass rounded-panel flex flex-wrap items-center gap-6 border p-6 ${TONE_SURFACE[tone]}`}
      >
        <div className="flex items-center gap-4">
          <ShieldCheck className={`size-8 ${TONE_TEXT[tone]}`} aria-hidden="true" />
          <div>
            <p className="text-eyebrow text-ink-faint uppercase">Security score</p>
            <p className={`text-3xl font-semibold tabular-nums ${TONE_TEXT[tone]}`}>
              {security.score}
              <span className="text-ink-faint text-base">/100</span>
            </p>
          </div>
        </div>

        <p className="text-ink-muted min-w-64 flex-1 text-sm leading-relaxed">
          Starts at 100 and deducts by finding severity, weighted so a live credential costs far
          more than a style issue. This is static analysis of committed source only — it cannot see
          runtime configuration, infrastructure, or anything in your secret manager.
        </p>
      </section>

      {/* Secrets ---------------------------------------------------------- */}
      <Section
        title="Hardcoded secrets"
        description="Rule-based and entropy-gated detection, with placeholders and .env templates suppressed."
        action={<Badge variant={secrets.length > 0 ? 'bad' : 'good'}>{secrets.length} found</Badge>}
      >
        {secrets.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 />}
            title="No credentials found in the source"
            description="GitBrain scanned every text file for provider key formats, private key blocks, connection strings with inline credentials, and high-entropy assignments."
          />
        ) : (
          <>
            <p className="border-line bg-surface/50 text-ink-subtle mb-4 flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed">
              <EyeOff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              Every preview below is truncated to its first four characters. GitBrain never stores
              or displays a usable credential. Treat any finding here as already compromised and
              rotate it — it exists in the git history even if you delete the line.
            </p>

            <ul className="space-y-2">
              {secrets.map((secret) => {
                const secretTone = severityTone(secret.severity);
                return (
                  <li
                    key={secret.id}
                    className={`glass rounded-panel flex flex-wrap items-center gap-x-4 gap-y-2 border p-4 ${TONE_SURFACE[secretTone]}`}
                  >
                    <KeyRound
                      className={`size-4 shrink-0 ${TONE_TEXT[secretTone]}`}
                      aria-hidden="true"
                    />

                    <div className="min-w-48 flex-1">
                      <p className="text-ink text-sm font-medium">{secret.rule}</p>
                      <p className="text-ink-subtle mt-0.5 font-mono text-[11px] break-all">
                        {secret.file}:{secret.line}
                      </p>
                    </div>

                    <code className="border-line bg-canvas text-ink-muted rounded border px-2 py-1 font-mono text-[11px]">
                      {secret.preview}
                    </code>

                    {secret.entropy !== undefined && (
                      <span className="text-ink-faint text-[11px] tabular-nums">
                        entropy {secret.entropy.toFixed(2)}
                      </span>
                    )}

                    <Badge variant={secretTone === 'neutral' ? 'neutral' : secretTone}>
                      {secret.severity}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>

      {/* Risks ------------------------------------------------------------- */}
      <Section
        title="Risks"
        description="Dangerous sinks, configuration weaknesses and hygiene problems found in the source."
      >
        {risks.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 />}
            title="No risk patterns matched"
            description="No dangerous sinks, permissive CORS, disabled certificate validation or committed environment files were found."
          />
        ) : (
          <ul className="space-y-3">
            {risks.map((risk) => {
              const riskTone = severityTone(risk.severity);
              return (
                <li key={risk.id} className="glass rounded-panel p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-ink text-[15px] font-medium">{risk.title}</h3>
                    <Badge variant={riskTone === 'neutral' ? 'neutral' : riskTone}>
                      {risk.severity}
                    </Badge>
                    {risk.reference && (
                      <span className="border-line text-ink-subtle rounded border px-1.5 py-0.5 font-mono text-[11px]">
                        {risk.reference}
                      </span>
                    )}
                  </div>

                  <p className="text-ink-muted mt-2 text-sm leading-relaxed">{risk.detail}</p>

                  <p className="border-jade/20 bg-jade/5 text-ink-muted mt-3 rounded-lg border px-3 py-2 text-sm leading-relaxed">
                    <span className="text-jade font-medium">Fix: </span>
                    {risk.recommendation}
                  </p>

                  {risk.files.length > 0 && (
                    <ul className="mt-3 flex flex-wrap gap-1.5">
                      {risk.files.slice(0, 8).map((file) => (
                        <li
                          key={file}
                          className="border-line bg-surface/60 text-ink-subtle rounded border px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {file}
                        </li>
                      ))}
                      {risk.files.length > 8 && (
                        <li className="text-ink-faint px-1.5 py-0.5 text-[11px]">
                          +{risk.files.length - 8} more
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Environment ------------------------------------------------------- */}
      <Section
        title="Environment variables"
        description={`${security.envVars.length} referenced in code. ${security.undocumentedEnvVars.length} are not documented in any committed template.`}
      >
        {security.envVars.length === 0 ? (
          <p className="text-ink-subtle text-sm">
            This repository does not read any environment variables.
          </p>
        ) : (
          <>
            {security.undocumentedEnvVars.length > 0 && (
              <p className="border-warn/25 bg-warn/10 text-ink-muted mb-4 rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed">
                A new contributor cannot run this project without knowing{' '}
                {security.undocumentedEnvVars.slice(0, 5).map((name, index) => (
                  <span key={name}>
                    {index > 0 && ', '}
                    <code className="text-ink font-mono">{name}</code>
                  </span>
                ))}
                {security.undocumentedEnvVars.length > 5 &&
                  ` and ${security.undocumentedEnvVars.length - 5} more`}
                . Add them to a committed <code className="text-ink font-mono">.env.example</code>.
              </p>
            )}

            <div className="border-line overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                  Environment variables referenced in the source
                </caption>
                <thead>
                  <tr className="bg-surface/60">
                    <th scope="col" className="text-ink-muted px-3 py-2 text-left font-medium">
                      Variable
                    </th>
                    <th scope="col" className="text-ink-muted px-3 py-2 text-left font-medium">
                      Documented
                    </th>
                    <th scope="col" className="text-ink-muted px-3 py-2 text-left font-medium">
                      Referenced in
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {security.envVars.map((variable) => (
                    <tr key={variable.name} className="border-line/60 border-t">
                      <th
                        scope="row"
                        className="text-ink px-3 py-2 text-left font-mono text-[12px] font-normal"
                      >
                        {variable.name}
                      </th>
                      <td className="px-3 py-2">
                        <Badge variant={variable.documented ? 'good' : 'warn'}>
                          {variable.documented ? 'yes' : 'no'}
                        </Badge>
                      </td>
                      <td className="text-ink-subtle px-3 py-2 font-mono text-[11px]">
                        {variable.files.slice(0, 3).join(', ')}
                        {variable.files.length > 3 && ` +${variable.files.length - 3}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Section>

      {/* Dependencies ------------------------------------------------------ */}
      <Section
        title="Dependency risks"
        description={`${formatCount(dependencies.dependencies.length)} declared dependencies. Lockfile ${dependencies.hasLockfile ? 'present' : 'missing'}.`}
      >
        {security.flaggedDependencies.length === 0 && dependencies.unpinned.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 />}
            title="No flagged dependencies"
            description="Nothing in the manifests matched GitBrain's list of deprecated or known-risky packages, and every range is pinned."
          />
        ) : (
          <div className="space-y-3">
            {security.flaggedDependencies.map((flag) => {
              const flagTone = severityTone(flag.severity);
              return (
                <div key={flag.name} className="glass rounded-panel p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-ink font-mono text-sm">{flag.name}</code>
                    <Badge variant={flagTone === 'neutral' ? 'neutral' : flagTone}>
                      {flag.severity}
                    </Badge>
                  </div>
                  <p className="text-ink-muted mt-1.5 text-sm">{flag.reason}</p>
                  {flag.replacement && (
                    <p className="text-ink-subtle mt-1 text-sm">
                      Consider <code className="text-jade font-mono">{flag.replacement}</code>{' '}
                      instead.
                    </p>
                  )}
                </div>
              );
            })}

            {dependencies.unpinned.length > 0 && (
              <div className="glass rounded-panel p-4">
                <p className="text-ink text-sm font-medium">Unpinned version ranges</p>
                <p className="text-ink-muted mt-1 text-sm leading-relaxed">
                  {dependencies.unpinned.length} dependencies use a range that cannot be reproduced,
                  so two installs can resolve to different code.
                </p>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {dependencies.unpinned.slice(0, 12).map((name) => (
                    <li
                      key={name}
                      className="border-line bg-surface/60 text-ink-subtle rounded border px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      {name}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Structural risks --------------------------------------------------- */}
      <Section
        title="Structural risks"
        description="Problems that make a codebase harder to change safely, rather than directly exploitable."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="glass rounded-panel p-5">
            <p className="text-ink text-sm font-medium">Circular dependencies</p>
            <p className="text-ink mt-1 text-3xl font-semibold tabular-nums">
              {graph.cycles.length}
            </p>
            <p className="text-ink-muted mt-1.5 text-sm leading-relaxed">
              {graph.cycles.length === 0
                ? 'No modules import each other in a loop.'
                : 'Modules in a loop cannot be loaded or tested independently.'}
            </p>
            {graph.cycles.length > 0 && (
              <Link
                href={`/r/${id}/graph`}
                className="text-jade mt-3 inline-block text-sm underline underline-offset-2"
              >
                Inspect the chains
              </Link>
            )}
          </div>

          <div className="glass rounded-panel p-5">
            <p className="text-ink text-sm font-medium">Duplicated blocks</p>
            <p className="text-ink mt-1 text-3xl font-semibold tabular-nums">
              {debt.duplicates.length}
            </p>
            <p className="text-ink-muted mt-1.5 text-sm leading-relaxed">
              {debt.duplicates.length === 0
                ? 'No significant copy-pasted blocks were detected.'
                : 'A fix applied to one copy has to be remembered for the others.'}
            </p>

            {debt.duplicates.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {debt.duplicates.slice(0, 4).map((block) => (
                  <li key={block.hash} className="text-ink-subtle text-[11px]">
                    <span className="text-ink-faint">{block.lineCount} lines · </span>
                    {block.occurrences.slice(0, 2).map((occurrence, index) => (
                      <span
                        key={`${occurrence.file}:${occurrence.startLine}`}
                        className="font-mono"
                      >
                        {index > 0 && ' ↔ '}
                        {occurrence.file}:{occurrence.startLine}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {security.largeFiles.length > 0 && (
          <div className="glass rounded-panel mt-4 p-5">
            <p className="text-ink text-sm font-medium">Large files</p>
            <p className="text-ink-muted mt-1 text-sm leading-relaxed">
              Files over 1 MB slow clones and reviews, and are usually build output or assets that
              belong outside the repository.
            </p>
            <ul className="mt-3 space-y-1">
              {security.largeFiles.slice(0, 10).map((file) => (
                <li key={file.path} className="flex justify-between gap-4 text-[12px]">
                  <span className="text-ink-subtle min-w-0 truncate font-mono" title={file.path}>
                    {file.path}
                  </span>
                  <span className="text-ink-faint shrink-0 tabular-nums">
                    {formatBytes(file.size)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Generated analysis -------------------------------------------------- */}
      {doc && (
        <Section title={doc.title} description={doc.summary}>
          <div className="glass rounded-panel p-6">
            <Markdown>{doc.markdown}</Markdown>
          </div>
        </Section>
      )}
    </div>
  );
}
