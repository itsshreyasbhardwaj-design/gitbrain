import { describe, expect, it } from 'vitest';

import { findDuplicates } from './duplication';
import { makeSnapshot } from '../testing/fixtures';

const BLOCK = [
  'const alpha = compute(1);',
  'const beta = transform(alpha);',
  'const gamma = validate(beta);',
  'const delta = persist(gamma);',
  'const epsilon = notify(delta);',
  'const zeta = audit(epsilon);',
  'const eta = archive(zeta);',
  'const theta = publish(eta);',
  'const iota = finalize(theta);',
  'const kappa = report(iota);',
];

describe('findDuplicates', () => {
  it('finds a block repeated across two files', () => {
    const blocks = findDuplicates(
      makeSnapshot({
        'src/a.ts': `${BLOCK.join('\n')}\nalphaOnly();`,
        'src/b.ts': `${BLOCK.join('\n')}\nbetaOnly();`,
      }),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.occurrences.map((occurrence) => occurrence.file)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('merges overlapping windows into one longer block instead of many', () => {
    const blocks = findDuplicates(
      makeSnapshot({
        'src/a.ts': `${BLOCK.join('\n')}\nalphaOnly();`,
        'src/b.ts': `${BLOCK.join('\n')}\nbetaOnly();`,
      }),
    );

    // Five overlapping six-line windows collapse into a single ten-line finding.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lineCount).toBe(BLOCK.length);
    expect(blocks[0]?.occurrences).toEqual([
      { file: 'src/a.ts', startLine: 1 },
      { file: 'src/b.ts', startLine: 1 },
    ]);
  });

  it('reports the real 1-based line of the first significant line', () => {
    const blocks = findDuplicates(
      makeSnapshot({
        'src/a.ts': ['// header', '', ...BLOCK, 'alphaOnly();'].join('\n'),
        'src/b.ts': [...BLOCK, 'betaOnly();'].join('\n'),
      }),
    );

    expect(blocks[0]?.occurrences).toEqual([
      { file: 'src/a.ts', startLine: 3 },
      { file: 'src/b.ts', startLine: 1 },
    ]);
  });

  it('ignores blank and comment-only lines when matching', () => {
    const spaced = BLOCK.flatMap((line, index) => (index === 4 ? ['', '// note', line] : [line]));

    const blocks = findDuplicates(
      makeSnapshot({
        'src/a.ts': `${BLOCK.join('\n')}\nalphaOnly();`,
        'src/b.ts': `${spaced.join('\n')}\nbetaOnly();`,
      }),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lineCount).toBe(BLOCK.length);
  });

  it('matches clones that differ only in string literals', () => {
    const tweaked = BLOCK.map((line) => line);
    tweaked[0] = 'const alpha = compute(1);';

    const original = [...BLOCK, `console.log('finished the alpha run');`];
    const clone = [...tweaked, `console.log('finished the beta run');`];

    const blocks = findDuplicates(
      makeSnapshot({ 'src/a.ts': original.join('\n'), 'src/b.ts': clone.join('\n') }),
    );

    // normalizeForDuplication blanks the string contents, so the log line matches too.
    expect(blocks[0]?.lineCount).toBe(BLOCK.length + 1);
  });

  it('skips pure import blocks', () => {
    const imports = [
      "import { a } from './a';",
      "import { b } from './b';",
      "import { c } from './c';",
      "import { d } from './d';",
      "import { e } from './e';",
      "import { f } from './f';",
    ].join('\n');

    const blocks = findDuplicates(
      makeSnapshot({
        'src/a.ts': `${imports}\nuseA();`,
        'src/b.ts': `${imports}\nuseB();`,
      }),
    );

    expect(blocks).toEqual([]);
  });

  it('skips runs of closing punctuation and single repeated lines', () => {
    const closers = ['}', '}', ')', '}', ');', '}'].join('\n');
    const repeated = Array.from({ length: 8 }, () => 'next();').join('\n');

    expect(
      findDuplicates(
        makeSnapshot({ 'src/a.ts': `first();\n${closers}`, 'src/b.ts': `second();\n${closers}` }),
      ),
    ).toEqual([]);

    expect(
      findDuplicates(
        makeSnapshot({ 'src/a.ts': `first();\n${repeated}`, 'src/b.ts': `second();\n${repeated}` }),
      ),
    ).toEqual([]);
  });

  it('skips windows that are too short to carry information', () => {
    const tiny = ['a;', 'b;', 'c;', 'd;', 'e;', 'f;'].join('\n');

    expect(findDuplicates(makeSnapshot({ 'src/a.ts': tiny, 'src/b.ts': tiny }))).toEqual([]);
  });

  it('honours a custom window size', () => {
    const short = [
      'const one = load(alpha);',
      'const two = load(beta);',
      'const three = load(gamma);',
    ];

    expect(
      findDuplicates(
        makeSnapshot({
          'src/a.ts': `${short.join('\n')}\nx();`,
          'src/b.ts': `${short.join('\n')}\ny();`,
        }),
      ),
    ).toEqual([]);

    const blocks = findDuplicates(
      makeSnapshot({
        'src/a.ts': `${short.join('\n')}\nx();`,
        'src/b.ts': `${short.join('\n')}\ny();`,
      }),
      3,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lineCount).toBe(3);
  });

  it('detects duplication inside a single file', () => {
    const content = [...BLOCK, 'divider();', ...BLOCK, 'tail();'].join('\n');
    const blocks = findDuplicates(makeSnapshot({ 'src/a.ts': content }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.occurrences).toHaveLength(2);
    expect(blocks[0]?.occurrences.every((occurrence) => occurrence.file === 'src/a.ts')).toBe(true);
  });

  it('sorts by duplicated volume and caps the result at fifty blocks', () => {
    const files: Record<string, string> = {};
    for (let group = 0; group < 60; group++) {
      const body = Array.from(
        { length: 6 + (group % 4) },
        (_, line) => `const g${group}_${line} = handle(${group}, ${line});`,
      ).join('\n');
      files[`src/a${group}.ts`] = `${body}\nfirst${group}();`;
      files[`src/b${group}.ts`] = `${body}\nsecond${group}();`;
    }

    const blocks = findDuplicates(makeSnapshot(files));

    expect(blocks).toHaveLength(50);
    for (let i = 1; i < blocks.length; i++) {
      const previous = blocks[i - 1];
      const current = blocks[i];
      const weight = (block: (typeof blocks)[number] | undefined) =>
        block ? block.lineCount * block.occurrences.length : 0;
      expect(weight(previous)).toBeGreaterThanOrEqual(weight(current));
    }
  });

  it('ignores generated and vendored files', () => {
    const body = `${BLOCK.join('\n')}\ntail();`;

    expect(findDuplicates(makeSnapshot({ 'dist/a.js': body, 'vendor/b.js': body }))).toEqual([]);
  });

  it('returns an empty list when there is nothing to compare', () => {
    expect(findDuplicates(makeSnapshot({}))).toEqual([]);
    expect(findDuplicates(makeSnapshot({ 'src/a.ts': 'const a = 1;' }))).toEqual([]);
  });
});
