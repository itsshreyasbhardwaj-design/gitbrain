/**
 * Copy-paste detection by rolling window hash.
 *
 * The technique is deliberately simple — hash every N-line window, group the
 * collisions — but three details are what separate a useful duplication report
 * from an unreadable one, and each is handled explicitly below.
 *
 * 1. **Normalization.** Windows are hashed after `normalizeForDuplication`,
 *    which strips comments, string *contents* and whitespace. Two clones that
 *    differ only in a log message or indentation still hash equal, which is the
 *    common real-world case (someone copied a block and tweaked a literal).
 *
 * 2. **Triviality filtering.** Every codebase has hundreds of identical
 *    six-line runs of `}`, of import statements, or of one repeated line. Those
 *    are true duplicates and completely worthless as findings, so they are
 *    dropped before hashing rather than ranked down afterwards.
 *
 * 3. **Merging.** A duplicated 30-line block produces 25 overlapping 6-line
 *    windows. Reporting 25 findings for one problem is noise. Windows are grown
 *    greedily — a seed window extends while *every* occurrence still agrees —
 *    and the consumed positions are marked so the same block is never re-emitted
 *    from a later starting offset.
 *
 * Blank and comment-only lines are removed before windowing rather than
 * terminating a window, so a clone that gained a blank line is still detected.
 * `lineCount` therefore counts *significant* lines, while `startLine` refers to
 * the real 1-based line in the file.
 */

import type { DuplicateBlock, RepoSnapshot } from '../types';
import { isCountableSource } from '../shared/classify';
import { hashString, normalizeForDuplication, toLines } from '../shared/text';

/** Default window. Six lines is long enough to be a real block, short enough to catch small clones. */
const DEFAULT_WINDOW = 6;

/** Reporting cap. Beyond this the list stops being actionable. */
const MAX_BLOCKS = 50;

/** A window whose lines are all this short carries no structure worth reporting. */
const MIN_SIGNIFICANT_LINE_LENGTH = 3;

/** Total normalized characters a window must carry before it is worth a finding. */
const MIN_WINDOW_CHARS = 40;

const IMPORT_LINE = /^(?:import|from|using|use|require|include|package|export|extern|open)\b/;
const CLOSER_LINE = /^[)}\][;,]+$/;

interface CodeLine {
  /** Normalized text used for hashing and equality. */
  readonly text: string;
  /** 1-based line number in the original file. */
  readonly line: number;
}

interface FileLines {
  readonly path: string;
  readonly lines: readonly CodeLine[];
}

interface Position {
  /** Index into the file list. */
  readonly file: number;
  /** Index into that file's significant-line list. */
  readonly at: number;
}

/**
 * Find duplicated blocks of at least `minLines` significant lines.
 *
 * Returns at most 50 blocks, sorted by `lineCount * occurrences` descending so
 * the biggest, most-repeated clones come first.
 */
