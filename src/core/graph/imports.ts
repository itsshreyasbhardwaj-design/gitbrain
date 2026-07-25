/**
 * Import extraction.
 *
 * GitBrain deliberately does **not** depend on a real parser (Babel, tree-sitter,
 * the TypeScript compiler). Three reasons drove that call:
 *
 *  1. `src/core` must run unchanged in a browser, an edge runtime and Node. Every
 *     production-grade parser ships either native bindings or a multi-megabyte
 *     WASM blob, and we would need one *per language* — Python, Go, Rust, Ruby,
 *     PHP and the JVM family are all in scope.
 *  2. We only need edges, not semantics. An import graph cares about "which
 *     string does this file reference", which is a lexical question.
 *  3. A parser fails hard on a syntax error, and real repositories contain files
 *     that do not parse (work in progress, exotic dialects, custom decorators).
 *     A lexical scanner degrades gracefully: it simply finds fewer edges.
 *
 * The cost of that choice is false positives — the word `import` inside a comment
 * or a string literal. We pay it down with a real single-pass scanner that
 * understands each language's comment and string grammar. Comments are blanked
 * out (replaced with spaces, newlines preserved, so byte offsets and therefore
 * line numbers stay exact) and string-literal *ranges* are recorded. A candidate
 * match is rejected when it starts inside a recorded string range, which is what
 * kills `const doc = "import x from 'y'"` without also killing the specifier —
 * the specifier is itself a string, but the `import` keyword that anchors the
 * match is not.
 */

import { extensionOf } from '../shared/languages';

export interface ParsedImport {
  readonly specifier: string;
  readonly line: number;
  readonly kind: 'static' | 'dynamic' | 'require' | 'export-from' | 'type-only';
}

// ---------------------------------------------------------------------------
// Language families
// ---------------------------------------------------------------------------

/**
 * Import syntax clusters far more coarsely than language identity does: `.ts`,
 * `.jsx` and `.mjs` share one grammar, and `.java`/`.kt`/`.scala` share another.
 * Families keep the rule tables small.
 */
export type ImportFamily = 'js' | 'markup' | 'python' | 'go' | 'rust' | 'ruby' | 'php' | 'jvm';

type Family = ImportFamily;

const FAMILY_BY_EXTENSION: Readonly<Record<string, Family>> = {
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  vue: 'markup',
  svelte: 'markup',
  astro: 'markup',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  java: 'jvm',
  kt: 'jvm',
  kts: 'jvm',
  scala: 'jvm',
};

/** The import family for a repo-relative path, or `null` when unsupported. */
export function importFamily(path: string): Family | null {
  return FAMILY_BY_EXTENSION[extensionOf(path)] ?? null;
}

// ---------------------------------------------------------------------------
// Lexical masking
// ---------------------------------------------------------------------------

interface Dialect {
  /** Tokens that start a comment running to end of line. */
  readonly lineComments: readonly string[];
  /** Open/close pair for block comments, when the language has them. */
  readonly blockComment: readonly [string, string] | null;
  /** Delimiters for strings that terminate at the end of a line. */
  readonly quotes: readonly string[];
  /** Delimiters for strings that may span lines (template/raw strings). */
  readonly multilineQuotes: readonly string[];
  /** Python's `'''` / `"""`. */
  readonly triples: boolean;
  /** Whether a backslash escapes the next character inside a string. */
  readonly escapes: boolean;
  /** Whether `/…/` may be a regular-expression literal (JavaScript only). */
  readonly regexLiterals: boolean;
  /** Ruby's `=begin` / `=end` block comments. */
  readonly rubyBlockComment: boolean;
}

const JS_DIALECT: Dialect = {
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ["'", '"'],
  multilineQuotes: ['`'],
  triples: false,
  escapes: true,
  regexLiterals: true,
  rubyBlockComment: false,
};

