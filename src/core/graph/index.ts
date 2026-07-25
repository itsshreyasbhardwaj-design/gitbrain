/**
 * Code-graph layer.
 *
 * Four independent stages, deliberately kept separable so each can be tested
 * and reasoned about on its own:
 *
 *   imports  — lexical extraction of module references, per language
 *   resolve  — mapping a specifier onto a real repository path, or `null`
 *   build    — nodes, edges, cycles, externals and orphans
 *   tree     — the annotated directory hierarchy
 *
 * `build` is the only stage that composes the others; consumers that need just
 * one (a "find every import of X" query, say) can reach for `imports` alone.
 */

export type { ImportFamily, ParsedImport } from './imports';
export { importFamily, parseImports } from './imports';

export { createResolver, isRelativeSpecifier, parseTsconfigAliases } from './resolve';

export { buildModuleGraph, packageRoot } from './build';

export { buildTree } from './tree';
