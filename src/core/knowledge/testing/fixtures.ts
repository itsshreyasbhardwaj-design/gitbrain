/**
 * Hand-built `KnowledgeContext` fixtures for the knowledge engine's tests.
 *
 * These are constructed directly from `src/core/types.ts` rather than by
 * running the detectors, the graph builder or the health scorer. That is
 * deliberate: it keeps the knowledge tests honest about the *contract* they
 * consume, and it means a change in a detector's heuristics cannot silently
 * rewrite what these tests assert.
 *
 * Only `src/core/search` and `src/core/testing/fixtures` are borrowed, because
 * a real inverted index is cheap to build and a fake one would prove nothing.
 */

import type {
  ComplexityReport,
  DependencyReport,
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
} from '../../types';
import { buildSearchIndex } from '../../search';
import { makeFile, makeSnapshot } from '../../testing/fixtures';
import type { KnowledgeContext } from '../context';

export const RICH_FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify(
    {
      name: 'orbit-api',
      version: '2.4.0',
      description: 'Booking API for the Orbit scheduling product.',
      license: 'MIT',
      engines: { node: '>=20.11.0' },
      scripts: {
        dev: 'tsx watch src/server.ts',
        build: 'tsc -p tsconfig.json',
        start: 'node dist/server.js',
        test: 'vitest run',
        lint: 'eslint .',
      },
      dependencies: { express: '^4.19.2', jsonwebtoken: '^9.0.2', pg: '^8.11.5' },
      devDependencies: { vitest: '^3.2.4', typescript: '^5.9.3' },
    },
    null,
    2,
  ),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  '.env.example': 'DATABASE_URL=\nPORT=3000\n',
  'README.md': [
    '# Orbit API',
    '',
    '[![build](https://img.shields.io/badge/build-passing-green)](https://example.com)',
    '',
    'Orbit API is the booking service behind the Orbit scheduling product. It exposes a',
    'REST interface for reservations and manages availability windows.',
    '',
    '## Install',
    '',
    '```bash',
    'pnpm install',
    '```',
  ].join('\n'),
  Dockerfile: [
    'FROM node:20-alpine AS build',
    'WORKDIR /app',
    'COPY . .',
    'RUN npm ci && npm run build',
    '',
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY --from=build /app/dist ./dist',
    'EXPOSE 3000',
    'CMD ["node", "dist/server.js"]',
  ].join('\n'),
  '.github/workflows/ci.yml': [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: pnpm install',
    '      - run: pnpm test',
  ].join('\n'),
  'src/server.ts': [
    "import express from 'express';",
    "import { createBooking, listBookings } from './bookings/service';",
    "import { requireAuth } from './auth/session';",
    '',
    'const app = express();',
    'const port = process.env.PORT ?? 3000;',
    '',
    "app.get('/api/bookings', requireAuth, listBookings);",
    "app.post('/api/bookings', requireAuth, createBooking);",
    '',
    'app.listen(port);',
  ].join('\n'),
  'src/auth/session.ts': [
    "import jwt from 'jsonwebtoken';",
    '',
    'const secret = process.env.JWT_SECRET ?? "";',
    '',
    'export function issueToken(userId: string): string {',
    '  return jwt.sign({ sub: userId }, secret, { expiresIn: "1h" });',
    '}',
    '',
    'export function requireAuth(request: Request): boolean {',
    '  // TODO: support refresh tokens',
    '  return jwt.verify(String(request.headers), secret) !== null;',
    '}',
  ].join('\n'),
  'src/bookings/service.ts': [
    "import { query } from '../db/client';",
    '',
    'export async function listBookings() {',
    "  return query('SELECT * FROM bookings');",
    '}',
    '',
    'export async function createBooking(input: { slot: string }) {',
    "  return query('INSERT INTO bookings (slot) VALUES ($1)', [input.slot]);",
    '}',
  ].join('\n'),
  'src/db/client.ts': [
    "import { Pool } from 'pg';",
    '',
    'const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
    '',
    'export function query(text: string, values: unknown[] = []) {',
    '  return pool.query(text, values);',
    '}',
  ].join('\n'),
  'db/schema.sql': [
    'CREATE TABLE bookings (',
    '  id SERIAL PRIMARY KEY,',
    '  slot TEXT NOT NULL',
    ');',
    '',
    'CREATE TABLE availability (',
    '  id SERIAL PRIMARY KEY',
    ');',
  ].join('\n'),
  'src/bookings/service.test.ts': [
    "import { describe, it } from 'vitest';",
    '',
    "describe('bookings', () => {",
    "  it('lists', () => {});",
    '});',
  ].join('\n'),
};

