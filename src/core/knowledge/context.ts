/**
 * The input bundle every knowledge generator reads from.
 *
 * `KnowledgeContext` is deliberately the whole analysis minus the knowledge
 * base itself: generators are pure functions of computed facts, which is what
 * makes the output reproducible and testable without a network or an API key.
 *
 * Alongside the shape, this module owns the lookups that all five generator
 * modules need — resolving the repository's name, finding a file, grepping for
 * evidence, and building citations that are guaranteed to point at files that
 * actually exist in the snapshot. A citation to a path that is not in the
 * repository renders as a dead chip in the UI, so every citation the engine
 * emits goes through `citationsFor`.
 */

import type {
  Citation,
  ComplexityReport,
  DependencyReport,
  Detection,
  EntryPoint,
  HealthReport,
  LanguageBreakdown,
  ModuleGraph,
  ReadmeReport,
  RepoFile,
  RepoSource,
  RepoStats,
  SearchIndex,
  SecurityReport,
  StackDetection,
  TechDebtReport,
  TreeNode,
} from '../types';
import { isVendored } from '../shared/classify';
import { normalizePath } from '../shared/paths';
import { squish, truncate } from '../shared/text';
import { citation } from './format';

export interface KnowledgeContext {
  readonly source: RepoSource;
  readonly stats: RepoStats;
  readonly languages: readonly LanguageBreakdown[];
  readonly stack: StackDetection;
  readonly dependencies: DependencyReport;
  readonly tree: TreeNode;
  readonly graph: ModuleGraph;
  readonly entryPoints: readonly EntryPoint[];
  readonly complexity: ComplexityReport;
  readonly debt: TechDebtReport;
  readonly security: SecurityReport;
  readonly readme: ReadmeReport;
  readonly health: HealthReport;
  readonly search: SearchIndex;
  readonly files: readonly RepoFile[];
}

// ---------------------------------------------------------------------------
// Identity and lookup
// ---------------------------------------------------------------------------

/** `owner/repo` for a GitHub snapshot, or the uploaded archive's filename. */
export function repoName(context: KnowledgeContext): string {
  const { source } = context;
  return source.kind === 'github' ? `${source.owner}/${source.repo}` : source.filename;
}

/** Canonical repository URL, when the snapshot came from one. */
export function repoUrl(context: KnowledgeContext): string | null {
  return context.source.kind === 'github' ? context.source.url : null;
}

/**
 * Path lookup, memoised per context.
 *
 * Generators call `findFile` hundreds of times while validating citations; a
 * linear scan each time turns citation building into the slowest part of the
 * engine on a large monorepo.
 */
const pathIndexCache = new WeakMap<KnowledgeContext, Map<string, RepoFile>>();

function pathIndex(context: KnowledgeContext): Map<string, RepoFile> {
  const cached = pathIndexCache.get(context);
  if (cached) return cached;

  const built = new Map<string, RepoFile>();
  for (const file of context.files) built.set(file.path, file);
  pathIndexCache.set(context, built);
  return built;
}

/** Find a file by repo-relative path. Tolerates `./` and duplicate slashes. */
export function findFile(context: KnowledgeContext, path: string): RepoFile | undefined {
  const index = pathIndex(context);
  return index.get(path) ?? index.get(normalizePath(path));
}

/** True when the snapshot contains this exact path. */
export function hasFile(context: KnowledgeContext, path: string): boolean {
  return findFile(context, path) !== undefined;
}

/** First existing path from a list of candidates. Used for well-known filenames. */
export function firstExisting(
  context: KnowledgeContext,
  candidates: readonly string[],
): string | null {
  for (const candidate of candidates) {
    if (hasFile(context, candidate)) return candidate;
  }
  return null;
}

/** Every text file whose path matches a pattern, shallowest first. */
export function filesMatching(
  context: KnowledgeContext,
  pattern: RegExp,
  limit = 50,
): readonly RepoFile[] {
  const test = stateless(pattern);
  const matched = context.files.filter((file) => !isVendored(file.path) && test.test(file.path));

  return matched
    .slice()
    .sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
    )
    .slice(0, limit);
}

/**
 * Line-level search across the snapshot's text files.
 *
 * This is how generators turn a hunch ("does anything sign a JWT?") into a
 * citable `file:line`. Vendored trees are skipped so a bundled dependency never
 * masquerades as the project's own code.
 */
export function grep(
  context: KnowledgeContext,
  pattern: RegExp,
  limit = 20,
): { file: string; line: number; text: string }[] {
  const test = stateless(pattern);
  const out: { file: string; line: number; text: string }[] = [];

  for (const file of context.files) {
    if (file.isBinary || file.content === null) continue;
    if (isVendored(file.path)) continue;

    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      if (raw === undefined || raw.length === 0) continue;
      if (!test.test(raw)) continue;

      out.push({ file: file.path, line: index + 1, text: truncate(squish(raw), 160) });
      if (out.length >= limit) return out;
    }
  }

  return out;
}

/**
 * Drop `g`/`y` flags.
 *
 * A global regex carries `lastIndex` between `test` calls, which silently makes
 * every other match disappear. Callers pass whatever regex reads best, and this
 * makes it safe to reuse.
 */
function stateless(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, '');
  return flags === pattern.flags ? pattern : new RegExp(pattern.source, flags);
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export interface CitationRef {
  readonly file: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly excerpt?: string;
}

/**
 * Build citations, keeping only references to files present in the snapshot
 * and de-duplicating by `file:line`.
 */
