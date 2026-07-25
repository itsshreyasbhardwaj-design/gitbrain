import { describe, expect, it } from 'vitest';

import { computeLanguages } from './languages';
import { makeBinaryFile, makeFile, makeSnapshot } from '../testing/fixtures';

describe('computeLanguages', () => {
  it('returns nothing for an empty repository', () => {
    expect(computeLanguages([])).toEqual([]);
  });

  it('aggregates files and bytes per language', () => {
    const snapshot = makeSnapshot({
      'src/a.ts': 'x'.repeat(300),
      'src/b.ts': 'y'.repeat(100),
      'src/c.py': 'z'.repeat(100),
    });

    const languages = computeLanguages(snapshot.files);

    expect(languages).toHaveLength(2);
    expect(languages[0]).toMatchObject({
      language: 'TypeScript',
      files: 2,
      bytes: 400,
      percent: 80,
    });
    expect(languages[1]).toMatchObject({ language: 'Python', files: 1, bytes: 100, percent: 20 });
  });

  it('sorts by bytes descending regardless of file count', () => {
    const snapshot = makeSnapshot({
      'a.ts': 'x'.repeat(10),
      'b.ts': 'x'.repeat(10),
      'c.ts': 'x'.repeat(10),
      'big.go': 'g'.repeat(500),
    });

    const [first] = computeLanguages(snapshot.files);

    expect(first?.language).toBe('Go');
  });

  it('carries the linguist colour for each language', () => {
    const snapshot = makeSnapshot({ 'main.rs': 'fn main() {}' });

    expect(computeLanguages(snapshot.files)[0]?.color).toBe('#dea584');
  });

  it('excludes binary files', () => {
    const files = [
      makeFile('src/a.ts', 'x'.repeat(100)),
      makeBinaryFile('assets/logo.png', 90_000),
    ];

    const languages = computeLanguages(files);

    expect(languages).toHaveLength(1);
    expect(languages[0]?.percent).toBe(100);
  });

  it('excludes vendored trees so third-party code cannot dominate', () => {
    const snapshot = makeSnapshot({
      'src/app.ts': 'x'.repeat(100),
      'vendor/github.com/pkg/errors/errors.go': 'g'.repeat(50_000),
      'node_modules/left-pad/index.js': 'j'.repeat(50_000),
    });

    const languages = computeLanguages(snapshot.files);

    expect(languages.map((entry) => entry.language)).toEqual(['TypeScript']);
  });

  it('percentages sum to 100 even when they do not divide evenly', () => {
    const snapshot = makeSnapshot({
      'a.ts': 'x'.repeat(100),
      'b.py': 'y'.repeat(100),
      'c.go': 'z'.repeat(100),
    });

    const languages = computeLanguages(snapshot.files);
    const total = languages.reduce((sum, entry) => sum + entry.percent, 0);

    expect(Math.round(total * 10) / 10).toBe(100);
  });

  it('keeps percentages summing to 100 across a long tail', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 17; i++) files[`file${i}.ts`] = 'x'.repeat(i + 1);
    files['other.py'] = 'y'.repeat(7);
    files['more.go'] = 'z'.repeat(13);
    files['readme.md'] = 'm'.repeat(3);

    const languages = computeLanguages(makeSnapshot(files).files);
    const total = languages.reduce((sum, entry) => sum + entry.percent, 0);

    expect(Math.round(total * 10) / 10).toBe(100);
  });

  it('spreads shares evenly when every file is empty', () => {
    const snapshot = makeSnapshot({ 'a.ts': '', 'b.py': '' });

    const languages = computeLanguages(snapshot.files);
    const total = languages.reduce((sum, entry) => sum + entry.percent, 0);

    expect(languages).toHaveLength(2);
    expect(Math.round(total)).toBe(100);
  });

  it('counts documentation and config languages alongside source', () => {
    const snapshot = makeSnapshot({
      'src/a.ts': 'x'.repeat(50),
      'README.md': 'm'.repeat(50),
      'package.json': 'j'.repeat(50),
    });

    expect(
      computeLanguages(snapshot.files)
        .map((entry) => entry.language)
        .sort(),
    ).toEqual(['JSON', 'Markdown', 'TypeScript']);
  });

  it('is deterministic for languages of equal weight', () => {
    const snapshot = makeSnapshot({ 'a.go': 'xx', 'b.rs': 'yy' });

    expect(computeLanguages(snapshot.files).map((entry) => entry.language)).toEqual(['Go', 'Rust']);
  });
});