export const MINIMAL_FILES: Readonly<Record<string, string>> = {
  'main.py': ['def add(a, b):', '    return a + b', ''].join('\n'),
  'notes.txt': 'scratch notes\n',
};

function toRepoFiles(files: Readonly<Record<string, string>>): readonly RepoFile[] {
  return Object.entries(files).map(([path, content]) => makeFile(path, content));
}

function indexFor(files: Readonly<Record<string, string>>): SearchIndex {
  return buildSearchIndex(makeSnapshot({ ...files }));
}

const EMPTY_STACK: StackDetection = {
  frameworks: [],
  packageManagers: [],
  ci: [],
  deployment: [],
  testing: [],
  databases: [],
  runtimes: [],
  architecture: { style: 'unknown', confidence: 'low', evidence: [] },
  api: { style: 'none', confidence: 'low', evidence: [], endpoints: [] },
};

const EMPTY_DEPENDENCIES: DependencyReport = {
  dependencies: [],
  manifests: [],
  counts: { runtime: 0, dev: 0, peer: 0, optional: 0 },
  flagged: [],
  unpinned: [],
  hasLockfile: false,
};

const EMPTY_GRAPH: ModuleGraph = {
  nodes: [],
  edges: [],
  cycles: [],
  externals: [],
  orphans: [],
};

const EMPTY_COMPLEXITY: ComplexityReport = {
  files: [],
  totalLoc: 0,
  totalSloc: 0,
  averageComplexity: 0,
  hotspots: [],
  distribution: [],
};

const EMPTY_DEBT: TechDebtReport = {
  items: [],
  totalEstimatedHours: 0,
  markers: [],
  duplicates: [],
};

const EMPTY_SECURITY: SecurityReport = {
  secrets: [],
  envVars: [],
  undocumentedEnvVars: [],
  largeFiles: [],
  flaggedDependencies: [],
  risks: [],
  score: 100,
};

const EMPTY_README: ReadmeReport = {
  exists: false,
  path: null,
  wordCount: 0,
  score: 0,
  sections: [],
  missingSections: [],
  suggestions: [],
  hasBadges: false,
  hasCodeExamples: false,
  hasImages: false,
  generatedSections: [],
};

const EMPTY_HEALTH: HealthReport = {
  overall: 50,
  grade: 'C',
  scores: [],
  topSuggestions: [],
};

const EMPTY_STATS: RepoStats = {
  files: 0,
  directories: 0,
  totalBytes: 0,
  linesOfCode: 0,
  maxDepth: 0,
  configFiles: 0,
  testFiles: 0,
  documentationFiles: 0,
  testRatio: 0,
  commentRatio: 0,
};

const RICH_SOURCE: RepoSource = {
  kind: 'github',
  owner: 'orbit',
  repo: 'orbit-api',
  ref: 'main',
  url: 'https://github.com/orbit/orbit-api',
};

const RICH_LANGUAGES: readonly LanguageBreakdown[] = [
  { language: 'TypeScript', files: 6, bytes: 2400, percent: 92.3, color: '#3178c6' },
  { language: 'SQL', files: 1, bytes: 200, percent: 7.7, color: '#e38c00' },
];

