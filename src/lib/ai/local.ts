/**
 * The local reasoner: answers questions about a repository with no API key.
 *
 * It is not a language model and does not pretend to be one. It is a retrieval
 * engine over facts GitBrain already computed, and it is honest about that in
 * the UI. In practice it answers the questions developers actually ask of an
 * unfamiliar codebase — "where is auth", "what starts this", "how do I run it" —
 * better than a generic LLM with no repository access, because every sentence
 * is anchored to a real file at a real line.
 *
 * Strategy:
 *   1. Classify the question into a topic.
 *   2. If a knowledge document covers that topic, lead with it.
 *   3. Always run BM25 retrieval and show the strongest code evidence.
 *   4. Emit citations first so source chips render before the prose.
 */

import type { Analysis, Citation, KnowledgeDocId, SearchHit } from '@/core/types';
import { groupHitsByFile, search } from '@/core/search';
import { truncate } from '@/core/shared/text';
import type { ReasoningChunk, ReasoningProvider, ReasoningRequest } from './types';

/**
 * Topic routing.
 *
 * Ordered most-specific-first: "how do I deploy this" should route to
 * deployment even though it also contains the generic word "how".
 */
interface Topic {
  readonly doc: KnowledgeDocId;
  readonly patterns: readonly RegExp[];
  /** Extra terms mixed into retrieval to sharpen results for this topic. */
  readonly expansion: readonly string[];
}

