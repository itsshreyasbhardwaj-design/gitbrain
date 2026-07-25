/**
 * Per-file size, branch-density and nesting metrics.
 *
 * GitBrain deliberately does not parse an AST. A real parser per language is a
 * per-language maintenance burden and, worse, fails closed: one unsupported
 * syntax version and a whole file silently drops out of the report. A
 * repository-intelligence tool has to survive the long tail, so we run a small
 * language-aware *lexical* pass instead and accept a known, documented error bar.
 *
 * The part that actually matters is masking. Almost every naive line counter is
 * wrong for the same two reasons: it sees `if` inside a comment and `||` inside a
 * URL string. `maskSource` walks each file once with a tiny state machine and
 * blanks the interior of every comment and every string literal while preserving
 * column positions, so downstream measurements (sloc, branch tokens, brace depth,
 * indentation) all operate on code and only code.
 *
 * The masker is exported because `debt.ts` needs the mirror image of the same
 * pass — the comment text — to find TODO/FIXME markers without matching the word
 * "todo" inside a string or a piece of prose.
 */

import type { ComplexityReport, FileComplexity, RepoSnapshot } from '../types';
import { isCountableSource } from '../shared/classify';
import { extensionOf } from '../shared/languages';
import { basename } from '../shared/paths';
import { clamp, toLines } from '../shared/text';

// ---------------------------------------------------------------------------
// Language syntax profiles
// ---------------------------------------------------------------------------

/** How a language expresses block structure, and therefore how we measure it. */
type NestingModel = 'braces' | 'indent';

interface SyntaxProfile {
  /** Tokens that comment out the rest of the line. */
  readonly lineComments: readonly string[];
  /** Balanced `[open, close]` comment delimiters, possibly spanning lines. */
  readonly blockComments: readonly (readonly [string, string])[];
  /** String delimiters. Order matters: longest first. */
  readonly quotes: readonly string[];
  /** Triple-quoted forms, checked before `quotes`. Python docstrings live here. */
  readonly tripleQuotes: readonly string[];
  /**
   * True when a bare `/` in expression position starts a regular expression.
   * Only JavaScript/TypeScript; everywhere else `/` is division and pretending
   * otherwise would swallow real code.
   */
  readonly regexLiterals: boolean;
  readonly nesting: NestingModel;
  /** Keywords that introduce a decision point. `\b`-anchored when applied. */
  readonly branchWords: readonly string[];
  /** Operators that introduce a decision point, or `null` when none exist. */
  readonly branchSymbols: RegExp | null;
  /** Patterns whose matches each represent one function/method declaration. */
  readonly functionPatterns: readonly RegExp[];
}

/**
 * A brace-delimited method or function header at the start of a line.
 *
 * The leading negative lookahead is load-bearing: without it `if (x) {`,
 * `for (…) {` and `catch (e) {` all look exactly like a method signature. The
 * `[^;()]*` argument body refuses to cross a nested call, which keeps the match
 * anchored to a declaration rather than an invocation.
 */
const BRACE_METHOD =
  /^[ \t]*(?!(?:if|for|while|switch|catch|do|else|return|case|new|using|namespace|try|finally|synchronized)\b)[\w$~<>,[\]*&.:\t ]*?\b([A-Za-z_$~][\w$]*)\s*\([^;()]*\)\s*(?:const\s*)?(?:->\s*[\w:<>[\], ]+\s*)?(?:throws\s+[\w., ]+)?\{/gm;

/** `function foo(`, `function* (`, `function (` — named or not. */
const JS_FUNCTION_KEYWORD = /\bfunction\b\s*\*?\s*[\w$]*\s*\(/g;

/** `const foo = (a) => …`, `let foo: T = async x => …`. */
const JS_ASSIGNED_ARROW =
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::\s*[^=;]+?)?=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=>/g;

/** `render() {`, `private async load(x: T): Promise<void> {` inside a class. */
const JS_CLASS_METHOD =
  /^[ \t]*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|\*)\s+)*(?!(?:if|for|while|switch|catch|do|else|return|case|new|typeof|await|yield|function|import|export|class|try|finally)\b)[A-Za-z_$#][\w$]*\s*(?:<[^<>]*>)?\s*\([^;()]*\)\s*(?::\s*[^{;=]+)?\{/gm;

const JS_TS: SyntaxProfile = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  quotes: ['"', "'", '`'],
  tripleQuotes: [],
  regexLiterals: true,
  nesting: 'braces',
  branchWords: ['if', 'for', 'while', 'case', 'catch'],
  branchSymbols: /&&|\|\||\?\?|\?(?![?.:=])/g,
  functionPatterns: [JS_FUNCTION_KEYWORD, JS_ASSIGNED_ARROW, JS_CLASS_METHOD],
};

