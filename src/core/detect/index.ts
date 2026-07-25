/**
 * The detection layer.
 *
 * Ordered by dependency: languages need only the file list, the stack detector
 * needs the dependency report, and entry-point discovery needs the stack. The
 * pipeline calls them in that order.
 */

export { computeLanguages } from './languages';
export { analyzeDependencies, isLockfile } from './dependencies';
export { detectStack } from './stack';
export { findEntryPoints } from './entry-points';
