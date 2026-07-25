import { describe, expect, it } from 'vitest';

import { analyzeComplexity, maskSource } from './complexity';
import { makeBinaryFile, makeSnapshot, DEFAULT_SOURCE } from '../testing/fixtures';
import type { RepoSnapshot } from '../types';

function fileFor(snapshot: ReturnType<typeof analyzeComplexity>, path: string) {
  const found = snapshot.files.find((file) => file.path === path);
  if (!found) throw new Error(`no measurement for ${path}`);
  return found;
}

describe('maskSource', () => {
  it('blanks line comments while preserving column positions', () => {
    const { code, comments } = maskSource('const a = 1; // set a\n', 'src/a.ts');

    expect(code[0]).toBe('const a = 1;         ');
    expect(code[0]?.length).toBe('const a = 1; // set a'.length);
    expect(comments[0]).toBe(' set a');
  });

  it('carries block comments across lines', () => {
    const { code, comments } = maskSource('a();\n/* one\n   two */ b();\n', 'src/a.ts');

    expect(code[1]?.trim()).toBe('');
    expect(code[2]?.trim()).toBe('b();');
    expect(comments[1]).toBe(' one');
    expect(comments[2]).toContain('two');
  });

  it('blanks string interiors but keeps the delimiters', () => {
    const { code } = maskSource(`const s = "if && || for";\n`, 'src/a.ts');

    expect(code[0]).toBe(`const s = "            ";`);
  });

  it('treats Python triple-quoted docstrings as comments', () => {
    const source = ['def f():', '    """TODO: implement"""', '    return 1', ''].join('\n');
    const { code, comments } = maskSource(source, 'src/a.py');

    expect(code[1]?.trim()).toBe('');
    expect(comments[1]).toBe('TODO: implement');
  });

  it('does not mistake a hash inside a string for a Python comment', () => {
    const { code } = maskSource(`color = "#ff0000"\nsize = 3\n`, 'src/a.py');

    expect(code[0]).toBe('color = "       "');
    expect(code[1]).toBe('size = 3');
  });

  it('masks JavaScript regex literals but leaves division alone', () => {
    const { code } = maskSource('const re = /a||b/;\nconst half = total / 2 / 3;\n', 'src/a.ts');

    expect(code[0]).toBe('const re = /    /;');
    expect(code[1]).toBe('const half = total / 2 / 3;');
  });

  it('survives escaped quotes', () => {
    const { code } = maskSource('const s = "a\\"b"; const t = 1;\n', 'src/a.ts');

    expect(code[0]?.trimEnd().endsWith('const t = 1;')).toBe(true);
  });
});

