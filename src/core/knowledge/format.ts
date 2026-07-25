/**
 * Markdown rendering primitives for the knowledge engine.
 *
 * Every knowledge document is GitHub-flavoured Markdown assembled from these
 * helpers rather than from template literals sprinkled through the generators.
 * Centralising it buys three things that matter: tables never come out ragged,
 * cell contents are always pipe-escaped, and numbers are formatted identically
 * in all eighteen documents.
 *
 * Nothing here knows anything about repositories — it is pure presentation.
 */

import type { Citation, KnowledgeDoc, KnowledgeDocId, Severity } from '../types';

// ---------------------------------------------------------------------------
// Block-level Markdown
// ---------------------------------------------------------------------------

/** ATX heading, clamped to the six levels Markdown actually has. */
export function heading(level: number, text: string): string {
  const clamped = Math.min(6, Math.max(1, Math.round(level)));
  return `${'#'.repeat(clamped)} ${text.trim()}`;
}

/** Escape a value so it cannot break out of a table cell. */
export function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * GFM table. Rows shorter than the header are padded, longer rows are cut, so
 * a generator bug can never produce a table the renderer refuses to parse.
 */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (headers.length === 0) return '';

  const head = `| ${headers.map(escapeCell).join(' | ')} |`;
  const rule = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => {
    const cells = headers.map((_, index) => escapeCell(row[index] ?? ''));
    return `| ${cells.join(' | ')} |`;
  });

  return [head, rule, ...body].join('\n');
}

/** Unordered list. Blank items are dropped rather than rendered as empty bullets. */
export function bulletList(items: readonly string[]): string {
  return items
    .filter((item) => item.trim().length > 0)
    .map((item) => `- ${item.trim()}`)
    .join('\n');
}

/** Ordered list, renumbered from 1 regardless of input. */
export function numberedList(items: readonly string[]): string {
  return items
    .filter((item) => item.trim().length > 0)
    .map((item, index) => `${index + 1}. ${item.trim()}`)
    .join('\n');
}

/** Fenced code block. Pass `''` for an unlabelled fence. */
export function codeBlock(lang: string, code: string): string {
  return `\`\`\`${lang}\n${code.replace(/\s+$/, '')}\n\`\`\``;
}

/** A Mermaid diagram, which the UI renders natively from a `mermaid` fence. */
export function mermaid(diagram: string): string {
  return codeBlock('mermaid', diagram);
}

/** Blockquote, used for caveats about what static analysis can and cannot see. */
export function note(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

/** Join document sections with exactly one blank line, dropping empty ones. */
export function section(...parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Inline Markdown
// ---------------------------------------------------------------------------

/** Inline code span with backticks in the value neutralised. */
export function code(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

/**
 * A `path:line` reference rendered as inline code.
 *
 * The UI turns these into the same clickable chips as `Citation`s, so use it
 * whenever prose mentions a location and pair it with a real citation.
 */
export function fileRef(file: string, startLine?: number, endLine?: number): string {
  if (typeof startLine !== 'number' || !Number.isFinite(startLine) || startLine <= 0) {
    return code(file);
  }
  if (typeof endLine === 'number' && Number.isFinite(endLine) && endLine > startLine) {
    return code(`${file}:${startLine}-${endLine}`);
  }
  return code(`${file}:${startLine}`);
}

// ---------------------------------------------------------------------------
// Numbers and words
// ---------------------------------------------------------------------------

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Human byte size, e.g. `18.4 KB`. Never returns `NaN` or `Infinity`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const label = BYTE_UNITS[unit] ?? 'B';
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${label}`;
}

/**
 * Thousands-separated number, rounded to one decimal place.
 *
 * Hand-rolled rather than `toLocaleString` so output is byte-identical in every
 * runtime and locale — knowledge documents are snapshot-tested.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';

  const rounded = Math.round(value * 10) / 10;
  const negative = rounded < 0;
  const absolute = Math.abs(rounded);
  const whole = Math.floor(absolute);
  const decimal = Math.round((absolute - whole) * 10);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = decimal > 0 && decimal < 10 ? `${grouped}.${decimal}` : grouped;

  return negative ? `-${text}` : text;
}

/** The correct noun form for a count. Returns the word only, never the number. */
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/** `3 files` / `1 file` — the common pairing of `formatNumber` and `pluralize`. */
export function countLabel(count: number, singular: string, plural?: string): string {
  return `${formatNumber(count)} ${pluralize(count, singular, plural)}`;
}

/** Percentage of `total`, rendered with at most one decimal. */
export function formatPercent(part: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0%';
  return `${formatNumber((part / total) * 100)}%`;
}

/** Oxford-comma list: `a`, `a and b`, `a, b and c`. */
export function joinWords(words: readonly string[], conjunction = 'and'): string {
  const items = words.filter((word) => word.trim().length > 0);
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  const head = items.slice(0, -1).join(', ');
  return `${head} ${conjunction} ${items[items.length - 1] ?? ''}`;
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Sort key: 0 for `critical` through 4 for `info`. */
export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/** Title-cased severity for table cells. */
export function severityLabel(severity: Severity): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/**
 * Make arbitrary text safe as a Mermaid node label.
 *
 * Mermaid's parser is unforgiving about quotes, brackets and semicolons inside
 * labels, and long labels wreck the layout, so labels are stripped and clipped.
 * Callers still wrap the result in quotes: `id["label"]`.
 */
export function mermaidLabel(text: string, maxLength = 28): string {
  const cleaned = text
    .replace(/["`]/g, '')
    .replace(/[[\]{}()<>|;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return 'unnamed';
  if (cleaned.length <= maxLength) return cleaned;
  return `…${cleaned.slice(cleaned.length - (maxLength - 1))}`;
}

/** A collision-free Mermaid identifier. Mermaid ids must not contain symbols. */
export function mermaidId(prefix: string, index: number): string {
  return `${prefix.replace(/[^a-zA-Z]/g, '')}${index}`;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Build a `Citation`.
 *
 * Optional fields are omitted rather than set to `undefined` so serialized
 * analyses stay compact and comparisons stay simple.
 */
export function citation(
  file: string,
  startLine?: number,
  endLine?: number,
  excerpt?: string,
): Citation {
  const built: {
    file: string;
    startLine?: number;
    endLine?: number;
    excerpt?: string;
  } = { file };

  if (typeof startLine === 'number' && Number.isFinite(startLine) && startLine > 0) {
    built.startLine = Math.round(startLine);
    if (typeof endLine === 'number' && Number.isFinite(endLine) && endLine >= startLine) {
      built.endLine = Math.round(endLine);
    }
  }
  if (typeof excerpt === 'string' && excerpt.trim().length > 0) {
    built.excerpt = excerpt.trim();
  }

  return built;
}

/** Assemble a deterministic, derived knowledge document. */
export function makeDoc(
  id: KnowledgeDocId,
  title: string,
  summary: string,
  markdown: string,
  citations: readonly Citation[],
): KnowledgeDoc {
  return {
    id,
    title,
    summary: summary.trim(),
    markdown: markdown.trim(),
    citations,
    provenance: 'derived',
  };
}
