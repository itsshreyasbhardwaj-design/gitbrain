/**
 * Text primitives shared by the analyzers: entropy, tokenization, hashing,
 * line handling and redaction.
 *
 * Pure and dependency-free so they can be unit-tested exhaustively.
 */

/** Shannon entropy in bits per character. Used to grade secret candidates. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * FNV-1a 32-bit, rendered as 8 hex chars.
 *
 * Not cryptographic. Used for duplicate-block identity and stable element ids,
 * where speed and determinism matter and collisions are cheap to tolerate.
 */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Split into lines, tolerating CRLF and a trailing newline. */
export function toLines(content: string): string[] {
  return content.split(/\r?\n/);
}

/** 1-indexed line number containing the given character offset. */
export function lineAtOffset(content: string, offset: number): number {
  let line = 1;
  const limit = Math.min(offset, content.length);
  for (let i = 0; i < limit; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

const IDENTIFIER_SPLIT = /[^A-Za-z0-9_$]+/;

/**
 * Tokenize source or prose into lowercase search terms.
 *
 * camelCase and snake_case identifiers are additionally split into their parts,
 * so a query for "user" matches `getUserProfile`. The original identifier is
 * kept too, so an exact query still outranks a partial one.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const raw of text.split(IDENTIFIER_SPLIT)) {
    if (raw.length < 2) continue;
    const lower = raw.toLowerCase();
    tokens.push(lower);

    for (const part of splitIdentifier(raw)) {
      if (part.length >= 2 && part !== lower) tokens.push(part);
    }
  }

  return tokens;
}

/** Split `getUserByID` / `get_user_by_id` into lowercase parts. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_$-]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/** English stop words, plus terms so common in code they carry no signal. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'for',
  'while',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'as',
  'with',
  'from',
  'into',
  'about',
  'how',
  'what',
  'where',
  'when',
  'which',
  'who',
  'why',
  'does',
  'do',
  'did',
  'can',
  'const',
  'let',
  'var',
  'function',
  'return',
  'import',
  'export',
  'default',
  'from',
  'new',
  'class',
  'extends',
  'public',
  'private',
  'protected',
  'static',
  'void',
  'null',
  'undefined',
  'true',
  'false',
  'type',
  'interface',
]);

/** Tokenize and drop stop words. Used for indexing and for queries alike. */
export function tokenizeForSearch(text: string): string[] {
  return tokenize(text).filter((token) => !STOP_WORDS.has(token));
}

/**
 * Redact a credential for display.
 *
 * Keeps a 4-character prefix so a human can recognise which key it is, and
 * nothing else. GitBrain never persists or renders a usable secret.
 */
export function redact(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '****';
  return `${trimmed.slice(0, 4)}${'*'.repeat(Math.min(trimmed.length - 4, 24))}`;
}

/** Collapse runs of whitespace so snippets render on one line. */
export function squish(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Truncate on a word boundary, appending an ellipsis when shortened. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cut = value.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Normalize a line for duplicate detection: strip comments, string contents
 * and whitespace so that cosmetically different clones still hash equal.
 */
export function normalizeForDuplication(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/#.*$/, '')
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Percentage helper that never returns NaN or Infinity. */
export function percent(part: number, total: number): number {
  if (!total || !Number.isFinite(total)) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/** Clamp into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
