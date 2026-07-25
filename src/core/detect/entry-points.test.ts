import { describe, expect, it } from 'vitest';

import { analyzeDependencies } from './dependencies';
import { detectStack } from './stack';
import { findEntryPoints } from './entry-points';
import { makeSnapshot } from '../testing/fixtures';
import type { EntryPoint } from '../types';

/** Run the real pipeline so entry points see the stack the detector produced. */
function analyze(files: Record<string, string>): EntryPoint[] {
  const snapshot = makeSnapshot(files);
  const stack = detectStack(snapshot, analyzeDependencies(snapshot));
  return findEntryPoints(snapshot, stack);
}

const at = (entries: readonly EntryPoint[], path: string): EntryPoint | undefined =>
  entries.find((entry) => entry.path === path);

const paths = (entries: readonly EntryPoint[]): string[] => entries.map((entry) => entry.path);

const PKG = (extra: Record<string, unknown>): string => JSON.stringify({ name: 'demo', ...extra });

describe('findEntryPoints', () => {
  it('returns nothing for an empty repository', () => {
    expect(analyze({})).toEqual([]);
  });

  describe('package.json', () => {
    it('resolves scripts.start to the file it runs', () => {
      const entries = analyze({
        'package.json': PKG({ scripts: { start: 'node src/server.js' } }),
        'src/server.js': 'require("http");\n',
      });

      expect(at(entries, 'src/server.js')).toMatchObject({
        kind: 'server',
        confidence: 'high',
      });
      expect(at(entries, 'src/server.js')?.reason).toContain('scripts.start');
    });

    it('cites the manifest when scripts.start names no file', () => {
      const entries = analyze({ 'package.json': PKG({ scripts: { start: 'next start' } }) });

      expect(at(entries, 'package.json')).toMatchObject({ kind: 'server', confidence: 'high' });
      expect(at(entries, 'package.json')?.reason).toContain('next start');
    });

    it('resolves every command in a bin map', () => {
      const entries = analyze({
        'package.json': PKG({ bin: { gitbrain: 'bin/cli.js', gb: 'bin/short.js' } }),
        'bin/cli.js': '#!/usr/bin/env node\n',
        'bin/short.js': '#!/usr/bin/env node\n',
      });

      expect(paths(entries)).toEqual(expect.arrayContaining(['bin/cli.js', 'bin/short.js']));
      expect(at(entries, 'bin/cli.js')?.kind).toBe('cli');
      expect(at(entries, 'bin/cli.js')?.reason).toContain('gitbrain');
    });

    it('accepts the string form of bin', () => {
      const entries = analyze({
        'package.json': PKG({ bin: 'cli.js' }),
        'cli.js': '#!/usr/bin/env node\n',
      });

      expect(at(entries, 'cli.js')?.reason).toContain('demo');
    });

    it('cites the manifest when bin points at unbuilt output', () => {
      const entries = analyze({ 'package.json': PKG({ bin: { demo: 'dist/cli.js' } }) });

      expect(at(entries, 'package.json')?.reason).toContain('dist/cli.js');
    });

    it('reports main, module and exports as library entries', () => {
      const entries = analyze({
        'package.json': PKG({
          main: 'src/index.js',
          module: 'src/index.mjs',
          exports: { '.': { import: './src/index.mjs' } },
        }),
        'src/index.js': 'module.exports = {};\n',
        'src/index.mjs': 'export default {};\n',
      });

      expect(at(entries, 'src/index.js')?.kind).toBe('library');
      expect(at(entries, 'src/index.js')?.reason).toContain('main');
      expect(at(entries, 'src/index.mjs')).toBeDefined();
    });

    it('reads the root manifest of a monorepo, not a nested one', () => {
      const entries = analyze({
        'package.json': PKG({ scripts: { start: 'node server.js' } }),
        'server.js': '',
        'apps/web/package.json': PKG({ scripts: { start: 'node apps/web/other.js' } }),
        'apps/web/other.js': '',
      });

      expect(paths(entries)).toContain('server.js');
      expect(paths(entries)).not.toContain('apps/web/other.js');
    });

    it('ignores a malformed manifest without failing', () => {
      const entries = analyze({ 'package.json': '{ oops', 'src/index.ts': 'export const a = 1;' });

      expect(paths(entries)).toEqual(['src/index.ts']);
    });
  });

  describe('frameworks and conventions', () => {
    it('puts the Next.js layout ahead of the page', () => {
      const entries = analyze({
        'package.json': PKG({ dependencies: { next: '16.2.11' } }),
        'src/app/layout.tsx': 'export default function RootLayout() {}\n',
        'src/app/page.tsx': 'export default function Home() {}\n',
      });

      expect(paths(entries).slice(0, 2)).toEqual(['src/app/layout.tsx', 'src/app/page.tsx']);
      expect(at(entries, 'src/app/layout.tsx')).toMatchObject({
        kind: 'app',
        confidence: 'high',
      });
    });

    it('downgrades app/page.tsx when no framework confirms it', () => {
      const entries = analyze({ 'app/page.tsx': 'export default function Home() {}\n' });

      expect(at(entries, 'app/page.tsx')?.confidence).toBe('medium');
    });

    it.each([
      ['src/index.ts', 'library'],
      ['src/main.ts', 'app'],
      ['src/server.ts', 'server'],
      ['index.js', 'library'],
      ['main.py', 'app'],
      ['manage.py', 'cli'],
      ['app/__main__.py', 'cli'],
      ['config/wsgi.py', 'server'],
      ['config/asgi.py', 'server'],
      ['cmd/server/main.go', 'cli'],
      ['src/main.rs', 'app'],
      ['src/bin/worker.rs', 'cli'],
    ])('classifies %s as %s', (path, kind) => {
      const entries = analyze({ [path]: '// code\n' });

      expect(at(entries, path)?.kind).toBe(kind);
      expect(at(entries, path)?.reason.length).toBeGreaterThan(0);
    });

    it('finds every cmd/ executable in a Go repository', () => {
      const entries = analyze({
        'go.mod': 'module demo\n\ngo 1.22\n',
        'cmd/api/main.go': 'package main\n',
        'cmd/worker/main.go': 'package main\n',
      });

      expect(paths(entries)).toEqual(
        expect.arrayContaining(['cmd/api/main.go', 'cmd/worker/main.go']),
      );
    });
  });

  describe('Dockerfile', () => {
    it('resolves a JSON-array CMD to the file it runs', () => {
      const entries = analyze({
        Dockerfile: 'FROM node:20\nWORKDIR /app\nCMD ["node", "server.js"]\n',
        'server.js': '',
      });

      expect(at(entries, 'server.js')?.reason).toContain('Dockerfile CMD');
    });

    it('handles the shell form and ENTRYPOINT', () => {
      const entries = analyze({ Dockerfile: 'FROM python:3.12\nENTRYPOINT python -m app\n' });

      expect(at(entries, 'Dockerfile')).toMatchObject({ kind: 'build', confidence: 'high' });
      expect(at(entries, 'Dockerfile')?.reason).toContain('ENTRYPOINT');
    });

    it('uses the last start directive in a multi-stage build', () => {
      const entries = analyze({
        Dockerfile: [
          'FROM node:20 AS build',
          'CMD ["node", "build.js"]',
          '',
          'FROM node:20',
          'CMD ["node", "dist/server.js"]',
        ].join('\n'),
      });

      expect(at(entries, 'Dockerfile')?.reason).toContain('dist/server.js');
    });

    it('ignores a Dockerfile with no start directive', () => {
      const entries = analyze({ Dockerfile: 'FROM node:20\nRUN npm ci\n' });

      expect(entries).toEqual([]);
    });
  });

  describe('Makefile', () => {
    it('reports the first target as the default goal', () => {
      const entries = analyze({
        Makefile: '.PHONY: build test\n\nbuild:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n',
      });

      expect(at(entries, 'Makefile')).toMatchObject({ kind: 'build', confidence: 'medium' });
      expect(at(entries, 'Makefile')?.reason).toContain('build');
    });

    it('prefers an explicit .DEFAULT_GOAL', () => {
      const entries = analyze({
        Makefile: '.DEFAULT_GOAL := help\n\nbuild:\n\tgo build ./...\n\nhelp:\n\t@echo hi\n',
      });

      expect(at(entries, 'Makefile')).toMatchObject({ confidence: 'high' });
      expect(at(entries, 'Makefile')?.reason).toContain('help');
    });

    it('does not mistake a variable assignment for a target', () => {
      const entries = analyze({ Makefile: 'BIN := ./bin\n\nrun:\n\t$(BIN)/app\n' });

      expect(at(entries, 'Makefile')?.reason).toContain('run');
    });
  });

  describe('ordering and deduplication', () => {
    it('lists application entries before build scaffolding', () => {
      const entries = analyze({
        'package.json': PKG({ dependencies: { next: '16.2.11' } }),
        'app/layout.tsx': 'export default function RootLayout() {}\n',
        Dockerfile: 'FROM node:20\nCMD ["node", "server.js"]\n',
        Makefile: 'build:\n\tnpm run build\n',
      });

      const kinds = entries.map((entry) => entry.kind);
      expect(kinds.indexOf('app')).toBeLessThan(kinds.indexOf('build'));
    });

    it('emits each path once, keeping the strongest reason', () => {
      const entries = analyze({
        'package.json': PKG({ bin: { demo: 'src/index.ts' }, main: 'src/index.ts' }),
        'src/index.ts': 'export const run = () => {};\n',
      });

      expect(entries.filter((entry) => entry.path === 'src/index.ts')).toHaveLength(1);
      expect(at(entries, 'src/index.ts')?.kind).toBe('cli');
    });

    it('promotes the exported surface for a library repository', () => {
      const entries = analyze({
        'package.json': PKG({ main: 'src/index.ts', exports: './src/index.ts' }),
        'src/index.ts': 'export const version = 1;\n',
        Makefile: 'build:\n\ttsc\n',
      });

      expect(entries[0]?.path).toBe('src/index.ts');
      expect(entries[0]?.kind).toBe('library');
    });

    it('sorts high confidence ahead of medium within a kind', () => {
      const entries = analyze({
        'package.json': PKG({ bin: { demo: 'bin/cli.js' } }),
        'bin/cli.js': '',
        'cmd/tool/main.go': 'package main\n',
        'src/main.rs': 'fn main() {}\n',
      });

      const cliEntries = entries.filter((entry) => entry.kind === 'cli');
      expect(cliEntries.length).toBeGreaterThan(1);
      expect(cliEntries[0]?.confidence).toBe('high');
    });

    it('ignores vendored trees', () => {
      const entries = analyze({
        'src/index.ts': 'export const a = 1;\n',
        'node_modules/left-pad/index.js': 'module.exports = () => {};\n',
        'vendor/lib/main.go': 'package main\n',
      });

      expect(paths(entries)).toEqual(['src/index.ts']);
    });
  });

  describe('realistic repositories', () => {
    it('describes a Next.js application', () => {
      const entries = analyze({
        'package.json': PKG({
          dependencies: { next: '16.2.11', react: '19.2.4' },
          scripts: { start: 'next start', dev: 'next dev' },
        }),
        'next.config.ts': 'export default {};\n',
        'src/app/layout.tsx': 'export default function RootLayout() {}\n',
        'src/app/page.tsx': 'export default function Home() {}\n',
      });

      expect(paths(entries)).toEqual(['src/app/layout.tsx', 'src/app/page.tsx', 'package.json']);
    });

    it('describes a Django project', () => {
      const entries = analyze({
        'requirements.txt': 'Django==5.0.6\n',
        'manage.py': '#!/usr/bin/env python\n',
        'config/wsgi.py': 'application = get_wsgi_application()\n',
        'config/asgi.py': 'application = get_asgi_application()\n',
      });

      expect(paths(entries)).toEqual(['config/wsgi.py', 'config/asgi.py', 'manage.py']);
      expect(entries.every((entry) => entry.confidence === 'high')).toBe(true);
    });

    it('describes a Go service', () => {
      const entries = analyze({
        'go.mod': 'module demo\n\ngo 1.22\n',
        'cmd/server/main.go': 'package main\n\nfunc main() {}\n',
        Dockerfile: 'FROM golang:1.22\nCMD ["/app/server"]\n',
        Makefile: 'build:\n\tgo build ./cmd/server\n',
      });

      expect(paths(entries)).toEqual(['cmd/server/main.go', 'Dockerfile', 'Makefile']);
      expect(entries.map((entry) => entry.kind)).toEqual(['cli', 'build', 'build']);
    });
  });
});