const RICH_TREE: TreeNode = {
  name: '',
  path: '',
  type: 'dir',
  size: 4200,
  fileCount: 13,
  children: [
    {
      name: 'src',
      path: 'src',
      type: 'dir',
      size: 2200,
      fileCount: 5,
      language: 'TypeScript',
      purpose: 'Application source',
      children: [
        {
          name: 'auth',
          path: 'src/auth',
          type: 'dir',
          size: 500,
          fileCount: 1,
          language: 'TypeScript',
          purpose: 'Session issuing and verification',
          children: [
            {
              name: 'session.ts',
              path: 'src/auth/session.ts',
              type: 'file',
              size: 500,
              fileCount: 1,
            },
          ],
        },
        {
          name: 'bookings',
          path: 'src/bookings',
          type: 'dir',
          size: 900,
          fileCount: 2,
          language: 'TypeScript',
          purpose: 'Booking domain logic',
          children: [
            {
              name: 'service.ts',
              path: 'src/bookings/service.ts',
              type: 'file',
              size: 450,
              fileCount: 1,
            },
            {
              name: 'service.test.ts',
              path: 'src/bookings/service.test.ts',
              type: 'file',
              size: 450,
              fileCount: 1,
            },
          ],
        },
        {
          name: 'db',
          path: 'src/db',
          type: 'dir',
          size: 400,
          fileCount: 1,
          language: 'TypeScript',
          purpose: 'Database access',
          children: [
            { name: 'client.ts', path: 'src/db/client.ts', type: 'file', size: 400, fileCount: 1 },
          ],
        },
        { name: 'server.ts', path: 'src/server.ts', type: 'file', size: 400, fileCount: 1 },
      ],
    },
    {
      name: 'db',
      path: 'db',
      type: 'dir',
      size: 200,
      fileCount: 1,
      language: 'SQL',
      purpose: 'SQL schema',
      children: [
        { name: 'schema.sql', path: 'db/schema.sql', type: 'file', size: 200, fileCount: 1 },
      ],
    },
    {
      name: '.github',
      path: '.github',
      type: 'dir',
      size: 200,
      fileCount: 1,
      purpose: 'CI workflows',
      children: [
        {
          name: 'workflows',
          path: '.github/workflows',
          type: 'dir',
          size: 200,
          fileCount: 1,
          purpose: 'GitHub Actions pipelines',
          children: [
            {
              name: 'ci.yml',
              path: '.github/workflows/ci.yml',
              type: 'file',
              size: 200,
              fileCount: 1,
            },
          ],
        },
      ],
    },
    { name: 'package.json', path: 'package.json', type: 'file', size: 600, fileCount: 1 },
    { name: 'README.md', path: 'README.md', type: 'file', size: 400, fileCount: 1 },
    { name: 'Dockerfile', path: 'Dockerfile', type: 'file', size: 250, fileCount: 1 },
    { name: '.env.example', path: '.env.example', type: 'file', size: 30, fileCount: 1 },
    { name: 'pnpm-lock.yaml', path: 'pnpm-lock.yaml', type: 'file', size: 30, fileCount: 1 },
  ],
};

const RICH_GRAPH: ModuleGraph = {
  nodes: [
    {
      id: 'src/server.ts',
      label: 'server',
      path: 'src/server.ts',
      language: 'TypeScript',
      loc: 11,
      outDegree: 2,
      inDegree: 0,
      instability: 1,
      isEntry: true,
      isOrphan: false,
    },
    {
      id: 'src/bookings/service.ts',
      label: 'service',
      path: 'src/bookings/service.ts',
      language: 'TypeScript',
      loc: 9,
      outDegree: 1,
      inDegree: 1,
      instability: 0.5,
      isEntry: false,
      isOrphan: false,
    },
    {
      id: 'src/auth/session.ts',
      label: 'session',
      path: 'src/auth/session.ts',
      language: 'TypeScript',
      loc: 12,
      outDegree: 0,
      inDegree: 1,
      instability: 0,
      isEntry: false,
      isOrphan: false,
    },
    {
      id: 'src/db/client.ts',
      label: 'client',
      path: 'src/db/client.ts',
      language: 'TypeScript',
      loc: 7,
      outDegree: 0,
      inDegree: 1,
      instability: 0,
      isEntry: false,
      isOrphan: false,
    },
  ],
  edges: [
    {
      from: 'src/server.ts',
      to: 'src/bookings/service.ts',
      specifier: './bookings/service',
      circular: false,
    },
    {
      from: 'src/server.ts',
      to: 'src/auth/session.ts',
      specifier: './auth/session',
      circular: false,
    },
    {
      from: 'src/bookings/service.ts',
      to: 'src/db/client.ts',
      specifier: '../db/client',
      circular: false,
    },
  ],
  cycles: [],
  externals: [
    { name: 'express', count: 1, importers: ['src/server.ts'], undeclared: false },
    { name: 'jsonwebtoken', count: 1, importers: ['src/auth/session.ts'], undeclared: false },
    { name: 'pg', count: 1, importers: ['src/db/client.ts'], undeclared: false },
    { name: 'axios', count: 1, importers: ['src/bookings/service.ts'], undeclared: true },
  ],
  orphans: [],
};

