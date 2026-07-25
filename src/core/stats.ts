/**
 * Repository-level statistics.
 *
 * Kept separate from the metrics module because these are counts a human would
 * recognise ("how many files, how deep, how much of it is tests"), whereas
 * `src/core/metrics` computes derived quality signals.
 */

import type { RepoFile, RepoSnapshot, RepoStats } from './types';
import { depthOf, dirname } from './shared/paths';
import { detectLanguage } from './shared/languages';
import {
  isConfigFile,
  isCountableSource,
  isDocumentationFile,
  isTestFile,
} from './shared/classify';

/** Leading comment forms that signal a file documents itself. */
const LEADING_DOC_COMMENT = /^\s*(\/\*\*|\/\/|#(?!!)|"""|'''|--\[\[|\/\*)/;

export function computeStats(snapshot: RepoSnapshot): RepoStats {
  const directories = new Set<string>();
  let linesOfCode = 0;
  let maxDepth = 0;
  let configFiles = 0;
  let testFiles = 0;
  let documentationFiles = 0;
  let sourceFiles = 0;
  let documentedSourceFiles = 0;

  for (const file of snapshot.files) {
    maxDepth = Math.max(maxDepth, depthOf(file.path));

    // Register every ancestor directory so the count reflects the real tree,
    // not just directories that happen to contain a file directly.
    let dir = dirname(file.path);
    while (dir) {
      if (directories.has(dir)) break;
      directories.add(dir);
      dir = dirname(dir);
    }

    if (isTestFile(file.path)) testFiles++;
    if (isConfigFile(file.path)) configFiles++;
    if (isDocumentationFile(file.path)) documentationFiles++;

    if (!isCountableSource(file.path, file.content)) continue;
    if (isTestFile(file.path)) continue;

    sourceFiles++;
    linesOfCode += file.lines;
    if (hasLeadingDocComment(file)) documentedSourceFiles++;
  }

  return {
    files: snapshot.files.length,
    directories: directories.size,
    totalBytes: snapshot.totalBytes,
    linesOfCode,
    maxDepth,
    configFiles,
    testFiles,
    documentationFiles,
    testRatio: ratio(testFiles, testFiles + sourceFiles),
    commentRatio: ratio(documentedSourceFiles, sourceFiles),
  };
}

/**
 * True when a source file opens with a comment.
 *
 * A deliberately shallow proxy for "is this documented". Counting every
 * comment line would reward commented-out code; checking that an author
 * bothered to explain the file's purpose up front correlates far better with
 * a codebase that is pleasant to read. Blank lines and shebangs are skipped.
 */
function hasLeadingDocComment(file: RepoFile): boolean {
  if (!file.content) return false;
  if (!detectLanguage(file.path).isSource) return false;

  for (const line of file.content.split('\n', 12)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#!')) continue;
    return LEADING_DOC_COMMENT.test(line);
  }

  return false;
}

function ratio(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 1000;
}