export function findDuplicates(
  snapshot: RepoSnapshot,
  minLines = DEFAULT_WINDOW,
): DuplicateBlock[] {
  const window = Math.max(2, Math.floor(minLines));
  const files = collectFiles(snapshot);
  if (files.length === 0) return [];

  // hashes[fileIndex][at] — null where the window was filtered as trivial.
  const hashes: (string | null)[][] = [];
  const index = new Map<string, Position[]>();

  files.forEach((file, fileIndex) => {
    const row: (string | null)[] = [];
    const last = file.lines.length - window;

    for (let at = 0; at <= last; at++) {
      const slice = file.lines.slice(at, at + window);
      if (!isSignificantWindow(slice)) {
        row.push(null);
        continue;
      }

      const hash = hashString(textOf(slice));
      row.push(hash);

      const bucket = index.get(hash);
      if (bucket) bucket.push({ file: fileIndex, at });
      else index.set(hash, [{ file: fileIndex, at }]);
    }

    hashes.push(row);
  });

  const blocks: DuplicateBlock[] = [];
  const consumed = new Set<string>();

  files.forEach((file, fileIndex) => {
    const row = hashes[fileIndex] ?? [];

    for (let at = 0; at < row.length; at++) {
      const hash = row[at];
      if (hash === null || hash === undefined) continue;
      if (consumed.has(key(fileIndex, at))) continue;

      const seedText = textOf(file.lines.slice(at, at + window));
      const group = (index.get(hash) ?? []).filter(
        (position) =>
          !consumed.has(key(position.file, position.at)) &&
          textOf(sliceAt(files, position, window)) === seedText,
      );
      const seed = group[0];
      if (group.length < 2 || !seed) continue;

      const length = extend(files, group, window);
      for (const position of group) {
        for (let offset = 0; offset <= length - window; offset++) {
          consumed.add(key(position.file, position.at + offset));
        }
      }

      blocks.push({
        hash: hashString(textOf(sliceAt(files, seed, length))),
        lineCount: length,
        occurrences: group.map((position) => ({
          file: files[position.file]?.path ?? '',
          startLine: files[position.file]?.lines[position.at]?.line ?? 1,
        })),
      });
    }
  });

  blocks.sort(
    (a, b) =>
      b.lineCount * b.occurrences.length - a.lineCount * a.occurrences.length ||
      b.lineCount - a.lineCount ||
      (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
  );

  return blocks.slice(0, MAX_BLOCKS);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectFiles(snapshot: RepoSnapshot): FileLines[] {
  const files: FileLines[] = [];

  for (const file of snapshot.files) {
    if (file.isBinary || file.content === null) continue;
    if (!isCountableSource(file.path, file.content)) continue;

    const lines: CodeLine[] = [];
    toLines(file.content).forEach((raw, offset) => {
      const text = normalizeForDuplication(raw);
      if (text === '') return;
      lines.push({ text, line: offset + 1 });
    });

    if (lines.length > 0) files.push({ path: file.path, lines });
  }

  return files;
}

function key(file: number, at: number): string {
  return `${file}:${at}`;
}

function textOf(slice: readonly CodeLine[]): string {
  return slice.map((line) => line.text).join('\n');
}

function sliceAt(files: readonly FileLines[], position: Position, length: number): CodeLine[] {
  return (files[position.file]?.lines ?? []).slice(position.at, position.at + length);
}

/**
 * Grow the block while every occurrence still matches.
 *
 * Occurrences inside the same file must stay disjoint, otherwise a file full of
 * one repeated line would "extend" forever by matching itself one line over.
 */
function extend(files: readonly FileLines[], group: readonly Position[], window: number): number {
  let length = window;

  for (;;) {
    const next: string[] = [];
    let ok = true;

    for (const position of group) {
      const line = files[position.file]?.lines[position.at + length];
      if (!line) {
        ok = false;
        break;
      }
      next.push(line.text);
    }
    if (!ok) break;

    const first = next[0];
    if (first === undefined || !next.every((text) => text === first)) break;
    if (overlaps(group, length + 1)) break;

    length += 1;
  }

  return length;
}

function overlaps(group: readonly Position[], length: number): boolean {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i];
      const b = group[j];
      if (!a || !b || a.file !== b.file) continue;
      if (Math.abs(a.at - b.at) < length) return true;
    }
  }
  return false;
}

/**
 * Reject windows that are technically duplicated but carry no information:
 * runs of closing punctuation, blocks of imports, a single line repeated, and
 * anything too short to be a real block.
 */
function isSignificantWindow(slice: readonly CodeLine[]): boolean {
  if (slice.every((line) => line.text.length < MIN_SIGNIFICANT_LINE_LENGTH)) return false;
  if (slice.every((line) => CLOSER_LINE.test(line.text))) return false;
  if (slice.every((line) => IMPORT_LINE.test(line.text))) return false;

  const distinct = new Set(slice.map((line) => line.text));
  if (distinct.size < 2) return false;

  const chars = slice.reduce((sum, line) => sum + line.text.length, 0);
  return chars >= MIN_WINDOW_CHARS;
}