const RICH_ENTRY_POINTS: readonly EntryPoint[] = [
  {
    path: 'src/server.ts',
    reason: 'package.json `scripts.dev` runs it directly',
    kind: 'server',
    confidence: 'high',
  },
  {
    path: '.github/workflows/ci.yml',
    reason: 'GitHub Actions workflow definition',
    kind: 'build',
    confidence: 'medium',
  },
];

const RICH_COMPLEXITY: ComplexityReport = {
  files: [
    {
      path: 'src/auth/session.ts',
      loc: 12,
      sloc: 9,
      cyclomatic: 6,
      maxNesting: 3,
      functions: 2,
      riskScore: 74,
    },
    {
      path: 'src/server.ts',
      loc: 11,
      sloc: 8,
      cyclomatic: 2,
      maxNesting: 1,
      functions: 0,
      riskScore: 30,
    },
    {
      path: 'src/bookings/service.ts',
      loc: 9,
      sloc: 7,
      cyclomatic: 3,
      maxNesting: 2,
      functions: 2,
      riskScore: 41,
    },
    {
      path: 'src/db/client.ts',
      loc: 7,
      sloc: 6,
      cyclomatic: 1,
      maxNesting: 1,
      functions: 1,
      riskScore: 18,
    },
  ],
  totalLoc: 39,
  totalSloc: 30,
  averageComplexity: 3,
  hotspots: [
    {
      path: 'src/auth/session.ts',
      loc: 12,
      sloc: 9,
      cyclomatic: 6,
      maxNesting: 3,
      functions: 2,
      riskScore: 74,
    },
    {
      path: 'src/bookings/service.ts',
      loc: 9,
      sloc: 7,
      cyclomatic: 3,
      maxNesting: 2,
      functions: 2,
      riskScore: 41,
    },
  ],
  distribution: [
    { bucket: 'low', count: 2 },
    { bucket: 'medium', count: 1 },
    { bucket: 'high', count: 1 },
  ],
};