describe('analyzeComplexity', () => {
  it('counts loc and sloc, excluding blank and comment-only lines', () => {
    const snapshot = makeSnapshot({
      'src/a.ts': ['// header', '', 'const a = 1;', '/* block', '   more */', 'const b = 2;'].join(
        '\n',
      ),
    });

    const measured = fileFor(analyzeComplexity(snapshot), 'src/a.ts');
    expect(measured.loc).toBe(6);
    expect(measured.sloc).toBe(2);
  });

  it('ignores branch keywords and operators inside comments and strings', () => {
    const snapshot = makeSnapshot({
      'src/quiet.ts': [
        'function quiet() {',
        '  // if for while && || case catch',
        `  const message = 'if && || for case';`,
        '  /* while (x) { } */',
        '  return message;',
        '}',
      ].join('\n'),
      'src/loud.ts': [
        'function loud(x) {',
        '  if (x && x.y) {',
        '    for (const item of x.y) {',
        '      if (item || fallback) return item;',
        '    }',
        '  }',
        '  return null;',
        '}',
      ].join('\n'),
    });

    const report = analyzeComplexity(snapshot);

    // 1 baseline, nothing else: every branch token is masked.
    expect(fileFor(report, 'src/quiet.ts').cyclomatic).toBe(1);
    // 1 + if + && + for + if + || = 6
    expect(fileFor(report, 'src/loud.ts').cyclomatic).toBe(6);
  });

  it('measures brace nesting for C-family languages', () => {
    const snapshot = makeSnapshot({
      'src/nest.ts': [
        'function outer() {',
        '  if (a) {',
        '    while (b) {',
        '      run();',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    });

    expect(fileFor(analyzeComplexity(snapshot), 'src/nest.ts').maxNesting).toBe(3);
  });

  it('measures indentation nesting for Python', () => {
    const snapshot = makeSnapshot({
      'src/nest.py': [
        'def outer():',
        '    if flag:',
        '        for item in items:',
        '            print(item)',
        '    return None',
      ].join('\n'),
    });

    // module -> def -> if -> for  ==  3 levels below the top, matching braces.
    expect(fileFor(analyzeComplexity(snapshot), 'src/nest.py').maxNesting).toBe(3);
  });

  it('counts Python decision points including elif, except, and, or', () => {
    const snapshot = makeSnapshot({
      'src/branch.py': [
        'def check(a, b):',
        '    if a and b:',
        '        return 1',
        '    elif a or b:',
        '        return 2',
        '    try:',
        '        risky()',
        '    except ValueError:',
        '        pass',
        '    return 0',
      ].join('\n'),
    });

    // 1 + if + and + elif + or + except = 6
    expect(fileFor(analyzeComplexity(snapshot), 'src/branch.py').cyclomatic).toBe(6);
  });

  it('counts function declarations across declaration styles', () => {
    const snapshot = makeSnapshot({
      'src/fns.ts': [
        'export function one() { return 1; }',
        'const two = () => 2;',
        'const three = async (x: number) => x;',
        'class Holder {',
        '  four() { return 4; }',
        '  private async five(): Promise<number> { return 5; }',
        '}',
      ].join('\n'),
    });

    expect(fileFor(analyzeComplexity(snapshot), 'src/fns.ts').functions).toBe(5);
  });

  it('counts Python and Go declarations', () => {
    const snapshot = makeSnapshot({
      'src/a.py': ['def one():', '    pass', '', 'async def two():', '    pass'].join('\n'),
      'src/b.go': [
        'package main',
        'func one() {}',
        'func (r *Repo) two() {}',
        'func main() {}',
      ].join('\n'),
    });

    const report = analyzeComplexity(snapshot);
    expect(fileFor(report, 'src/a.py').functions).toBe(2);
    expect(fileFor(report, 'src/b.go').functions).toBe(3);
  });

  it('scores a small, flat file as low risk and a large, dense one as high', () => {
    const simple = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const gnarly = Array.from(
      { length: 400 },
      (_, i) => `${'  '.repeat(Math.min(6, i % 8))}if (a${i} && b${i}) { run(${i}); }`,
    ).join('\n');

    const report = analyzeComplexity(
      makeSnapshot({ 'src/simple.ts': simple, 'src/gnarly.ts': gnarly }),
    );

    expect(fileFor(report, 'src/simple.ts').riskScore).toBeLessThan(15);
    expect(fileFor(report, 'src/gnarly.ts').riskScore).toBeGreaterThan(60);
    expect(report.hotspots[0]?.path).toBe('src/gnarly.ts');
  });

  it('keeps risk scores inside 0-100', () => {
    const extreme = Array.from(
      { length: 2000 },
      () => 'if (a && b || c ?? d) { if (e) { f(); } }',
    ).join('\n');
    const report = analyzeComplexity(makeSnapshot({ 'src/extreme.ts': extreme }));

    const measured = fileFor(report, 'src/extreme.ts');
    expect(measured.riskScore).toBeGreaterThanOrEqual(0);
    expect(measured.riskScore).toBeLessThanOrEqual(100);
  });

  it('caps hotspots at twenty entries, sorted by risk descending', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      files[`src/f${i}.ts`] = Array.from(
        { length: 20 + i * 20 },
        (_, line) => `if (a${line} && b${line}) { run(); }`,
      ).join('\n');
    }

    const report = analyzeComplexity(makeSnapshot(files));

    expect(report.hotspots).toHaveLength(20);
    for (let i = 1; i < report.hotspots.length; i++) {
      expect(report.hotspots[i - 1]?.riskScore).toBeGreaterThanOrEqual(
        report.hotspots[i]?.riskScore ?? 0,
      );
    }
  });

  it('buckets the cyclomatic distribution into the documented bands', () => {
    const snapshot = makeSnapshot({
      'src/flat.ts': 'const a = 1;',
      'src/some.ts': Array.from({ length: 8 }, () => 'if (a) { b(); }').join('\n'),
      'src/many.ts': Array.from({ length: 30 }, () => 'if (a) { b(); }').join('\n'),
    });

    const report = analyzeComplexity(snapshot);
    const buckets = Object.fromEntries(
      report.distribution.map((entry) => [entry.bucket, entry.count]),
    );

    expect(report.distribution.map((entry) => entry.bucket)).toEqual([
      '1-5',
      '6-10',
      '11-20',
      '21-50',
      '50+',
    ]);
    expect(buckets['1-5']).toBe(1);
    expect(buckets['6-10']).toBe(1);
    expect(buckets['21-50']).toBe(1);
  });

  it('skips binary, generated and vendored files', () => {
    const snapshot: RepoSnapshot = {
      source: DEFAULT_SOURCE,
      files: [
        ...makeSnapshot({
          'src/real.ts': 'const a = 1;',
          'dist/bundle.js': 'const a = 1;',
          'vendor/lib.ts': 'const a = 1;',
          'src/types.d.ts': 'export type A = 1;',
        }).files,
        makeBinaryFile('assets/logo.png', 4096),
      ],
      totalBytes: 0,
      truncated: false,
      skipped: { ignored: 0, binary: 0, tooLarge: 0, overBudget: 0 },
      ingestMs: 0,
    };

    const report = analyzeComplexity(snapshot);
    expect(report.files.map((file) => file.path)).toEqual(['src/real.ts']);
  });

  it('returns an empty report for a snapshot with no source', () => {
    const report = analyzeComplexity(makeSnapshot({ 'README.md': '# hi' }));

    expect(report.files).toEqual([]);
    expect(report.totalLoc).toBe(0);
    expect(report.totalSloc).toBe(0);
    expect(report.averageComplexity).toBe(0);
    expect(report.hotspots).toEqual([]);
  });

  it('totals loc and sloc across files', () => {
    const report = analyzeComplexity(
      makeSnapshot({
        'src/a.ts': 'const a = 1;\n\nconst b = 2;',
        'src/b.ts': 'const c = 3;',
      }),
    );

    expect(report.totalLoc).toBe(4);
    expect(report.totalSloc).toBe(3);
  });
});
