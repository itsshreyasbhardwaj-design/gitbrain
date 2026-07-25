/**
 * Code metrics: complexity, duplication and technical debt.
 *
 * All three share the `maskSource` lexer from `complexity.ts`, which blanks
 * comment and string interiors while preserving column positions. That single
 * pass is what makes `eval(` inside a string, `if` inside a comment, and a
 * `TODO` inside a string literal impossible false positives by construction.
 */

export { analyzeComplexity, maskSource } from './complexity';
export { findDuplicates } from './duplication';
export { analyzeTechDebt, scanMarkers } from './debt';