const PYTHON: SyntaxProfile = {
  lineComments: ['#'],
  blockComments: [],
  quotes: ['"', "'"],
  tripleQuotes: ['"""', "'''"],
  regexLiterals: false,
  nesting: 'indent',
  // `and`/`or` are Python's short-circuit operators, so they are decision points
  // exactly like `&&`/`||` elsewhere. `case` covers 3.10+ structural matching.
  branchWords: ['if', 'elif', 'for', 'while', 'except', 'case', 'and', 'or'],
  branchSymbols: null,
  functionPatterns: [/^[ \t]*(?:async\s+)?def\s+[A-Za-z_]\w*/gm],
};

const GO: SyntaxProfile = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  quotes: ['"', '`', "'"],
  tripleQuotes: [],
  regexLiterals: false,
  nesting: 'braces',
  // Go has no `while`; `for` covers every loop form and `case` covers both
  // `switch` and `select`.
  branchWords: ['if', 'for', 'case'],
  branchSymbols: /&&|\|\|/g,
  functionPatterns: [/\bfunc\b/g],
};

const RUST: SyntaxProfile = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  // Only double quotes: `'a` lifetimes are far more common than char literals,
  // and treating `'` as a string opener would mask the rest of the file.
  quotes: ['"'],
  tripleQuotes: [],
  regexLiterals: false,
  nesting: 'braces',
  branchWords: ['if', 'for', 'while', 'match'],
  // `=>` is a `match` arm, i.e. one branch each. Zero-argument closures (`||`)
  // are counted as a branch here; that over-count is rare and documented.
  branchSymbols: /&&|\|\||=>/g,
  functionPatterns: [/\bfn\s+[A-Za-z_]\w*/g],
};

const RUBY: SyntaxProfile = {
  lineComments: ['#'],
  blockComments: [],
  quotes: ['"', "'", '`'],
  tripleQuotes: [],
  regexLiterals: false,
  nesting: 'indent',
  branchWords: ['if', 'elsif', 'unless', 'while', 'until', 'for', 'when', 'rescue', 'and', 'or'],
  branchSymbols: /&&|\|\|/g,
  functionPatterns: [/^[ \t]*def\s+[A-Za-z_]/gm],
};