/** A context with a realistic amount of everything. */
export function makeRichContext(): KnowledgeContext {
  return {
    source: RICH_SOURCE,
    stats: {
      files: 13,
      directories: 6,
      totalBytes: 4200,
      linesOfCode: 96,
      maxDepth: 3,
      configFiles: 5,
      testFiles: 1,
      documentationFiles: 1,
      testRatio: 0.2,
      commentRatio: 0.15,
    },
    languages: RICH_LANGUAGES,
    stack: {
      frameworks: [
        {
          name: 'Express',
          confidence: 'high',
          evidence: ['express@^4.19.2 in package.json dependencies'],
          files: ['package.json', 'src/server.ts'],
          version: '4.19.2',
        },
      ],
      packageManagers: [
        {
          name: 'pnpm',
          confidence: 'high',
          evidence: ['pnpm-lock.yaml is committed'],
          files: ['pnpm-lock.yaml'],
        },
      ],
      ci: [
        {
          name: 'GitHub Actions',
          confidence: 'high',
          evidence: ['.github/workflows/ci.yml'],
          files: ['.github/workflows/ci.yml'],
        },
      ],
      deployment: [
        {
          name: 'Docker',
          confidence: 'high',
          evidence: ['Dockerfile at the repository root'],
          files: ['Dockerfile'],
        },
      ],
      testing: [
        {
          name: 'Vitest',
          confidence: 'high',
          evidence: ['vitest@^3.2.4 in devDependencies'],
          files: ['package.json'],
        },
      ],
      databases: [
        {
          name: 'PostgreSQL',
          confidence: 'high',
          evidence: ['pg@^8.11.5 in dependencies', 'CREATE TABLE statements in db/schema.sql'],
          files: ['src/db/client.ts', 'db/schema.sql'],
        },
      ],
      runtimes: [
        {
          name: 'Node.js',
          confidence: 'high',
          evidence: ['engines.node >=20.11.0 in package.json'],
          files: ['package.json'],
          version: '>=20.11.0',
        },
      ],
      architecture: {
        style: 'layered',
        confidence: 'medium',
        evidence: ['Routing, domain and data-access layers are separate directories under src/'],
      },
      api: {
        style: 'rest',
        confidence: 'high',
        evidence: ['Express route registrations in src/server.ts'],
        endpoints: [
          { method: 'GET', path: '/api/bookings', file: 'src/server.ts', line: 8 },
          { method: 'POST', path: '/api/bookings', file: 'src/server.ts', line: 9 },
        ],
      },
    },
    dependencies: {
      dependencies: [
        {
          name: 'express',
          range: '^4.19.2',
          kind: 'runtime',
          manifest: 'package.json',
          ecosystem: 'npm',
        },
        {
          name: 'jsonwebtoken',
          range: '^9.0.2',
          kind: 'runtime',
          manifest: 'package.json',
          ecosystem: 'npm',
        },
        {
          name: 'pg',
          range: '^8.11.5',
          kind: 'runtime',
          manifest: 'package.json',
          ecosystem: 'npm',
        },
        {
          name: 'vitest',
          range: '^3.2.4',
          kind: 'dev',
          manifest: 'package.json',
          ecosystem: 'npm',
        },
        {
          name: 'typescript',
          range: '^5.9.3',
          kind: 'dev',
          manifest: 'package.json',
          ecosystem: 'npm',
        },
      ],
      manifests: ['package.json'],
      counts: { runtime: 3, dev: 2, peer: 0, optional: 0 },
      flagged: [
        {
          name: 'jsonwebtoken',
          reason: 'Versions below 9 allow algorithm confusion attacks',
          severity: 'medium',
          replacement: 'jose',
        },
      ],
      unpinned: [],
      hasLockfile: true,
    },
    tree: RICH_TREE,
    graph: RICH_GRAPH,
    entryPoints: RICH_ENTRY_POINTS,
    complexity: RICH_COMPLEXITY,
    debt: {
      items: [
        {
          id: 'debt-tests',
          title: 'Raise test coverage above the 20% file ratio',
          detail: 'Only one of five source files has an accompanying test.',
          severity: 'high',
          category: 'testing',
          files: ['src/auth/session.ts', 'src/db/client.ts'],
          estimatedHours: 12,
        },
        {
          id: 'debt-todo',
          title: 'Resolve the refresh-token TODO',
          detail: 'Session verification is incomplete without refresh support.',
          severity: 'medium',
          category: 'complexity',
          files: ['src/auth/session.ts'],
          estimatedHours: 3,
        },
      ],
      totalEstimatedHours: 15,
      markers: [
        {
          kind: 'TODO',
          file: 'src/auth/session.ts',
          line: 10,
          text: 'TODO: support refresh tokens',
        },
      ],
      duplicates: [
        {
          hash: 'a1b2c3d4',
          lineCount: 4,
          occurrences: [
            { file: 'src/bookings/service.ts', startLine: 3 },
            { file: 'src/db/client.ts', startLine: 5 },
          ],
        },
      ],
    },
    security: {
      secrets: [
        {
          id: 'secret-1',
          rule: 'Generic high-entropy string',
          file: 'src/auth/session.ts',
          line: 3,
          preview: 'sk_l********',
          severity: 'high',
          entropy: 4.2,
        },
      ],
      envVars: [
        { name: 'DATABASE_URL', files: ['src/db/client.ts'], documented: true },
        { name: 'PORT', files: ['src/server.ts'], documented: true },
        { name: 'JWT_SECRET', files: ['src/auth/session.ts'], documented: false },
      ],
      undocumentedEnvVars: ['JWT_SECRET'],
      largeFiles: [{ path: 'pnpm-lock.yaml', size: 30 }],
      flaggedDependencies: [
        {
          name: 'jsonwebtoken',
          reason: 'Versions below 9 allow algorithm confusion attacks',
          severity: 'medium',
          replacement: 'jose',
        },
      ],
      risks: [
        {
          id: 'risk-secret',
          title: 'Signing secret read from an undocumented variable',
          detail: 'JWT_SECRET is read at module load and defaults to an empty string.',
          severity: 'high',
          files: ['src/auth/session.ts'],
          recommendation: 'Fail fast when JWT_SECRET is unset and document it in .env.example.',
          reference: 'CWE-1188',
        },
      ],
      score: 62,
    },
    readme: {
      exists: true,
      path: 'README.md',
      wordCount: 42,
      score: 65,
      sections: [
        { name: 'Install', present: true, weight: 0.3 },
        {
          name: 'Usage',
          present: false,
          weight: 0.3,
          suggestion: 'Show a request/response example.',
        },
      ],
      missingSections: ['Usage', 'License'],
      suggestions: ['Add a usage section with a worked example.'],
      hasBadges: true,
      hasCodeExamples: true,
      hasImages: false,
      generatedSections: [{ name: 'Usage', markdown: '## Usage\n' }],
    },
    health: {
      overall: 68,
      grade: 'C',
      scores: [
        {
          dimension: 'testing',
          label: 'Testing',
          score: 40,
          grade: 'D',
          rationale: ['Only 20% of source files have a colocated test'],
          suggestions: [
            {
              id: 'sug-tests',
              title: 'Add tests for the auth and database layers',
              detail: 'Both are untested and both are on every request path.',
              impact: 'high',
              effort: 'medium',
              files: ['src/auth/session.ts', 'src/db/client.ts'],
            },
          ],
        },
        {
          dimension: 'documentation',
          label: 'Documentation',
          score: 65,
          grade: 'C',
          rationale: ['README covers install but not usage'],
          suggestions: [],
        },
      ],
      topSuggestions: [
        {
          id: 'sug-tests',
          title: 'Add tests for the auth and database layers',
          detail: 'Both are untested and both are on every request path.',
          impact: 'high',
          effort: 'medium',
          files: ['src/auth/session.ts', 'src/db/client.ts'],
        },
        {
          id: 'sug-env',
          title: 'Document JWT_SECRET in .env.example',
          detail: 'The variable is read at startup but absent from the committed template.',
          impact: 'medium',
          effort: 'low',
          files: ['.env.example', 'src/auth/session.ts'],
        },
      ],
    },
    search: indexFor(RICH_FILES),
    files: toRepoFiles(RICH_FILES),
  };
}

