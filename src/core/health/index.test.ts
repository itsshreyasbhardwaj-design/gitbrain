import { describe, expect, it } from 'vitest';

import { computeHealth, type HealthInput } from './index';
import type {
  ComplexityReport,
  DependencyReport,
  Detection,
  DuplicateBlock,
  FileComplexity,
  GraphEdge,
  GraphNode,
  HealthDimension,
  HealthReport,
  LanguageBreakdown,
  ModuleGraph,
  ReadmeReport,
  ReadmeSection,
  RepoStats,
  SecretFinding,
  SecurityReport,
  StackDetection,
  TechDebtReport,
} from '../types';

// ---------------------------------------------------------------------------
// Hand-built fixtures.
//
// Nothing here imports from src/core/detect, graph, metrics or security — the
// health scorer depends only on the shapes in src/core/types.ts, and these
// builders prove it.
// ---------------------------------------------------------------------------

function detection(name: string, files: string[] = [], evidence: string[] = []): Detection {
  return { name, confidence: 'high', evidence, files };
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

function makeStats(overrides: Partial<RepoStats> = {}): RepoStats {
  return {
    files: 100,
    directories: 20,
    totalBytes: 500_000,
    linesOfCode: 10_000,
    maxDepth: 4,
    configFiles: 8,
    testFiles: 0,
    documentationFiles: 0,
    testRatio: 0,
    commentRatio: 0,
    ...overrides,
  };
}

function makeSection(name: string, present: boolean): ReadmeSection {
  return { name, present, weight: 0.1 };
}

function makeReadme(overrides: Partial<ReadmeReport> = {}): ReadmeReport {
  return {
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
    ...overrides,
  };
}

function makeDependencies(overrides: Partial<DependencyReport> = {}): DependencyReport {
  return {
    dependencies: [],
    manifests: [],
    counts: { runtime: 0, dev: 0, peer: 0, optional: 0 },
    flagged: [],
    unpinned: [],
    hasLockfile: false,
    ...overrides,
  };
}

function makeGraph(overrides: Partial<ModuleGraph> = {}): ModuleGraph {
  return { nodes: [], edges: [], cycles: [], externals: [], orphans: [], ...overrides };
}

function makeComplexity(overrides: Partial<ComplexityReport> = {}): ComplexityReport {
  return {
    files: [],
    totalLoc: 0,
    totalSloc: 0,
    averageComplexity: 0,
    hotspots: [],
    distribution: [],
    ...overrides,
  };
}

function makeDebt(overrides: Partial<TechDebtReport> = {}): TechDebtReport {
  return { items: [], totalEstimatedHours: 0, markers: [], duplicates: [], ...overrides };
}

function makeSecurity(overrides: Partial<SecurityReport> = {}): SecurityReport {
  return {
    secrets: [],
    envVars: [],
    undocumentedEnvVars: [],
    largeFiles: [],
    flaggedDependencies: [],
    risks: [],
    score: 100,
    ...overrides,
  };
}

function complexityFile(
  path: string,
  loc: number,
  cyclomatic: number,
  maxNesting: number,
  riskScore: number,
): FileComplexity {
  return {
    path,
    loc,
    sloc: Math.round(loc * 0.8),
    cyclomatic,
    maxNesting,
    functions: 5,
    riskScore,
  };
}

function graphNode(path: string, instability: number, isOrphan = false): GraphNode {
  return {
    id: path,
    label: path.slice(path.lastIndexOf('/') + 1),
    path,
    language: 'TypeScript',
    loc: 150,
    outDegree: 2,
    inDegree: isOrphan ? 0 : 2,
    instability,
    isEntry: false,
    isOrphan,
  };
}

function graphEdge(from: string, to: string): GraphEdge {
  return { from, to, specifier: `./${to}`, circular: false };
}

function secret(file: string, severity: SecretFinding['severity']): SecretFinding {
  return {
    id: `secret-${file}-${severity}`,
    rule: 'AWS Access Key ID',
    file,
    line: 12,
    preview: 'AKIA********',
    severity,
  };
}

function duplicate(lineCount: number, files: string[]): DuplicateBlock {
  return {
    hash: `dup-${lineCount}-${files.join('-')}`,
    lineCount,
    occurrences: files.map((file) => ({ file, startLine: 1 })),
  };
}

const TS_LANGUAGE: LanguageBreakdown = {
  language: 'TypeScript',
  files: 90,
  bytes: 800_000,
  percent: 92.4,
  color: '#3178c6',
};

function baseInput(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    stats: makeStats(),
    languages: [TS_LANGUAGE],
    stack: EMPTY_STACK,
    dependencies: makeDependencies(),
    graph: makeGraph(),
    complexity: makeComplexity(),
    debt: makeDebt(),
    security: makeSecurity(),
    readme: makeReadme(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A deliberately excellent repository.
// ---------------------------------------------------------------------------

const HEALTHY_NODES: GraphNode[] = Array.from({ length: 60 }, (_unused, index) =>
  graphNode(`src/module-${String(index).padStart(2, '0')}.ts`, 0.4),
);

const HEALTHY_EDGES: GraphEdge[] = HEALTHY_NODES.slice(0, 59).map((node, index) =>
  graphEdge(node.id, HEALTHY_NODES[index + 1]?.id ?? node.id),
);

const HEALTHY_FILES: FileComplexity[] = HEALTHY_NODES.map((node) =>
  complexityFile(node.path, 150, 4, 2, 18),
);

const EXCELLENT: HealthInput = {
  stats: makeStats({
    files: 120,
    directories: 24,
    totalBytes: 900_000,
    linesOfCode: 14_000,
    maxDepth: 5,
    configFiles: 12,
    testFiles: 30,
    documentationFiles: 8,
    testRatio: 0.3,
    commentRatio: 0.45,
  }),
  languages: [TS_LANGUAGE],
  stack: {
    ...EMPTY_STACK,
    frameworks: [detection('Next.js', ['next.config.ts', 'eslint.config.mjs'], ['next@16'])],
    packageManagers: [detection('pnpm', ['pnpm-lock.yaml', 'package.json'])],
    ci: [detection('GitHub Actions', ['.github/workflows/ci.yml'], ['ci.yml runs pnpm test'])],
    testing: [detection('Vitest', ['vitest.config.ts'])],
    deployment: [detection('Docker', ['Dockerfile', 'docs/deployment.md'])],
    runtimes: [detection('Node.js', ['package.json'])],
    architecture: { style: 'modular', confidence: 'high', evidence: ['src/ is feature-sliced'] },
  },
  dependencies: makeDependencies({
    manifests: ['package.json'],
    counts: { runtime: 18, dev: 22, peer: 0, optional: 0 },
    hasLockfile: true,
  }),
  graph: makeGraph({ nodes: HEALTHY_NODES, edges: HEALTHY_EDGES }),
  complexity: makeComplexity({
    files: HEALTHY_FILES,
    totalLoc: 9_000,
    totalSloc: 7_200,
    averageComplexity: 4,
  }),
  debt: makeDebt({ totalEstimatedHours: 20 }),
  security: makeSecurity({
    score: 98,
    envVars: [{ name: 'DATABASE_URL', files: ['src/db.ts'], documented: true }],
  }),
  readme: makeReadme({
    exists: true,
    path: 'README.md',
    wordCount: 900,
    score: 95,
    sections: [
      makeSection('Installation', true),
      makeSection('License', true),
      makeSection('Contributing', true),
      makeSection('Usage', true),
    ],
  }),
};

// ---------------------------------------------------------------------------
// A deliberately terrible repository.
// ---------------------------------------------------------------------------

const ROTTEN_NODES: GraphNode[] = Array.from({ length: 60 }, (_unused, index) =>
  graphNode(
    index % 2 === 0 ? `src/Thing_${index}.js` : `lib/otherThing${index}.js`,
    0.9,
    index < 20,
  ),
);

const ROTTEN_EDGES: GraphEdge[] = ROTTEN_NODES.slice(0, 40).map((node, index) => ({
  ...graphEdge(node.id, ROTTEN_NODES[(index + 1) % ROTTEN_NODES.length]?.id ?? node.id),
  circular: true,
}));

const ROTTEN_FILES: FileComplexity[] = ROTTEN_NODES.map((node, index) =>
  complexityFile(node.path, index < 20 ? 1_400 : 400, 30, 7, index < 25 ? 88 : 55),
);

const TERRIBLE: HealthInput = {
  stats: makeStats({
    files: 80,
    directories: 30,
    totalBytes: 900_000,
    linesOfCode: 22_000,
    maxDepth: 11,
    configFiles: 2,
    testFiles: 0,
    documentationFiles: 0,
    testRatio: 0,
    commentRatio: 0,
  }),
  languages: [{ ...TS_LANGUAGE, language: 'JavaScript', color: '#f1e05a' }],
  stack: EMPTY_STACK,
  dependencies: makeDependencies({
    manifests: ['package.json'],
    counts: { runtime: 60, dev: 4, peer: 0, optional: 0 },
    unpinned: ['left-pad', 'request'],
    hasLockfile: false,
  }),
  graph: makeGraph({
    nodes: ROTTEN_NODES,
    edges: ROTTEN_EDGES,
    cycles: [
      ['src/Thing_0.js', 'lib/otherThing1.js', 'src/Thing_0.js'],
      ['src/Thing_2.js', 'lib/otherThing3.js', 'src/Thing_2.js'],
      ['src/Thing_4.js', 'lib/otherThing5.js', 'src/Thing_4.js'],
      ['src/Thing_6.js', 'lib/otherThing7.js', 'src/Thing_6.js'],
    ],
    orphans: ROTTEN_NODES.filter((node) => node.isOrphan).map((node) => node.id),
    externals: [{ name: 'lodash', count: 12, importers: ['src/Thing_0.js'], undeclared: true }],
  }),
  complexity: makeComplexity({
    files: ROTTEN_FILES,
    totalLoc: 22_000,
    totalSloc: 20_000,
    averageComplexity: 28,
    hotspots: ROTTEN_FILES.filter((file) => file.riskScore >= 70).slice(0, 10),
  }),
  debt: makeDebt({
    totalEstimatedHours: 900,
    items: [
      {
        id: 'debt-complexity',
        title: 'God objects',
        detail: 'Twenty modules exceed 1000 lines.',
        severity: 'high',
        category: 'complexity',
        files: ['src/Thing_0.js'],
        estimatedHours: 900,
      },
    ],
    markers: Array.from({ length: 40 }, (_unused, index) => ({
      kind: 'FIXME' as const,
      file: `src/Thing_${index}.js`,
      line: 3,
      text: 'FIXME: this is wrong',
    })),
    duplicates: [
      duplicate(400, ['src/Thing_0.js', 'src/Thing_2.js', 'src/Thing_4.js']),
      duplicate(500, ['lib/otherThing1.js', 'lib/otherThing3.js', 'lib/otherThing5.js']),
      duplicate(600, ['src/Thing_6.js', 'src/Thing_8.js']),
    ],
  }),
  security: makeSecurity({
    score: 15,
    secrets: [secret('src/config.js', 'critical'), secret('src/Thing_0.js', 'high')],
    envVars: [
      { name: 'API_KEY', files: ['src/config.js'], documented: false },
      { name: 'DB_PASSWORD', files: ['src/db.js'], documented: false },
    ],
    undocumentedEnvVars: ['API_KEY', 'DB_PASSWORD', 'STRIPE_SECRET', 'JWT_SECRET'],
    largeFiles: Array.from({ length: 6 }, (_unused, index) => ({
      path: `assets/blob-${index}.bin`,
      size: 70_000,
    })),
    flaggedDependencies: [
      { name: 'request', reason: 'Deprecated since 2020', severity: 'high', replacement: 'undici' },
      { name: 'left-pad', reason: 'Single-function package', severity: 'medium' },
    ],
    risks: [
      {
        id: 'eval-usage',
        title: 'Dynamic code execution',
        detail: 'eval() is called on request input.',
        severity: 'critical',
        files: ['src/Thing_0.js'],
        recommendation: 'Replace eval with an explicit dispatch table.',
        reference: 'CWE-95',
      },
    ],
  }),
  readme: makeReadme(),
};

function dimension(report: HealthReport, name: HealthDimension): number {
  return report.scores.find((score) => score.dimension === name)?.score ?? -1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeHealth — report shape', () => {
  const report = computeHealth(EXCELLENT);

  it('scores all eight dimensions exactly once', () => {
    expect(report.scores).toHaveLength(8);
    expect(new Set(report.scores.map((score) => score.dimension)).size).toBe(8);
    expect(report.scores.map((score) => score.dimension).sort()).toEqual([
      'architecture',
      'developerExperience',
      'documentation',
      'maintainability',
      'performance',
      'readability',
      'security',
      'testing',
    ]);
  });

  it('gives every dimension a human label, a 0–100 score and a matching grade', () => {
    for (const score of report.scores) {
      expect(score.label.length).toBeGreaterThan(3);
      expect(score.score).toBeGreaterThanOrEqual(0);
      expect(score.score).toBeLessThanOrEqual(100);
      expect(score.grade).toBe(
        score.score >= 90
          ? 'A'
          : score.score >= 80
            ? 'B'
            : score.score >= 70
              ? 'C'
              : score.score >= 60
                ? 'D'
                : 'F',
      );
    }
  });

  it('states rationale as facts containing numbers, never bare adjectives', () => {
    for (const score of report.scores) {
      expect(score.rationale.length).toBeGreaterThan(2);
      for (const line of score.rationale) {
        expect(line, `${score.dimension}: "${line}"`).toMatch(/\d/);
        expect(line.length).toBeGreaterThan(15);
      }
    }
  });

  it('is deterministic', () => {
    expect(computeHealth(EXCELLENT)).toEqual(computeHealth(EXCELLENT));
    expect(computeHealth(TERRIBLE)).toEqual(computeHealth(TERRIBLE));
  });

  it('survives a completely empty input without throwing', () => {
    const report = computeHealth(baseInput());
    expect(report.scores).toHaveLength(8);
    expect(report.overall).toBeGreaterThanOrEqual(0);
    expect(report.overall).toBeLessThanOrEqual(100);
  });
});

describe('computeHealth — a deliberately excellent repository', () => {
  const report = computeHealth(EXCELLENT);

  it('scores in the A range overall', () => {
    expect(report.overall).toBeGreaterThanOrEqual(90);
    expect(report.grade).toBe('A');
  });

  it('scores well on every individual dimension', () => {
    for (const score of report.scores) {
      expect(score.score, `${score.dimension} scored ${score.score}`).toBeGreaterThanOrEqual(85);
    }
  });

  it('has few remaining suggestions', () => {
    expect(report.topSuggestions.length).toBeLessThanOrEqual(3);
  });
});

describe('computeHealth — a deliberately terrible repository', () => {
  const report = computeHealth(TERRIBLE);

  it('scores in the F range overall', () => {
    expect(report.overall).toBeLessThan(60);
    expect(report.grade).toBe('F');
  });

  it('fails testing outright because there are no tests', () => {
    expect(dimension(report, 'testing')).toBeLessThanOrEqual(10);
  });

  it('fails security outright because a critical secret is committed', () => {
    expect(dimension(report, 'security')).toBeLessThanOrEqual(20);
  });

  it('fails documentation outright because there is no README and no docs', () => {
    expect(dimension(report, 'documentation')).toBeLessThanOrEqual(10);
  });

  it('penalises the four dependency cycles in architecture', () => {
    const architecture = report.scores.find((score) => score.dimension === 'architecture');
    expect(architecture?.score).toBeLessThan(60);
    expect(architecture?.rationale.join(' ')).toContain('4 circular dependency chains');
  });

  it('reports the duplicated-line count as a number, not an adjective', () => {
    const maintainability = report.scores.find((score) => score.dimension === 'maintainability');
    // 400*2 + 500*2 + 600*1 duplicated lines.
    expect(maintainability?.rationale.join(' ')).toContain('2400 duplicated lines');
  });

  it('surfaces the committed secret as a top suggestion', () => {
    expect(report.topSuggestions.map((item) => item.id)).toContain('sec-secrets');
  });

  it('scores every dimension strictly below the excellent repository', () => {
    const good = computeHealth(EXCELLENT);
    for (const score of report.scores) {
      expect(score.score, score.dimension).toBeLessThan(dimension(good, score.dimension));
    }
  });
});

describe('computeHealth — testing is monotonic in the amount of testing', () => {
  function withTests(testFiles: number, testRatio: number, extras: Partial<HealthInput> = {}) {
    return computeHealth(
      baseInput({
        stats: makeStats({ files: 100, testFiles, testRatio }),
        ...extras,
      }),
    );
  }

  it('rises strictly as the test ratio rises', () => {
    const none = dimension(withTests(0, 0), 'testing');
    const few = dimension(withTests(5, 0.05), 'testing');
    const some = dimension(withTests(12, 0.12), 'testing');
    const target = dimension(withTests(25, 0.25), 'testing');
    const beyond = dimension(withTests(40, 0.4), 'testing');

    expect(none).toBeLessThan(few);
    expect(few).toBeLessThan(some);
    expect(some).toBeLessThan(target);
    expect(beyond).toBeGreaterThanOrEqual(target);
  });

  it('raises the overall score too, never lowers it', () => {
    expect(withTests(25, 0.25).overall).toBeGreaterThan(withTests(0, 0).overall);
  });

  it('caps a repository with tooling but zero tests at 10', () => {
    const tooledButUntested = withTests(0, 0, {
      stack: {
        ...EMPTY_STACK,
        testing: [detection('Vitest', ['vitest.config.ts'])],
        ci: [detection('GitHub Actions', ['.github/workflows/ci.yml'], ['runs pnpm test'])],
      },
    });

    expect(dimension(tooledButUntested, 'testing')).toBeLessThanOrEqual(10);

    // …and adding a single test file immediately lifts the cap.
    const withOneTest = withTests(1, 0.01, {
      stack: {
        ...EMPTY_STACK,
        testing: [detection('Vitest', ['vitest.config.ts'])],
        ci: [detection('GitHub Actions', ['.github/workflows/ci.yml'], ['runs pnpm test'])],
      },
    });
    expect(dimension(withOneTest, 'testing')).toBeGreaterThan(
      dimension(tooledButUntested, 'testing'),
    );
  });

  it('credits a detected framework and CI on top of the ratio', () => {
    const bare = dimension(withTests(25, 0.25), 'testing');
    const tooled = dimension(
      withTests(25, 0.25, {
        stack: {
          ...EMPTY_STACK,
          testing: [detection('Vitest', ['vitest.config.ts'])],
          ci: [detection('GitHub Actions', ['.github/workflows/ci.yml'], ['runs pnpm test'])],
        },
      }),
      'testing',
    );

    expect(tooled).toBeGreaterThan(bare);
    expect(tooled).toBe(100);
  });
});

describe('computeHealth — security cannot be laundered', () => {
  it('caps a repository with a critical secret regardless of its analyzer score', () => {
    const report = computeHealth(
      baseInput({
        dependencies: makeDependencies({ hasLockfile: true, manifests: ['package.json'] }),
        security: makeSecurity({ score: 100, secrets: [secret('src/config.ts', 'critical')] }),
      }),
    );

    expect(dimension(report, 'security')).toBeLessThanOrEqual(20);
  });

  it('caps a repository with a high-severity secret less harshly', () => {
    const report = computeHealth(
      baseInput({
        dependencies: makeDependencies({ hasLockfile: true, manifests: ['package.json'] }),
        security: makeSecurity({ score: 100, secrets: [secret('src/config.ts', 'high')] }),
      }),
    );

    expect(dimension(report, 'security')).toBeGreaterThan(20);
    expect(dimension(report, 'security')).toBeLessThanOrEqual(45);
  });

  it('rises when the secret is removed', () => {
    const withSecret = computeHealth(
      baseInput({
        dependencies: makeDependencies({ hasLockfile: true }),
        security: makeSecurity({ score: 100, secrets: [secret('src/config.ts', 'critical')] }),
      }),
    );
    const without = computeHealth(
      baseInput({
        dependencies: makeDependencies({ hasLockfile: true }),
        security: makeSecurity({ score: 100 }),
      }),
    );

    expect(dimension(without, 'security')).toBeGreaterThan(dimension(withSecret, 'security'));
  });

  it('deducts for a missing lockfile and for flagged dependencies', () => {
    const clean = computeHealth(
      baseInput({
        dependencies: makeDependencies({ hasLockfile: true }),
        security: makeSecurity({ score: 100 }),
      }),
    );
    const noLock = computeHealth(
      baseInput({
        dependencies: makeDependencies({ hasLockfile: false }),
        security: makeSecurity({ score: 100 }),
      }),
    );
    const flagged = computeHealth(
      baseInput({
        dependencies: makeDependencies({ hasLockfile: true }),
        security: makeSecurity({
          score: 100,
          flaggedDependencies: [
            { name: 'request', reason: 'Deprecated', severity: 'critical' },
            { name: 'left-pad', reason: 'Trivial', severity: 'medium' },
          ],
        }),
      }),
    );

    expect(dimension(clean, 'security')).toBe(100);
    expect(dimension(noLock, 'security')).toBe(90);
    expect(dimension(flagged, 'security')).toBe(87);
  });
});

describe('computeHealth — other dimensions respond to their own inputs', () => {
  it('raises documentation when a README appears', () => {
    const without = computeHealth(baseInput());
    const withReadme = computeHealth(
      baseInput({
        readme: makeReadme({
          exists: true,
          path: 'README.md',
          score: 90,
          wordCount: 800,
          sections: [makeSection('License', true), makeSection('Contributing', true)],
        }),
        stats: makeStats({ documentationFiles: 4, commentRatio: 0.3 }),
      }),
    );

    expect(dimension(withReadme, 'documentation')).toBeGreaterThan(
      dimension(without, 'documentation'),
    );
  });

  it('raises architecture when a cycle is removed', () => {
    const cyclic = computeHealth(
      baseInput({
        graph: makeGraph({
          nodes: HEALTHY_NODES,
          edges: HEALTHY_EDGES,
          cycles: [['src/module-00.ts', 'src/module-01.ts', 'src/module-00.ts']],
        }),
      }),
    );
    const acyclic = computeHealth(
      baseInput({ graph: makeGraph({ nodes: HEALTHY_NODES, edges: HEALTHY_EDGES }) }),
    );

    expect(dimension(acyclic, 'architecture')).toBe(dimension(cyclic, 'architecture') + 10);
  });

  it('does not apply instability penalties to a graph too small to measure', () => {
    const tiny = computeHealth(
      baseInput({
        graph: makeGraph({
          nodes: [graphNode('src/a.ts', 0), graphNode('src/b.ts', 0)],
          edges: [graphEdge('src/a.ts', 'src/b.ts')],
        }),
      }),
    );

    expect(dimension(tiny, 'architecture')).toBe(100);
  });

  it('lowers maintainability as average complexity rises', () => {
    const scoreAt = (averageComplexity: number): number =>
      dimension(
        computeHealth(
          baseInput({
            complexity: makeComplexity({
              files: HEALTHY_FILES,
              totalLoc: 9_000,
              totalSloc: 7_200,
              averageComplexity,
            }),
          }),
        ),
        'maintainability',
      );

    expect(scoreAt(3)).toBe(100);
    expect(scoreAt(15)).toBeLessThan(scoreAt(3));
    expect(scoreAt(30)).toBeLessThan(scoreAt(15));
  });

  it('lowers performance when large binaries are committed', () => {
    const lean = computeHealth(baseInput());
    const heavy = computeHealth(
      baseInput({
        security: makeSecurity({
          largeFiles: [
            { path: 'assets/a.mp4', size: 200_000 },
            { path: 'assets/b.mp4', size: 200_000 },
          ],
        }),
      }),
    );

    expect(dimension(heavy, 'performance')).toBeLessThan(dimension(lean, 'performance'));
  });

  it('rewards developer experience for each committed affordance', () => {
    const bare = dimension(computeHealth(baseInput()), 'developerExperience');
    const tooled = dimension(
      computeHealth(
        baseInput({
          dependencies: makeDependencies({ hasLockfile: true, manifests: ['package.json'] }),
          stack: {
            ...EMPTY_STACK,
            ci: [detection('GitHub Actions', ['.github/workflows/ci.yml'])],
            frameworks: [detection('Next.js', ['eslint.config.mjs'])],
            deployment: [detection('Docker', ['Dockerfile'])],
          },
          security: makeSecurity({
            envVars: [{ name: 'PORT', files: ['src/server.ts'], documented: true }],
          }),
          readme: makeReadme({
            exists: true,
            path: 'README.md',
            score: 90,
            sections: [makeSection('Installation', true)],
          }),
        }),
      ),
      'developerExperience',
    );

    expect(bare).toBe(0);
    expect(tooled).toBeGreaterThanOrEqual(90);
  });

  it('penalises naming that is inconsistent and unidiomatic for the language', () => {
    const consistent = dimension(
      computeHealth(
        baseInput({
          complexity: makeComplexity({
            files: HEALTHY_FILES,
            totalLoc: 9_000,
            totalSloc: 7_200,
            averageComplexity: 3,
          }),
          stats: makeStats({ commentRatio: 0.35 }),
        }),
      ),
      'readability',
    );
    const inconsistent = dimension(
      computeHealth(
        baseInput({
          complexity: makeComplexity({
            files: ROTTEN_NODES.map((node) => complexityFile(node.path, 150, 3, 2, 10)),
            totalLoc: 9_000,
            totalSloc: 7_200,
            averageComplexity: 3,
          }),
          stats: makeStats({ commentRatio: 0.35 }),
        }),
      ),
      'readability',
    );

    expect(consistent).toBe(100);
    expect(inconsistent).toBeLessThan(consistent);
  });
});

describe('computeHealth — infers community health files from cited paths', () => {
  it('counts a LICENSE that another analyzer mentioned', () => {
    const without = computeHealth(baseInput());
    const withFiles = computeHealth(
      baseInput({
        debt: makeDebt({
          items: [
            {
              id: 'stale-docs',
              title: 'Stale community docs',
              detail: 'CONTRIBUTING.md references a removed script.',
              severity: 'low',
              category: 'documentation',
              files: ['LICENSE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'],
              estimatedHours: 1,
            },
          ],
          totalEstimatedHours: 1,
        }),
      }),
    );

    expect(dimension(withFiles, 'documentation')).toBe(dimension(without, 'documentation') + 10);
  });
});

describe('computeHealth — composite score', () => {
  it('weights security and maintainability above performance', () => {
    const securityDrop =
      computeHealth(EXCELLENT).overall -
      computeHealth({
        ...EXCELLENT,
        security: makeSecurity({ score: 0, secrets: [secret('src/config.ts', 'critical')] }),
      }).overall;

    const performanceDrop =
      computeHealth(EXCELLENT).overall -
      computeHealth({
        ...EXCELLENT,
        security: makeSecurity({
          score: 98,
          envVars: [{ name: 'DATABASE_URL', files: ['src/db.ts'], documented: true }],
          largeFiles: Array.from({ length: 8 }, (_unused, index) => ({
            path: `assets/blob-${index}.bin`,
            size: 200_000,
          })),
        }),
      }).overall;

    expect(securityDrop).toBeGreaterThan(performanceDrop);
  });

  it('never leaves the 0–100 range', () => {
    for (const input of [EXCELLENT, TERRIBLE, baseInput()]) {
      const report = computeHealth(input);
      expect(report.overall).toBeGreaterThanOrEqual(0);
      expect(report.overall).toBeLessThanOrEqual(100);
    }
  });
});

describe('computeHealth — top suggestions', () => {
  const report = computeHealth(TERRIBLE);

  it('returns at most eight, deduplicated by id', () => {
    expect(report.topSuggestions.length).toBeGreaterThan(0);
    expect(report.topSuggestions.length).toBeLessThanOrEqual(8);

    const ids = report.topSuggestions.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts by impact-to-effort, best first', () => {
    const impact = { high: 3, medium: 2, low: 1 } as const;
    const effort = { low: 1, medium: 2, high: 3 } as const;

    const ratios = report.topSuggestions.map((item) => impact[item.impact] / effort[item.effort]);

    for (let index = 1; index < ratios.length; index++) {
      expect(ratios[index] ?? 0).toBeLessThanOrEqual(ratios[index - 1] ?? 0);
    }
  });

  it('leads with high-impact, low-effort work', () => {
    const first = report.topSuggestions[0];
    expect(first?.impact).toBe('high');
    expect(first?.effort).toBe('low');
  });

  it('gives each suggestion a real detail string', () => {
    for (const item of report.topSuggestions) {
      expect(item.title.length).toBeGreaterThan(5);
      expect(item.detail.length).toBeGreaterThan(30);
    }
  });

  it('only draws from suggestions the dimensions actually produced', () => {
    const known = new Set(
      report.scores.flatMap((score) => score.suggestions.map((item) => item.id)),
    );
    for (const item of report.topSuggestions) {
      expect(known.has(item.id)).toBe(true);
    }
  });
});
