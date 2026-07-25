import {
  Boxes,
  FileSearch,
  Gauge,
  GitFork,
  MessagesSquare,
  Network,
  ScrollText,
  ShieldAlert,
} from 'lucide-react';

import { AnalyzeForm } from '@/features/analyze/analyze-form';
import { capabilities } from '@/lib/env';

const FEATURES = [
  {
    icon: ScrollText,
    title: 'A knowledge base, not a summary',
    body: 'Eighteen generated documents — architecture, data flow, auth, setup, deployment, environment variables — each written from measured facts and citing the exact files it drew from.',
  },
  {
    icon: Network,
    title: 'The real import graph',
    body: 'Every import is parsed and resolved across TypeScript, Python, Go, Rust and more. Circular dependencies are found with Tarjan’s algorithm, not guessed at.',
  },
  {
    icon: Gauge,
    title: 'Health scored on evidence',
    body: 'Eight dimensions, each with a rationale made of numbers you can check. No repository gets a good testing score for having zero tests.',
  },
  {
    icon: ShieldAlert,
    title: 'Security that avoids crying wolf',
    body: 'Entropy-gated secret detection with placeholder and .env.example suppression, dangerous-sink analysis, and dependency flags. Findings are always redacted.',
  },
  {
    icon: FileSearch,
    title: 'Search that understands code',
    body: 'BM25 ranking with symbol boosting, so searching a function name surfaces where it is defined before the twenty places it is called.',
  },
  {
    icon: MessagesSquare,
    title: 'Ask the codebase',
    body: 'Streaming answers with clickable citations. Works with no API key at all; plug in OpenRouter for conversational depth.',
  },
];

const STEPS = [
  {
    icon: GitFork,
    title: 'Fetch',
    body: 'The repository archive is downloaded directly — no git binary, no temp directory, no history to clone. An uploaded ZIP takes the identical path.',
  },
  {
    icon: Boxes,
    title: 'Analyze',
    body: 'Dependencies, stack, entry points, module graph, complexity, duplication, secrets, README and health are computed in one deterministic pass.',
  },
  {
    icon: ScrollText,
    title: 'Explain',
    body: 'Those facts become documents, diagrams and an interactive graph you can filter, search and question.',
  },
];

export default function HomePage() {
  const { ai, persistence } = capabilities();

  return (
    <>
      {/* Hero ------------------------------------------------------------ */}
      <section className="relative isolate overflow-hidden">
        <div
          className="grid-backdrop pointer-events-none absolute inset-0 -z-10"
          aria-hidden="true"
        />

        <div className="mx-auto max-w-3xl px-4 pt-20 pb-16 text-center sm:px-6 sm:pt-28 lg:px-8">
          <p className="animate-in-up text-eyebrow text-jade uppercase">Repository intelligence</p>

          <h1 className="animate-in-up text-ink sm:text-display mt-5 text-4xl font-semibold tracking-tighter text-balance">
            Understand any codebase <span className="text-gradient">in minutes, not weeks</span>
          </h1>

          <p className="animate-in-up text-ink-muted mx-auto mt-5 max-w-2xl text-base leading-relaxed text-pretty sm:text-lg">
            Paste a GitHub repository. GitBrain reads every file, maps the architecture, scores the
            health, finds the risks, and hands you an interactive knowledge base you can question.
          </p>

          <div className="animate-in-up mx-auto mt-9 max-w-2xl text-left">
            <AnalyzeForm />
          </div>

          <p className="text-ink-faint mt-8 text-xs">
            {ai ? 'LLM answers enabled' : 'No API key required'}
            <span className="mx-2 opacity-50">·</span>
            {persistence ? 'Analyses stored durably' : 'Analyses kept in memory'}
            <span className="mx-2 opacity-50">·</span>
            MIT licensed
          </p>
        </div>
      </section>

      {/* Features --------------------------------------------------------- */}
      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <article
              key={feature.title}
              className="glass group rounded-panel hover:border-line-strong p-6 transition-colors duration-200"
            >
              <feature.icon
                className="text-jade size-5 transition-transform duration-300 group-hover:scale-110"
                aria-hidden="true"
              />
              <h2 className="text-ink mt-4 text-[15px] font-semibold tracking-tight">
                {feature.title}
              </h2>
              <p className="text-ink-muted mt-2 text-sm leading-relaxed">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* How it works ----------------------------------------------------- */}
      <section
        id="how-it-works"
        className="mx-auto max-w-7xl scroll-mt-20 px-4 py-16 sm:px-6 lg:px-8"
      >
        <div className="max-w-2xl">
          <p className="text-eyebrow text-ink-faint uppercase">How it works</p>
          <h2 className="text-ink sm:text-title mt-3 text-3xl font-semibold tracking-tight">
            Static analysis first. Language models second.
          </h2>
          <p className="text-ink-muted mt-4 leading-relaxed text-pretty">
            Everything GitBrain tells you is computed from the source, so it is reproducible and
            checkable. A model can then explain those findings more fluently — but it never invents
            them, and the product works completely without one.
          </p>
        </div>

        <ol className="mt-10 grid gap-4 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="glass-subtle rounded-panel p-6">
              <div className="flex items-center gap-3">
                <span className="border-line bg-surface text-jade flex size-8 items-center justify-center rounded-lg border font-mono text-xs">
                  {index + 1}
                </span>
                <step.icon className="text-ink-faint size-4" aria-hidden="true" />
              </div>
              <h3 className="text-ink mt-4 text-[15px] font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="text-ink-muted mt-2 text-sm leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