const TOPICS: readonly Topic[] = [
  {
    doc: 'authentication-flow',
    patterns: [
      /\bauth(entication|orization|orize|enticate)?\b/i,
      /\blogin\b/i,
      /\bsign[- ]?(in|up)\b/i,
      /\bsession\b/i,
      /\bjwt\b/i,
      /\btoken\b/i,
      /\bpermission/i,
      /\brole/i,
      /\bmiddleware\b.*\bprotect/i,
    ],
    expansion: [
      'auth',
      'login',
      'session',
      'token',
      'jwt',
      'password',
      'credential',
      'signin',
      'user',
    ],
  },
  {
    doc: 'database-overview',
    patterns: [
      /\bdatabase\b/i,
      /\bschema\b/i,
      /\bmigration/i,
      /\bmodel(s)?\b/i,
      /\borm\b/i,
      /\bsql\b/i,
      /\bprisma\b/i,
      /\btable(s)?\b/i,
      /\bquery\b/i,
    ],
    expansion: [
      'database',
      'schema',
      'model',
      'migration',
      'table',
      'query',
      'repository',
      'entity',
    ],
  },
  {
    doc: 'api-overview',
    patterns: [
      /\bapi\b/i,
      /\bendpoint/i,
      /\broute(s|ing)?\b/i,
      /\bcontroller/i,
      /\brest\b/i,
      /\bgraphql\b/i,
      /\bhandler/i,
    ],
    expansion: ['route', 'endpoint', 'handler', 'controller', 'api', 'request', 'response'],
  },
  {
    doc: 'entry-points',
    patterns: [
      /\bentry ?point/i,
      /what (starts|runs|boots|launches)/i,
      /\bmain\b/i,
      /\bbootstrap/i,
      /where.*\bstart/i,
      /\bindex\b/i,
    ],
    expansion: ['main', 'index', 'start', 'bootstrap', 'server', 'app', 'entry'],
  },
  {
    doc: 'setup-guide',
    patterns: [
      /how (do i|to) (run|start|install|set ?up|build)/i,
      /\bset ?up\b/i,
      /\binstall/i,
      /\bgetting started\b/i,
      /\bdev(elopment)? server\b/i,
    ],
    expansion: ['install', 'setup', 'scripts', 'dev', 'build', 'start'],
  },
  {
    doc: 'deployment-guide',
    patterns: [
      /\bdeploy/i,
      /\bproduction\b/i,
      /\bci\/?cd\b/i,
      /\bpipeline/i,
      /\bdocker/i,
      /\bkubernetes|k8s\b/i,
      /\bhost(ing|ed)?\b/i,
    ],
    expansion: ['deploy', 'docker', 'build', 'production', 'workflow', 'pipeline'],
  },
  {
    doc: 'environment-variables',
    patterns: [
      /\benv(ironment)?\b.*\bvar/i,
      /\.env\b/i,
      /\bconfig(uration)?\b/i,
      /\bsecret(s)?\b.*\bset\b/i,
    ],
    expansion: ['env', 'environment', 'config', 'process', 'variable'],
  },
  {
    doc: 'security-risks',
    patterns: [
      /\bsecurity\b/i,
      /\bvulnerab/i,
      /\bexploit/i,
      /\bxss\b/i,
      /\bsql ?injection\b/i,
      /\bunsafe\b/i,
      /\brisk/i,
      /\bhardcoded\b/i,
    ],
    expansion: ['security', 'secret', 'sanitize', 'validate', 'escape', 'password'],
  },
  {
    doc: 'data-flow',
    patterns: [
      /\bdata ?flow\b/i,
      /how does data\b/i,
      /\bstate management\b/i,
      /\bstore\b/i,
      /\bredux|zustand|context\b/i,
      /\bpipeline\b/i,
    ],
    expansion: ['store', 'state', 'context', 'reducer', 'dispatch', 'flow', 'stream'],
  },
  {
    doc: 'architecture-overview',
    patterns: [
      /\barchitect/i,
      /\bstructure\b/i,
      /\bhow.*organi[sz]ed\b/i,
      /\boverview\b/i,
      /\bdesign\b/i,
      /\bmodule/i,
      /\blayer/i,
    ],
    expansion: ['module', 'service', 'layer', 'component', 'architecture'],
  },
  {
    doc: 'technical-debt',
    patterns: [
      /\btech(nical)? debt\b/i,
      /\btodo/i,
      /\bfixme/i,
      /\brefactor/i,
      /\bcleanup\b/i,
      /\bsmell/i,
    ],
    expansion: ['todo', 'fixme', 'hack', 'deprecated', 'refactor'],
  },
  {
    doc: 'code-complexity',
    patterns: [
      /\bcomplex/i,
      /\bhard(est)? to (read|maintain|understand)\b/i,
      /\bhotspot/i,
      /\bbiggest file/i,
      /\blargest file/i,
    ],
    expansion: ['complexity', 'nesting', 'function'],
  },
  {
    doc: 'dependency-analysis',
    patterns: [
      /\bdependenc/i,
      /\bpackage(s)?\b/i,
      /\blibrar/i,
      /\bnpm\b/i,
      /\bimport(s)?\b.*\bexternal\b/i,
    ],
    expansion: ['dependency', 'package', 'import', 'require', 'library'],
  },
  {
    doc: 'performance-bottlenecks',
    patterns: [
      /\bperformance\b/i,
      /\bslow\b/i,
      /\boptimi[sz]/i,
      /\bbottleneck/i,
      /\bbundle size\b/i,
    ],
    expansion: ['performance', 'cache', 'async', 'loop', 'optimize'],
  },
  {
    doc: 'project-purpose',
    patterns: [
      /what (is|does) (this|it)\b/i,
      /\bpurpose\b/i,
      /\bwhat.*\bfor\b/i,
      /\bexplain (this|the) (project|repo)/i,
    ],
    expansion: [],
  },
];

/** Words that carry no retrieval signal but appear in nearly every question. */
const QUESTION_NOISE =
  /\b(where|what|how|why|when|which|who|is|are|does|do|the|a|an|in|this|repo|repository|codebase|project|please|explain|tell|me|about|implemented|implementation)\b/gi;

function classify(question: string): Topic | null {
  for (const topic of TOPICS) {
    if (topic.patterns.some((pattern) => pattern.test(question))) return topic;
  }
  return null;
}

/** Build the retrieval query: the question, denoised, plus topic expansion. */
function buildQuery(question: string, topic: Topic | null): string {
  const core = question.replace(QUESTION_NOISE, ' ').replace(/[?.,!]/g, ' ');
  return topic ? `${core} ${topic.expansion.join(' ')}` : core;
}

