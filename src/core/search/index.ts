/**
 * Code search: chunking, an inverted index, and BM25 ranking.
 *
 * Why lexical search rather than embeddings? Three reasons that matter for this
 * product:
 *
 *   1. It works offline, instantly, with no API key and no per-query cost.
 *   2. Code queries are overwhelmingly lexical — people search for `authorize`,
 *      `POST /login`, `UserRepository`. Exact identifier matching is a feature,
 *      not a limitation, and it is precisely what embeddings blur away.
 *   3. Every hit is a real file and line range, so citations cannot hallucinate.
 *
 * The index is deliberately serializable and small enough to travel with the
 * analysis, so search stays fast without a vector database. The `SearchIndex`
 * shape is embedding-ready: adding a dense vector per `SearchDocument` and a
 * hybrid re-rank is an additive change, not a rewrite.
 */

import type { RepoFile, RepoSnapshot, SearchDocument, SearchHit, SearchIndex } from '../types';
import { detectLanguage } from '../shared/languages';
import { isCountableSource, isDocumentationFile, isGeneratedFile } from '../shared/classify';
import { tokenizeForSearch } from '../shared/text';

/**
 * Chunk sizing.
 *
 * 40 lines is about one screen: large enough to contain a whole function with
 * its signature, small enough that a citation points somewhere specific. The
 * 10-line overlap stops a function that straddles a boundary from becoming
 * invisible to both chunks.
 */
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 10;

/**
 * BM25 parameters.
 *
 * `k1` is the textbook default. `b` is lowered from the usual 0.75 because
 * length normalization is tuned for prose, and code chunks vary in length far
 * more than paragraphs do — a 6-line Go file and an 80-line React component
 * are both "one unit of code". At 0.75 a one-sentence README reliably
 * outranked the file that actually implemented the thing being asked about.
 */
const K1 = 1.5;
const B = 0.45;

/** Symbol matches are worth more than incidental body text. */
const SYMBOL_BOOST = 2.5;

/**
 * How many times a path token is repeated into a chunk's term list.
 *
 * A file at `src/auth/session.ts` is about authentication even when the word
 * never appears in its body, and that path is the single most reliable signal
 * a repository offers. Repetition is a cheap stand-in for per-field weighting.
 */
const PATH_TERM_WEIGHT = 3;

/**
 * Multiplier when a query term appears in the file's own path.
 *
 * A path is a curated, human-authored label for what a file contains, which
 * makes it the highest-precision signal in a repository. Every serious code
 * search engine boosts path matches, and so does this one.
 */
const PATH_BOOST = 2.2;

/**
 * Weight applied to a prefix-expanded term relative to an exact match.
 *
 * Low enough that an exact hit always outranks a morphological one, high
 * enough that "authentication" still finds `authenticate` and `authorize`.
 */
const EXPANSION_WEIGHT = 0.42;

/** Below this length a term is too ambiguous to expand by prefix. */
const MIN_EXPANDABLE_LENGTH = 4;

/** Cap expansions per query term so a common stem cannot explode the query. */
const MAX_EXPANSIONS = 12;

/** Skip chunks with almost no content — imports blocks, closing braces. */
const MIN_CHUNK_TOKENS = 5;

/** Bound the index so a huge monorepo still produces a portable artifact. */
const MAX_DOCUMENTS = 12_000;

/**
 * Declaration patterns per language family.
 *
 * Symbols get a scoring boost, so a query for `createUser` should rank the file
 * that *defines* it above the twenty that merely call it.
 */
