import { describe, expect, it } from 'vitest';

import { analyzeTechDebt, scanMarkers } from './debt';
import { analyzeComplexity } from './complexity';
import { findDuplicates } from './duplication';
import { makeSnapshot } from '../testing/fixtures';
import type { DependencyReport, RepoSnapshot, RepoStats } from '../types';

function stats(overrides: Partial<RepoStats> = {}): RepoStats {
  return {
    files: 10,
    directories: 3,
    totalBytes: 4096,
    linesOfCode: 400,
    maxDepth: 3,
    configFiles: 2,
    testFiles: 3,
    documentationFiles: 1,
    testRatio: 0.3,
    commentRatio: 0.5,
    ...overrides,
  };
}

function deps(overrides: Partial<DependencyReport> = {}): DependencyReport {
  return {
    dependencies: [],
    manifests: ['package.json'],
    counts: { runtime: 0, dev: 0, peer: 0, optional: 0 },
    flagged: [],
    unpinned: [],
    hasLockfile: true,
    ...overrides,
  };
}

function report(
  snapshot: RepoSnapshot,
  overrides: { stats?: Partial<RepoStats>; deps?: Partial<DependencyReport> } = {},
) {
  const complexity = analyzeComplexity(snapshot);
  const duplicates = findDuplicates(snapshot);
  return analyzeTechDebt(
    snapshot,
    complexity,
    duplicates,
    deps(overrides.deps),
    stats(overrides.stats),
  );
}

describe('scanMarkers', () => {
  it('finds markers in line comments and captures the trailing text', () => {
    const markers = scanMarkers(
      makeSnapshot({
        'src/a.ts': ['const a = 1; // TODO: extract this', '// FIXME handle the null case'].join(
          '\n',
        ),
      }),
    );

    expect(markers).toEqual([
      { kind: 'TODO', file: 'src/a.ts', line: 1, text: 'extract this' },
      { kind: 'FIXME', file: 'src/a.ts', line: 2, text: 'handle the null case' },
    ]);
  });

  it('strips an owner annotation from the captured text', () => {
    const markers = scanMarkers(makeSnapshot({ 'src/a.ts': '// HACK(alice): remove after v2' }));

    expect(markers[0]).toEqual({
      kind: 'HACK',
      file: 'src/a.ts',
      line: 1,
      text: 'remove after v2',
    });
  });

  it('does not match markers inside string literals', () => {
    const markers = scanMarkers(
      makeSnapshot({
        'src/a.ts': [
          `const label = 'TODO';`,
          `const banner = "FIXME: this is data, not a marker";`,
          'const c = 3;',
        ].join('\n'),
      }),
    );

    expect(markers).toEqual([]);
  });

  it('does not match prose in Markdown', () => {
    const markers = scanMarkers(
      makeSnapshot({
        'docs/plan.md': '# Roadmap\n\n- TODO: ship the thing\n- FIXME the docs\n',
        'README.md': 'XXX marks the spot. DEPRECATED sections follow.',
      }),
    );

    expect(markers).toEqual([]);
  });

  it('finds markers in block comments and Python docstrings', () => {
    const markers = scanMarkers(
      makeSnapshot({
        'src/a.ts': ['/*', ' * XXX: this whole module is provisional', ' */', 'run();'].join('\n'),
        'src/b.py': ['def f():', '    """DEPRECATED: use g() instead."""', '    return 1'].join(
          '\n',
        ),
      }),
    );

    expect(markers).toEqual([
      { kind: 'XXX', file: 'src/a.ts', line: 2, text: 'this whole module is provisional' },
      { kind: 'DEPRECATED', file: 'src/b.py', line: 2, text: 'use g() instead.' },
    ]);
  });

  it('matches only the shouted convention, not ordinary English', () => {
    const markers = scanMarkers(
      makeSnapshot({ 'src/a.ts': '// this todo is deprecated prose, not a marker' }),
    );

    expect(markers).toEqual([]);
  });

  it('skips generated and vendored files', () => {
    const markers = scanMarkers(
      makeSnapshot({ 'dist/a.js': '// TODO: x', 'vendor/b.js': '// FIXME: y' }),
    );

    expect(markers).toEqual([]);
  });
});