const PYTHON_DIALECT: Dialect = {
  lineComments: ['#'],
  blockComment: null,
  quotes: ["'", '"'],
  multilineQuotes: [],
  triples: true,
  escapes: true,
  regexLiterals: false,
  rubyBlockComment: false,
};

const GO_DIALECT: Dialect = {
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ["'", '"'],
  multilineQuotes: ['`'],
  triples: false,
  escapes: true,
  regexLiterals: false,
  rubyBlockComment: false,
};

const CLIKE_DIALECT: Dialect = {
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: ["'", '"'],
  multilineQuotes: [],
  triples: false,
  escapes: true,
  regexLiterals: false,
  rubyBlockComment: false,
};

const PHP_DIALECT: Dialect = {
  lineComments: ['//', '#'],
  blockComment: ['/*', '*/'],
  quotes: ["'", '"'],
  multilineQuotes: [],
  triples: false,
  escapes: true,
  regexLiterals: false,
  rubyBlockComment: false,
};

const RUBY_DIALECT: Dialect = {
  lineComments: ['#'],
  blockComment: null,
  quotes: ["'", '"'],
  multilineQuotes: [],
  triples: false,
  escapes: true,
  regexLiterals: false,
  rubyBlockComment: true,
};

const DIALECTS: Readonly<Record<Family, Dialect>> = {
  js: JS_DIALECT,
  markup: JS_DIALECT,
  python: PYTHON_DIALECT,
  go: GO_DIALECT,
  rust: CLIKE_DIALECT,
  ruby: RUBY_DIALECT,
  php: PHP_DIALECT,
  jvm: CLIKE_DIALECT,
};

type Range = readonly [number, number];

interface MaskedSource {
  /** Same length as the input, with comment bodies replaced by spaces. */
  readonly masked: string;
  /** Ascending, non-overlapping spans covering every string literal. */
  readonly stringRanges: readonly Range[];
}

/**
 * Characters that may legally precede a regular-expression literal.
 *
 * JavaScript cannot be tokenized without this heuristic: `/` is either division
 * or the start of a regex depending on the *parser* state. We bias towards
 * "division" because misreading division as a regex would swallow real code,
 * whereas misreading a regex as division merely advances one character.
 */
const REGEX_PRECEDERS: ReadonlySet<string> = new Set([
  '',
  '(',
  ',',
  '=',
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
  '~',
  '^',
  '<',
  '>',
]);

/**
 * Blank out comments and record string-literal spans in one pass.
 *
 * Comment bodies become spaces rather than being deleted so that every later
 * offset still maps to the original line, which is what makes the reported line
 * numbers trustworthy.
 */
