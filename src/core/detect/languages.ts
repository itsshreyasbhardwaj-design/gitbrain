/**
 * Language breakdown.
 *
 * The breakdown drives the headline chart, the treemap colours and the
 * "primary language" badge, so it has to agree with what a developer would say
 * the repo is written in — not with a raw file count. Two decisions follow from
 * that:
 *
 *   1. We weight by **bytes**, not by file count. A repo with 400 tiny barrel
 *      files and 20 large Python modules is a Python repo, and byte weighting
 *      is what GitHub Linguist does, so the numbers match user expectations.
 *   2. We exclude **vendored** trees. Checked-in `vendor/` or `third_party/`
 *      code is not the repository's own work and would otherwise swamp it.
 *
 * Binary files are excluded because they have no language and their sizes
 * (images, fonts, sample datasets) are large enough to distort every share.
 */

import type { LanguageBreakdown, RepoFile } from '../types';
import { detectLanguage } from '../shared/languages';
import { isVendored } from '../shared/classify';

interface Bucket {
  language: string;
  color: string;
  files: number;
  bytes: number;
}

/**
 * Aggregate per-language byte and file totals, sorted by bytes descending.
 *
 * `percent` values are rounded to one decimal and then reconciled against 100
 * by absorbing the rounding residual into the largest bucket. Without that
 * step a repo with three near-equal languages renders as 99.9% or 100.1%,
 * which looks like a bug in a pie chart even though it is only rounding.
 */
export function computeLanguages(files: readonly RepoFile[]): LanguageBreakdown[] {
  const buckets = new Map<string, Bucket>();
  let total = 0;

  for (const file of files) {
    if (file.isBinary) continue;
    if (isVendored(file.path)) continue;

    const definition = detectLanguage(file.path);
    const existing = buckets.get(definition.name);

    if (existing) {
      existing.files += 1;
      existing.bytes += file.size;
    } else {
      buckets.set(definition.name, {
        language: definition.name,
        color: definition.color,
        files: 1,
        bytes: file.size,
      });
    }

    total += file.size;
  }

  // Sort by bytes, then alphabetically. The name tie-break keeps the output
  // stable for repos where several languages weigh exactly the same, which
  // matters because snapshots of this array end up in stored analyses.
  const ordered = [...buckets.values()].sort(
    (a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language),
  );

  if (ordered.length === 0) return [];

  const percents = ordered.map((bucket) =>
    total > 0 ? Math.round((bucket.bytes / total) * 1000) / 10 : 0,
  );

  // A repo of exclusively empty files has no bytes to divide, so shares are
  // meaningless; spread 100 evenly rather than emitting a column of zeroes.
  if (total === 0) {
    const even = Math.round((100 / ordered.length) * 10) / 10;
    for (let i = 0; i < percents.length; i++) percents[i] = even;
  }

  reconcileToHundred(percents);

  return ordered.map((bucket, index) => ({
    language: bucket.language,
    files: bucket.files,
    bytes: bucket.bytes,
    percent: percents[index] ?? 0,
    color: bucket.color,
  }));
}

/**
 * Push the rounding residual into the largest share.
 *
 * The largest bucket is chosen because a ±0.1 adjustment is proportionally
 * least visible there; applying it to a 0.1% tail language could double or
 * erase that language's slice.
 */
function reconcileToHundred(percents: number[]): void {
  if (percents.length === 0) return;

  const sum = percents.reduce((acc, value) => acc + value, 0);
  const residual = Math.round((100 - sum) * 10) / 10;
  if (residual === 0) return;

  let largestIndex = 0;
  for (let i = 1; i < percents.length; i++) {
    if ((percents[i] ?? 0) > (percents[largestIndex] ?? 0)) largestIndex = i;
  }

  const adjusted = Math.round(((percents[largestIndex] ?? 0) + residual) * 10) / 10;
  percents[largestIndex] = Math.max(0, adjusted);
}
