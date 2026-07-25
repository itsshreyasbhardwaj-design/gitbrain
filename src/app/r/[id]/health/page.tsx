import { Lightbulb } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/markdown';
import { DistributionBars, RadarChart, ScoreGauge } from '@/features/report/charts';
import { Section } from '@/features/report/section';
import { formatCount, gradeTone, scoreTone, TONE_TEXT } from '@/features/report/grade';
import { loadAnalysis } from '@/features/report/load';

const IMPACT_VARIANT = { high: 'jade', medium: 'neutral', low: 'outline' } as const;

export default async function HealthPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const analysis = await loadAnalysis(id);
  const { health, complexity, knowledge } = analysis;

  const complexityDoc = knowledge.docs.find((doc) => doc.id === 'code-complexity');
  const debtDoc = knowledge.docs.find((doc) => doc.id === 'technical-debt');

  return (
    <div className="mt-8 space-y-12">
      {/* Overall ---------------------------------------------------------- */}
      <section className="glass rounded-panel flex flex-col items-center gap-8 p-6 sm:p-8 lg:flex-row lg:items-start">
        <ScoreGauge
          value={health.overall}
          grade={health.grade}
          tone={gradeTone(health.grade)}
          label="Overall health"
        />

        <div className="min-w-0 flex-1">
          <RadarChart
            axes={health.scores.map((score) => ({ label: score.label, value: score.score }))}
            title="Health across all eight dimensions"
          />
        </div>
      </section>

      {/* Dimensions ------------------------------------------------------- */}
      <Section
        title="Dimensions"
        description="Each score is derived from measurements, and every rationale below states the numbers it used."
      >
        <div className="grid gap-4 md:grid-cols-2">
          {health.scores.map((score) => {
            const tone = scoreTone(score.score);

            return (
              <article key={score.dimension} className="glass rounded-panel p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-ink text-[15px] font-semibold tracking-tight">
                    {score.label}
                  </h3>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`text-lg font-semibold tabular-nums ${TONE_TEXT[tone]}`}>
                      {score.score}
                    </span>
                    <Badge variant="outline">{score.grade}</Badge>
                  </div>
                </div>

                <div
                  className="bg-surface mt-3 h-1.5 overflow-hidden rounded-full"
                  role="img"
                  aria-label={`${score.label}: ${score.score} out of 100, grade ${score.grade}`}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(2, score.score)}%`,
                      backgroundColor: `var(--color-${tone === 'neutral' ? 'info' : tone})`,
                    }}
                  />
                </div>

                {score.rationale.length > 0 && (
                  <ul className="mt-4 space-y-1.5">
                    {score.rationale.map((reason) => (
                      <li
                        key={reason}
                        className="text-ink-muted flex gap-2 text-sm leading-relaxed"
                      >
                        <span
                          className="bg-ink-faint mt-2 size-1 shrink-0 rounded-full"
                          aria-hidden="true"
                        />
                        {reason}
                      </li>
                    ))}
                  </ul>
                )}

                {score.suggestions.length > 0 && (
                  <ul className="border-line mt-4 space-y-2 border-t pt-3">
                    {score.suggestions.map((suggestion) => (
                      <li key={suggestion.id}>
                        <p className="text-ink text-sm font-medium">{suggestion.title}</p>
                        <p className="text-ink-subtle mt-0.5 text-sm leading-relaxed">
                          {suggestion.detail}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      </Section>

      {/* Top suggestions --------------------------------------------------- */}
      {health.topSuggestions.length > 0 && (
        <Section
          title="Where to start"
          description="Ranked by impact relative to effort, across every dimension."
        >
          <ol className="space-y-3">
            {health.topSuggestions.map((suggestion, index) => (
              <li key={suggestion.id} className="glass rounded-panel flex gap-4 p-4">
                <span className="border-line bg-surface text-jade flex size-7 shrink-0 items-center justify-center rounded-lg border font-mono text-xs">
                  {index + 1}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-ink text-[15px] font-medium">{suggestion.title}</h3>
                    <Badge variant={IMPACT_VARIANT[suggestion.impact]}>
                      {suggestion.impact} impact
                    </Badge>
                    <Badge variant="outline">{suggestion.effort} effort</Badge>
                  </div>

                  <p className="text-ink-muted mt-1.5 text-sm leading-relaxed">
                    {suggestion.detail}
                  </p>

                  {suggestion.files.length > 0 && (
                    <ul className="mt-2.5 flex flex-wrap gap-1.5">
                      {suggestion.files.slice(0, 6).map((file) => (
                        <li
                          key={file}
                          className="border-line bg-surface/60 text-ink-subtle rounded border px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {file}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* Complexity -------------------------------------------------------- */}
      <Section
        title="Complexity hotspots"
        description={`${formatCount(complexity.totalSloc)} significant lines measured across ${formatCount(complexity.files.length)} files. Average cyclomatic complexity is ${complexity.averageComplexity.toFixed(1)}.`}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            {complexity.hotspots.length === 0 ? (
              <p className="text-ink-subtle text-sm">
                No source files were measurable in this repository.
              </p>
            ) : (
              <div className="border-line overflow-x-auto rounded-lg border">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">Files ranked by risk score, highest first</caption>
                  <thead>
                    <tr className="bg-surface/60">
                      <th scope="col" className="text-ink-muted px-3 py-2 text-left font-medium">
                        File
                      </th>
                      <th scope="col" className="text-ink-muted px-3 py-2 text-right font-medium">
                        Lines
                      </th>
                      <th scope="col" className="text-ink-muted px-3 py-2 text-right font-medium">
                        Cyclomatic
                      </th>
                      <th scope="col" className="text-ink-muted px-3 py-2 text-right font-medium">
                        Nesting
                      </th>
                      <th scope="col" className="text-ink-muted px-3 py-2 text-right font-medium">
                        Risk
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {complexity.hotspots.slice(0, 15).map((file) => {
                      // Risk is "higher is worse", so the tone scale inverts.
                      const tone = scoreTone(100 - file.riskScore);
                      return (
                        <tr key={file.path} className="border-line/60 border-t">
                          <th
                            scope="row"
                            className="text-ink max-w-0 px-3 py-2 text-left font-mono text-[12px] font-normal"
                          >
                            <span className="block truncate" title={file.path}>
                              {file.path}
                            </span>
                          </th>
                          <td className="text-ink-muted px-3 py-2 text-right tabular-nums">
                            {formatCount(file.sloc)}
                          </td>
                          <td className="text-ink-muted px-3 py-2 text-right tabular-nums">
                            {file.cyclomatic}
                          </td>
                          <td className="text-ink-muted px-3 py-2 text-right tabular-nums">
                            {file.maxNesting}
                          </td>
                          <td
                            className={`px-3 py-2 text-right font-medium tabular-nums ${TONE_TEXT[tone]}`}
                          >
                            {file.riskScore}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <DistributionBars
            data={complexity.distribution}
            title="Files by cyclomatic complexity"
            bucketHeading="Complexity"
          />
        </div>
      </Section>

      {/* Generated analysis ------------------------------------------------ */}
      {complexityDoc && (
        <Section title={complexityDoc.title} description={complexityDoc.summary}>
          <div className="glass rounded-panel p-6">
            <Markdown>{complexityDoc.markdown}</Markdown>
          </div>
        </Section>
      )}

      {debtDoc && (
        <Section
          title={debtDoc.title}
          description={debtDoc.summary}
          action={
            analysis.debt.totalEstimatedHours > 0 ? (
              <Badge variant="outline">
                <Lightbulb className="size-3" aria-hidden="true" />~
                {Math.round(analysis.debt.totalEstimatedHours)}h estimated
              </Badge>
            ) : undefined
          }
        >
          <div className="glass rounded-panel p-6">
            <Markdown>{debtDoc.markdown}</Markdown>
          </div>
        </Section>
      )}
    </div>
  );
}
