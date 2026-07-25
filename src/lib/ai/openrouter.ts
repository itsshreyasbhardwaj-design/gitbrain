/**
 * OpenRouter-backed reasoning.
 *
 * Active only when `OPENROUTER_API_KEY` is configured. The critical design
 * choice here is that the model never sees the repository as raw text — it sees
 * a compact, structured brief built from GitBrain's own analysis plus the
 * specific code chunks retrieved for this question.
 *
 * That does three things at once: it keeps the prompt inside a sane token
 * budget on a million-line repo, it makes answers reproducible, and it means
 * every citation the model can offer is one we retrieved and verified — so a
 * hallucinated file path is structurally unlikely rather than merely discouraged.
 */

import type { Analysis, Citation } from '@/core/types';
import { groupHitsByFile, search } from '@/core/search';
import type { ReasoningChunk, ReasoningProvider, ReasoningRequest } from './types';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Keep the retrieved-code section within a predictable token budget. */
const MAX_CONTEXT_CHARS = 24_000;
const MAX_HISTORY_TURNS = 8;

const SYSTEM_PROMPT = `You are GitBrain, a senior engineer explaining an unfamiliar codebase to a colleague.

You will be given:
1. A structured analysis of the repository (facts computed by static analysis — these are reliable).
2. Code excerpts retrieved for the user's specific question, each labelled with its file path and line numbers.

Rules:
- Ground every claim in the provided analysis or excerpts. If the context does not answer the question, say so plainly and state what you would need to look at.
- NEVER invent a file path, function name, dependency, or line number. Cite only paths that appear in the provided context.
- Cite as \`path/to/file.ts:42\` inline, in backticks.
- Be concise and concrete. Lead with the answer, then the evidence.
- Use Markdown: short paragraphs, fenced code blocks with a language tag, tables when comparing.
- When you are inferring rather than reading directly, say "appears to" and explain the signal you used.`;

interface OpenRouterDelta {
  choices?: { delta?: { content?: unknown } }[];
}

export class OpenRouterProvider implements ReasoningProvider {
  readonly id: string;
  readonly label: string;
  readonly isGenerative = true;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly referer: string | undefined;

  constructor(apiKey: string, model: string, referer?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.id = model;
    this.label = model.split('/').pop() ?? model;
    this.referer = referer;
  }

  async *answer(request: ReasoningRequest): AsyncIterable<ReasoningChunk> {
    const { question, history, analysis, signal } = request;

    const hits = search(analysis.search, question, 14);
    const grouped = groupHitsByFile(hits).slice(0, 8);

    const citations: Citation[] = grouped.map((group) => {
      const best = group.hits[0];
      return {
        file: group.file,
        ...(best ? { startLine: best.document.startLine, endLine: best.document.endLine } : {}),
      };
    });

    yield { type: 'citations', citations };

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: buildBrief(analysis, grouped) },
      ...history
        .slice(-MAX_HISTORY_TURNS)
        .map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user' as const, content: question },
    ];

    let response: Response;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'GitBrain',
      };
      if (this.referer) headers['HTTP-Referer'] = this.referer;

      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, messages, stream: true, temperature: 0.2 }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      yield { type: 'error', message: `Could not reach OpenRouter: ${describe(error)}` };
      return;
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      yield {
        type: 'error',
        message: `OpenRouter returned ${response.status}. ${detail.slice(0, 200)}`.trim(),
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are newline-delimited; the last piece may be incomplete.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            yield { type: 'done' };
            return;
          }

          try {
            const parsed = JSON.parse(payload) as OpenRouterDelta;
            const content = parsed.choices?.[0]?.delta?.content;
            if (typeof content === 'string' && content) yield { type: 'text', text: content };
          } catch {
            // A partial frame; the next read will complete it.
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    yield { type: 'done' };
  }
}

/**
 * Compress the analysis into a brief the model can actually use.
 *
 * Everything here is a computed fact. The model's job is explanation and
 * synthesis, not measurement — we already measured.
 */
function buildBrief(
  analysis: Analysis,
  grouped: readonly {
    file: string;
    hits: { document: { startLine: number; endLine: number; text: string; language: string } }[];
  }[],
): string {
  const { stack, stats, languages, health, dependencies, graph } = analysis;

  const name =
    analysis.source.kind === 'github'
      ? `${analysis.source.owner}/${analysis.source.repo}`
      : analysis.source.filename;

  const list = (items: readonly { name: string }[], limit = 6) =>
    items
      .slice(0, limit)
      .map((item) => item.name)
      .join(', ') || 'none detected';

  const lines = [
    `# Repository analysis: ${name}`,
    '',
    '## Facts',
    `- Languages: ${languages
      .slice(0, 5)
      .map((l) => `${l.language} ${l.percent}%`)
      .join(', ')}`,
    `- Frameworks: ${list(stack.frameworks)}`,
    `- Runtimes: ${list(stack.runtimes)}`,
    `- Package managers: ${list(stack.packageManagers)}`,
    `- Testing: ${list(stack.testing)}`,
    `- Databases: ${list(stack.databases)}`,
    `- CI: ${list(stack.ci)}`,
    `- Deployment: ${list(stack.deployment)}`,
    `- Architecture: ${stack.architecture.style} (${stack.architecture.confidence} confidence)`,
    `- API style: ${stack.api.style}, ${stack.api.endpoints.length} endpoints detected`,
    `- Size: ${stats.files} files, ${stats.linesOfCode.toLocaleString()} lines of code, max depth ${stats.maxDepth}`,
    `- Tests: ${stats.testFiles} test files (ratio ${stats.testRatio})`,
    `- Dependencies: ${dependencies.dependencies.length} declared, lockfile ${dependencies.hasLockfile ? 'present' : 'absent'}`,
    `- Module graph: ${graph.nodes.length} modules, ${graph.edges.length} edges, ${graph.cycles.length} circular chains`,
    `- Health: ${health.overall}/100 (${health.grade})`,
    '',
    '## Entry points',
    analysis.entryPoints
      .slice(0, 8)
      .map((e) => `- \`${e.path}\` — ${e.reason}`)
      .join('\n') || '- none detected',
    '',
    '## Top-level structure',
    (analysis.tree.children ?? [])
      .slice(0, 20)
      .map((child) => `- \`${child.name}\`${child.purpose ? ` — ${child.purpose}` : ''}`)
      .join('\n'),
  ];

  // Retrieved code last, and budgeted, so it is the first thing truncated.
  const excerpts: string[] = ['', '## Retrieved code for this question'];
  let remaining = MAX_CONTEXT_CHARS;

  for (const group of grouped) {
    const best = group.hits[0];
    if (!best) continue;

    const body = best.document.text.slice(0, Math.min(2400, remaining));
    if (body.length < 40) break;
    remaining -= body.length;

    excerpts.push(
      '',
      `### \`${group.file}\` (lines ${best.document.startLine}–${best.document.endLine})`,
      '```' + best.document.language.toLowerCase(),
      body,
      '```',
    );

    if (remaining <= 0) break;
  }

  return [...lines, ...excerpts].join('\n');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