function maskSource(content: string, dialect: Dialect): MaskedSource {
  const chars = content.split('');
  const ranges: Range[] = [];

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < chars.length; k++) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
  };

  let i = 0;
  let atLineStart = true;
  let previous = '';

  while (i < content.length) {
    const ch = content.charAt(i);

    if (dialect.rubyBlockComment && atLineStart && content.startsWith('=begin', i)) {
      const marker = content.indexOf('\n=end', i);
      let end = content.length;
      if (marker !== -1) {
        const eol = content.indexOf('\n', marker + 1);
        end = eol === -1 ? content.length : eol;
      }
      blank(i, end);
      i = end;
      continue;
    }

    const lineComment = dialect.lineComments.find((token) => content.startsWith(token, i));
    if (lineComment) {
      const eol = content.indexOf('\n', i);
      const end = eol === -1 ? content.length : eol;
      blank(i, end);
      i = end;
      atLineStart = false;
      continue;
    }

    const block = dialect.blockComment;
    if (block && content.startsWith(block[0], i)) {
      const close = content.indexOf(block[1], i + block[0].length);
      const end = close === -1 ? content.length : close + block[1].length;
      blank(i, end);
      i = end;
      atLineStart = false;
      continue;
    }

    if (dialect.triples && (content.startsWith('"""', i) || content.startsWith("'''", i))) {
      const delimiter = content.slice(i, i + 3);
      const close = content.indexOf(delimiter, i + 3);
      const end = close === -1 ? content.length : close + 3;
      ranges.push([i, end]);
      i = end;
      atLineStart = false;
      continue;
    }

    if (dialect.quotes.includes(ch) || dialect.multilineQuotes.includes(ch)) {
      const multiline = dialect.multilineQuotes.includes(ch);
      const start = i;
      i++;
      while (i < content.length) {
        const c = content.charAt(i);
        if (dialect.escapes && c === '\\') {
          i += 2;
          continue;
        }
        if (c === ch) {
          i++;
          break;
        }
        // An unterminated single-line string must not swallow the rest of the
        // file — apostrophes appear in prose far more often than in code.
        if (c === '\n' && !multiline) break;
        i++;
      }
      ranges.push([start, i]);
      previous = ch;
      atLineStart = false;
      continue;
    }

    if (dialect.regexLiterals && ch === '/' && REGEX_PRECEDERS.has(previous)) {
      const end = scanRegexLiteral(content, i);
      if (end !== null) {
        ranges.push([i, end]);
        i = end;
        previous = '/';
        atLineStart = false;
        continue;
      }
    }

    if (ch === '\n') {
      atLineStart = true;
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      atLineStart = false;
      previous = ch;
    }
    i++;
  }

  return { masked: chars.join(''), stringRanges: ranges };
}

/**
 * End offset of a regex literal beginning at `start`, or `null` when the slash
 * is really a division operator (no closing slash before the line ends).
 */
function scanRegexLiteral(content: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;

  while (i < content.length) {
    const c = content.charAt(i);
    if (c === '\n') return null;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i++;
      // Consume trailing flags so `previous` lands on a letter, not `/`.
      while (i < content.length && /[a-z]/i.test(content.charAt(i))) i++;
      return i;
    }
    i++;
  }

  return null;
}

/** Binary-search predicate: does `offset` fall inside any recorded string? */
function makeStringGuard(ranges: readonly Range[]): (offset: number) => boolean {
  return (offset) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const range = ranges[mid];
      if (!range) return false;
      if (offset < range[0]) hi = mid - 1;
      else if (offset >= range[1]) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

/**
 * Offset -> 1-indexed line, in O(log n) per lookup.
 *
 * `lineAtOffset` in `shared/text` is O(offset); a file with hundreds of imports
 * would make repeated calls quadratic, so the graph layer precomputes instead.
 */
function makeLineLookup(content: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1);
  }

  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * Accumulates results while enforcing the two cross-language invariants:
 * specifiers are non-empty, and `(specifier, line)` pairs are unique.
 *
 * Deduplication matters because several patterns legitimately overlap — a line
 * such as `export { x } from './a'` is reachable from more than one rule, and a
 * single `require()` inside an `import()` wrapper would otherwise double-count.
 */
class ImportCollector {
  private readonly seen = new Set<string>();
  private readonly items: ParsedImport[] = [];

  add(specifier: string, line: number, kind: ParsedImport['kind']): void {
    const trimmed = specifier.trim();
    if (!trimmed) return;

    const key = `${trimmed} ${line}`;
    if (this.seen.has(key)) return;

    this.seen.add(key);
    this.items.push({ specifier: trimmed, line, kind });
  }