const SHELL: SyntaxProfile = {
  lineComments: ['#'],
  blockComments: [],
  quotes: ['"', "'"],
  tripleQuotes: [],
  regexLiterals: false,
  nesting: 'indent',
  branchWords: ['if', 'elif', 'for', 'while', 'until', 'case'],
  branchSymbols: /&&|\|\|/g,
  functionPatterns: [/^[ \t]*(?:function\s+)?[A-Za-z_]\w*\s*\(\)\s*\{/gm],
};

const PHP: SyntaxProfile = {
  lineComments: ['//', '#'],
  blockComments: [['/*', '*/']],
  quotes: ['"', "'"],
  tripleQuotes: [],
  regexLiterals: false,
  nesting: 'braces',
  branchWords: ['if', 'elseif', 'for', 'foreach', 'while', 'case', 'catch'],
  branchSymbols: /&&|\|\||\?\?|\?(?![?.:=])/g,
  functionPatterns: [/\bfunction\s*&?\s*[\w$]*\s*\(/g],
};

/** C, C++, C#, Java, Scala, Dart, Solidity, Zig — brace languages, no regex sugar. */
const C_FAMILY: SyntaxProfile = {
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  quotes: ['"', "'"],
  tripleQuotes: [],
  regexLiterals: false,
  nesting: 'braces',
  branchWords: ['if', 'for', 'while', 'case', 'catch'],
  branchSymbols: /&&|\|\||\?\?|\?(?![?.:=])/g,
  functionPatterns: [BRACE_METHOD],
};

const KOTLIN: SyntaxProfile = {
  ...C_FAMILY,
  tripleQuotes: ['"""'],
  branchWords: ['if', 'for', 'while', 'when', 'catch'],
  functionPatterns: [/\bfun\s+[A-Za-z_`]/g],
};

const SWIFT: SyntaxProfile = {
  ...C_FAMILY,
  tripleQuotes: ['"""'],
  branchWords: ['if', 'for', 'while', 'case', 'catch', 'guard'],
  functionPatterns: [/\bfunc\s+[A-Za-z_]/g],
};

const EXTENSION_SYNTAX: Readonly<Record<string, SyntaxProfile>> = {
  ts: JS_TS,
  tsx: JS_TS,
  mts: JS_TS,
  cts: JS_TS,
  js: JS_TS,
  jsx: JS_TS,
  mjs: JS_TS,
  cjs: JS_TS,
  vue: JS_TS,
  svelte: JS_TS,
  astro: JS_TS,
  py: PYTHON,
  pyi: PYTHON,
  go: GO,
  rs: RUST,
  rb: RUBY,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: SHELL,
  php: PHP,
  kt: KOTLIN,
  kts: KOTLIN,
  swift: SWIFT,
};

const FILENAME_SYNTAX: Readonly<Record<string, SyntaxProfile>> = {
  dockerfile: SHELL,
  makefile: SHELL,
  rakefile: RUBY,
  gemfile: RUBY,
  brewfile: RUBY,
};

/** Resolve the lexical profile for a path, defaulting to the C family. */
function syntaxFor(path: string): SyntaxProfile {
  const base = basename(path).toLowerCase();
  const byName = FILENAME_SYNTAX[base];
  if (byName) return byName;

  const stemName = base.split('.')[0] ?? '';
  const byStem = FILENAME_SYNTAX[stemName];
  if (byStem && base.startsWith(`${stemName}.`)) return byStem;

  return EXTENSION_SYNTAX[extensionOf(path)] ?? C_FAMILY;
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/** One entry per input line: code with comments/strings blanked, plus the comment text. */
export interface MaskedSource {
  /**
   * The line with every comment and string interior replaced by spaces. Column
   * positions are preserved so indentation-based nesting still works.
   */
  readonly code: readonly string[];
  /** Concatenated comment/docstring text found on that line, or `''`. */
  readonly comments: readonly string[];
}

/** Characters after which a `/` opens a regular expression rather than dividing. */
const REGEX_PRECEDERS = new Set([
  '',
  '=',
  '(',
  ',',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  '<',
  '>',
]);

/** Keywords after which a `/` opens a regular expression. */
const REGEX_PRECEDING_WORD = /\b(?:return|typeof|case|in|of|delete|void|yield|await|do|else)$/;

function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

/**
 * Blank out comments and string literals, keeping the file's shape intact.
 *
 * Single pass, no backtracking, state carried across lines for block comments and
 * triple-quoted strings. Escapes consume two characters so `"\\"` does not leave
 * a dangling open quote.
 */
export function maskSource(content: string, path: string): MaskedSource {
  const syntax = syntaxFor(path);
  const lines = toLines(content);
  const code: string[] = [];
  const comments: string[] = [];

  let block: string | null = null;
  let triple: string | null = null;

  for (const line of lines) {
    let masked = '';
    let comment = '';
    let quote: string | null = null;
    let index = 0;

    while (index < line.length) {
      const char = line.charAt(index);

      if (block !== null) {
        if (line.startsWith(block, index)) {
          masked += ' '.repeat(block.length);
          index += block.length;
          block = null;
        } else {
          comment += char;
          masked += ' ';
          index += 1;
        }
        continue;
      }

      if (triple !== null) {
        if (line.startsWith(triple, index)) {
          masked += ' '.repeat(triple.length);
          index += triple.length;
          triple = null;
        } else {
          // Python docstrings are documentation, so they feed the comment
          // channel even though lexically they are strings.
          comment += char;
          masked += ' ';
          index += 1;
        }
        continue;
      }

      if (quote !== null) {
        if (char === '\\') {
          const take = Math.min(2, line.length - index);
          masked += ' '.repeat(take);
          index += take;
          continue;
        }
        if (line.startsWith(quote, index)) {
          masked += quote;
          index += quote.length;
          quote = null;
          continue;
        }
        masked += ' ';
        index += 1;
        continue;
      }

      const openTriple = syntax.tripleQuotes.find((token) => line.startsWith(token, index));
      if (openTriple !== undefined) {
        masked += ' '.repeat(openTriple.length);
        index += openTriple.length;
        triple = openTriple;
        continue;
      }

      const lineComment = syntax.lineComments.find((token) => line.startsWith(token, index));
      if (lineComment !== undefined) {
        comment += line.slice(index + lineComment.length);
        masked += ' '.repeat(line.length - index);
        index = line.length;
        continue;
      }

      const blockOpen = syntax.blockComments.find(([open]) => line.startsWith(open, index));
      if (blockOpen) {
        masked += ' '.repeat(blockOpen[0].length);
        index += blockOpen[0].length;
        block = blockOpen[1];
        continue;
      }

      if (syntax.regexLiterals && char === '/' && isRegexPosition(masked)) {
        const end = findRegexEnd(line, index);
        if (end > index) {
          masked += `/${' '.repeat(end - index - 1)}/`;
          index = end + 1;
          continue;
        }
      }

      const openQuote = syntax.quotes.find((token) => line.startsWith(token, index));
      if (openQuote !== undefined) {
        masked += openQuote;
        index += openQuote.length;
        quote = openQuote;
        continue;
      }

      masked += char;
      index += 1;
    }

    code.push(masked);
    comments.push(comment);
  }

  return { code, comments };
}

/** True when the code emitted so far leaves `/` in expression position. */
function isRegexPosition(masked: string): boolean {
  const trimmed = masked.trimEnd();
  if (trimmed === '') return true;
  if (REGEX_PRECEDING_WORD.test(trimmed)) return true;
  return REGEX_PRECEDERS.has(trimmed.charAt(trimmed.length - 1));
}

/**
 * Index of the `/` closing a regex started at `start`, or `-1` when the literal
 * does not terminate on this line (in which case the caller treats `/` as
 * division, which is the safe reading).
 */
function findRegexEnd(line: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < line.length; i++) {
    const char = line.charAt(i);
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
}

/** Cyclomatic complexity: one, plus every decision point in the masked code. */
function cyclomaticOf(code: string, syntax: SyntaxProfile): number {
  const words = new RegExp(`\\b(?:${syntax.branchWords.join('|')})\\b`, 'g');
  let total = 1 + countMatches(code, words);
  if (syntax.branchSymbols) total += countMatches(code, syntax.branchSymbols);
  return total;
}

function braceNesting(code: readonly string[]): number {
  let depth = 0;
  let max = 0;
  for (const line of code) {
    for (const char of line) {
      if (char === '{') {
        depth += 1;
        if (depth > max) max = depth;
      } else if (char === '}') {
        depth = Math.max(0, depth - 1);
      }
    }
  }
  return max;
}

/**
 * Indentation nesting for Python/Ruby/shell.
 *
 * A stack of open indentation levels mirrors what braces do elsewhere: the
 * module level is level 1 on the stack but nesting depth 0, so the result is
 * directly comparable with `braceNesting`.
 */
function indentNesting(code: readonly string[]): number {
  const stack: number[] = [];
  let max = 0;

  for (const line of code) {
    if (line.trim() === '') continue;
    const width = indentWidth(line);
    while (stack.length > 0 && (stack[stack.length - 1] ?? 0) >= width) stack.pop();
    stack.push(width);
    if (stack.length > max) max = stack.length;
  }

  return Math.max(0, max - 1);
}

/**
 * Count declarations, refusing to count the same span twice.
 *
 * Several JavaScript patterns legitimately overlap (`const f = function () {}`
 * is both an assignment and a `function` keyword), so matches are collected,
 * sorted, and consumed greedily left to right.
 */
function countFunctions(code: string, patterns: readonly RegExp[]): number {
  const spans: [number, number][] = [];

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const start = match.index ?? 0;
      spans.push([start, start + match[0].length]);
    }
  }

  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  let count = 0;
  let cursor = -1;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    count += 1;
    cursor = end;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Risk model
// ---------------------------------------------------------------------------

/**
 * Composite maintainability risk, 0–100.
 *
 * Three independent things make a file hard to work in, and they are weighted by
 * how strongly each one predicts "nobody wants to touch this":
 *
 * - **Size (0–40).** Ramps from 50 sloc (a file you can hold in your head) to
 *   600 sloc (a file nobody reads end to end before editing).
 * - **Branch density (0–40).** Cyclomatic complexity per 100 source lines, from
 *   5 (straight-line code) to 40 (a decision on every other line). Density —
 *   not raw complexity — is used so a large, simple file is not punished twice
 *   for its size. It is additionally scaled by `min(1, sloc/40)` because in a
 *   15-line file two `if`s produce a meaningless density spike.
 * - **Nesting (0–20).** From depth 2 (normal) to depth 8 (arrow anti-pattern).
 *
 * The weights are ordinal, not calibrated against an external corpus: the score
 * is for *ranking* files within one repository, which is what `hotspots` needs.
 */
function riskScoreOf(sloc: number, cyclomatic: number, maxNesting: number): number {
  const size = clamp((sloc - 50) / 550, 0, 1) * 40;

  const density = sloc > 0 ? (cyclomatic / sloc) * 100 : 0;
  const confidence = Math.min(1, sloc / 40);
  const branch = clamp((density - 5) / 35, 0, 1) * 40 * confidence;

  const nesting = clamp((maxNesting - 2) / 6, 0, 1) * 20;

  return Math.round(clamp(size + branch + nesting, 0, 100));
}

const COMPLEXITY_BUCKETS: readonly { readonly bucket: string; readonly limit: number }[] = [
  { bucket: '1-5', limit: 5 },
  { bucket: '6-10', limit: 10 },
  { bucket: '11-20', limit: 20 },
  { bucket: '21-50', limit: 50 },
  { bucket: '50+', limit: Number.POSITIVE_INFINITY },
];

const HOTSPOT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Measure every countable source file in the snapshot. */
export function analyzeComplexity(snapshot: RepoSnapshot): ComplexityReport {
  const files: FileComplexity[] = [];

  for (const file of snapshot.files) {
    if (file.isBinary || file.content === null) continue;
    if (!isCountableSource(file.path, file.content)) continue;

    files.push(measureFile(file.path, file.content));
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totalLoc = files.reduce((sum, file) => sum + file.loc, 0);
  const totalSloc = files.reduce((sum, file) => sum + file.sloc, 0);
  const totalCyclomatic = files.reduce((sum, file) => sum + file.cyclomatic, 0);

  const hotspots = [...files]
    .sort((a, b) => b.riskScore - a.riskScore || b.sloc - a.sloc || (a.path < b.path ? -1 : 1))
    .slice(0, HOTSPOT_LIMIT);

  return {
    files,
    totalLoc,
    totalSloc,
    averageComplexity:
      files.length === 0 ? 0 : Math.round((totalCyclomatic / files.length) * 10) / 10,
    hotspots,
    distribution: distributionOf(files),
  };
}

/** Measure one file. Exported shape matches `FileComplexity` exactly. */
function measureFile(path: string, content: string): FileComplexity {
  const syntax = syntaxFor(path);
  const { code } = maskSource(content, path);
  const joined = code.join('\n');

  const sloc = code.reduce((count, line) => (line.trim() === '' ? count : count + 1), 0);
  const cyclomatic = cyclomaticOf(joined, syntax);
  const maxNesting = syntax.nesting === 'indent' ? indentNesting(code) : braceNesting(code);
  const functions = countFunctions(joined, syntax.functionPatterns);

  return {
    path,
    loc: code.length,
    sloc,
    cyclomatic,
    maxNesting,
    functions,
    riskScore: riskScoreOf(sloc, cyclomatic, maxNesting),
  };
}

function distributionOf(
  files: readonly FileComplexity[],
): readonly { readonly bucket: string; readonly count: number }[] {
  return COMPLEXITY_BUCKETS.map((bucket, index) => {
    const lower = index === 0 ? 0 : (COMPLEXITY_BUCKETS[index - 1]?.limit ?? 0);
    const count = files.filter(
      (file) => file.cyclomatic > lower && file.cyclomatic <= bucket.limit,
    ).length;
    return { bucket: bucket.bucket, count };
  });
}