/** Trim a hit's text to the lines that actually matched, for a tight excerpt. */
function excerpt(hit: SearchHit, maxLines = 12): { text: string; startLine: number } {
  const lines = hit.document.text.split('\n');
  const firstHighlight = hit.highlights[0];

  if (!firstHighlight) {
    return { text: lines.slice(0, maxLines).join('\n'), startLine: hit.document.startLine };
  }

  // Convert the character offset of the first match into a line offset.
  const before = hit.document.text.slice(0, firstHighlight[0]);
  const matchLine = before.split('\n').length - 1;
  const start = Math.max(0, matchLine - 3);
  const end = Math.min(lines.length, start + maxLines);

  return {
    text: lines.slice(start, end).join('\n'),
    startLine: hit.document.startLine + start,
  };
}

/**
 * Stream a string as small chunks.
 *
 * Chunking on whitespace rather than characters keeps Markdown tokens intact,
 * so the client never renders a half-written fence or link.
 */
async function* streamText(text: string, signal?: AbortSignal): AsyncGenerator<ReasoningChunk> {
  const parts = text.split(/(\s+)/);
  let buffer = '';

  for (const part of parts) {
    if (signal?.aborted) return;
    buffer += part;
    if (buffer.length >= 24) {
      yield { type: 'text', text: buffer };
      buffer = '';
    }
  }

  if (buffer) yield { type: 'text', text: buffer };
}

export class LocalReasoner implements ReasoningProvider {
  readonly id = 'local';
  readonly label = 'Local analysis';
  readonly isGenerative = false;

  async *answer(request: ReasoningRequest): AsyncIterable<ReasoningChunk> {
    const { question, analysis, signal } = request;

    const topic = classify(question);
    const hits = search(analysis.search, buildQuery(question, topic), 12);
    const grouped = groupHitsByFile(hits).slice(0, 5);

    const doc = topic ? analysis.knowledge.docs.find((d) => d.id === topic.doc) : undefined;

    const citations: Citation[] = [
      ...(doc?.citations ?? []).slice(0, 4),
      ...grouped.map((group): Citation => {
        const best = group.hits[0];
        return {
          file: group.file,
          ...(best ? { startLine: best.document.startLine, endLine: best.document.endLine } : {}),
        };
      }),
    ];

    // De-duplicate by file, preserving the first (highest-confidence) entry.
    const seen = new Set<string>();
    const unique = citations.filter((c) => (seen.has(c.file) ? false : (seen.add(c.file), true)));

    yield { type: 'citations', citations: unique };

    const sections: string[] = [];

    if (doc) {
      sections.push(`## ${doc.title}\n\n${doc.markdown.trim()}`);
    }

    if (grouped.length > 0) {
      const evidence = grouped
        .map((group) => {
          const best = group.hits[0];
          if (!best) return `- \`${group.file}\``;
          const snippet = excerpt(best);
          const language = best.document.language.toLowerCase();
          return [
            `**\`${group.file}\`** — line ${snippet.startLine}`,
            '',
            '```' + (language === 'other' ? '' : language),
            snippet.text,
            '```',
          ].join('\n');
        })
        .join('\n\n');

      sections.push(
        `${doc ? '## Where this lives in the code' : '## Matching code'}\n\n` +
          `${grouped.length === 1 ? 'One file' : `${grouped.length} files`} in this repository ` +
          `${grouped.length === 1 ? 'matches' : 'match'} your question:\n\n${evidence}`,
      );
    }

    if (sections.length === 0) {
      sections.push(this.noResults(question, analysis));
    }

    yield* streamText(sections.join('\n\n'), signal);
    yield { type: 'done' };
  }

  /**
   * The honest empty state.
   *
   * Rather than guessing, say what was searched and offer the questions this
   * repository can actually answer — which is far more useful than a
   * confidently wrong paragraph.
   */
  private noResults(question: string, analysis: Analysis): string {
    const topLanguages = analysis.languages
      .slice(0, 3)
      .map((l) => l.language)
      .join(', ');

    const suggestions = analysis.knowledge.docs
      .slice(0, 6)
      .map((doc) => `- ${doc.title} — ${truncate(doc.summary, 90)}`)
      .join('\n');

    return [
      `I could not find anything in this repository matching **${truncate(question, 80)}**.`,
      '',
      `I searched ${analysis.search.totalDocuments.toLocaleString()} indexed code chunks across ` +
        `${analysis.stats.files.toLocaleString()} files (${topLanguages}).`,
      '',
      'Things this repository *can* answer:',
      '',
      suggestions,
    ].join('\n');
  }
}