  result(): ParsedImport[] {
    return this.items.slice().sort((a, b) => a.line - b.line);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extract every module reference from `content`, with 1-indexed line numbers.
 *
 * Returns an empty array for languages GitBrain does not model, which keeps
 * callers free of language checks.
 */
export function parseImports(path: string, content: string): ParsedImport[] {
  const family = importFamily(path);
  if (!family || !content) return [];

  const collector = new ImportCollector();

  // Markup single-file components carry ordinary JavaScript inside `<script>`
  // (and, for Astro, a leading `---` frontmatter fence). We blank everything
  // outside those regions rather than slicing them out, so offsets — and hence
  // line numbers — remain those of the original file.
  const source = family === 'markup' ? isolateScriptRegions(content) : content;

  const dialect = DIALECTS[family];
  const { masked, stringRanges } = maskSource(source, dialect);
  const inString = makeStringGuard(stringRanges);
  const lineAt = makeLineLookup(content);

  switch (family) {
    case 'js':
    case 'markup':
      collectJs(masked, collector, inString, lineAt);
      break;
    case 'python':
      collectPython(masked, collector, inString, lineAt);
      break;
    case 'go':
      collectGo(masked, collector, lineAt);
      break;
    case 'rust':
      collectRust(masked, collector, inString, lineAt);
      break;
    case 'ruby':
      collectRuby(masked, collector, inString, lineAt);
      break;
    case 'php':
      collectPhp(masked, collector, inString, lineAt);
      break;
    case 'jvm':
      collectJvm(masked, collector, inString, lineAt);
      break;
  }

  return collector.result();
}

type Guard = (offset: number) => boolean;
type LineAt = (offset: number) => number;

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------

const SCRIPT_OPEN = /<script\b[^>]*>/gi;
const ASTRO_FRONTMATTER = /^\s*---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Blank everything that is not executable script in a `.vue`/`.svelte`/`.astro`
 * file. Template markup routinely contains the words `import` and `require`
 * inside attribute strings, and Astro templates embed arbitrary prose.
 */
function isolateScriptRegions(content: string): string {
  const chars = new Array<string>(content.length);
  for (let i = 0; i < content.length; i++) {
    const ch = content.charAt(i);
    chars[i] = ch === '\n' ? '\n' : ' ';
  }

  const keep = (from: number, to: number): void => {
    for (let i = from; i < to && i < content.length; i++) chars[i] = content.charAt(i);
  };

  const frontmatter = ASTRO_FRONTMATTER.exec(content);
  if (frontmatter && frontmatter[1] !== undefined) {
    const body = frontmatter[1];
    const start = content.indexOf(body, frontmatter.index);
    if (start !== -1) keep(start, start + body.length);
  }

  SCRIPT_OPEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_OPEN.exec(content)) !== null) {
    const bodyStart = match.index + match[0].length;
    const close = content.toLowerCase().indexOf('</script', bodyStart);
    const bodyEnd = close === -1 ? content.length : close;
    keep(bodyStart, bodyEnd);
    SCRIPT_OPEN.lastIndex = bodyEnd;
  }

  return chars.join('');
}

/**
 * `import` with an optional `type` modifier, an optional binding clause and a
 * mandatory string specifier. The binding clause character set is deliberately
 * narrow (identifiers, `*`, braces, commas, whitespace) so that a stray
 * `import` keyword cannot scan across statement boundaries.
 */
