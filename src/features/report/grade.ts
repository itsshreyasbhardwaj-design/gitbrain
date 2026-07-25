import type { Severity } from '@/core/types';

/**
 * Shared score/severity presentation.
 *
 * Centralised so a 72 is the same colour on the overview card, the health
 * gauge and the security panel. Inconsistent colour on the same number is the
 * fastest way to make a dashboard feel untrustworthy.
 */

export type Tone = 'good' | 'fair' | 'warn' | 'bad' | 'critical' | 'neutral';

export function scoreTone(score: number): Tone {
  if (score >= 85) return 'good';
  if (score >= 70) return 'fair';
  if (score >= 55) return 'warn';
  if (score >= 35) return 'bad';
  return 'critical';
}

export function severityTone(severity: Severity): Tone {
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'bad';
    case 'medium':
      return 'warn';
    case 'low':
      return 'fair';
    case 'info':
      return 'neutral';
  }
}

/** Text colour class per tone. */
export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-good',
  fair: 'text-fair',
  warn: 'text-warn',
  bad: 'text-bad',
  critical: 'text-critical',
  neutral: 'text-ink-subtle',
};

/** Fill colour, as a CSS variable reference for SVG and inline styles. */
export const TONE_VAR: Record<Tone, string> = {
  good: 'var(--color-good)',
  fair: 'var(--color-fair)',
  warn: 'var(--color-warn)',
  bad: 'var(--color-bad)',
  critical: 'var(--color-critical)',
  neutral: 'var(--color-ink-subtle)',
};

/** Soft background + border pairing per tone. */
export const TONE_SURFACE: Record<Tone, string> = {
  good: 'bg-good/10 border-good/25',
  fair: 'bg-fair/10 border-fair/25',
  warn: 'bg-warn/10 border-warn/25',
  bad: 'bg-bad/10 border-bad/25',
  critical: 'bg-critical/12 border-critical/30',
  neutral: 'bg-surface border-line',
};

export function gradeTone(grade: string): Tone {
  switch (grade) {
    case 'A':
      return 'good';
    case 'B':
      return 'fair';
    case 'C':
      return 'warn';
    case 'D':
      return 'bad';
    default:
      return 'critical';
  }
}

/** Compact byte formatting, e.g. `1.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Thousands-separated integer. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** `1.2s` / `840ms`, for the analysis timing footnote. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