/**
 * A context with essentially nothing detected: no framework, no auth, no
 * database, no API, no deployment, no dependencies.
 */
export function makeBareContext(): KnowledgeContext {
  return {
    source: { kind: 'upload', filename: 'scratch.zip' },
    stats: {
      ...EMPTY_STATS,
      files: 2,
      directories: 0,
      totalBytes: 60,
      linesOfCode: 4,
      maxDepth: 1,
      documentationFiles: 1,
    },
    languages: [{ language: 'Python', files: 1, bytes: 40, percent: 100, color: '#3572A5' }],
    stack: EMPTY_STACK,
    dependencies: EMPTY_DEPENDENCIES,
    tree: {
      name: '',
      path: '',
      type: 'dir',
      size: 60,
      fileCount: 2,
      children: [
        { name: 'main.py', path: 'main.py', type: 'file', size: 40, fileCount: 1 },
        { name: 'notes.txt', path: 'notes.txt', type: 'file', size: 20, fileCount: 1 },
      ],
    },
    graph: EMPTY_GRAPH,
    entryPoints: [],
    complexity: EMPTY_COMPLEXITY,
    debt: EMPTY_DEBT,
    security: EMPTY_SECURITY,
    readme: EMPTY_README,
    health: EMPTY_HEALTH,
    search: indexFor(MINIMAL_FILES),
    files: toRepoFiles(MINIMAL_FILES),
  };
}

/** The rich context with npm rather than pnpm, for package-manager assertions. */
export function makeNpmContext(): KnowledgeContext {
  const base = makeRichContext();
  const files: Record<string, string> = { ...RICH_FILES };
  delete files['pnpm-lock.yaml'];
  files['package-lock.json'] = '{ "lockfileVersion": 3 }';

  return {
    ...base,
    stack: {
      ...base.stack,
      packageManagers: [
        {
          name: 'npm',
          confidence: 'high',
          evidence: ['package-lock.json is committed'],
          files: ['package-lock.json'],
        },
      ],
    },
    files: toRepoFiles(files),
    search: indexFor(files),
  };
}