const JS_IMPORT =
  /\bimport(?![\w$])\s*(?:(type)\s+)?(?:([A-Za-z0-9_$*{},\s]+?)\s*from\s*)?(['"])([^'"\n]+)\3/g;
const JS_DYNAMIC = /\bimport\s*\(\s*(['"])([^'"\n]+)\1/g;
const JS_REQUIRE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1/g;
const JS_EXPORT_FROM =
  /\bexport\s+(?:(type)\s+)?(?:\*(?:\s+as\s+[A-Za-z0-9_$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g;

function collectJs(masked: string, out: ImportCollector, inString: Guard, lineAt: LineAt): void {
  for (const match of matchAll(JS_IMPORT, masked, inString)) {
    const specifier = match[4];
    if (specifier === undefined) continue;
    out.add(specifier, lineAt(match.index), match[1] ? 'type-only' : 'static');
  }

  for (const match of matchAll(JS_DYNAMIC, masked, inString)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    out.add(specifier, lineAt(match.index), 'dynamic');
  }

  for (const match of matchAll(JS_REQUIRE, masked, inString)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    out.add(specifier, lineAt(match.index), 'require');
  }

  for (const match of matchAll(JS_EXPORT_FROM, masked, inString)) {
    const specifier = match[3];
    if (specifier === undefined) continue;
    out.add(specifier, lineAt(match.index), match[1] ? 'type-only' : 'export-from');
  }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/** `import a.b`, `import a.b as c`, `import a, b` — everything after the keyword. */
const PY_IMPORT = /^[ \t]*import[ \t]+([^\n#]+)/gm;

/**
 * `from a.b import c`, `from . import x`, `from ..pkg import y`.
 *
 * The leading dots are part of the specifier: they encode *how many package
 * levels up* the target lives, and dropping them would make `from . import x`
 * indistinguishable from an absolute import of a top-level package.
 */
const PY_FROM = /^[ \t]*from[ \t]+(\.*[A-Za-z_][\w.]*|\.+)[ \t]+import\b/gm;

function collectPython(
  masked: string,
  out: ImportCollector,
  inString: Guard,
  lineAt: LineAt,
): void {
  for (const match of matchAll(PY_FROM, masked, inString, leadingWhitespace)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    out.add(specifier, lineAt(match.index), 'static');
  }

  for (const match of matchAll(PY_IMPORT, masked, inString, leadingWhitespace)) {
    const clause = match[1];
    if (clause === undefined) continue;
    const line = lineAt(match.index);
    for (const part of clause.split(',')) {
      const name =
        part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim() ?? '';
      if (/^[.\w]+$/.test(name)) out.add(name, line, 'static');
    }
  }
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_SINGLE = /^[ \t]*import[ \t]+(?:[A-Za-z0-9_.]+[ \t]+)?"([^"]+)"/;
const GO_GROUP_OPEN = /^[ \t]*import[ \t]*\(/;
const GO_GROUP_ENTRY = /^[ \t]*(?:[A-Za-z0-9_.]+[ \t]+)?"([^"]+)"/;

/**
 * Go is handled line-by-line rather than with a global regex because grouped
 * imports are a *block* construct: the same `"path"` line means "an import"
 * inside `import ( … )` and "a string expression" anywhere else.
 */
function collectGo(masked: string, out: ImportCollector, lineAt: LineAt): void {
  const lines = masked.split('\n');
  let offset = 0;
  let inGroup = false;

  for (const line of lines) {
    if (inGroup) {
      if (/^[ \t]*\)/.test(line)) {
        inGroup = false;
      } else {
        const entry = GO_GROUP_ENTRY.exec(line);
        if (entry?.[1] !== undefined) out.add(entry[1], lineAt(offset), 'static');
      }
    } else if (GO_GROUP_OPEN.test(line)) {
      inGroup = true;
      // `import ( "fmt"` on one line is legal, if unusual.
      const inline = GO_GROUP_ENTRY.exec(line.slice(line.indexOf('(') + 1));
      if (inline?.[1] !== undefined) out.add(inline[1], lineAt(offset), 'static');
    } else {
      const single = GO_SINGLE.exec(line);
      if (single?.[1] !== undefined) out.add(single[1], lineAt(offset), 'static');
    }

    offset += line.length + 1;
  }
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

/** `use a::b::c;`, `pub use …`, `pub(crate) use …`; the body may span lines. */
const RS_USE = /^[ \t]*(?:pub(?:[ \t]*\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm;
/** `mod x;` declares a sibling file; `mod x { … }` does not and is excluded. */
const RS_MOD = /^[ \t]*(?:pub(?:[ \t]*\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm;

function collectRust(masked: string, out: ImportCollector, inString: Guard, lineAt: LineAt): void {
  for (const match of matchAll(RS_USE, masked, inString, leadingWhitespace)) {
    const raw = match[1];
    if (raw === undefined) continue;
    out.add(normalizeRustPath(raw), lineAt(match.index), 'static');
  }

  for (const match of matchAll(RS_MOD, masked, inString, leadingWhitespace)) {
    const name = match[1];
    if (name === undefined) continue;
    out.add(name, lineAt(match.index), 'static');
  }
}

/**
 * Reduce a `use` body to the module path it hangs off.
 *
 * `a::b::{c, d}` -> `a::b`, `a::b as c` -> `a::b`. The imported *items* are
 * irrelevant to a module graph; only the owning module is an edge target.
 */
function normalizeRustPath(raw: string): string {
  let path = raw.trim();
  const brace = path.indexOf('{');
  if (brace !== -1) path = path.slice(0, brace);
  path = path.split(/\s+as\s+/)[0] ?? path;
  return path.replace(/\s+/g, '').replace(/::$/, '');
}

// ---------------------------------------------------------------------------
// Ruby / PHP / JVM
// ---------------------------------------------------------------------------

const RB_REQUIRE = /\brequire(?:_relative)?[ \t]*\(?[ \t]*(['"])([^'"\n]+)\1/g;

function collectRuby(masked: string, out: ImportCollector, inString: Guard, lineAt: LineAt): void {
  for (const match of matchAll(RB_REQUIRE, masked, inString)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    out.add(specifier, lineAt(match.index), 'require');
  }
}

/**
 * `use App\Models\User;` — anchored to a line start so that the *other* PHP
 * `use`, the closure capture `function () use ($x)`, cannot match.
 */
const PHP_USE =
  /^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?([A-Za-z_\\][\w\\]*)(?:[ \t]+as[ \t]+\w+)?[ \t]*;/gm;
const PHP_REQUIRE =
  /\b(?:require|require_once|include|include_once)[ \t]*\(?[ \t]*(['"])([^'"\n]+)\1/g;

function collectPhp(masked: string, out: ImportCollector, inString: Guard, lineAt: LineAt): void {
  for (const match of matchAll(PHP_USE, masked, inString, leadingWhitespace)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    out.add(specifier.replace(/^\\/, ''), lineAt(match.index), 'static');
  }

  for (const match of matchAll(PHP_REQUIRE, masked, inString)) {
    const specifier = match[2];
    if (specifier === undefined) continue;
    out.add(specifier, lineAt(match.index), 'require');
  }
}

const JVM_IMPORT =
  /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.*]+)(?:[ \t]+as[ \t]+\w+)?[ \t]*;?[ \t]*$/gm;

function collectJvm(masked: string, out: ImportCollector, inString: Guard, lineAt: LineAt): void {
  for (const match of matchAll(JVM_IMPORT, masked, inString, leadingWhitespace)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    out.add(specifier, lineAt(match.index), 'static');
  }
}

// ---------------------------------------------------------------------------
// Match plumbing
// ---------------------------------------------------------------------------

/** Number of leading spaces/tabs — where the keyword actually starts. */
function leadingWhitespace(text: string): number {
  const match = /^[ \t]*/.exec(text);
  return match ? match[0].length : 0;
}

/**
 * Run a global regex, dropping matches whose *keyword* sits inside a string
 * literal, and hand back a plain array so callers never touch `lastIndex`.
 *
 * `keywordOffset` exists for line-anchored patterns: their match index points
 * at the start of the line, which may be indentation rather than the keyword,
 * and the string-literal test must be applied to the keyword itself.
 */
function matchAll(
  pattern: RegExp,
  content: string,
  inString: Guard,
  keywordOffset: (text: string) => number = () => 0,
): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    // A zero-length match would loop forever; defend explicitly.
    if (match[0].length === 0) {
      pattern.lastIndex++;
      continue;
    }
    if (!inString(match.index + keywordOffset(match[0]))) results.push(match);
  }

  pattern.lastIndex = 0;
  return results;
}