describe('analyzeTechDebt', () => {
  it('flags a high-risk hotspot file with concrete numbers', () => {
    const gnarly = Array.from(
      { length: 500 },
      (_, i) => `${'  '.repeat(Math.min(7, i % 9))}if (a${i} && b${i}) { run(${i}); }`,
    ).join('\n');

    const result = report(makeSnapshot({ 'src/gnarly.ts': gnarly }));
    const item = result.items.find((entry) => entry.id.startsWith('debt-complexity-hotspot-'));

    expect(item).toBeDefined();
    expect(item?.category).toBe('complexity');
    expect(item?.files).toEqual(['src/gnarly.ts']);
    expect(item?.detail).toMatch(/src\/gnarly\.ts scores \d+\/100/);
    expect(item?.detail).toMatch(/cyclomatic complexity \d+/);
    expect(item?.estimatedHours).toBeGreaterThan(0);
  });

  it('flags oversized files separately from hotspots', () => {
    const flat = Array.from({ length: 700 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const result = report(makeSnapshot({ 'src/big.ts': flat }));

    const item = result.items.find((entry) => entry.id === 'debt-complexity-oversized-files');
    expect(item?.detail).toContain('src/big.ts (700 sloc)');
  });

  it('flags duplication with the duplicated line volume', () => {
    const block = Array.from({ length: 12 }, (_, i) => `const step${i} = handle(${i});`).join('\n');
    const result = report(
      makeSnapshot({ 'src/a.ts': `${block}\nfirst();`, 'src/b.ts': `${block}\nsecond();` }),
    );

    const item = result.items.find((entry) => entry.id === 'debt-duplication-copy-paste');
    expect(item).toBeDefined();
    expect(item?.detail).toContain('src/a.ts:1');
    expect(result.duplicates).toHaveLength(1);
  });

  it('flags a repository with no tests as critical when it has real code', () => {
    const body = Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const result = report(makeSnapshot({ 'src/a.ts': body }), {
      stats: { testFiles: 0, testRatio: 0 },
    });

    const item = result.items.find((entry) => entry.id === 'debt-testing-no-tests');
    expect(item?.severity).toBe('critical');
    expect(item?.estimatedHours).toBeGreaterThanOrEqual(4);
  });

  it('flags a thin test ratio rather than absent tests', () => {
    const result = report(makeSnapshot({ 'src/a.ts': 'const a = 1;' }), {
      stats: { testFiles: 1, testRatio: 0.04 },
    });

    expect(result.items.some((entry) => entry.id === 'debt-testing-no-tests')).toBe(false);
    const item = result.items.find((entry) => entry.id === 'debt-testing-low-test-ratio');
    expect(item?.severity).toBe('high');
    expect(item?.detail).toContain('4%');
  });

  it('flags a missing README and stays quiet when one exists', () => {
    const withoutReadme = report(makeSnapshot({ 'src/a.ts': 'const a = 1;' }));
    expect(
      withoutReadme.items.find((entry) => entry.id === 'debt-documentation-missing-readme')
        ?.severity,
    ).toBe('high');

    const withReadme = report(
      makeSnapshot({ 'src/a.ts': 'const a = 1;', 'README.md': '# Demo\n\nIt does things.' }),
    );
    expect(withReadme.items.some((entry) => entry.id === 'debt-documentation-missing-readme')).toBe(
      false,
    );
  });

  it('flags dependency problems: no lockfile, unpinned ranges, flagged packages', () => {
    const result = report(makeSnapshot({ 'src/a.ts': 'const a = 1;' }), {
      deps: {
        hasLockfile: false,
        unpinned: ['left-pad', 'request', 'moment', 'lodash', 'chalk', 'axios'],
        flagged: [
          {
            name: 'request',
            reason: 'deprecated since 2020',
            severity: 'high',
            replacement: 'undici',
          },
        ],
      },
    });

    const ids = result.items.map((entry) => entry.id);
    expect(ids).toContain('debt-dependencies-missing-lockfile');
    expect(ids).toContain('debt-dependencies-unpinned-ranges');
    expect(ids).toContain('debt-dependencies-flagged-packages');

    const flagged = result.items.find((entry) => entry.id === 'debt-dependencies-flagged-packages');
    expect(flagged?.severity).toBe('high');
    expect(flagged?.detail).toContain('use undici');
  });

  it('flags a flat directory holding too many source files', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 40; i++) files[`src/module${i}.ts`] = `export const v${i} = ${i};`;

    const result = report(makeSnapshot(files));
    const item = result.items.find((entry) => entry.id === 'debt-structure-flat-directories');

    expect(item?.detail).toContain('src (40 files)');
  });

  it('flags a high marker density and deprecated code separately', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i++)
      files[`src/m${i}.ts`] = `// TODO: finish ${i}\nconst v${i} = ${i};`;
    files['src/old.ts'] = '// DEPRECATED: drop in v3\nexport const old = 1;';

    const result = report(makeSnapshot(files));
    const ids = result.items.map((entry) => entry.id);

    expect(ids).toContain('debt-convention-marker-density');
    expect(ids).toContain('debt-convention-deprecated-code');
    expect(result.markers).toHaveLength(26);
  });

  it('flags mixed file naming conventions only when both styles are common', () => {
    const mixed: Record<string, string> = {};
    for (let i = 0; i < 15; i++) mixed[`src/user-profile-${i}.ts`] = 'export const a = 1;';
    for (let i = 0; i < 10; i++) mixed[`src/user_profile_${i}.ts`] = 'export const a = 1;';

    expect(
      report(makeSnapshot(mixed)).items.some(
        (entry) => entry.id === 'debt-convention-mixed-file-naming',
      ),
    ).toBe(true);

    const consistent: Record<string, string> = {};
    for (let i = 0; i < 25; i++) consistent[`src/user-profile-${i}.ts`] = 'export const a = 1;';
    consistent['src/one_odd_name.ts'] = 'export const a = 1;';

    expect(
      report(makeSnapshot(consistent)).items.some(
        (entry) => entry.id === 'debt-convention-mixed-file-naming',
      ),
    ).toBe(false);
  });

  it('sorts items by severity and totals the estimated hours', () => {
    const result = report(makeSnapshot({ 'src/a.ts': 'const a = 1;' }), {
      stats: { testFiles: 0, testRatio: 0 },
      deps: { hasLockfile: false, unpinned: ['left-pad'] },
    });

    const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as const;
    for (let i = 1; i < result.items.length; i++) {
      const previous = result.items[i - 1];
      const current = result.items[i];
      if (!previous || !current) continue;
      expect(rank[previous.severity]).toBeGreaterThanOrEqual(rank[current.severity]);
    }

    const sum = result.items.reduce((total, entry) => total + entry.estimatedHours, 0);
    expect(result.totalEstimatedHours).toBeCloseTo(Math.round(sum * 10) / 10, 5);
    expect(result.totalEstimatedHours).toBeGreaterThan(0);
  });

  it('produces a clean report for a healthy repository', () => {
    const snapshot = makeSnapshot({
      'src/a.ts': 'export const a = 1;',
      'src/a.test.ts': 'import { a } from "./a";\nit("works", () => expect(a).toBe(1));',
      'README.md': '# Demo\n\nDoes one thing.',
      'docs/architecture.md': '# Architecture',
    });

    const result = report(snapshot);

    expect(result.items).toEqual([]);
    expect(result.totalEstimatedHours).toBe(0);
    expect(result.markers).toEqual([]);
    expect(result.duplicates).toEqual([]);
  });
});
