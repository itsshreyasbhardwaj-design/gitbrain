/**
 * The deterministic knowledge engine.
 *
 * Eighteen Markdown documents, generated from computed analysis facts with no
 * model in the loop. That constraint is the product decision, not a limitation:
 * GitBrain has to produce a genuinely useful read of a repository with zero API
 * keys, offline, in milliseconds, and reproducibly. Every sentence here is
 * traceable to a number or a file path that the analyzers produced.
 *
 * An optional AI layer enriches these documents afterwards by rewriting prose
 * and adding interpretation. When it runs it replaces `provenance: 'derived'`
 * with `'ai'` and records the model. When it does not run — no key, no network,
 * a failed request — this output stands on its own, unchanged. That makes the
 * derived layer both the fallback and the ground truth the AI layer is checked
 * against.
 *
 * Document order follows the `KnowledgeDocId` union in `src/core/types.ts`,
 * which is also the order the UI renders them in: orientation, then code, then
 * runtime surface, then operations, then quality.
 */

import type { KnowledgeBase, KnowledgeDoc } from '../types';
import type { KnowledgeContext } from './context';
import {
  architectureOverview,
  executiveSummary,
  folderExplanation,
  projectPurpose,
} from './generators/overview';
import {
  codeComplexity,
  dataFlow,
  dependencyAnalysis,
  entryPoints,
  technicalDebt,
} from './generators/code';
import { apiOverview, authenticationFlow, databaseOverview } from './generators/runtime';
import { deploymentGuide, environmentVariables, setupGuide } from './generators/ops';
import { performanceBottlenecks, securityRisks, suggestedImprovements } from './generators/quality';

/**
 * Every generator, in `KnowledgeDocId` order.
 *
 * Listing them as data rather than as eighteen call sites keeps the ordering
 * contract in one place and makes "did we generate all of them?" a length check.
 */
const GENERATORS: readonly ((context: KnowledgeContext) => KnowledgeDoc)[] = [
  executiveSummary,
  projectPurpose,
  folderExplanation,
  architectureOverview,
  dependencyAnalysis,
  codeComplexity,
  technicalDebt,
  entryPoints,
  dataFlow,
  authenticationFlow,
  apiOverview,
  databaseOverview,
  deploymentGuide,
  setupGuide,
  environmentVariables,
  performanceBottlenecks,
  securityRisks,
  suggestedImprovements,
];

/**
 * Run every generator and assemble the knowledge base.
 *
 * `model` is `null` because nothing here used one; the AI enrichment pass sets
 * it when it runs.
 */
export function buildKnowledgeBase(context: KnowledgeContext): KnowledgeBase {
  const docs = GENERATORS.map((generate) => generate(context));

  return {
    docs,
    generatedAt: new Date().toISOString(),
    model: null,
  };
}

export type { KnowledgeContext } from './context';
export type { CitationRef, PackageManifest } from './context';
export {
  anchorRefs,
  citationsFor,
  detectionLabel,
  detectionRefs,
  ensureCitations,
  filesMatching,
  findFile,
  firstExisting,
  grep,
  hasFile,
  pickScript,
  primaryLanguage,
  rankDetections,
  readManifest,
  repoName,
  repoUrl,
  topDetection,
  topLevelDirectories,
  walkDirectories,
} from './context';
export {
  bulletList,
  citation,
  code,
  codeBlock,
  countLabel,
  escapeCell,
  fileRef,
  formatBytes,
  formatNumber,
  formatPercent,
  heading,
  joinWords,
  makeDoc,
  mermaid,
  mermaidId,
  mermaidLabel,
  note,
  numberedList,
  pluralize,
  section,
  severityLabel,
  severityRank,
  table,
} from './format';

export {
  architectureOverview,
  executiveSummary,
  folderExplanation,
  projectPurpose,
} from './generators/overview';
export {
  codeComplexity,
  dataFlow,
  dependencyAnalysis,
  entryPoints,
  technicalDebt,
} from './generators/code';
export { apiOverview, authenticationFlow, databaseOverview } from './generators/runtime';
export { deploymentGuide, environmentVariables, setupGuide } from './generators/ops';
export { performanceBottlenecks, securityRisks, suggestedImprovements } from './generators/quality';
