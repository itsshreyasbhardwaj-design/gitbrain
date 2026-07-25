/**
 * GitBrain core domain contracts.
 *
 * Everything in `src/core` is pure, framework-free TypeScript: no React, no
 * Next.js, no Node built-ins beyond what is explicitly noted. That keeps the
 * analysis engine unit-testable in isolation and portable to a CLI or worker.
 *
 * These types are the single source of truth. Analyzers produce them, the API
 * serializes them, and the UI renders them.
 */

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/** Where a snapshot came from. Discriminated on `kind`. */
export type RepoSource =
  | {
      kind: 'github';
      owner: string;
      repo: string;
      /** Branch, tag or commit-ish actually fetched. */
      ref: string;
      /** Canonical https URL of the repository. */
      url: string;
    }
  | {
      kind: 'upload';
      /** Original name of the uploaded archive. */
      filename: string;
    };

/** A single text-or-binary file inside a snapshot. */
export interface RepoFile {
  /** POSIX, repository-relative, no leading `./` or `/`. */
  readonly path: string;
  /** Size in bytes of the original file. */
  readonly size: number;
  /** Lowercased extension without the dot; empty string when there is none. */
  readonly ext: string;
  /** True when the file is not decodable/indexable text. */
  readonly isBinary: boolean;
  /** Decoded UTF-8 content, or `null` for binary or over-limit files. */
  readonly content: string | null;
  /** Newline count + 1 for text files, 0 for binary. */
  readonly lines: number;
}

/** Why files were left out of a snapshot, for honest reporting in the UI. */
export interface SkippedSummary {
  /** Matched an ignore rule (node_modules, .git, dist, lockfiles, …). */
  readonly ignored: number;
  /** Detected as binary (images, fonts, archives, compiled artifacts). */
  readonly binary: number;
  /** Individually larger than the per-file byte budget. */
  readonly tooLarge: number;
  /** Dropped because the whole-snapshot file budget was exhausted. */
  readonly overBudget: number;
}

/** The immutable result of ingesting a repository. */
export interface RepoSnapshot {
  readonly source: RepoSource;
  readonly files: readonly RepoFile[];
  /** Sum of `size` over every file that survived ingestion. */
  readonly totalBytes: number;
  /** True when limits forced us to analyze only part of the repository. */
  readonly truncated: boolean;
  readonly skipped: SkippedSummary;
  /** Wall-clock milliseconds spent fetching + unpacking. */
  readonly ingestMs: number;
}

