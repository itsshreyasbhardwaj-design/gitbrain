import { describe, expect, it } from 'vitest';

import type { TreeNode } from '../types';
import { makeBinaryFile, makeFile } from '../testing/fixtures';
import { buildTree } from './tree';

/** Depth-first lookup by repo-relative path. */
function find(node: TreeNode, path: string): TreeNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, path);
    if (hit) return hit;
  }
  return undefined;
}

function childNames(node: TreeNode | undefined): string[] {
  return (node?.children ?? []).map((child) => child.name);
}

const SAMPLE = [
  makeFile('README.md', '# Demo\n'),
  makeFile('package.json', '{"name":"demo"}'),
  makeFile('src/index.ts', 'export const run = 1;\n'),
  makeFile('src/components/Button.tsx', 'export const Button = () => null;\n'),
  makeFile('src/components/Card.tsx', 'export const Card = () => null;\n'),
  makeFile('src/components/helpers.ts', 'export const cx = (s: string) => s;\n'),
  makeFile('src/lib/format.ts', 'export const format = () => 1;\n'),
  makeFile('src/lib/format.test.ts', 'it("works", () => {});\n'),
  makeBinaryFile('public/logo.png', 2048),
];

describe('buildTree — structure', () => {
  it('produces a synthetic root with an empty path', () => {
    const tree = buildTree(SAMPLE);

    expect(tree.name).toBe('/');
    expect(tree.path).toBe('');
    expect(tree.type).toBe('dir');
  });

  it('nests directories to arbitrary depth with correct paths', () => {
    const tree = buildTree(SAMPLE);

    const components = find(tree, 'src/components');
    expect(components?.type).toBe('dir');
    expect(components?.name).toBe('components');
    expect(childNames(components)).toEqual(['Button.tsx', 'Card.tsx', 'helpers.ts']);

    const button = find(tree, 'src/components/Button.tsx');
    expect(button?.type).toBe('file');
    expect(button?.children).toBeUndefined();
    expect(button?.fileCount).toBe(1);
  });

  it('sorts directories before files, each group alphabetically', () => {
    const tree = buildTree([
      makeFile('z.txt', 'z'),
      makeFile('a.txt', 'a'),
      makeFile('zebra/x.ts', 'x'),
      makeFile('alpha/y.ts', 'y'),
    ]);

    expect(childNames(tree)).toEqual(['alpha', 'zebra', 'a.txt', 'z.txt']);
  });

  it('returns a bare root for an empty file list', () => {
    const tree = buildTree([]);

    expect(tree.children).toEqual([]);
    expect(tree.fileCount).toBe(0);
    expect(tree.size).toBe(0);
    expect(tree.purpose).toBe('Repository root. Currently empty.');
  });
});

describe('buildTree — aggregates', () => {
  it('rolls size and file count up through every ancestor', () => {
    const tree = buildTree(SAMPLE);

    const components = find(tree, 'src/components');
    expect(components?.fileCount).toBe(3);
    expect(components?.size).toBe(
      SAMPLE.filter((file) => file.path.startsWith('src/components/')).reduce(
        (total, file) => total + file.size,
        0,
      ),
    );

    expect(find(tree, 'src')?.fileCount).toBe(6);
    expect(tree.fileCount).toBe(SAMPLE.length);
    expect(tree.size).toBe(SAMPLE.reduce((total, file) => total + file.size, 0));
  });

  it('reports the language holding the most bytes beneath a node', () => {
    const tree = buildTree(SAMPLE);

    expect(find(tree, 'src')?.language).toBe('TypeScript');
    expect(find(tree, 'src/components/Button.tsx')?.language).toBe('TypeScript');
  });

  it('omits language when nothing beneath a node is recognisable', () => {
    const tree = buildTree([makeBinaryFile('blobs/data.bin', 10)]);

    expect(find(tree, 'blobs')?.language).toBeUndefined();
  });

  it('weights the dominant language by bytes rather than file count', () => {
    const tree = buildTree([
      makeFile('mixed/a.ts', 'a'),
      makeFile('mixed/b.ts', 'b'),
      makeFile('mixed/c.ts', 'c'),
      makeFile('mixed/big.py', 'x'.repeat(500)),
    ]);

    expect(find(tree, 'mixed')?.language).toBe('Python');
  });
});

describe('buildTree — purpose', () => {
  it('combines a conventional folder meaning with observed contents', () => {
    const tree = buildTree(SAMPLE);
    const purpose = find(tree, 'src/components')?.purpose ?? '';

    expect(purpose).toContain('Reusable presentation components.');
    expect(purpose).toContain('2 React components');
  });

  it('counts API route handlers found in an api folder', () => {
    const tree = buildTree([
      makeFile('src/api/users.ts', 'export const GET = () => null;'),
      makeFile('src/api/orders.ts', 'export const GET = () => null;'),
    ]);

    const purpose = find(tree, 'src/api')?.purpose ?? '';
    expect(purpose).toContain('HTTP surface');
    expect(purpose).toContain('2 API route handlers');
  });

  it('counts tests and documents', () => {
    const lib = buildTree(SAMPLE);
    expect(find(lib, 'src/lib')?.purpose).toContain('1 test file');

    const docs = buildTree([
      makeFile('docs/guide.md', '# Guide'),
      makeFile('docs/api.md', '# API'),
    ]);
    expect(find(docs, 'docs')?.purpose).toContain('2 documents');
  });

  it('describes an unconventional folder purely from its contents', () => {
    const tree = buildTree([
      makeFile('widgetry/one.ts', 'export const a = 1;'),
      makeFile('widgetry/two.ts', 'export const b = 2;'),
    ]);

    expect(find(tree, 'widgetry')?.purpose).toBe('Holds 2 TypeScript files.');
  });

  it('falls back to a plain file count when no category or language applies', () => {
    const tree = buildTree([makeBinaryFile('blobs/a.bin', 4), makeBinaryFile('blobs/b.bin', 4)]);

    expect(find(tree, 'blobs')?.purpose).toBe('Holds 2 files.');
  });

  it('uses singular wording for a single item', () => {
    const tree = buildTree([makeFile('widgetry/one.ts', 'export const a = 1;')]);

    expect(find(tree, 'widgetry')?.purpose).toBe('Holds 1 TypeScript file.');
  });

  it('describes the repository root and never annotates files', () => {
    const tree = buildTree(SAMPLE);

    expect(tree.purpose).toContain('Repository root.');
    expect(find(tree, 'src/index.ts')?.purpose).toBeUndefined();
  });

  it('recognises Go layout conventions', () => {
    const tree = buildTree([
      makeFile('cmd/server/main.go', 'package main'),
      makeFile('internal/store/store.go', 'package store'),
      makeFile('pkg/api/api.go', 'package api'),
    ]);

    expect(find(tree, 'cmd')?.purpose).toContain('Go command entry points');
    expect(find(tree, 'internal')?.purpose).toContain('importable only from within this module');
    expect(find(tree, 'pkg')?.purpose).toContain('intended for import by other modules');
  });
});
