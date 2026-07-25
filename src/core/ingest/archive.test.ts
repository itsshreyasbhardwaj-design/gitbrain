import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, DEFAULT_LIMITS, extractArchive } from './archive';
import { isContentSkipped, isIgnoredPath, looksBinary } from './ignore';

/** Build a ZIP the way GitHub does: everything under one root directory. */
function makeZip(
  files: Record<string, string | Uint8Array>,
  root = 'acme-demo-abc123',
): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[`${root}/${path}`] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(entries);
}

describe('extractArchive', () => {
  it('strips the GitHub archive root directory', async () => {
    const zip = makeZip({ 'src/index.ts': 'export const x = 1;\n', 'README.md': '# Demo\n' });
    const result = await extractArchive(zip);

    expect(result.files.map((f) => f.path).sort()).toEqual(['README.md', 'src/index.ts']);
  });

  it('decodes text content and counts lines', async () => {
    const zip = makeZip({ 'a.ts': 'one\ntwo\nthree\n' });
    const result = await extractArchive(zip);
    const file = result.files.find((f) => f.path === 'a.ts');

    expect(file?.content).toBe('one\ntwo\nthree\n');
    expect(file?.lines).toBe(4);
    expect(file?.isBinary).toBe(false);
    expect(file?.ext).toBe('ts');
  });

  it('excludes dependency and build directories at any depth', async () => {
    const zip = makeZip({
      'src/app.ts': 'ok',
      'node_modules/left-pad/index.js': 'nope',
      'packages/web/node_modules/x/index.js': 'nope',
      'dist/bundle.js': 'nope',
      '.git/config': 'nope',
      'coverage/lcov.info': 'nope',
    });
    const result = await extractArchive(zip);

    expect(result.files.map((f) => f.path)).toEqual(['src/app.ts']);
    expect(result.skipped.ignored).toBeGreaterThanOrEqual(5);
  });

  it('keeps lockfiles as entries but drops their contents', async () => {
    const zip = makeZip({
      'package.json': '{"name":"demo"}',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n'.repeat(500),
    });
    const result = await extractArchive(zip);
    const lock = result.files.find((f) => f.path === 'pnpm-lock.yaml');

    // The dependency analyzer needs to see that a lockfile exists...
    expect(lock).toBeDefined();
    // ...but its contents must not pollute line counts or duplication.
    expect(lock?.content).toBeNull();
    expect(lock?.size).toBeGreaterThan(0);
  });

  it('marks binary files without attempting to decode them', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const zip = makeZip({ 'logo.png': png, 'src/a.ts': 'ok' });
    const result = await extractArchive(zip);
    const image = result.files.find((f) => f.path === 'logo.png');

    expect(image?.isBinary).toBe(true);
    expect(image?.content).toBeNull();
    expect(result.skipped.binary).toBe(1);
  });

  it('skips content for files over the per-file limit but keeps the entry', async () => {
    const zip = makeZip({ 'big.ts': 'x'.repeat(5000), 'small.ts': 'ok' });
    const result = await extractArchive(zip, { ...DEFAULT_LIMITS, maxFileBytes: 1000 });

    const big = result.files.find((f) => f.path === 'big.ts');
    expect(big?.content).toBeNull();
    expect(big?.size).toBe(5000);
    expect(result.skipped.tooLarge).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('rejects a non-ZIP payload', async () => {
    await expect(extractArchive(strToU8('this is not a zip'))).rejects.toThrow(ArchiveError);
  });

  it('rejects an empty payload', async () => {
    await expect(extractArchive(new Uint8Array(0))).rejects.toThrow(ArchiveError);
  });

  it('rejects an archive over the size limit before decompressing it', async () => {
    const zip = makeZip({ 'a.ts': 'x'.repeat(2000) });
    await expect(extractArchive(zip, { ...DEFAULT_LIMITS, maxArchiveBytes: 10 })).rejects.toThrow(
      /over the/,
    );
  });

  it('rejects an archive containing only ignored files', async () => {
    const zip = makeZip({ 'node_modules/x/index.js': 'nope' });
    await expect(extractArchive(zip)).rejects.toThrow(/no analyzable source files/i);
  });

  it('does not strip a root when entries do not share one', async () => {
    const zip = zipSync({ 'a.ts': strToU8('a'), 'b/c.ts': strToU8('c') });
    const result = await extractArchive(zip);

    expect(result.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b/c.ts']);
  });

  it('returns files sorted by path for deterministic downstream output', async () => {
    const zip = makeZip({ 'z.ts': 'z', 'a.ts': 'a', 'm/b.ts': 'b' });
    const result = await extractArchive(zip);
    const paths = result.files.map((f) => f.path);

    expect(paths).toEqual([...paths].sort());
  });

  it('enforces the file-count budget and reports truncation', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i++) files[`src/file-${i}.ts`] = `export const v${i} = ${i};`;

    const result = await extractArchive(makeZip(files), { ...DEFAULT_LIMITS, maxFiles: 10 });

    expect(result.files.length).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.skipped.overBudget).toBe(40);
  });
});

describe('ignore rules', () => {
  it.each([
    'node_modules/react/index.js',
    'src/../node_modules/x.js',
    '.git/HEAD',
    'dist/main.js',
    'app.min.js',
    'vendor/bundle.chunk.js',
    'build/out.js.map',
    '.DS_Store',
  ])('ignores %s', (path) => {
    expect(isIgnoredPath(path)).toBe(true);
  });

  it.each([
    'src/index.ts',
    'README.md',
    'package.json',
    '.github/workflows/ci.yml',
    'src/a.test.ts',
  ])('keeps %s', (path) => {
    expect(isIgnoredPath(path)).toBe(false);
  });

  it('recognises lockfiles as content-skipped rather than ignored', () => {
    expect(isContentSkipped('pnpm-lock.yaml')).toBe(true);
    expect(isIgnoredPath('pnpm-lock.yaml')).toBe(false);
  });
});

describe('looksBinary', () => {
  it('detects a NUL byte as binary', () => {
    expect(looksBinary(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true);
  });

  it('treats plain ASCII as text', () => {
    expect(looksBinary(strToU8('const x = 1;\n'))).toBe(false);
  });

  it('treats UTF-8 with emoji and accents as text', () => {
    expect(looksBinary(strToU8('const café = "🎉";\n'))).toBe(false);
  });

  it('treats an empty buffer as text', () => {
    expect(looksBinary(new Uint8Array(0))).toBe(false);
  });

  it('detects control-character-dense data as binary', () => {
    expect(
      looksBinary(new Uint8Array(Array.from({ length: 100 }, (_, i) => (i % 2 ? 0x01 : 0x41)))),
    ).toBe(true);
  });
});
