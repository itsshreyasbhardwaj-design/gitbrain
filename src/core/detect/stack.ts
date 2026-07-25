/**
 * Stack detection.
 *
 * Every `Detection` GitBrain emits carries the evidence that produced it. That
 * is not decoration — it is the product's core claim. A tool that says "this is
 * a Next.js repo" is guessing as far as the reader knows; a tool that says
 * "`next@16.2.11` in package.json dependencies, plus next.config.ts" can be
 * checked in ten seconds. So the detector never records a conclusion it cannot
 * cite, and the confidence ladder is defined in terms of what kind of evidence
 * was found rather than a tuned score:
 *
 *   - **high** — a declared dependency or a framework-owned config file. These
 *     are statements the repository makes about itself.
 *   - **medium** — two or more source files containing a characteristic import
 *     or call. Corroboration across files rules out a stray comment.
 *   - **low** — a single content match. Worth surfacing, not worth trusting.
 *
 * Manifest evidence outranks content evidence because a manifest cannot be
 * accidental, whereas `// we used to use Express here` is a real false positive
 * that a naive grep-based detector reports with full confidence.
 */

import type {
  ApiEndpoint,
  ApiStyle,
  Confidence,
  Dependency,
  DependencyReport,
  Detection,
  RepoFile,
  RepoSnapshot,
  StackDetection,
} from '../types';
import { basename, dirname } from '../shared/paths';
import { squish, toLines, truncate } from '../shared/text';
import { isTestFile, isVendored } from '../shared/classify';

// ---------------------------------------------------------------------------
// Rule shapes
// ---------------------------------------------------------------------------

/** A package name in one ecosystem. `RegExp` covers versioned Go/Maven names. */
interface PackageRef {
  readonly ecosystem: string;
  readonly name: string | RegExp;
}

interface ContentRef {
  readonly pattern: RegExp;
  /** Extensions the pattern is meaningful in; omit to scan all text files. */
  readonly exts?: readonly string[];
}

interface Rule {
  readonly name: string;
  readonly packages?: readonly PackageRef[];
  /** Paths that only this technology creates. Matched against the full path. */
  readonly paths?: readonly RegExp[];
  readonly content?: readonly ContentRef[];
  /** Package whose declared range becomes `Detection.version`. */
  readonly versionFrom?: PackageRef;
}

/**
 * Bounds on content scanning.
 *
 * Content rules are the expensive half of detection: without a cap, a rule set
 * this size would read every file for every rule on a 20,000-file repository.
 * Three matches are already more evidence than a reader will look at, and a
 * technology that appears in none of the first 400 candidate files of the right
 * extension is not the repository's stack.
 */
const MAX_CONTENT_MATCHES = 3;
const MAX_CONTENT_FILES = 400;

// ---------------------------------------------------------------------------
// Analysis context
// ---------------------------------------------------------------------------

interface Context {
  /** Text files, excluding vendored trees, grouped by lowercase extension. */
  readonly byExt: ReadonlyMap<string, readonly RepoFile[]>;
  /** Every non-binary, non-vendored file, in snapshot order. */
  readonly text: readonly RepoFile[];
  /** Every non-vendored path, including binaries — path rules need those. */
  readonly paths: readonly string[];
  readonly dependencies: readonly Dependency[];
}

function buildContext(snapshot: RepoSnapshot, deps: DependencyReport): Context {
  const text: RepoFile[] = [];
  const byExt = new Map<string, RepoFile[]>();
  const paths: string[] = [];

  for (const file of snapshot.files) {
    if (isVendored(file.path)) continue;
    paths.push(file.path);
    if (file.isBinary || file.content === null) continue;

    text.push(file);
    const bucket = byExt.get(file.ext);
    if (bucket) bucket.push(file);
    else byExt.set(file.ext, [file]);
  }

  return { byExt, text, paths, dependencies: deps.dependencies };
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

interface Accumulator {
  readonly evidence: string[];
  readonly files: string[];
  manifestHit: boolean;
  /** True when at least one matching package was a runtime/peer dependency. */
  shippedManifestHit: boolean;
  pathHit: boolean;
  contentFiles: number;
  version?: string;
}

/**
 * Per-category evaluation options.
 *
 * `devEvidenceIsWeak` exists because "is this package in the manifest?" means
 * different things for different categories. Vitest in `devDependencies` is
 * definitive proof of the test framework — that is the only place it can be.
 * Express in `devDependencies` proves almost nothing about the application:
 * test harnesses routinely spin up a throwaway HTTP server, which is exactly
 * why `sindresorhus/ky` — an HTTP *client* — carries `express` as a dev
 * dependency. Branding it an Express app would be a confident lie.
 */
interface RuleOptions {
  readonly devEvidenceIsWeak?: boolean;
}

/** npm section names, so evidence reads the way the manifest does. */
const KIND_LABEL: Readonly<Record<string, string>> = {
  runtime: 'dependencies',
  dev: 'devDependencies',
  peer: 'peerDependencies',
  optional: 'optionalDependencies',
};

function matchesName(ref: PackageRef, dependency: Dependency): boolean {
  if (ref.ecosystem !== dependency.ecosystem) return false;
  return typeof ref.name === 'string'
    ? ref.name.toLowerCase() === dependency.name.toLowerCase()
    : ref.name.test(dependency.name);
}

function findDependency(context: Context, ref: PackageRef): Dependency | undefined {
  return context.dependencies.find((dependency) => matchesName(ref, dependency));
}

/**
 * Strip range operators so `^16.2.11` reads as `16.2.11`.
 *
 * Only the leading operator is removed. A compound range such as `>=1,<2` has
 * no single version to report, so it is returned unchanged rather than
 * truncated into a number the manifest never stated.
 */
function cleanVersion(range: string): string | undefined {
  const trimmed = range.trim();
  if (!trimmed) return undefined;
  if (trimmed === '*' || trimmed.toLowerCase() === 'latest') return undefined;

  const simple = /^[\^~>=<v\s]*(\d[\w.+-]*)$/.exec(trimmed);
  return simple?.[1] ?? trimmed;
}

/** Evaluate one rule against the repository, returning `null` when unmatched. */
function evaluate(context: Context, rule: Rule, options: RuleOptions = {}): Detection | null {
  const acc: Accumulator = {
    evidence: [],
    files: [],
    manifestHit: false,
    shippedManifestHit: false,
    pathHit: false,
    contentFiles: 0,
  };

  for (const ref of rule.packages ?? []) {
    for (const dependency of context.dependencies) {
      if (!matchesName(ref, dependency)) continue;

      const label = KIND_LABEL[dependency.kind] ?? 'dependencies';
      acc.evidence.push(
        dependency.range
          ? `${dependency.name}@${dependency.range} in ${dependency.manifest} ${label}`
          : `${dependency.name} in ${dependency.manifest} ${label}`,
      );
      acc.files.push(dependency.manifest);
      acc.manifestHit = true;
      if (dependency.kind === 'runtime' || dependency.kind === 'peer') {
        acc.shippedManifestHit = true;
      }
      break; // One citation per package ref is enough; monorepos repeat them.
    }
  }

  for (const pattern of rule.paths ?? []) {
    const hit = context.paths.find((path) => pattern.test(path));
    if (!hit) continue;
    acc.evidence.push(`${hit} present`);
    acc.files.push(hit);
    acc.pathHit = true;
  }

  for (const ref of rule.content ?? []) {
    scanContent(context, ref, acc);
  }

  if (acc.evidence.length === 0) return null;

  if (rule.versionFrom) {
    const dependency = findDependency(context, rule.versionFrom);
    if (dependency) acc.version = cleanVersion(dependency.range);
  }

  // A manifest hit is decisive unless the category asked us to discount
  // dev-only evidence and that is all we have. In that case the package's
  // presence is real but weak, so we fall back to what the source code shows:
  // actually importing the framework in more than one file is corroboration,
  // a lone devDependency is not.
  const manifestIsDecisive =
    acc.manifestHit && (acc.shippedManifestHit || !options.devEvidenceIsWeak);

  const confidence: Confidence =
    manifestIsDecisive || acc.pathHit
      ? 'high'
      : acc.contentFiles > 1
        ? 'medium'
        : acc.contentFiles === 1 && acc.manifestHit
          ? 'medium'
          : 'low';

  return {
    name: rule.name,
    confidence,
    evidence: dedupeStrings(acc.evidence),
    files: dedupeStrings(acc.files),
    ...(acc.version === undefined ? {} : { version: acc.version }),
  };
}

/** Scan candidate files for a content pattern, recording file:line citations. */
function scanContent(context: Context, ref: ContentRef, acc: Accumulator): void {
  const candidates = ref.exts
    ? ref.exts.flatMap((ext) => context.byExt.get(ext) ?? [])
    : context.text;

  let scanned = 0;
  let matches = 0;

  for (const file of candidates) {
    if (matches >= MAX_CONTENT_MATCHES || scanned >= MAX_CONTENT_FILES) break;
    scanned++;

    const content = file.content;
    if (content === null || !ref.pattern.test(content)) continue;

    const lines = toLines(content);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!ref.pattern.test(line)) continue;

      acc.evidence.push(`${file.path}:${i + 1} — ${truncate(squish(line), 80)}`);
      acc.files.push(file.path);
      acc.contentFiles++;
      matches++;
      break; // First occurrence per file; repeats add noise, not confidence.
    }
  }
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