export function citationsFor(
  context: KnowledgeContext,
  refs: readonly CitationRef[],
  limit = 12,
): readonly Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];

  for (const ref of refs) {
    if (!ref.file || !hasFile(context, ref.file)) continue;

    const key = `${ref.file}:${ref.startLine ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(citation(ref.file, ref.startLine, ref.endLine, ref.excerpt));
    if (out.length >= limit) break;
  }

  return out;
}

/**
 * The files that best identify the repository: its README, its primary
 * manifest, its first entry point, its largest source file.
 *
 * Used as the citation of last resort so a document about something the repo
 * does not have still points the reader somewhere real.
 */
export function anchorRefs(context: KnowledgeContext): readonly CitationRef[] {
  const refs: CitationRef[] = [];

  if (context.readme.path) refs.push({ file: context.readme.path });
  const manifest = context.dependencies.manifests[0];
  if (manifest) refs.push({ file: manifest });
  const entry = context.entryPoints[0];
  if (entry) refs.push({ file: entry.path });
  const hotspot = context.complexity.files[0];
  if (hotspot) refs.push({ file: hotspot.path });
  const firstFile = context.files[0];
  if (firstFile) refs.push({ file: firstFile.path });

  return refs;
}

/** Fall back to anchor citations when a document found nothing specific to cite. */
export function ensureCitations(
  context: KnowledgeContext,
  citations: readonly Citation[],
): readonly Citation[] {
  if (citations.length > 0) return citations;
  return citationsFor(context, anchorRefs(context), 3);
}

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Detections ordered by confidence, then by weight of evidence. */
export function rankDetections(detections: readonly Detection[]): readonly Detection[] {
  return detections
    .slice()
    .sort(
      (a, b) =>
        CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
        b.evidence.length - a.evidence.length ||
        a.name.localeCompare(b.name),
    );
}

/** The single most credible detection in a list, if there is one. */
export function topDetection(detections: readonly Detection[]): Detection | undefined {
  return rankDetections(detections)[0];
}

/** `Next.js 16.2.11` / `Next.js` — a detection rendered for prose. */
export function detectionLabel(detection: Detection): string {
  return detection.version ? `${detection.name} ${detection.version}` : detection.name;
}

/** Citation refs for every file a set of detections used as evidence. */
export function detectionRefs(detections: readonly Detection[]): readonly CitationRef[] {
  return detections.flatMap((detection) => detection.files.map((file) => ({ file })));
}

// ---------------------------------------------------------------------------
// Languages and tree
// ---------------------------------------------------------------------------

/** The language with the largest share of analyzed source bytes. */
export function primaryLanguage(context: KnowledgeContext): LanguageBreakdown | undefined {
  return context.languages.slice().sort((a, b) => b.bytes - a.bytes)[0];
}

/** Top-level directories, largest first by file count. */
export function topLevelDirectories(context: KnowledgeContext): readonly TreeNode[] {
  return (context.tree.children ?? [])
    .filter((node) => node.type === 'dir')
    .slice()
    .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
}

/** Walk every directory node in the tree, depth-first. */
export function walkDirectories(root: TreeNode): readonly TreeNode[] {
  const out: TreeNode[] = [];

  const visit = (node: TreeNode): void => {
    for (const child of node.children ?? []) {
      if (child.type !== 'dir') continue;
      out.push(child);
      visit(child);
    }
  };

  visit(root);
  return out;
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

export interface PackageManifest {
  readonly path: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly version: string | null;
  readonly license: string | null;
  readonly main: string | null;
  readonly scripts: Readonly<Record<string, string>>;
  readonly engines: Readonly<Record<string, string>>;
  readonly binNames: readonly string[];
}

const manifestCache = new WeakMap<KnowledgeContext, PackageManifest | null>();

/**
 * Parse the repository's root `package.json`, when it has one.
 *
 * Setup and deployment guidance is only useful if the commands are the ones the
 * project actually defines, so the scripts block is read verbatim rather than
 * assumed. Malformed JSON yields `null` instead of throwing — a broken manifest
 * is a finding, not a crash.
 */
export function readManifest(context: KnowledgeContext): PackageManifest | null {
  if (manifestCache.has(context)) return manifestCache.get(context) ?? null;

  const parsed = parseManifest(context);
  manifestCache.set(context, parsed);
  return parsed;
}

function parseManifest(context: KnowledgeContext): PackageManifest | null {
  const candidates = context.files
    .filter((file) => file.path === 'package.json' || file.path.endsWith('/package.json'))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);

  const file = candidates[0];
  if (!file || !file.content) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(file.content);
  } catch {
    return null;
  }

  const record = asRecord(raw);
  if (!record) return null;

  return {
    path: file.path,
    name: asString(record.name),
    description: asString(record.description),
    version: asString(record.version),
    license: asString(record.license),
    main: asString(record.main),
    scripts: asStringRecord(record.scripts),
    engines: asStringRecord(record.engines),
    binNames: binNamesOf(record.bin),
  };
}

function binNamesOf(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  const record = asRecord(value);
  if (!record) return [];
  return Object.keys(record);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> {
  const record = asRecord(value);
  const out: Record<string, string> = {};
  if (!record) return out;

  for (const [key, entry] of Object.entries(record)) {
    const text = asString(entry);
    if (text) out[key] = text;
  }
  return out;
}

/** The first script whose name matches one of `names`, in preference order. */
export function pickScript(
  manifest: PackageManifest | null,
  names: readonly string[],
): { readonly name: string; readonly command: string } | null {
  if (!manifest) return null;

  for (const name of names) {
    const command = manifest.scripts[name];
    if (command) return { name, command };
  }
  return null;
}