/** Tunable ingestion budgets. All limits are defensive, not cosmetic. */
export interface IngestLimits {
  readonly maxArchiveBytes: number;
  readonly maxFileBytes: number;
  readonly maxTotalTextBytes: number;
  readonly maxFiles: number;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface LanguageBreakdown {
  readonly language: string;
  readonly files: number;
  readonly bytes: number;
  /** 0–100, share of analyzed source bytes. */
  readonly percent: number;
  /** Hex colour used consistently across charts and graphs. */
  readonly color: string;
}

/**
 * Confidence is deliberately coarse. A detector either found a decisive
 * marker (`high`), corroborating signals (`medium`), or a weak hint (`low`).
 */
export type Confidence = 'high' | 'medium' | 'low';

/** One detected technology, always carrying the evidence that produced it. */
export interface Detection {
  readonly name: string;
  readonly confidence: Confidence;
  /** Human-readable reasons, e.g. "next@16.2.11 in package.json dependencies". */
  readonly evidence: readonly string[];
  /** Repo-relative paths that justify the detection. Used for citations. */
  readonly files: readonly string[];
  /** Optional resolved version string when a manifest pinned one. */
  readonly version?: string;
}

export type ArchitectureStyle =
  | 'monolith'
  | 'monorepo'
  | 'microservices'
  | 'serverless'
  | 'layered'
  | 'modular'
  | 'library'
  | 'cli'
  | 'unknown';

export type ApiStyle = 'rest' | 'graphql' | 'grpc' | 'trpc' | 'websocket' | 'none' | 'unknown';

/** Everything the stack detectors concluded about the repository. */
export interface StackDetection {
  readonly frameworks: readonly Detection[];
  readonly packageManagers: readonly Detection[];
  readonly ci: readonly Detection[];
  readonly deployment: readonly Detection[];
  readonly testing: readonly Detection[];
  readonly databases: readonly Detection[];
  readonly runtimes: readonly Detection[];
  readonly architecture: {
    readonly style: ArchitectureStyle;
    readonly confidence: Confidence;
    readonly evidence: readonly string[];
  };
  readonly api: {
    readonly style: ApiStyle;
    readonly confidence: Confidence;
    readonly evidence: readonly string[];
    readonly endpoints: readonly ApiEndpoint[];
  };
}

export interface ApiEndpoint {
  readonly method: string;
  readonly path: string;
  readonly file: string;
  readonly line: number;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export type DependencyKind = 'runtime' | 'dev' | 'peer' | 'optional';

export interface Dependency {
  readonly name: string;
  /** Raw range as written in the manifest, e.g. `^16.2.11`. */
  readonly range: string;
  readonly kind: DependencyKind;
  /** Manifest that declared it. */
  readonly manifest: string;
  /** Ecosystem, e.g. `npm`, `pypi`, `go`, `cargo`, `maven`. */
  readonly ecosystem: string;
}

export interface DependencyReport {
  readonly dependencies: readonly Dependency[];
  readonly manifests: readonly string[];
  readonly counts: Record<DependencyKind, number>;
  /** Dependencies matching a curated deprecated/unsafe list. */
  readonly flagged: readonly DependencyFlag[];
  /** Ranges pinned so loosely they cannot be reproduced (`*`, `latest`). */
  readonly unpinned: readonly string[];
  /** True when a lockfile was present, which materially affects reproducibility. */
  readonly hasLockfile: boolean;
}

export interface DependencyFlag {
  readonly name: string;
  readonly reason: string;
  readonly severity: Severity;
  readonly replacement?: string;
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

export interface TreeNode {
  readonly name: string;
  /** Repo-relative path; empty string for the synthetic root. */
  readonly path: string;
  readonly type: 'dir' | 'file';
  readonly size: number;
  /** Total files at or below this node. */
  readonly fileCount: number;
  readonly children?: readonly TreeNode[];
  /** Dominant language beneath this node, when one exists. */
  readonly language?: string;
  /** Plain-language explanation of the folder's role. Directories only. */
  readonly purpose?: string;
}

// ---------------------------------------------------------------------------
// Module graph
// ---------------------------------------------------------------------------

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly language: string;
  readonly loc: number;
  /** Number of modules this file imports (outgoing edges). */
  readonly outDegree: number;
  /** Number of modules that import this file (incoming edges). */
  readonly inDegree: number;
  /** Instability metric I = out / (in + out); 0 = stable, 1 = unstable. */
  readonly instability: number;
  readonly isEntry: boolean;
  /** True when nothing imports it and it is not an entry point. */
  readonly isOrphan: boolean;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** Raw specifier as written in the source, e.g. `./utils/format`. */
  readonly specifier: string;
  /** True when the edge participates in at least one cycle. */
  readonly circular: boolean;
}

/** An external package imported by the code but resolved outside the repo. */
export interface ExternalImport {
  readonly name: string;
  readonly count: number;
  readonly importers: readonly string[];
  /** True when it is not declared in any manifest — a real correctness risk. */
  readonly undeclared: boolean;
}

export interface ModuleGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Strongly-connected components of size > 1, each as an ordered path list. */
  readonly cycles: readonly (readonly string[])[];
  readonly externals: readonly ExternalImport[];
  /** Files with no incoming edges that are not recognised entry points. */
  readonly orphans: readonly string[];
}

export interface EntryPoint {
  readonly path: string;
  /** Why this is an entry point, e.g. "package.json `main` field". */
  readonly reason: string;
  readonly kind: 'app' | 'server' | 'cli' | 'build' | 'test' | 'config' | 'library';
  readonly confidence: Confidence;
}

// ---------------------------------------------------------------------------
// Metrics & technical debt
// ---------------------------------------------------------------------------

export interface FileComplexity {
  readonly path: string;
  readonly loc: number;
  /** Non-blank, non-comment lines. */
  readonly sloc: number;
  /** Cyclomatic complexity approximated from branch-keyword density. */
  readonly cyclomatic: number;
  /** Deepest brace/indent nesting observed. */
  readonly maxNesting: number;
  readonly functions: number;
  /** 0–100 composite; higher means harder to maintain. */
  readonly riskScore: number;
}

export interface ComplexityReport {
  readonly files: readonly FileComplexity[];
  readonly totalLoc: number;
  readonly totalSloc: number;
  readonly averageComplexity: number;
  /** Highest-risk files, already sorted descending. */
  readonly hotspots: readonly FileComplexity[];
  readonly distribution: readonly { readonly bucket: string; readonly count: number }[];
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface DebtItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: Severity;
  readonly category:
    | 'complexity'
    | 'duplication'
    | 'documentation'
    | 'testing'
    | 'dependencies'
    | 'structure'
    | 'convention';
  readonly files: readonly string[];
  /** Rough remediation cost in engineer-hours. Heuristic, shown as an estimate. */
  readonly estimatedHours: number;
}

export interface TechDebtReport {
  readonly items: readonly DebtItem[];
  /** Sum of `estimatedHours`. */
  readonly totalEstimatedHours: number;
  /** `TODO` / `FIXME` / `HACK` / `XXX` markers found in source. */
  readonly markers: readonly CodeMarker[];
  readonly duplicates: readonly DuplicateBlock[];
}

export interface CodeMarker {
  readonly kind: 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'DEPRECATED';
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface DuplicateBlock {
  readonly hash: string;
  readonly lineCount: number;
  readonly occurrences: readonly { readonly file: string; readonly startLine: number }[];
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export interface SecretFinding {
  readonly id: string;
  /** Rule name, e.g. "AWS Access Key ID". */
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  /** Always redacted — GitBrain never stores or renders a full credential. */
  readonly preview: string;
  readonly severity: Severity;
  /** Shannon entropy of the matched token, when entropy contributed. */
  readonly entropy?: number;
}

export interface EnvVarUsage {
  readonly name: string;
  readonly files: readonly string[];
  /** True when the name appears in a committed `.env.example`-style template. */
  readonly documented: boolean;
}

export interface LargeFile {
  readonly path: string;
  readonly size: number;
}

export interface SecurityReport {
  readonly secrets: readonly SecretFinding[];
  readonly envVars: readonly EnvVarUsage[];
  /** Referenced in code but absent from any committed env template. */
  readonly undocumentedEnvVars: readonly string[];
  readonly largeFiles: readonly LargeFile[];
  readonly flaggedDependencies: readonly DependencyFlag[];
  readonly risks: readonly SecurityRisk[];
  /** 0–100, higher is safer. */
  readonly score: number;
}

export interface SecurityRisk {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: Severity;
  readonly files: readonly string[];
  readonly recommendation: string;
  /** OWASP or CWE reference when one applies. */
  readonly reference?: string;
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

export interface ReadmeSection {
  readonly name: string;
  readonly present: boolean;
  /** Relative importance when scoring, 0–1. */
  readonly weight: number;
  readonly suggestion?: string;
}

export interface ReadmeReport {
  readonly exists: boolean;
  readonly path: string | null;
  readonly wordCount: number;
  readonly score: number;
  readonly sections: readonly ReadmeSection[];
  readonly missingSections: readonly string[];
  readonly suggestions: readonly string[];
  readonly hasBadges: boolean;
  readonly hasCodeExamples: boolean;
  readonly hasImages: boolean;
  /** Ready-to-paste Markdown for every missing section. */
  readonly generatedSections: readonly { readonly name: string; readonly markdown: string }[];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthDimension =
  | 'documentation'
  | 'maintainability'
  | 'architecture'
  | 'testing'
  | 'performance'
  | 'security'
  | 'readability'
  | 'developerExperience';

export interface HealthScore {
  readonly dimension: HealthDimension;
  readonly label: string;
  /** 0–100. */
  readonly score: number;
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** What drove the score, stated as facts, not adjectives. */
  readonly rationale: readonly string[];
  readonly suggestions: readonly Suggestion[];
}

export interface Suggestion {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly impact: 'high' | 'medium' | 'low';
  readonly effort: 'high' | 'medium' | 'low';
  readonly files: readonly string[];
}

export interface HealthReport {
  readonly overall: number;
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly scores: readonly HealthScore[];
  /** Highest impact-to-effort suggestions across every dimension. */
  readonly topSuggestions: readonly Suggestion[];
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export type KnowledgeDocId =
  | 'executive-summary'
  | 'project-purpose'
  | 'folder-explanation'
  | 'architecture-overview'
  | 'dependency-analysis'
  | 'code-complexity'
  | 'technical-debt'
  | 'entry-points'
  | 'data-flow'
  | 'authentication-flow'
  | 'api-overview'
  | 'database-overview'
  | 'deployment-guide'
  | 'setup-guide'
  | 'environment-variables'
  | 'performance-bottlenecks'
  | 'security-risks'
  | 'suggested-improvements';

/** A pointer back into the repository that the UI renders as a clickable chip. */
export interface Citation {
  readonly file: string;
  readonly startLine?: number;
  readonly endLine?: number;
  /** Short excerpt shown on hover/expand. */
  readonly excerpt?: string;
}

export interface KnowledgeDoc {
  readonly id: KnowledgeDocId;
  readonly title: string;
  /** One-line summary used in cards and search results. */
  readonly summary: string;
  /** GitHub-flavoured Markdown. Sanitized before render. */
  readonly markdown: string;
  readonly citations: readonly Citation[];
  /** `derived` = computed from analysis facts. `ai` = LLM-enriched. */
  readonly provenance: 'derived' | 'ai';
}

export interface KnowledgeBase {
  readonly docs: readonly KnowledgeDoc[];
  readonly generatedAt: string;
  /** Model identifier when AI enrichment ran, otherwise null. */
  readonly model: string | null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchDocument {
  readonly id: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly language: string;
  /** Symbol names extracted from the chunk; weighted higher when matching. */
  readonly symbols: readonly string[];
}

/** Serializable inverted index. Small enough to ship to the client for a repo. */
export interface SearchIndex {
  readonly documents: readonly SearchDocument[];
  /** term -> [documentIndex, termFrequency][] */
  readonly postings: Record<string, readonly (readonly [number, number])[]>;
  readonly averageLength: number;
  readonly totalDocuments: number;
}

export interface SearchHit {
  readonly document: SearchDocument;
  readonly score: number;
  /** Character ranges within `document.text` that matched, for highlighting. */
  readonly highlights: readonly (readonly [number, number])[];
}

export interface SearchAnswer {
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly hits: readonly SearchHit[];
  readonly provenance: 'derived' | 'ai';
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly citations?: readonly Citation[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Top-level analysis
// ---------------------------------------------------------------------------

export interface RepoStats {
  readonly files: number;
  readonly directories: number;
  readonly totalBytes: number;
  readonly linesOfCode: number;
  readonly maxDepth: number;
  readonly configFiles: number;
  readonly testFiles: number;
  readonly documentationFiles: number;
  /** testFiles / (testFiles + sourceFiles), 0–1. */
  readonly testRatio: number;
  /** Files carrying a leading doc comment, over total source files, 0–1. */
  readonly commentRatio: number;
}

/** The complete, serializable output of a GitBrain run. */
export interface Analysis {
  readonly id: string;
  readonly createdAt: string;
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
  readonly knowledge: KnowledgeBase;
  readonly search: SearchIndex;
  readonly snapshot: {
    readonly truncated: boolean;
    readonly skipped: SkippedSummary;
    readonly ingestMs: number;
  };
  /** Total wall-clock milliseconds for the analysis phase. */
  readonly analysisMs: number;
}

/** Lightweight row used by dashboard lists — never ships the whole Analysis. */
export interface AnalysisSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly source: RepoSource;
  readonly name: string;
  readonly primaryLanguage: string | null;
  readonly overallScore: number;
  readonly files: number;
  readonly linesOfCode: number;
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export type AnalysisStage =
  | 'queued'
  | 'fetching'
  | 'unpacking'
  | 'scanning'
  | 'detecting'
  | 'graphing'
  | 'measuring'
  | 'securing'
  | 'scoring'
  | 'synthesizing'
  | 'indexing'
  | 'done'
  | 'error';

export interface ProgressEvent {
  readonly stage: AnalysisStage;
  /** 0–100. */
  readonly percent: number;
  readonly message: string;
}

export type ProgressReporter = (event: ProgressEvent) => void;