const CONFIDENCE_ORDER: Readonly<Record<Confidence, number>> = { high: 0, medium: 1, low: 2 };

/** Run a rule table and return the matches, strongest evidence first. */
function runRules(
  context: Context,
  rules: readonly Rule[],
  options: RuleOptions = {},
): Detection[] {
  const out: Detection[] = [];

  for (const rule of rules) {
    const detection = evaluate(context, rule, options);
    if (detection) out.push(detection);
  }

  return out.sort(
    (a, b) =>
      CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
      a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Frameworks
// ---------------------------------------------------------------------------

const JS_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts'] as const;
const PY_EXTS = ['py'] as const;

/**
 * Extensions worth scanning for connection strings.
 *
 * Source files are the obvious half. The rest covers committed environment
 * templates, whose names are wildly inconsistent — `.env.example` has the
 * extension `example`, `.env.local` has `local`, and a bare `.env` has none at
 * all — so each variant has to be listed for the scan to reach them.
 */
const URL_EXTS = [
  'ts',
  'tsx',
  'js',
  'py',
  'go',
  'rs',
  'rb',
  'yml',
  'yaml',
  'env',
  'example',
  'sample',
  'template',
  'local',
  '',
] as const;

const FRAMEWORK_RULES: readonly Rule[] = [
  {
    name: 'Next.js',
    packages: [{ ecosystem: 'npm', name: 'next' }],
    paths: [/(^|\/)next\.config\.[cm]?[jt]s$/],
    versionFrom: { ecosystem: 'npm', name: 'next' },
  },
  {
    name: 'React',
    packages: [{ ecosystem: 'npm', name: 'react' }],
    content: [{ pattern: /\bfrom\s+['"]react['"]/, exts: JS_EXTS }],
    versionFrom: { ecosystem: 'npm', name: 'react' },
  },
  {
    name: 'Vue',
    packages: [{ ecosystem: 'npm', name: 'vue' }],
    paths: [/(^|\/)vue\.config\.[cm]?[jt]s$/, /\.vue$/],
    versionFrom: { ecosystem: 'npm', name: 'vue' },
  },
  {
    name: 'Nuxt',
    packages: [{ ecosystem: 'npm', name: /^nuxt3?$/ }],
    paths: [/(^|\/)nuxt\.config\.[cm]?[jt]s$/],
    versionFrom: { ecosystem: 'npm', name: /^nuxt3?$/ },
  },
  {
    name: 'Svelte',
    packages: [{ ecosystem: 'npm', name: 'svelte' }],
    paths: [/(^|\/)svelte\.config\.[cm]?js$/, /\.svelte$/],
    versionFrom: { ecosystem: 'npm', name: 'svelte' },
  },
  {
    name: 'SvelteKit',
    packages: [{ ecosystem: 'npm', name: '@sveltejs/kit' }],
    paths: [/(^|\/)src\/routes\/\+page\.svelte$/],
    versionFrom: { ecosystem: 'npm', name: '@sveltejs/kit' },
  },
  {
    name: 'Angular',
    packages: [{ ecosystem: 'npm', name: '@angular/core' }],
    paths: [/(^|\/)angular\.json$/],
    versionFrom: { ecosystem: 'npm', name: '@angular/core' },
  },
  {
    name: 'Astro',
    packages: [{ ecosystem: 'npm', name: 'astro' }],
    paths: [/(^|\/)astro\.config\.[cm]?[jt]s$/, /\.astro$/],
    versionFrom: { ecosystem: 'npm', name: 'astro' },
  },
  {
    name: 'Remix',
    packages: [{ ecosystem: 'npm', name: /^@remix-run\// }],
    paths: [/(^|\/)remix\.config\.[cm]?js$/],
    versionFrom: { ecosystem: 'npm', name: '@remix-run/react' },
  },
  {
    name: 'Express',
    packages: [{ ecosystem: 'npm', name: 'express' }],
    content: [{ pattern: /require\(['"]express['"]\)|from\s+['"]express['"]/, exts: JS_EXTS }],
    versionFrom: { ecosystem: 'npm', name: 'express' },
  },
  {
    name: 'Fastify',
    packages: [{ ecosystem: 'npm', name: 'fastify' }],
    content: [{ pattern: /require\(['"]fastify['"]\)|from\s+['"]fastify['"]/, exts: JS_EXTS }],
    versionFrom: { ecosystem: 'npm', name: 'fastify' },
  },
  {
    name: 'NestJS',
    packages: [{ ecosystem: 'npm', name: '@nestjs/core' }],
    paths: [/(^|\/)nest-cli\.json$/],
    versionFrom: { ecosystem: 'npm', name: '@nestjs/core' },
  },
  {
    name: 'Koa',
    packages: [{ ecosystem: 'npm', name: 'koa' }],
    content: [{ pattern: /require\(['"]koa['"]\)|from\s+['"]koa['"]/, exts: JS_EXTS }],
    versionFrom: { ecosystem: 'npm', name: 'koa' },
  },
  {
    name: 'Django',
    packages: [{ ecosystem: 'pypi', name: /^django$/i }],
    paths: [/(^|\/)manage\.py$/],
    content: [{ pattern: /\bfrom\s+django\b|\bimport\s+django\b/, exts: PY_EXTS }],
    versionFrom: { ecosystem: 'pypi', name: /^django$/i },
  },
  {
    name: 'Flask',
    packages: [{ ecosystem: 'pypi', name: /^flask$/i }],
    content: [{ pattern: /\bfrom\s+flask\s+import\b/, exts: PY_EXTS }],
    versionFrom: { ecosystem: 'pypi', name: /^flask$/i },
  },
  {
    name: 'FastAPI',
    packages: [{ ecosystem: 'pypi', name: /^fastapi$/i }],
    content: [{ pattern: /\bfrom\s+fastapi\s+import\b/, exts: PY_EXTS }],
    versionFrom: { ecosystem: 'pypi', name: /^fastapi$/i },
  },
  {
    name: 'Ruby on Rails',
    packages: [{ ecosystem: 'rubygems', name: 'rails' }],
    paths: [/(^|\/)config\/routes\.rb$/, /(^|\/)config\/application\.rb$/],
    versionFrom: { ecosystem: 'rubygems', name: 'rails' },
  },
  {
    name: 'Laravel',
    packages: [{ ecosystem: 'composer', name: 'laravel/framework' }],
    paths: [/(^|\/)artisan$/],
    versionFrom: { ecosystem: 'composer', name: 'laravel/framework' },
  },
  {
    name: 'Spring Boot',
    packages: [{ ecosystem: 'maven', name: /:spring-boot(-|$)/ }],
    paths: [/(^|\/)src\/main\/resources\/application\.(properties|ya?ml)$/],
    content: [{ pattern: /@SpringBootApplication\b/, exts: ['java', 'kt'] }],
  },
  {
    name: 'Gin',
    packages: [{ ecosystem: 'go', name: /^github\.com\/gin-gonic\/gin/ }],
    content: [{ pattern: /gin\.(Default|New)\(\)/, exts: ['go'] }],
  },
  {
    name: 'Echo',
    packages: [{ ecosystem: 'go', name: /^github\.com\/labstack\/echo/ }],
    content: [{ pattern: /echo\.New\(\)/, exts: ['go'] }],
  },
  {
    name: 'Actix Web',
    packages: [{ ecosystem: 'cargo', name: 'actix-web' }],
    content: [{ pattern: /\buse\s+actix_web\b/, exts: ['rs'] }],
    versionFrom: { ecosystem: 'cargo', name: 'actix-web' },
  },
  {
    name: 'Axum',
    packages: [{ ecosystem: 'cargo', name: 'axum' }],
    content: [{ pattern: /\buse\s+axum\b/, exts: ['rs'] }],
    versionFrom: { ecosystem: 'cargo', name: 'axum' },
  },
  {
    name: '.NET',
    paths: [/\.(csproj|fsproj|vbproj|sln)$/],
    content: [{ pattern: /\busing\s+Microsoft\.AspNetCore\b/, exts: ['cs'] }],
  },
];

// ---------------------------------------------------------------------------
// Package managers
// ---------------------------------------------------------------------------

const PACKAGE_MANAGER_RULES: readonly Rule[] = [
  { name: 'pnpm', paths: [/(^|\/)pnpm-lock\.yaml$/, /(^|\/)pnpm-workspace\.yaml$/] },
  { name: 'npm', paths: [/(^|\/)package-lock\.json$/, /(^|\/)npm-shrinkwrap\.json$/] },
  { name: 'Yarn', paths: [/(^|\/)yarn\.lock$/, /(^|\/)\.yarnrc\.ya?ml$/] },
  { name: 'Bun', paths: [/(^|\/)bun\.lockb?$/, /(^|\/)bunfig\.toml$/] },
  { name: 'pip', paths: [/(^|\/)requirements[a-z.\-_]*\.txt$/, /(^|\/)Pipfile$/] },
  { name: 'Poetry', paths: [/(^|\/)poetry\.lock$/] },
  { name: 'uv', paths: [/(^|\/)uv\.lock$/] },
  { name: 'Cargo', paths: [/(^|\/)Cargo\.toml$/, /(^|\/)Cargo\.lock$/] },
  { name: 'Go modules', paths: [/(^|\/)go\.mod$/, /(^|\/)go\.work$/] },
  { name: 'Bundler', paths: [/(^|\/)Gemfile$/, /(^|\/)Gemfile\.lock$/] },
  { name: 'Composer', paths: [/(^|\/)composer\.json$/] },
  { name: 'Maven', paths: [/(^|\/)pom\.xml$/, /(^|\/)mvnw$/] },
  { name: 'Gradle', paths: [/(^|\/)build\.gradle(\.kts)?$/, /(^|\/)settings\.gradle(\.kts)?$/] },
];

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

const CI_RULES: readonly Rule[] = [
  { name: 'GitHub Actions', paths: [/^\.github\/workflows\/[^/]+\.ya?ml$/] },
  { name: 'GitLab CI', paths: [/(^|\/)\.gitlab-ci\.ya?ml$/] },
  { name: 'CircleCI', paths: [/^\.circleci\/config\.ya?ml$/] },
  { name: 'Travis CI', paths: [/(^|\/)\.travis\.ya?ml$/] },
  { name: 'Jenkins', paths: [/(^|\/)Jenkinsfile[^/]*$/] },
  { name: 'Azure Pipelines', paths: [/(^|\/)azure-pipelines[^/]*\.ya?ml$/] },
  { name: 'Drone CI', paths: [/(^|\/)\.drone\.ya?ml$/] },
  { name: 'Woodpecker CI', paths: [/^\.woodpecker(\.ya?ml|\/[^/]+\.ya?ml)$/] },
];

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

const DEPLOYMENT_RULES: readonly Rule[] = [
  {
    name: 'Vercel',
    packages: [{ ecosystem: 'npm', name: /^@vercel\// }],
    paths: [/(^|\/)vercel\.json$/, /^\.vercel\//],
  },
  { name: 'Netlify', paths: [/(^|\/)netlify\.toml$/, /(^|\/)netlify\/functions\//] },
  { name: 'Fly.io', paths: [/(^|\/)fly\.toml$/] },
  { name: 'Railway', paths: [/(^|\/)railway\.(json|toml)$/] },
  { name: 'Render', paths: [/(^|\/)render\.ya?ml$/] },
  { name: 'Heroku', paths: [/(^|\/)Procfile$/, /(^|\/)app\.json$/] },
  {
    name: 'Docker',
    paths: [/(^|\/)Dockerfile[^/]*$/, /(^|\/)docker-compose[^/]*\.ya?ml$/, /(^|\/)\.dockerignore$/],
  },
  {
    name: 'Kubernetes',
    paths: [
      /^(k8s|kubernetes|manifests|charts)\//,
      /(^|\/)Chart\.ya?ml$/,
      /(^|\/)skaffold\.ya?ml$/,
    ],
    content: [{ pattern: /^apiVersion:\s*(apps|batch|networking)/m, exts: ['yaml', 'yml'] }],
  },
  {
    name: 'AWS',
    packages: [{ ecosystem: 'npm', name: /^(aws-cdk|@aws-sdk\/|aws-sdk$)/ }],
    paths: [/(^|\/)cdk\.json$/, /(^|\/)samconfig\.toml$/, /(^|\/)serverless\.ya?ml$/],
    content: [{ pattern: /AWS::Serverless-\d{4}-\d{2}-\d{2}/, exts: ['yaml', 'yml', 'json'] }],
  },
  {
    name: 'Cloudflare',
    packages: [{ ecosystem: 'npm', name: /^(wrangler|@cloudflare\/)/ }],
    paths: [/(^|\/)wrangler\.(toml|jsonc?)$/],
  },
  {
    name: 'Firebase',
    packages: [{ ecosystem: 'npm', name: /^(firebase|firebase-admin|firebase-functions)$/ }],
    paths: [/(^|\/)firebase\.json$/, /(^|\/)\.firebaserc$/],
  },
];

// ---------------------------------------------------------------------------
// Testing
// ---------------------------------------------------------------------------

const TESTING_RULES: readonly Rule[] = [
  {
    name: 'Vitest',
    packages: [{ ecosystem: 'npm', name: 'vitest' }],
    paths: [/(^|\/)vitest\.config\.[cm]?[jt]s$/],
    versionFrom: { ecosystem: 'npm', name: 'vitest' },
  },
  {
    name: 'Jest',
    packages: [{ ecosystem: 'npm', name: 'jest' }],
    paths: [/(^|\/)jest\.config\.[cm]?[jt]s$/, /(^|\/)jest\.setup\.[cm]?[jt]s$/],
    versionFrom: { ecosystem: 'npm', name: 'jest' },
  },
  {
    name: 'Mocha',
    packages: [{ ecosystem: 'npm', name: 'mocha' }],
    paths: [/(^|\/)\.mocharc\.(ya?ml|json|js|cjs)$/],
  },
  {
    name: 'Playwright',
    packages: [{ ecosystem: 'npm', name: /^(@playwright\/test|playwright)$/ }],
    paths: [/(^|\/)playwright\.config\.[cm]?[jt]s$/],
    versionFrom: { ecosystem: 'npm', name: '@playwright/test' },
  },
  {
    name: 'Cypress',
    packages: [{ ecosystem: 'npm', name: 'cypress' }],
    paths: [/(^|\/)cypress\.config\.[cm]?[jt]s$/, /^cypress\//],
    versionFrom: { ecosystem: 'npm', name: 'cypress' },
  },
  {
    name: 'Testing Library',
    packages: [{ ecosystem: 'npm', name: /^@testing-library\// }],
    content: [{ pattern: /from\s+['"]@testing-library\//, exts: JS_EXTS }],
  },
  {
    name: 'pytest',
    packages: [{ ecosystem: 'pypi', name: /^pytest$/i }],
    paths: [/(^|\/)pytest\.ini$/, /(^|\/)conftest\.py$/],
  },
  {
    name: 'unittest',
    content: [{ pattern: /^\s*import\s+unittest\b|^\s*from\s+unittest\b/m, exts: PY_EXTS }],
  },
  { name: 'Go testing', paths: [/_test\.go$/] },
  {
    name: 'RSpec',
    packages: [{ ecosystem: 'rubygems', name: /^rspec(-rails)?$/ }],
    paths: [/(^|\/)\.rspec$/, /^spec\/spec_helper\.rb$/],
  },
  {
    name: 'JUnit',
    packages: [{ ecosystem: 'maven', name: /(^|:)junit(-|:|$)/ }],
    content: [{ pattern: /\bimport\s+org\.junit\b/, exts: ['java', 'kt'] }],
  },
  {
    name: 'PHPUnit',
    packages: [{ ecosystem: 'composer', name: 'phpunit/phpunit' }],
    paths: [/(^|\/)phpunit\.xml(\.dist)?$/],
  },
];

// ---------------------------------------------------------------------------
// Databases and data access
// ---------------------------------------------------------------------------

const DATABASE_RULES: readonly Rule[] = [
  {
    name: 'PostgreSQL',
    packages: [
      { ecosystem: 'npm', name: /^(pg|postgres|@neondatabase\/serverless)$/ },
      { ecosystem: 'pypi', name: /^psycopg2?(-binary)?$/i },
      { ecosystem: 'go', name: /^(github\.com\/lib\/pq|github\.com\/jackc\/pgx)/ },
      { ecosystem: 'cargo', name: 'tokio-postgres' },
    ],
    content: [{ pattern: /postgres(ql)?:\/\//, exts: URL_EXTS }],
  },
  {
    name: 'MySQL',
    packages: [
      { ecosystem: 'npm', name: /^mysql2?$/ },
      { ecosystem: 'pypi', name: /^(pymysql|mysqlclient)$/i },
      { ecosystem: 'go', name: /^github\.com\/go-sql-driver\/mysql/ },
    ],
    content: [{ pattern: /mysql:\/\//, exts: URL_EXTS }],
  },
  {
    name: 'SQLite',
    packages: [
      { ecosystem: 'npm', name: /^(better-sqlite3|sqlite3|@libsql\/client)$/ },
      { ecosystem: 'pypi', name: /^aiosqlite$/i },
      { ecosystem: 'go', name: /sqlite/ },
    ],
    paths: [/\.(sqlite3?|db)$/],
    content: [{ pattern: /sqlite:\/\/|sqlite3\.connect\(/, exts: URL_EXTS }],
  },
  {
    name: 'MongoDB',
    packages: [
      { ecosystem: 'npm', name: /^(mongodb|mongoose)$/ },
      { ecosystem: 'pypi', name: /^(pymongo|motor)$/i },
    ],
    content: [{ pattern: /mongodb(\+srv)?:\/\//, exts: URL_EXTS }],
  },
  {
    name: 'Redis',
    packages: [
      { ecosystem: 'npm', name: /^(redis|ioredis|@upstash\/redis)$/ },
      { ecosystem: 'pypi', name: /^redis$/i },
      { ecosystem: 'go', name: /redis/ },
    ],
    content: [{ pattern: /rediss?:\/\//, exts: URL_EXTS }],
  },
  {
    name: 'Supabase',
    packages: [{ ecosystem: 'npm', name: /^@supabase\// }],
    paths: [/^supabase\/config\.toml$/, /^supabase\/migrations\//],
  },
  {
    name: 'Prisma',
    packages: [{ ecosystem: 'npm', name: /^(prisma|@prisma\/client)$/ }],
    paths: [/(^|\/)schema\.prisma$/],
    versionFrom: { ecosystem: 'npm', name: '@prisma/client' },
  },
  {
    name: 'Drizzle',
    packages: [{ ecosystem: 'npm', name: /^drizzle-(orm|kit)$/ }],
    paths: [/(^|\/)drizzle\.config\.[cm]?[jt]s$/],
    versionFrom: { ecosystem: 'npm', name: 'drizzle-orm' },
  },
  {
    name: 'TypeORM',
    packages: [{ ecosystem: 'npm', name: 'typeorm' }],
    content: [{ pattern: /from\s+['"]typeorm['"]/, exts: JS_EXTS }],
  },
  {
    name: 'Sequelize',
    packages: [{ ecosystem: 'npm', name: 'sequelize' }],
    content: [{ pattern: /from\s+['"]sequelize['"]/, exts: JS_EXTS }],
  },
  {
    name: 'Mongoose',
    packages: [{ ecosystem: 'npm', name: 'mongoose' }],
    content: [{ pattern: /from\s+['"]mongoose['"]|require\(['"]mongoose['"]\)/, exts: JS_EXTS }],
  },
  {
    name: 'SQLAlchemy',
    packages: [{ ecosystem: 'pypi', name: /^sqlalchemy$/i }],
    content: [{ pattern: /\bfrom\s+sqlalchemy\b/i, exts: PY_EXTS }],
  },
  {
    name: 'ActiveRecord',
    packages: [{ ecosystem: 'rubygems', name: /^activerecord$/ }],
    paths: [/^db\/schema\.rb$/, /^db\/migrate\//],
    content: [{ pattern: /<\s*ActiveRecord::Base|ApplicationRecord\b/, exts: ['rb'] }],
  },
];

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

/**
 * Runtimes are detected by hand rather than through the rule table because the
 * interesting part is the **version**, and every ecosystem states it in a
 * different place: a JSON field, a bare-text dotfile, a directive inside a
 * manifest, or an XML element. Encoding that in a generic rule shape would have
 * produced a rule shape with one field per ecosystem, which is just this code
 * with extra indirection.
 *
 * Source files count as high confidence on their own: a repository containing
 * Go files runs Go, whether or not anything declares it.
 */
function detectRuntimes(context: Context): Detection[] {
  const out: Detection[] = [];
  const pkg = rootPackageJson(context);

  // --- Node.js ---
  {
    const evidence: string[] = [];
    const files: string[] = [];
    let version: string | undefined;

    const engines = asRecord(pkg?.json['engines']);
    const enginesNode = engines?.['node'];
    if (typeof enginesNode === 'string' && pkg) {
      evidence.push(`engines.node "${enginesNode}" in ${pkg.path}`);
      files.push(pkg.path);
      version = cleanVersion(enginesNode);
    }

    const nvmrc = findFile(context, /(^|\/)\.(nvmrc|node-version)$/);
    if (nvmrc?.content) {
      const declared = nvmrc.content.trim().split(/\s+/)[0] ?? '';
      evidence.push(`${nvmrc.path} pins ${declared}`);
      files.push(nvmrc.path);
      version ??= cleanVersion(declared);
    }

    if (evidence.length === 0 && pkg) {
      evidence.push(`${pkg.path} present`);
      files.push(pkg.path);
    }

    if (evidence.length > 0) {
      out.push(runtime('Node.js', evidence, files, version));
    }
  }

  // --- Deno ---
  {
    const config = findFile(context, /(^|\/)deno\.jsonc?$/);
    const lock = findFile(context, /(^|\/)deno\.lock$/);
    if (config ?? lock) {
      const hit = config ?? lock;
      out.push(runtime('Deno', [`${hit?.path ?? ''} present`], hit ? [hit.path] : []));
    }
  }

  // --- Bun ---
  {
    const evidence: string[] = [];
    const files: string[] = [];

    const marker = findFile(context, /(^|\/)(bun\.lockb?|bunfig\.toml)$/);
    if (marker) {
      evidence.push(`${marker.path} present`);
      files.push(marker.path);
    }

    const engines = asRecord(pkg?.json['engines']);
    if (typeof engines?.['bun'] === 'string' && pkg) {
      evidence.push(`engines.bun "${engines['bun']}" in ${pkg.path}`);
      files.push(pkg.path);
    }

    if (evidence.length > 0) out.push(runtime('Bun', evidence, files));
  }

  // --- Python ---
  {
    const evidence: string[] = [];
    const files: string[] = [];
    let version: string | undefined;

    const pyproject = findFile(context, /(^|\/)pyproject\.toml$/);
    const requires = pyproject?.content
      ? /requires-python\s*=\s*["']([^"']+)["']/.exec(pyproject.content)?.[1]
      : undefined;
    if (pyproject && requires) {
      evidence.push(`requires-python "${requires}" in ${pyproject.path}`);
      files.push(pyproject.path);
      version = requires;
    }

    const pythonVersion = findFile(context, /(^|\/)\.python-version$/);
    if (pythonVersion?.content) {
      const declared = pythonVersion.content.trim().split(/\s+/)[0] ?? '';
      evidence.push(`${pythonVersion.path} pins ${declared}`);
      files.push(pythonVersion.path);
      version ??= cleanVersion(declared);
    }

    const setup = findFile(context, /(^|\/)setup\.py$/);
    const setupRequires = setup?.content
      ? /python_requires\s*=\s*["']([^"']+)["']/.exec(setup.content)?.[1]
      : undefined;
    if (setup && setupRequires) {
      evidence.push(`python_requires "${setupRequires}" in ${setup.path}`);
      files.push(setup.path);
      version ??= setupRequires;
    }

    const sources = context.byExt.get('py') ?? [];
    if (sources.length > 0) {
      evidence.push(`${sources.length} Python source file${sources.length === 1 ? '' : 's'}`);
      const first = sources[0];
      if (first) files.push(first.path);
    }

    if (evidence.length > 0) out.push(runtime('Python', evidence, files, version));
  }

  // --- Go ---
  {
    const evidence: string[] = [];
    const files: string[] = [];
    let version: string | undefined;

    const goMod = findFile(context, /(^|\/)go\.mod$/);
    const declared = goMod?.content ? /^go\s+(\d[\d.]*)/m.exec(goMod.content)?.[1] : undefined;
    if (goMod) {
      evidence.push(declared ? `go ${declared} in ${goMod.path}` : `${goMod.path} present`);
      files.push(goMod.path);
      version = declared;
    }

    const sources = context.byExt.get('go') ?? [];
    if (sources.length > 0) {
      evidence.push(`${sources.length} Go source file${sources.length === 1 ? '' : 's'}`);
      const first = sources[0];
      if (first) files.push(first.path);
    }

    if (evidence.length > 0) out.push(runtime('Go', evidence, files, version));
  }

  // --- Rust ---
  {
    const evidence: string[] = [];
    const files: string[] = [];
    let version: string | undefined;

    const toolchain = findFile(context, /(^|\/)rust-toolchain(\.toml)?$/);
    const channel = toolchain?.content
      ? (/channel\s*=\s*["']([^"']+)["']/.exec(toolchain.content)?.[1] ??
        toolchain.content.trim().split(/\s+/)[0])
      : undefined;
    if (toolchain && channel) {
      evidence.push(`${toolchain.path} selects ${channel}`);
      files.push(toolchain.path);
      version = channel;
    }

    const cargo = findFile(context, /(^|\/)Cargo\.toml$/);
    if (cargo) {
      const edition = cargo.content
        ? /^\s*edition\s*=\s*["']([^"']+)["']/m.exec(cargo.content)?.[1]
        : undefined;
      evidence.push(edition ? `Rust ${edition} edition in ${cargo.path}` : `${cargo.path} present`);
      files.push(cargo.path);
    }

    const sources = context.byExt.get('rs') ?? [];
    if (sources.length > 0) {
      evidence.push(`${sources.length} Rust source file${sources.length === 1 ? '' : 's'}`);
      const first = sources[0];
      if (first) files.push(first.path);
    }

    if (evidence.length > 0) out.push(runtime('Rust', evidence, files, version));
  }

  // --- Java ---
  {
    const evidence: string[] = [];
    const files: string[] = [];
    let version: string | undefined;

    const pom = findFile(context, /(^|\/)pom\.xml$/);
    const pomVersion = pom?.content
      ? (/<maven\.compiler\.(?:source|release)>([^<]+)</.exec(pom.content)?.[1] ??
        /<java\.version>([^<]+)</.exec(pom.content)?.[1])
      : undefined;
    if (pom) {
      evidence.push(
        pomVersion ? `Java ${pomVersion} target in ${pom.path}` : `${pom.path} present`,
      );
      files.push(pom.path);
      version = pomVersion;
    }

    const gradle = findFile(context, /(^|\/)build\.gradle(\.kts)?$/);
    const gradleVersion = gradle?.content
      ? (/(?:sourceCompatibility|targetCompatibility)\s*=?\s*["']?(?:JavaVersion\.VERSION_)?([\d._]+)/.exec(
          gradle.content,
        )?.[1] ??
        /languageVersion\s*=\s*JavaLanguageVersion\.of\((\d+)\)/.exec(gradle.content)?.[1])
      : undefined;
    if (gradle) {
      evidence.push(
        gradleVersion ? `Java ${gradleVersion} target in ${gradle.path}` : `${gradle.path} present`,
      );
      files.push(gradle.path);
      version ??= gradleVersion?.replace(/_/g, '.');
    }

    const sources = context.byExt.get('java') ?? [];
    if (sources.length > 0) {
      evidence.push(`${sources.length} Java source file${sources.length === 1 ? '' : 's'}`);
      const first = sources[0];
      if (first) files.push(first.path);
    }

    if (evidence.length > 0) out.push(runtime('Java', evidence, files, version));
  }

  // --- Ruby ---
  {
    const evidence: string[] = [];
    const files: string[] = [];
    let version: string | undefined;

    const rubyVersion = findFile(context, /(^|\/)\.ruby-version$/);
    if (rubyVersion?.content) {
      const declared = rubyVersion.content.trim().split(/\s+/)[0] ?? '';
      evidence.push(`${rubyVersion.path} pins ${declared}`);
      files.push(rubyVersion.path);
      version = cleanVersion(declared.replace(/^ruby-/, ''));
    }

    const gemfile = findFile(context, /(^|\/)Gemfile$/);
    const gemfileRuby = gemfile?.content
      ? /^\s*ruby\s+["']([^"']+)["']/m.exec(gemfile.content)?.[1]
      : undefined;
    if (gemfile) {
      evidence.push(
        gemfileRuby ? `ruby "${gemfileRuby}" in ${gemfile.path}` : `${gemfile.path} present`,
      );
      files.push(gemfile.path);
      version ??= cleanVersion(gemfileRuby ?? '');
    }

    const sources = context.byExt.get('rb') ?? [];
    if (sources.length > 0) {
      evidence.push(`${sources.length} Ruby source file${sources.length === 1 ? '' : 's'}`);
      const first = sources[0];
      if (first) files.push(first.path);
    }

    if (evidence.length > 0) out.push(runtime('Ruby', evidence, files, version));
  }

  // --- PHP ---
  {
    const evidence: string[] = [];
    const files: string[] = [];
    let version: string | undefined;

    const composer = findFile(context, /(^|\/)composer\.json$/);
    const composerJson = composer ? readJson(composer) : null;
    const require = asRecord(composerJson?.['require']);
    if (composer && typeof require?.['php'] === 'string') {
      evidence.push(`require.php "${require['php']}" in ${composer.path}`);
      files.push(composer.path);
      version = cleanVersion(require['php']);
    }

    const sources = context.byExt.get('php') ?? [];
    if (sources.length > 0) {
      evidence.push(`${sources.length} PHP source file${sources.length === 1 ? '' : 's'}`);
      const first = sources[0];
      if (first) files.push(first.path);
    }

    if (evidence.length > 0) out.push(runtime('PHP', evidence, files, version));
  }

  // --- .NET ---
  {
    const project = findFile(context, /\.(csproj|fsproj|vbproj)$/);
    if (project) {
      const target = project.content
        ? /<TargetFrameworks?>([^<]+)</.exec(project.content)?.[1]
        : undefined;
      out.push(
        runtime(
          '.NET',
          [target ? `TargetFramework ${target} in ${project.path}` : `${project.path} present`],
          [project.path],
          target?.split(';')[0],
        ),
      );
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function runtime(
  name: string,
  evidence: readonly string[],
  files: readonly string[],
  version?: string,
): Detection {
  return {
    name,
    confidence: 'high',
    evidence: dedupeStrings(evidence),
    files: dedupeStrings(files),
    ...(version === undefined || version === '' ? {} : { version }),
  };
}

// ---------------------------------------------------------------------------
// Shared file helpers
// ---------------------------------------------------------------------------

function findFile(context: Context, pattern: RegExp): RepoFile | undefined {
  return context.text.find((file) => pattern.test(file.path));
}

function findFiles(context: Context, pattern: RegExp): RepoFile[] {
  return context.text.filter((file) => pattern.test(file.path));
}

function readJson(file: RepoFile): Record<string, unknown> | null {
  if (file.content === null) return null;
  try {
    return asRecord(JSON.parse(file.content) as unknown);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The shallowest `package.json`, which in a monorepo is the workspace root.
 *
 * Root-level fields (`engines`, `packageManager`, `workspaces`) describe the
 * whole repository, so reading a nested package's manifest instead would
 * attribute one app's settings to the entire project.
 */
function rootPackageJson(
  context: Context,
): { readonly path: string; readonly json: Record<string, unknown> } | null {
  const candidates = findFiles(context, /(^|\/)package\.json$/).sort(
    (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
  );

  for (const file of candidates) {
    const json = readJson(file);
    if (json) return { path: file.path, json };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

/** Every directory that contains at least one file. */
function directorySet(context: Context): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const path of context.paths) {
    let dir = dirname(path);
    while (dir) {
      if (dirs.has(dir)) break;
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  return dirs;
}

/** True when a directory with this name exists anywhere in the repository. */
function hasDirectory(dirs: ReadonlySet<string>, name: string): boolean {
  for (const dir of dirs) {
    if (dir === name || dir.endsWith(`/${name}`)) return true;
  }
  return false;
}

const LAYER_DIRS = [
  'controllers',
  'services',
  'repositories',
  'models',
  'entities',
  'domain',
  'application',
  'infrastructure',
  'usecases',
  'handlers',
] as const;

/**
 * Classify the repository into a single architectural style.
 *
 * The styles overlap in reality — a Turborepo of serverless functions is
 * genuinely all three — so the checks run in a fixed precedence order and the
 * first decisive one wins. The order runs from *most specific evidence* to
 * *least*: `services/` plus several Dockerfiles is a narrower claim than a
 * workspace field, which is narrower than "there is source code here".
 *
 * `monolith` is the honest fallback for a repository with code and no
 * distinguishing structure; `unknown` is reserved for a repository with nothing
 * to classify, because reporting "monolith" for an empty repo would be a
 * fabrication.
 */
function detectArchitecture(
  context: Context,
  pkg: { readonly path: string; readonly json: Record<string, unknown> } | null,
): StackDetection['architecture'] {
  const dirs = directorySet(context);
  const evidence: string[] = [];

  // --- microservices ---
  const dockerfiles = findFiles(context, /(^|\/)Dockerfile[^/]*$/);
  if (dockerfiles.length >= 2 && hasDirectory(dirs, 'services')) {
    evidence.push(`${dockerfiles.length} Dockerfiles across the repository`);
    for (const file of dockerfiles.slice(0, 4)) evidence.push(`${file.path} present`);
    evidence.push('a services/ directory groups independently deployable units');
    return { style: 'microservices', confidence: 'high', evidence };
  }

  // --- monorepo ---
  const workspaceMarker = findFile(
    context,
    /^(pnpm-workspace\.yaml|turbo\.json|nx\.json|lerna\.json|go\.work|rush\.json)$/,
  );
  if (workspaceMarker) evidence.push(`${workspaceMarker.path} present`);

  if (pkg && pkg.json['workspaces'] !== undefined) {
    evidence.push(`workspaces field in ${pkg.path}`);
  }

  const cargoRoot = findFile(context, /^Cargo\.toml$/);
  if (cargoRoot?.content && /^\s*\[workspace\]/m.test(cargoRoot.content)) {
    evidence.push(`[workspace] table in ${cargoRoot.path}`);
  }

  if (evidence.length > 0) {
    const packageCount = findFiles(context, /(^|\/)package\.json$/).length;
    if (packageCount > 1) evidence.push(`${packageCount} package.json manifests`);
    return { style: 'monorepo', confidence: 'high', evidence };
  }

  // --- serverless ---
  const serverlessMarker = findFile(
    context,
    /(^|\/)(serverless\.ya?ml|cdk\.json|samconfig\.toml|wrangler\.(toml|jsonc?))$/,
  );
  if (serverlessMarker) evidence.push(`${serverlessMarker.path} present`);

  const functionsDir = ['netlify/functions', 'functions', 'api'].find((name) => dirs.has(name));
  const samTemplate = findFiles(context, /(^|\/)template\.ya?ml$/).find((file) =>
    file.content ? /AWS::Serverless-/.test(file.content) : false,
  );
  if (samTemplate) evidence.push(`${samTemplate.path} declares an AWS SAM transform`);
  if (serverlessMarker && functionsDir) evidence.push(`${functionsDir}/ holds function handlers`);

  if (serverlessMarker ?? samTemplate) {
    return { style: 'serverless', confidence: 'high', evidence };
  }

  // --- cli ---
  const bin = pkg?.json['bin'];
  if (pkg && bin !== undefined) {
    const names = asRecord(bin);
    evidence.push(
      names
        ? `bin field in ${pkg.path} exposes ${Object.keys(names).join(', ')}`
        : `bin field in ${pkg.path}`,
    );
  }

  const goMain = findFile(context, /^cmd\/[^/]+\/main\.go$/);
  if (goMain) evidence.push(`${goMain.path} follows the Go cmd/ convention`);

  const setupPy = findFile(context, /(^|\/)setup\.py$/);
  if (setupPy?.content && /console_scripts/.test(setupPy.content)) {
    evidence.push(`console_scripts entry point in ${setupPy.path}`);
  }

  const pyprojectScripts = findFile(context, /(^|\/)pyproject\.toml$/);
  if (pyprojectScripts?.content && /^\s*\[project\.scripts\]/m.test(pyprojectScripts.content)) {
    evidence.push(`[project.scripts] table in ${pyprojectScripts.path}`);
  }

  if (evidence.length > 0) return { style: 'cli', confidence: 'high', evidence };

  // --- library ---
  const hasAppSurface =
    dirs.has('app') ||
    dirs.has('src/app') ||
    dirs.has('pages') ||
    dirs.has('src/pages') ||
    hasDirectory(dirs, 'templates') ||
    findFile(context, /(^|\/)(next|nuxt|astro|vite)\.config\.[cm]?[jt]s$/) !== undefined;

  const exportsField =
    pkg &&
    (pkg.json['exports'] !== undefined ||
      pkg.json['main'] !== undefined ||
      pkg.json['module'] !== undefined);

  if (exportsField && !hasAppSurface && pkg) {
    const declared = ['exports', 'main', 'module', 'types'].filter(
      (field) => pkg.json[field] !== undefined,
    );
    evidence.push(`${pkg.path} declares ${declared.join(', ')} but no application entry`);
    return { style: 'library', confidence: 'medium', evidence };
  }

  // --- layered ---
  const layers = LAYER_DIRS.filter((name) => hasDirectory(dirs, name));
  if (layers.length >= 3) {
    evidence.push(`layer directories present: ${layers.join(', ')}`);
    return { style: 'layered', confidence: 'medium', evidence };
  }

  // --- modular ---
  for (const container of ['modules', 'features', 'packages', 'apps'] as const) {
    if (!dirs.has(container)) continue;
    const children = new Set<string>();
    for (const dir of dirs) {
      const match = new RegExp(`^${container}/([^/]+)$`).exec(dir);
      if (match?.[1]) children.add(match[1]);
    }
    if (children.size >= 3) {
      evidence.push(`${container}/ contains ${children.size} sibling modules`);
      return { style: 'modular', confidence: 'medium', evidence };
    }
  }

  if (layers.length > 0) {
    evidence.push(`layer directories present: ${layers.join(', ')}`);
    return { style: 'layered', confidence: 'low', evidence };
  }

  // --- monolith / unknown ---
  const sourceCount = context.text.length;
  if (sourceCount === 0) {
    return {
      style: 'unknown',
      confidence: 'low',
      evidence: ['no analyzable source files in the snapshot'],
    };
  }

  return {
    style: 'monolith',
    confidence: 'low',
    evidence: [
      `${sourceCount} source files in a single deployable tree`,
      'no workspace, service or module boundaries found',
    ],
  };
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

/**
 * Endpoints are the most citable thing GitBrain produces — a method, a path,
 * and a file:line a reader can open. That is only true if the line number is
 * right, so every scanner works line-by-line rather than over the whole file:
 * a whole-file regex would find the route but not where it lives.
 *
 * The cap exists because a large API repository can declare thousands of
 * routes, and a list that long is a data dump rather than an explanation. The
 * first 500 in path order are representative; the count is still visible from
 * the array length.
 */
const MAX_ENDPOINTS = 500;

const HTTP_VERBS = 'get|post|put|patch|delete|head|options';

/** `app.get('/users')`, `router.post('/users/:id')`, `fastify.delete(...)`. */
const NODE_ROUTE = new RegExp(
  `\\b(?:app|router|api|server|fastify|instance)\\s*\\.\\s*(${HTTP_VERBS}|del|all)\\s*\\(\\s*(['"\`])(/[^'"\`]*)\\2`,
  'i',
);

/** `@app.get("/users")`, `@router.post(...)`, `@bp.route("/x", methods=["POST"])`. */
const PY_ROUTE = new RegExp(
  `^\\s*@\\w+\\.(${HTTP_VERBS}|route)\\s*\\(\\s*(['"])([^'"]*)\\2(.*)$`,
  'i',
);

/** `http.HandleFunc("/x", h)`, `mux.Handle("/x", h)`. */
const GO_HANDLE = /\b\w*\.?(?:HandleFunc|Handle)\s*\(\s*"(\/[^"]*)"/;

/** `r.GET("/x", h)` — the chi / gin / echo router convention. */
const GO_VERB_ROUTE = /\b\w+\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"(\/[^"]*)"/;

const NEXT_APP_ROUTE_FILE = /(^|\/)app\/(.*\/)?route\.[jt]sx?$/;
const NEXT_PAGES_API_FILE = /(^|\/)pages\/api\/(.+)\.[jt]sx?$/;

const NEXT_METHOD_EXPORT =
  /^\s*export\s+(?:async\s+function|function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;

function findEndpoints(context: Context): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];

  scanNodeRoutes(context, out);
  scanNextAppRouter(context, out);
  scanNextPagesApi(context, out);
  scanPythonRoutes(context, out);
  scanGoRoutes(context, out);
  scanRailsRoutes(context, out);

  const seen = new Set<string>();
  const deduped: ApiEndpoint[] = [];

  for (const endpoint of out) {
    const key = `${endpoint.method} ${endpoint.path} ${endpoint.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(endpoint);
  }

  // File then line, with no third key: the sort is stable, so several routes
  // declared on one line — a Flask `methods=[...]` list, an expanded Rails
  // `resources` — keep the order the framework itself implies.
  deduped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return deduped.slice(0, MAX_ENDPOINTS);
}

/** Files worth scanning for routes: real source, never tests or fixtures. */
function routeCandidates(context: Context, exts: readonly string[]): RepoFile[] {
  return exts
    .flatMap((ext) => context.byExt.get(ext) ?? [])
    .filter((file) => !isTestFile(file.path));
}

function eachLine(file: RepoFile, visit: (line: string, lineNumber: number) => void): void {
  if (file.content === null) return;
  const lines = toLines(file.content);
  for (let i = 0; i < lines.length; i++) visit(lines[i] ?? '', i + 1);
}

function scanNodeRoutes(context: Context, out: ApiEndpoint[]): void {
  for (const file of routeCandidates(context, JS_EXTS)) {
    eachLine(file, (line, lineNumber) => {
      const match = NODE_ROUTE.exec(line);
      const verb = match?.[1];
      const path = match?.[3];
      if (!verb || !path) return;

      const method = verb.toLowerCase() === 'del' ? 'DELETE' : verb.toUpperCase();
      out.push({ method, path, file: file.path, line: lineNumber });
    });
  }
}

/**
 * Next.js App Router handlers.
 *
 * The URL is encoded in the directory path, not in the code, so the path is
 * reconstructed from the file location. Route groups `(marketing)`, private
 * folders `_lib` and parallel-route slots `@modal` all exist purely to organise
 * the filesystem and never appear in the URL, so they are dropped.
 */
function scanNextAppRouter(context: Context, out: ApiEndpoint[]): void {
  for (const file of routeCandidates(context, JS_EXTS)) {
    if (!NEXT_APP_ROUTE_FILE.test(file.path)) continue;

    const path = nextAppRoutePath(file.path);
    eachLine(file, (line, lineNumber) => {
      const method = NEXT_METHOD_EXPORT.exec(line)?.[1];
      if (!method) return;
      out.push({ method, path, file: file.path, line: lineNumber });
    });
  }
}

function nextAppRoutePath(filePath: string): string {
  const segments = filePath.split('/');
  const appIndex = segments.lastIndexOf('app');
  const tail = segments
    .slice(appIndex + 1, -1)
    .filter(
      (segment) =>
        !(segment.startsWith('(') && segment.endsWith(')')) &&
        !segment.startsWith('_') &&
        !segment.startsWith('@'),
    );

  return `/${tail.join('/')}`.replace(/\/$/, '') || '/';
}

/**
 * Next.js Pages Router API routes.
 *
 * A pages API module exports one default handler that serves every method and
 * branches on `req.method` internally, so there is no per-method declaration to
 * cite. `ALL` states exactly that rather than guessing GET.
 */
function scanNextPagesApi(context: Context, out: ApiEndpoint[]): void {
  for (const file of routeCandidates(context, JS_EXTS)) {
    const match = NEXT_PAGES_API_FILE.exec(file.path);
    const rest = match?.[2];
    if (!rest) continue;

    const path = `/api/${rest}`.replace(/\/index$/, '') || '/api';

    let line = 1;
    eachLine(file, (text, lineNumber) => {
      if (line === 1 && /^\s*export\s+default\b/.test(text)) line = lineNumber;
    });

    out.push({ method: 'ALL', path, file: file.path, line });
  }
}

function scanPythonRoutes(context: Context, out: ApiEndpoint[]): void {
  for (const file of routeCandidates(context, PY_EXTS)) {
    eachLine(file, (line, lineNumber) => {
      const match = PY_ROUTE.exec(line);
      const verb = match?.[1];
      const path = match?.[3];
      if (!verb || path === undefined) return;

      // Flask's `@app.route` carries its verbs in a `methods=` keyword and
      // defaults to GET when the argument is omitted.
      if (verb.toLowerCase() === 'route') {
        const methods = /methods\s*=\s*\[([^\]]*)\]/.exec(match?.[4] ?? '')?.[1];
        const verbs = methods
          ? [...methods.matchAll(/['"](\w+)['"]/g)].map((entry) => (entry[1] ?? '').toUpperCase())
          : ['GET'];
        for (const method of verbs) {
          if (method) out.push({ method, path, file: file.path, line: lineNumber });
        }
        return;
      }

      out.push({ method: verb.toUpperCase(), path, file: file.path, line: lineNumber });
    });
  }
}

function scanGoRoutes(context: Context, out: ApiEndpoint[]): void {
  for (const file of routeCandidates(context, ['go'])) {
    eachLine(file, (line, lineNumber) => {
      const verbMatch = GO_VERB_ROUTE.exec(line);
      const verbPath = verbMatch?.[2];
      if (verbMatch?.[1] && verbPath) {
        out.push({ method: verbMatch[1], path: verbPath, file: file.path, line: lineNumber });
        return;
      }

      // `HandleFunc` registers one handler for every method; the handler
      // switches on `r.Method` internally, so `ALL` is the accurate label.
      const handlePath = GO_HANDLE.exec(line)?.[1];
      if (handlePath) {
        out.push({ method: 'ALL', path: handlePath, file: file.path, line: lineNumber });
      }
    });
  }
}

/**
 * Rails `config/routes.rb`.
 *
 * `resources :photos` is expanded into the five routes that carry data. The two
 * remaining default routes (`new` and `edit`) render HTML forms rather than
 * exposing an API surface, so they are omitted to keep the endpoint list about
 * the API rather than about the scaffolding.
 */
function scanRailsRoutes(context: Context, out: ApiEndpoint[]): void {
  for (const file of routeCandidates(context, ['rb'])) {
    if (basename(file.path) !== 'routes.rb') continue;

    eachLine(file, (line, lineNumber) => {
      const verb = new RegExp(`^\\s*(${HTTP_VERBS})\\s+['"]([^'"]+)['"]`, 'i').exec(line);
      const verbPath = verb?.[2];
      if (verb?.[1] && verbPath) {
        out.push({
          method: verb[1].toUpperCase(),
          path: verbPath.startsWith('/') ? verbPath : `/${verbPath}`,
          file: file.path,
          line: lineNumber,
        });
        return;
      }

      if (/^\s*root\b/.test(line)) {
        out.push({ method: 'GET', path: '/', file: file.path, line: lineNumber });
        return;
      }

      const resource = /^\s*resources\s+:(\w+)/.exec(line)?.[1];
      if (!resource) return;

      const collection = `/${resource}`;
      const member = `/${resource}/:id`;
      for (const [method, path] of [
        ['GET', collection],
        ['POST', collection],
        ['GET', member],
        ['PATCH', member],
        ['DELETE', member],
      ] as const) {
        out.push({ method, path, file: file.path, line: lineNumber });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// API style
// ---------------------------------------------------------------------------

interface ApiSignal {
  readonly style: ApiStyle;
  readonly evidence: readonly string[];
  /** True when a manifest or a dedicated file proved it, not just a grep. */
  readonly strong: boolean;
}

/**
 * Choose one API style, keeping every signal as evidence.
 *
 * Precedence puts the specialised transports first because they all *also* run
 * over HTTP: a tRPC or GraphQL server exposes an Express-style route handler,
 * so the REST scanner sees it too. Reporting "REST" for a GraphQL API because a
 * single `/graphql` route matched would be precisely wrong.
 */
const API_PRECEDENCE: readonly ApiStyle[] = ['trpc', 'graphql', 'grpc', 'rest', 'websocket'];

function detectApi(context: Context, endpoints: readonly ApiEndpoint[]): StackDetection['api'] {
  const signals: ApiSignal[] = [];

  const trpc = evaluate(context, {
    name: 'tRPC',
    packages: [{ ecosystem: 'npm', name: /^@trpc\// }],
    content: [{ pattern: /initTRPC\b/, exts: JS_EXTS }],
  });
  if (trpc)
    signals.push({ style: 'trpc', evidence: trpc.evidence, strong: trpc.confidence === 'high' });

  const graphql = evaluate(context, {
    name: 'GraphQL',
    packages: [
      {
        ecosystem: 'npm',
        name: /^(graphql|@apollo\/server|apollo-server.*|graphql-yoga|@nestjs\/graphql)$/,
      },
      { ecosystem: 'pypi', name: /^(strawberry-graphql|graphene)$/i },
      { ecosystem: 'rubygems', name: 'graphql' },
    ],
    paths: [/\.(graphql|gql)$/],
    content: [{ pattern: /\btype\s+Query\s*\{/, exts: ['ts', 'js', 'graphql'] }],
  });
  if (graphql) {
    signals.push({
      style: 'graphql',
      evidence: graphql.evidence,
      strong: graphql.confidence === 'high',
    });
  }

  const grpc = evaluate(context, {
    name: 'gRPC',
    packages: [
      { ecosystem: 'npm', name: /^@grpc\// },
      { ecosystem: 'pypi', name: /^grpcio/i },
      { ecosystem: 'go', name: /^google\.golang\.org\/grpc/ },
      { ecosystem: 'cargo', name: 'tonic' },
    ],
    paths: [/\.proto$/],
  });
  if (grpc)
    signals.push({ style: 'grpc', evidence: grpc.evidence, strong: grpc.confidence === 'high' });

  const websocket = evaluate(context, {
    name: 'WebSocket',
    packages: [
      { ecosystem: 'npm', name: /^(ws|socket\.io|socket\.io-client)$/ },
      { ecosystem: 'pypi', name: /^websockets$/i },
    ],
    content: [{ pattern: /new WebSocket\(|WebSocketServer\b/, exts: JS_EXTS }],
  });
  if (websocket) {
    signals.push({
      style: 'websocket',
      evidence: websocket.evidence,
      strong: websocket.confidence === 'high',
    });
  }

  const restEvidence: string[] = [];
  const openapi = findFile(context, /(^|\/)(openapi|swagger)\.(ya?ml|json)$/);
  if (openapi) restEvidence.push(`${openapi.path} present`);
  if (endpoints.length > 0) {
    restEvidence.push(`${endpoints.length} HTTP route declarations found`);
    for (const endpoint of endpoints.slice(0, 5)) {
      restEvidence.push(`${endpoint.method} ${endpoint.path} (${endpoint.file}:${endpoint.line})`);
    }
  }
  if (restEvidence.length > 0) {
    signals.push({ style: 'rest', evidence: restEvidence, strong: true });
  }

  const evidence = signals.flatMap((signal) => signal.evidence);

  for (const style of API_PRECEDENCE) {
    const signal = signals.find((candidate) => candidate.style === style);
    if (!signal) continue;
    return {
      style,
      confidence: signal.strong ? 'high' : 'medium',
      evidence: dedupeStrings(evidence),
      endpoints,
    };
  }

  // An empty snapshot cannot be said to have "no API" — there is nothing to
  // look at. `none` is a finding; `unknown` is an absence of one.
  return {
    style: context.text.length === 0 ? 'unknown' : 'none',
    confidence: 'low',
    evidence:
      context.text.length === 0
        ? ['no analyzable source files in the snapshot']
        : ['no route declarations, schema files or RPC definitions found'],
    endpoints,
  };
}

// ---------------------------------------------------------------------------
// Package managers
// ---------------------------------------------------------------------------

/**
 * Package managers, with the Corepack `packageManager` field folded in.
 *
 * That field is the single most authoritative statement a JS repository makes
 * about its package manager — it pins an exact version and Corepack enforces
 * it — so it is merged into the lockfile-derived detection rather than being
 * reported as a separate finding.
 */
function detectPackageManagers(
  context: Context,
  pkg: { readonly path: string; readonly json: Record<string, unknown> } | null,
): Detection[] {
  const detections = runRules(context, PACKAGE_MANAGER_RULES);
  const declared = pkg?.json['packageManager'];
  if (typeof declared !== 'string') return detections;

  const [name, version] = declared.split('@');
  if (!name) return detections;

  const canonical = name.toLowerCase() === 'yarn' ? 'Yarn' : name.toLowerCase();
  const evidence = `packageManager "${declared}" in ${pkg?.path ?? 'package.json'}`;
  const index = detections.findIndex(
    (detection) => detection.name.toLowerCase() === canonical.toLowerCase(),
  );

  const merged: Detection = {
    name: canonical,
    confidence: 'high',
    evidence: dedupeStrings([evidence, ...(detections[index]?.evidence ?? [])]),
    files: dedupeStrings([pkg?.path ?? 'package.json', ...(detections[index]?.files ?? [])]),
    ...(version ? { version } : {}),
  };

  if (index === -1) return [merged, ...detections];

  const copy = [...detections];
  copy[index] = merged;
  return copy;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Detect the repository's stack.
 *
 * Takes the already-computed `DependencyReport` rather than re-parsing
 * manifests: dependency declarations are the strongest evidence available, and
 * parsing them twice would risk the two views disagreeing about what the repo
 * declares.
 */
export function detectStack(snapshot: RepoSnapshot, deps: DependencyReport): StackDetection {
  const context = buildContext(snapshot, deps);
  const pkg = rootPackageJson(context);
  const endpoints = findEndpoints(context);

  return {
    // Frameworks are the one category where a devDependency is weak evidence:
    // test harnesses pull in real servers. Testing, CI and package managers
    // legitimately live in devDependencies and keep full confidence.
    frameworks: runRules(context, FRAMEWORK_RULES, { devEvidenceIsWeak: true }),
    packageManagers: detectPackageManagers(context, pkg),
    ci: runRules(context, CI_RULES),
    deployment: runRules(context, DEPLOYMENT_RULES),
    testing: runRules(context, TESTING_RULES),
    databases: runRules(context, DATABASE_RULES),
    runtimes: detectRuntimes(context),
    architecture: detectArchitecture(context, pkg),
    api: detectApi(context, endpoints),
  };
}
