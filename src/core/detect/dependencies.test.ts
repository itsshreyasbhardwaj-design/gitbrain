import { describe, expect, it } from 'vitest';

import { analyzeDependencies, isLockfile } from './dependencies';
import { makeSnapshot } from '../testing/fixtures';
import type { Dependency } from '../types';

const find = (deps: readonly Dependency[], name: string): Dependency | undefined =>
  deps.find((dependency) => dependency.name === name);

describe('analyzeDependencies', () => {
  it('reports an empty repository honestly', () => {
    const report = analyzeDependencies(makeSnapshot({}));

    expect(report.dependencies).toEqual([]);
    expect(report.manifests).toEqual([]);
    expect(report.counts).toEqual({ runtime: 0, dev: 0, peer: 0, optional: 0 });
    expect(report.flagged).toEqual([]);
    expect(report.unpinned).toEqual([]);
    expect(report.hasLockfile).toBe(false);
  });

  describe('package.json', () => {
    const snapshot = makeSnapshot({
      'package.json': JSON.stringify({
        name: 'demo',
        dependencies: { next: '16.2.11', react: '19.2.4' },
        devDependencies: { vitest: '^3.2.4' },
        peerDependencies: { typescript: '>=5' },
        optionalDependencies: { fsevents: '^2.3.3' },
      }),
    });

    it('parses all four dependency sections', () => {
      const { dependencies, counts } = analyzeDependencies(snapshot);

      expect(counts).toEqual({ runtime: 2, dev: 1, peer: 1, optional: 1 });
      expect(find(dependencies, 'next')).toEqual({
        name: 'next',
        range: '16.2.11',
        kind: 'runtime',
        manifest: 'package.json',
        ecosystem: 'npm',
      });
      expect(find(dependencies, 'vitest')?.kind).toBe('dev');
      expect(find(dependencies, 'typescript')?.kind).toBe('peer');
      expect(find(dependencies, 'fsevents')?.kind).toBe('optional');
    });

    it('records the manifest path', () => {
      expect(analyzeDependencies(snapshot).manifests).toEqual(['package.json']);
    });

    it('survives a malformed manifest without losing the others', () => {
      const broken = makeSnapshot({
        'package.json': '{ "dependencies": { "react": }',
        'api/package.json': JSON.stringify({ dependencies: { express: '^4.19.2' } }),
      });

      const report = analyzeDependencies(broken);

      // The broken file is still a manifest that exists, so it stays listed —
      // it simply contributes nothing.
      expect(report.manifests).toEqual(['api/package.json', 'package.json']);
      expect(report.dependencies).toHaveLength(1);
      expect(find(report.dependencies, 'express')?.range).toBe('^4.19.2');
    });

    it('keeps one entry per workspace manifest in a monorepo', () => {
      const monorepo = makeSnapshot({
        'apps/web/package.json': JSON.stringify({ dependencies: { react: '19.2.4' } }),
        'apps/api/package.json': JSON.stringify({ dependencies: { react: '19.2.4' } }),
      });

      const { dependencies, manifests } = analyzeDependencies(monorepo);

      expect(manifests).toEqual(['apps/api/package.json', 'apps/web/package.json']);
      expect(dependencies.filter((entry) => entry.name === 'react')).toHaveLength(2);
    });

    it('ignores manifests inside vendored trees', () => {
      const vendored = makeSnapshot({
        'package.json': JSON.stringify({ dependencies: { react: '19.2.4' } }),
        'node_modules/react/package.json': JSON.stringify({
          dependencies: { 'loose-envify': '*' },
        }),
      });

      const report = analyzeDependencies(vendored);

      expect(report.manifests).toEqual(['package.json']);
      expect(report.unpinned).toEqual([]);
    });
  });

  describe('Python', () => {
    it('parses requirements.txt including extras, markers and comments', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'requirements.txt': [
            '# Web layer',
            'fastapi==0.111.0',
            'uvicorn[standard]>=0.29',
            'requests  # HTTP client',
            'pydantic>=2,<3',
            'typing-extensions>=4.0 ; python_version < "3.11"',
            '-r dev-requirements.txt',
            '--index-url https://example.com/simple',
            '',
          ].join('\n'),
        }),
      );

      const names = report.dependencies.map((entry) => entry.name);
      expect(names).toEqual(['fastapi', 'uvicorn', 'requests', 'pydantic', 'typing-extensions']);
      expect(find(report.dependencies, 'fastapi')?.range).toBe('==0.111.0');
      expect(find(report.dependencies, 'pydantic')?.range).toBe('>=2,<3');
      expect(find(report.dependencies, 'requests')?.ecosystem).toBe('pypi');
    });

    it('treats requirements-dev.txt as dev dependencies', () => {
      const report = analyzeDependencies(
        makeSnapshot({ 'requirements-dev.txt': 'pytest==8.2.0\n' }),
      );

      expect(find(report.dependencies, 'pytest')?.kind).toBe('dev');
    });

    it('parses PEP 621 dependencies from pyproject.toml', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'pyproject.toml': [
            '[project]',
            'name = "demo"',
            'requires-python = ">=3.11"',
            'dependencies = [',
            '  "fastapi>=0.111",',
            '  "sqlalchemy[asyncio]==2.0.30",',
            ']',
            '',
            '[project.optional-dependencies]',
            'dev = ["pytest>=8", "ruff"]',
          ].join('\n'),
        }),
      );

      expect(report.dependencies.map((entry) => entry.name)).toEqual([
        'fastapi',
        'sqlalchemy',
        'pytest',
        'ruff',
      ]);
      expect(find(report.dependencies, 'sqlalchemy')?.range).toBe('==2.0.30');
      expect(find(report.dependencies, 'pytest')?.kind).toBe('dev');
    });

    it('parses poetry tables and skips the python interpreter pin', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'pyproject.toml': [
            '[tool.poetry]',
            'name = "demo"',
            '',
            '[tool.poetry.dependencies]',
            'python = "^3.11"',
            'django = "^5.0"',
            'psycopg = { version = "^3.1", extras = ["binary"] }',
            '',
            '[tool.poetry.group.dev.dependencies]',
            'pytest = "^8.2"',
          ].join('\n'),
        }),
      );

      expect(report.dependencies.map((entry) => entry.name)).toEqual([
        'django',
        'psycopg',
        'pytest',
      ]);
      expect(find(report.dependencies, 'psycopg')?.range).toBe('^3.1');
      expect(find(report.dependencies, 'pytest')?.kind).toBe('dev');
    });
  });

  describe('go.mod', () => {
    const snapshot = makeSnapshot({
      'go.mod': [
        'module github.com/acme/demo',
        '',
        'go 1.22',
        '',
        'require github.com/gin-gonic/gin v1.10.0',
        '',
        'require (',
        '\tgithub.com/lib/pq v1.10.9',
        '\tgolang.org/x/sync v0.7.0 // indirect',
        ')',
        '',
        'replace (',
        '\tgithub.com/old/pkg => github.com/new/pkg v1.0.0',
        ')',
      ].join('\n'),
    });

    it('parses both single-line and block requires', () => {
      const { dependencies } = analyzeDependencies(snapshot);

      expect(dependencies.map((entry) => entry.name)).toEqual([
        'github.com/gin-gonic/gin',
        'github.com/lib/pq',
        'golang.org/x/sync',
      ]);
      expect(find(dependencies, 'github.com/lib/pq')?.range).toBe('v1.10.9');
      expect(find(dependencies, 'github.com/lib/pq')?.ecosystem).toBe('go');
    });

    it('does not mistake replace directives for requirements', () => {
      const names = analyzeDependencies(snapshot).dependencies.map((entry) => entry.name);

      expect(names).not.toContain('github.com/old/pkg');
    });
  });

  describe('Cargo.toml', () => {
    it('parses string, inline-table and workspace dependencies', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'Cargo.toml': [
            '[package]',
            'name = "demo"',
            'edition = "2021"',
            '',
            '[dependencies]',
            'serde = "1.0"',
            'tokio = { version = "1.38", features = ["full"] }',
            'shared = { path = "../shared" }',
            '',
            '[dev-dependencies]',
            'criterion = "0.5"',
            '',
            '[build-dependencies]',
            'cc = "1.0"',
          ].join('\n'),
        }),
      );

      expect(find(report.dependencies, 'serde')).toMatchObject({
        range: '1.0',
        kind: 'runtime',
        ecosystem: 'cargo',
      });
      expect(find(report.dependencies, 'tokio')?.range).toBe('1.38');
      expect(find(report.dependencies, 'shared')?.range).toBe('local');
      expect(find(report.dependencies, 'criterion')?.kind).toBe('dev');
      expect(find(report.dependencies, 'cc')?.kind).toBe('dev');
    });

    it('ignores non-dependency tables', () => {
      const report = analyzeDependencies(
        makeSnapshot({ 'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n' }),
      );

      expect(report.dependencies).toEqual([]);
      expect(report.manifests).toEqual(['Cargo.toml']);
    });
  });

  describe('Gemfile', () => {
    it('classifies grouped gems as dev dependencies', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          Gemfile: [
            "source 'https://rubygems.org'",
            "ruby '3.3.0'",
            '',
            "gem 'rails', '~> 7.1.3'",
            "gem 'pg'",
            '',
            'group :development, :test do',
            "  gem 'rspec-rails', '~> 6.1'",
            'end',
            '',
            "gem 'puma', '>= 6.0'",
          ].join('\n'),
        }),
      );

      expect(find(report.dependencies, 'rails')).toMatchObject({
        range: '~> 7.1.3',
        kind: 'runtime',
        ecosystem: 'rubygems',
      });
      expect(find(report.dependencies, 'rspec-rails')?.kind).toBe('dev');
      expect(find(report.dependencies, 'puma')?.kind).toBe('runtime');
      expect(report.dependencies.map((entry) => entry.name)).not.toContain('ruby');
    });
  });

  describe('composer.json', () => {
    it('parses require and require-dev, skipping platform requirements', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'composer.json': JSON.stringify({
            require: { php: '^8.2', 'ext-json': '*', 'laravel/framework': '^11.0' },
            'require-dev': { 'phpunit/phpunit': '^11.0' },
          }),
        }),
      );

      expect(report.dependencies.map((entry) => entry.name)).toEqual([
        'laravel/framework',
        'phpunit/phpunit',
      ]);
      expect(find(report.dependencies, 'laravel/framework')?.ecosystem).toBe('composer');
      expect(find(report.dependencies, 'phpunit/phpunit')?.kind).toBe('dev');
    });
  });

  describe('pom.xml', () => {
    it('parses coordinates, scope and optional flags', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'pom.xml': [
            '<project>',
            '  <dependencies>',
            '    <dependency>',
            '      <groupId>org.springframework.boot</groupId>',
            '      <artifactId>spring-boot-starter-web</artifactId>',
            '      <version>3.3.0</version>',
            '    </dependency>',
            '    <dependency>',
            '      <groupId>org.junit.jupiter</groupId>',
            '      <artifactId>junit-jupiter</artifactId>',
            '      <version>5.10.2</version>',
            '      <scope>test</scope>',
            '    </dependency>',
            '    <dependency>',
            '      <groupId>com.example</groupId>',
            '      <artifactId>extras</artifactId>',
            '      <optional>true</optional>',
            '    </dependency>',
            '  </dependencies>',
            '</project>',
          ].join('\n'),
        }),
      );

      expect(
        find(report.dependencies, 'org.springframework.boot:spring-boot-starter-web'),
      ).toMatchObject({ range: '3.3.0', kind: 'runtime', ecosystem: 'maven' });
      expect(find(report.dependencies, 'org.junit.jupiter:junit-jupiter')?.kind).toBe('dev');
      expect(find(report.dependencies, 'com.example:extras')?.kind).toBe('optional');
    });
  });

  describe('lockfiles', () => {
    it.each([
      'pnpm-lock.yaml',
      'package-lock.json',
      'yarn.lock',
      'poetry.lock',
      'Cargo.lock',
      'go.sum',
      'Gemfile.lock',
      'composer.lock',
    ])('detects %s', (name) => {
      expect(analyzeDependencies(makeSnapshot({ [name]: '' })).hasLockfile).toBe(true);
      expect(isLockfile(name)).toBe(true);
    });

    it('reports no lockfile when only manifests are present', () => {
      const report = analyzeDependencies(
        makeSnapshot({ 'package.json': JSON.stringify({ dependencies: { react: '19.2.4' } }) }),
      );

      expect(report.hasLockfile).toBe(false);
      expect(isLockfile('package.json')).toBe(false);
    });

    it('does not treat a lockfile as a manifest', () => {
      const report = analyzeDependencies(makeSnapshot({ 'package-lock.json': '{"name":"demo"}' }));

      expect(report.manifests).toEqual([]);
    });
  });

  describe('unpinned ranges', () => {
    it('flags *, latest and empty ranges by package name', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'package.json': JSON.stringify({
            dependencies: { lodash: '*', chalk: 'latest', react: '19.2.4' },
          }),
          Gemfile: "gem 'pg'\n",
        }),
      );

      expect(report.unpinned).toEqual(['chalk', 'lodash', 'pg']);
    });

    it('does not flag workspace or catalog protocols', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'apps/web/package.json': JSON.stringify({
            dependencies: { '@acme/ui': 'workspace:*', react: 'catalog:' },
          }),
        }),
      );

      expect(report.unpinned).toEqual([]);
    });
  });

  describe('flagged dependencies', () => {
    it('flags deprecated npm packages with replacements', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'package.json': JSON.stringify({
            dependencies: { request: '^2.88.2', moment: '^2.30.1' },
            devDependencies: { tslint: '^6.1.3', 'node-sass': '^9.0.0' },
          }),
        }),
      );

      const names = report.flagged.map((flag) => flag.name);
      expect(names).toEqual(expect.arrayContaining(['request', 'moment', 'tslint', 'node-sass']));

      const moment = report.flagged.find((flag) => flag.name === 'moment');
      expect(moment?.replacement).toBe('date-fns or dayjs');
      expect(moment?.severity).toBe('medium');
    });

    it('marks supply-chain incidents as critical', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'package.json': JSON.stringify({ dependencies: { 'event-stream': '3.3.6' } }),
        }),
      );

      expect(report.flagged[0]).toMatchObject({ name: 'event-stream', severity: 'critical' });
    });

    it('escalates faker to critical at the sabotaged version', () => {
      const sabotaged = analyzeDependencies(
        makeSnapshot({ 'package.json': JSON.stringify({ dependencies: { faker: '6.6.6' } }) }),
      );
      const older = analyzeDependencies(
        makeSnapshot({ 'package.json': JSON.stringify({ dependencies: { faker: '^5.5.3' } }) }),
      );

      expect(sabotaged.flagged[0]?.severity).toBe('critical');
      expect(older.flagged[0]?.severity).toBe('high');
      expect(older.flagged[0]?.replacement).toBe('@faker-js/faker');
    });

    it('orders findings by severity', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'package.json': JSON.stringify({
            dependencies: { 'left-pad': '^1.3.0', 'event-stream': '3.3.6', request: '^2.88.2' },
          }),
        }),
      );

      expect(report.flagged.map((flag) => flag.severity)).toEqual(['critical', 'high', 'low']);
    });

    it('scopes flags to their ecosystem so python `requests` is safe', () => {
      const report = analyzeDependencies(
        makeSnapshot({ 'requirements.txt': 'requests==2.32.3\n' }),
      );

      expect(report.flagged).toEqual([]);
    });

    it('flags python packages from their own list', () => {
      const report = analyzeDependencies(makeSnapshot({ 'requirements.txt': 'nose==1.3.7\n' }));

      expect(report.flagged[0]).toMatchObject({ name: 'nose', replacement: 'pytest' });
    });

    it('reports one finding per package across many manifests', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'apps/a/package.json': JSON.stringify({ dependencies: { request: '^2.88.2' } }),
          'apps/b/package.json': JSON.stringify({ dependencies: { request: '^2.88.2' } }),
        }),
      );

      expect(report.flagged).toHaveLength(1);
    });

    it('leaves a healthy manifest unflagged', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'package.json': JSON.stringify({
            dependencies: { next: '16.2.11', react: '19.2.4', zod: '^4.1.11' },
          }),
        }),
      );

      expect(report.flagged).toEqual([]);
    });
  });

  describe('multi-ecosystem repositories', () => {
    it('merges every manifest into one report', () => {
      const report = analyzeDependencies(
        makeSnapshot({
          'package.json': JSON.stringify({ dependencies: { react: '19.2.4' } }),
          'pnpm-lock.yaml': 'lockfileVersion: 9',
          'services/api/requirements.txt': 'fastapi==0.111.0\n',
          'services/worker/go.mod': 'module x\n\ngo 1.22\n\nrequire github.com/lib/pq v1.10.9\n',
          'crates/engine/Cargo.toml': '[dependencies]\nserde = "1.0"\n',
        }),
      );

      expect(report.manifests).toEqual([
        'crates/engine/Cargo.toml',
        'package.json',
        'services/api/requirements.txt',
        'services/worker/go.mod',
      ]);
      expect(new Set(report.dependencies.map((entry) => entry.ecosystem))).toEqual(
        new Set(['npm', 'pypi', 'go', 'cargo']),
      );
      expect(report.hasLockfile).toBe(true);
      expect(report.counts.runtime).toBe(4);
    });
  });
});