const SYMBOL_PATTERNS: readonly RegExp[] = [
  // JS/TS: function, class, const arrow, method, type, interface, enum
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  /\b(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  // Python
  /\b(?:async\s+)?def\s+([A-Za-z_]\w*)/g,
  /\bclass\s+([A-Za-z_]\w*)/g,
  // Go
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /\btype\s+([A-Za-z_]\w*)\s+(?:struct|interface)/g,
  // Rust
  /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g,
  /\b(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/g,
  // Java / Kotlin / C#
  /\b(?:public|private|protected)\s+(?:static\s+)?(?:[\w<>[\],\s]+\s+)?([A-Za-z_]\w*)\s*\(/g,
  // Ruby / PHP
  /\bdef\s+([A-Za-z_]\w*[?!]?)/g,
  /\bfunction\s+([A-Za-z_]\w*)\s*\(/g,
];

/** Extract declared symbol names from a chunk of source. */
export function extractSymbols(text: string): string[] {
  const symbols = new Set<string>();

  for (const pattern of SYMBOL_PATTERNS) {
    // Patterns are module-level and stateful with /g; reset before each use.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1];
      if (name && name.length > 1) symbols.add(name);
      // Zero-length matches would loop forever.
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  return [...symbols];
}

/** True when the file's text should be searchable. */
function isIndexable(file: RepoFile): boolean {
  if (!file.content || file.isBinary) return false;
  if (isGeneratedFile(file.path, file.content)) return false;
  return isCountableSource(file.path, file.content) || isDocumentationFile(file.path);
}

/** Split one file into overlapping, line-aligned chunks. */
function chunkFile(file: RepoFile): SearchDocument[] {
  const content = file.content;
  if (!content) return [];

  const lines = content.split('\n');
  const language = detectLanguage(file.path).name;
  const documents: SearchDocument[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const text = lines.slice(start, end).join('\n');

    if (text.trim().length === 0) continue;

    documents.push({
      id: `${file.path}#${start + 1}`,
      file: file.path,
      startLine: start + 1,
      endLine: end,
      text,
      language,
      symbols: extractSymbols(text),
    });

    if (end >= lines.length) break;
  }

  return documents;
}

/**
 * Build the inverted index.
 *
 * Files are processed shortest-path-first so that if the document cap is hit,
 * what survives is the top-level application code rather than deep fixtures.
 */
export function buildSearchIndex(snapshot: RepoSnapshot): SearchIndex {
  const indexable = snapshot.files
    .filter(isIndexable)
    .sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
    );

  const documents: SearchDocument[] = [];
  for (const file of indexable) {
    if (documents.length >= MAX_DOCUMENTS) break;
    for (const doc of chunkFile(file)) {
      if (documents.length >= MAX_DOCUMENTS) break;
      documents.push(doc);
    }
  }

  // A Map, not an object literal.
  //
  // Source code contains identifiers like `constructor`, `toString`, `valueOf`
  // and `__proto__`. On a plain object those resolve to inherited
  // `Object.prototype` members, so `postings[term] ??= []` sees a truthy
  // function and never assigns the array — then `.push` throws. A Map has no
  // prototype chain to collide with.
  const buckets = new Map<string, [number, number][]>();
  let totalLength = 0;

  documents.forEach((doc, docIndex) => {
    const terms = tokenizeForSearch(doc.text);
    // Symbols are appended so they contribute term frequency as well as boost.
    for (const symbol of doc.symbols) terms.push(...tokenizeForSearch(symbol));

    // The path is evidence too, and strong evidence: a file living at
    // `src/auth/session.ts` is about authentication even if the word never
    // appears in its body. Repeating the path tokens weights them without
    // needing a separate field-scoring model.
    const pathTerms = tokenizeForSearch(doc.file.replace(/[/.]/g, ' '));
    for (let repeat = 0; repeat < PATH_TERM_WEIGHT; repeat++) terms.push(...pathTerms);

    if (terms.length < MIN_CHUNK_TOKENS) return;
    totalLength += terms.length;

    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);

    for (const [term, frequency] of frequencies) {
      const bucket = buckets.get(term);
      if (bucket) bucket.push([docIndex, frequency]);
      else buckets.set(term, [[docIndex, frequency]]);
    }
  });

  // `Object.create(null)` keeps the serialized shape a plain JSON object while
  // ensuring a rehydrated index cannot be probed for inherited members either.
  const postings: Record<string, [number, number][]> = Object.assign(
    Object.create(null) as Record<string, [number, number][]>,
    Object.fromEntries(buckets),
  );

  return {
    documents,
    postings,
    averageLength: documents.length > 0 ? totalLength / documents.length : 0,
    totalDocuments: documents.length,
  };
}

/**
 * Safe postings lookup.
 *
 * An index that has round-tripped through JSON (the Supabase store does this)
 * comes back with a normal prototype, so the read path needs the same
 * protection as the write path.
 */
function postingsFor(
  index: SearchIndex,
  term: string,
): readonly (readonly [number, number])[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(index.postings, term)) return undefined;
  const entries = index.postings[term];
  return Array.isArray(entries) ? entries : undefined;
}

/** Per-document term count, reconstructed from postings during scoring. */
function documentLengths(index: SearchIndex): number[] {
  const lengths = new Array<number>(index.documents.length).fill(0);
  for (const entries of Object.values(index.postings)) {
    for (const [docIndex, frequency] of entries) {
      const current = lengths[docIndex];
      if (current !== undefined) lengths[docIndex] = current + frequency;
    }
  }
  return lengths;
}

/**
 * Rank documents against a natural-language or identifier query using BM25.
 *
 * On top of standard BM25 we add two code-specific signals:
 *   - a boost when a query term is a *declared symbol* in the chunk, so the
 *     definition outranks the call sites;
 *   - a boost for exact substring presence, which rescues multi-word phrases
 *     like `POST /login` that tokenization would otherwise scatter.
 */
export function search(index: SearchIndex, query: string, limit = 10): SearchHit[] {
  const terms = tokenizeForSearch(query);
  if (terms.length === 0 || index.totalDocuments === 0) return [];

  const lengths = documentLengths(index);
  const scores = new Map<number, number>();
  const uniqueTerms = [...new Set(terms)];
  const vocabulary = Object.keys(index.postings);

  // Expanded terms are merged by keeping the strongest weight, so a term that
  // is both an exact match and someone else's expansion still scores as exact.
  const weighted = new Map<string, number>();
  for (const term of uniqueTerms) {
    for (const { term: expanded, weight } of expandTerm(term, vocabulary)) {
      weighted.set(expanded, Math.max(weighted.get(expanded) ?? 0, weight));
    }
  }

  for (const [term, weight] of weighted) {
    const entries = postingsFor(index, term);
    if (!entries || entries.length === 0) continue;

    // BM25 IDF with the +1 smoothing that keeps common terms non-negative.
    const idf = Math.log(
      1 + (index.totalDocuments - entries.length + 0.5) / (entries.length + 0.5),
    );

    for (const [docIndex, frequency] of entries) {
      const length = lengths[docIndex] ?? index.averageLength;
      const normalization = K1 * (1 - B + (B * length) / (index.averageLength || 1));
      let contribution = (idf * (frequency * (K1 + 1))) / (frequency + normalization);

      const doc = index.documents[docIndex];
      if (doc) {
        if (doc.symbols.some((symbol) => symbol.toLowerCase().includes(term))) {
          contribution *= SYMBOL_BOOST;
        }
        if (pathTokens(doc.file).has(term)) {
          contribution *= PATH_BOOST;
        }
      }

      scores.set(docIndex, (scores.get(docIndex) ?? 0) + contribution * weight);
    }
  }

  const lowerQuery = query.toLowerCase().trim();
  const hits: SearchHit[] = [];

  for (const [docIndex, score] of scores) {
    const document = index.documents[docIndex];
    if (!document) continue;

    const lowerText = document.text.toLowerCase();
    const phraseBonus = lowerQuery.length > 3 && lowerText.includes(lowerQuery) ? score * 0.5 : 0;

    hits.push({
      document,
      score: score + phraseBonus,
      highlights: findHighlights(document.text, uniqueTerms),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Tokenized path segments for a file, memoised across a search.
 *
 * Recomputed per query rather than stored on `SearchDocument`, which keeps the
 * serialized index smaller — paths are already in the document.
 */
const pathTokenCache = new Map<string, Set<string>>();

function pathTokens(file: string): Set<string> {
  const cached = pathTokenCache.get(file);
  if (cached) return cached;

  const tokens = new Set(tokenizeForSearch(file.replace(/[/.]/g, ' ')));
  // Bounded so a long-lived process analyzing many repositories cannot grow
  // this cache without limit.
  if (pathTokenCache.size > 20_000) pathTokenCache.clear();
  pathTokenCache.set(file, tokens);
  return tokens;
}

/**
 * Expand a query term to morphologically related index terms.
 *
 * Pure BM25 is exact-match only, which fails the single most common question
 * a developer asks: "where is authentication implemented" would not match a
 * file containing `auth`, `authenticate` and `authorize` but never the noun
 * itself. A stemmer would be the textbook answer, but English stemmers mangle
 * identifiers (`routes` → `rout`), so prefix matching in both directions is
 * both safer on code and cheap.
 *
 * Matching is bidirectional: `authentication` finds `auth` (the index term is
 * a prefix of the query) and `auth` finds `authentication` (the query is a
 * prefix of the index term).
 */
function expandTerm(
  term: string,
  vocabulary: readonly string[],
): { term: string; weight: number }[] {
  const expansions: { term: string; weight: number }[] = [{ term, weight: 1 }];
  if (term.length < MIN_EXPANDABLE_LENGTH) return expansions;

  // Require a substantial shared prefix so `state` does not pull in `static`.
  const stem = term.slice(0, Math.max(MIN_EXPANDABLE_LENGTH, Math.ceil(term.length * 0.6)));

  for (const candidate of vocabulary) {
    if (candidate === term || candidate.length < MIN_EXPANDABLE_LENGTH) continue;

    const candidateExtendsQuery = candidate.startsWith(stem);
    const queryExtendsCandidate = term.startsWith(candidate);

    if (candidateExtendsQuery || queryExtendsCandidate) {
      expansions.push({ term: candidate, weight: EXPANSION_WEIGHT });
      if (expansions.length > MAX_EXPANSIONS) break;
    }
  }

  return expansions;
}

/**
 * Character ranges to highlight, capped and merged.
 *
 * Overlapping ranges are merged so the renderer never has to reason about
 * nested marks.
 */
function findHighlights(text: string, terms: readonly string[]): [number, number][] {
  const ranges: [number, number][] = [];
  const lower = text.toLowerCase();

  for (const term of terms) {
    if (term.length < 3) continue;
    let from = 0;
    for (let found = 0; found < 8; found++) {
      const index = lower.indexOf(term, from);
      if (index === -1) break;
      ranges.push([index, index + term.length]);
      from = index + term.length;
    }
  }

  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }

  return merged.slice(0, 24);
}

/**
 * Group hits by file so the UI can show "3 matches in auth.ts" rather than
 * three near-identical adjacent chunks.
 */
export function groupHitsByFile(hits: readonly SearchHit[]): {
  file: string;
  score: number;
  hits: SearchHit[];
}[] {
  const groups = new Map<string, { file: string; score: number; hits: SearchHit[] }>();

  for (const hit of hits) {
    const existing = groups.get(hit.document.file);
    if (existing) {
      existing.hits.push(hit);
      existing.score = Math.max(existing.score, hit.score);
    } else {
      groups.set(hit.document.file, { file: hit.document.file, score: hit.score, hits: [hit] });
    }
  }

  return [...groups.values()].sort((a, b) => b.score - a.score);
}
