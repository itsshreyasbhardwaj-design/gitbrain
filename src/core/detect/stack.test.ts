import { describe, expect, it } from 'vitest';

import { analyzeDependencies } from './dependencies';
import { detectStack } from './stack';
import { makeSnapshot } from '../testing/fixtures';
import type { Detection, RepoSnapshot, StackDetection } from '../types';

/** Run the real pipeline: manifests -> dependency report -> stack. */
function analyze(files: Record<string, string>): StackDetection {
  const snapshot: RepoSnapshot = makeSnapshot(files);
  return detectStack(snapshot, analyzeDependencies(snapshot));
}

const named = (detections: readonly Detection[], name: string): Detection | undefined =>
  detections.find((detection) => detection.name === name);

const names = (detections: readonly Detection[]): string[] =>
  detections.map((detection) => detection.name);

const PKG = (extra: Record<string, unknown>): string => JSON.stringify({ name: 'demo', ...extra });

/**
 * Regression suite for a false positive found by running GitBrain on a real
 * repository: `sindresorhus/ky` is an HTTP *client*, but it carries `express`
 * in devDependencies because its test suite spins up a throwaway server. The
 * detector reported "Express" as a high-confidence framework, and the report
 * header branded the library an Express app.
 */
describe('dev-only dependencies are weak evidence for frameworks', () => {
  it('does not report a framework with high confidence from a devDependency alone', () => {
    const stack = analyze({
      'package.json': PKG({ devDependencies: { express: '^4.19.2', ava: '^6.0.0' } }),
      'source/index.ts': 'export default function ky() {}\n',
    });

    const express = named(stack.frameworks, 'Express');
    // It may still be reported — the package really is there — but it must not
    // be presented with the same certainty as a shipped dependency.
    expect(express?.confidence).not.toBe('high');
  });

  it('reports a framework with high confidence from a runtime dependency', () => {
    const stack = analyze({
      'package.json': PKG({ dependencies: { express: '^4.19.2' } }),
      'src/server.ts': "import express from 'express';\n",
    });

    expect(named(stack.frameworks, 'Express')?.confidence).toBe('high');
  });

  it('still trusts a devDependency for test frameworks, where that is the right home', () => {
    const stack = analyze({
      'package.json': PKG({ devDependencies: { vitest: '^3.2.4' } }),
      'src/a.test.ts': "import { it } from 'vitest';\n",
    });

    expect(named(stack.testing, 'Vitest')?.confidence).toBe('high');
  });

  it('still trusts a devDependency for build tooling and package managers', () => {
    const stack = analyze({
      'package.json': PKG({ devDependencies: { typescript: '^5.9.3' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    });

    expect(named(stack.packageManagers, 'pnpm')?.confidence).toBe('high');
  });

  it('upgrades a dev-only framework once the source actually imports it', () => {
    const stack = analyze({
      'package.json': PKG({ devDependencies: { express: '^4.19.2' } }),
      'src/server.ts': "import express from 'express';\nconst app = express();\n",
      'src/admin.ts': "import express from 'express';\nconst admin = express();\n",
    });

    const express = named(stack.frameworks, 'Express');
    expect(express).toBeDefined();
    expect(express?.confidence).not.toBe('low');
  });
});

describe('detectStack', () => {
  it('returns empty categories for an empty repository', () => {
    const stack = analyze({});

    expect(stack.frameworks).toEqual([]);
    expect(stack.packageManagers).toEqual([]);
    expect(stack.ci).toEqual([]);
    expect(stack.deployment).toEqual([]);
    expect(stack.testing).toEqual([]);
    expect(stack.databases).toEqual([]);
    expect(stack.runtimes).toEqual([]);
    expect(stack.architecture.style).toBe('unknown');
    expect(stack.api.style).toBe('unknown');
    expect(stack.api.endpoints).toEqual([]);
  });

  describe('evidence', () => {
    it('cites the manifest line that proved a framework', () => {
      const stack = analyze({ 'package.json': PKG({ dependencies: { next: '16.2.11' } }) });
      const next = named(stack.frameworks, 'Next.js');

      expect(next?.evidence).toContain('next@16.2.11 in package.json dependencies');
      expect(next?.files).toContain('package.json');
      expect(next?.version).toBe('16.2.11');
      expect(next?.confidence).toBe('high');
    });

    it('names the devDependencies section when that is where it was found', () => {
      const stack = analyze({ 'package.json': PKG({ devDependencies: { vitest: '^3.2.4' } }) });

      expect(named(stack.testing, 'Vitest')?.evidence).toContain(
        'vitest@^3.2.4 in package.json devDependencies',
      );
    });

    it('every detection carries at least one evidence string and file', () => {
      const stack = analyze({
        'package.json': PKG({
          dependencies: { next: '16.2.11', react: '19.2.4', '@prisma/client': '^5.14.0' },
          devDependencies: { vitest: '^3.2.4', '@playwright/test': '^1.55.0' },
        }),
        'pnpm-lock.yaml': 'lockfileVersion: 9',
        '.github/workflows/ci.yml': 'name: CI',
        Dockerfile: 'FROM node:20\nCMD ["node", "server.js"]',
      });

      const all = [
        ...stack.frameworks,
        ...stack.packageManagers,
        ...stack.ci,
        ...stack.deployment,
        ...stack.testing,
        ...stack.databases,
        ...stack.runtimes,
      ];

      expect(all.length).toBeGreaterThan(5);
      for (const detection of all) {
        expect(detection.evidence.length).toBeGreaterThan(0);
        expect(detection.files.length).toBeGreaterThan(0);
        for (const evidence of detection.evidence) expect(evidence).not.toBe('');
      }
    });

    it('grades a content-only match below a manifest match', () => {
      const contentOnly = analyze({
        'src/server.js': "const express = require('express');\n",
        'src/routes.js': "const express = require('express');\n",
      });
      const declared = analyze({ 'package.json': PKG({ dependencies: { express: '^4.19.2' } }) });

      expect(named(contentOnly.frameworks, 'Express')?.confidence).toBe('medium');
      expect(named(declared.frameworks, 'Express')?.confidence).toBe('high');
    });

    it('treats a single content match as low confidence', () => {
      const stack = analyze({ 'app.js': "const koa = require('koa');\n" });

      expect(named(stack.frameworks, 'Koa')?.confidence).toBe('low');
    });
  });

  describe('frameworks', () => {
    it.each([
      ['Next.js', { 'package.json': PKG({ dependencies: { next: '16.2.11' } }) }],
      ['React', { 'package.json': PKG({ dependencies: { react: '19.2.4' } }) }],
      ['Vue', { 'package.json': PKG({ dependencies: { vue: '^3.4.0' } }) }],
      ['Nuxt', { 'package.json': PKG({ dependencies: { nuxt: '^3.12.0' } }) }],
      ['Svelte', { 'package.json': PKG({ devDependencies: { svelte: '^4.2.0' } }) }],
      ['SvelteKit', { 'package.json': PKG({ devDependencies: { '@sveltejs/kit': '^2.5.0' } }) }],
      ['Angular', { 'package.json': PKG({ dependencies: { '@angular/core': '^18.0.0' } }) }],
      ['Astro', { 'package.json': PKG({ dependencies: { astro: '^4.10.0' } }) }],
      ['Remix', { 'package.json': PKG({ dependencies: { '@remix-run/react': '^2.9.0' } }) }],
      ['Express', { 'package.json': PKG({ dependencies: { express: '^4.19.2' } }) }],
      ['Fastify', { 'package.json': PKG({ dependencies: { fastify: '^4.28.0' } }) }],
      ['NestJS', { 'package.json': PKG({ dependencies: { '@nestjs/core': '^10.3.0' } }) }],
      ['Koa', { 'package.json': PKG({ dependencies: { koa: '^2.15.0' } }) }],
      ['Django', { 'requirements.txt': 'Django==5.0.6\n' }],
      ['Flask', { 'requirements.txt': 'Flask==3.0.3\n' }],
      ['FastAPI', { 'requirements.txt': 'fastapi==0.111.0\n' }],
      ['Ruby on Rails', { Gemfile: "gem 'rails', '~> 7.1'\n" }],
      [
        'Laravel',
        { 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }) },
      ],
      [
        'Spring Boot',
        {
          'pom.xml':
            '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
        },
      ],
      ['Gin', { 'go.mod': 'module x\nrequire github.com/gin-gonic/gin v1.10.0\n' }],
      ['Echo', { 'go.mod': 'module x\nrequire github.com/labstack/echo/v4 v4.12.0\n' }],
      ['Actix Web', { 'Cargo.toml': '[dependencies]\nactix-web = "4.6"\n' }],
      ['Axum', { 'Cargo.toml': '[dependencies]\naxum = "0.7"\n' }],
      [
        '.NET',
        { 'src/Api/Api.csproj': '<Project><TargetFramework>net8.0</TargetFramework></Project>' },
      ],
    ])('detects %s', (framework, files) => {
      expect(names(analyze(files).frameworks)).toContain(framework);
    });

    it('detects Next.js from its config file without a manifest', () => {
      const stack = analyze({ 'next.config.ts': 'export default {};' });

      expect(named(stack.frameworks, 'Next.js')?.confidence).toBe('high');
      expect(named(stack.frameworks, 'Next.js')?.evidence).toContain('next.config.ts present');
    });

    it('does not invent frameworks for a plain repository', () => {
      expect(analyze({ 'README.md': '# demo' }).frameworks).toEqual([]);
    });
  });

  describe('package managers', () => {
    it.each([
      ['pnpm', 'pnpm-lock.yaml'],
      ['npm', 'package-lock.json'],
      ['Yarn', 'yarn.lock'],
      ['Bun', 'bun.lockb'],
      ['pip', 'requirements.txt'],
      ['Poetry', 'poetry.lock'],
      ['uv', 'uv.lock'],
      ['Cargo', 'Cargo.toml'],
      ['Go modules', 'go.mod'],
      ['Bundler', 'Gemfile'],
      ['Composer', 'composer.json'],
      ['Maven', 'pom.xml'],
      ['Gradle', 'build.gradle.kts'],
    ])('detects %s from %s', (manager, file) => {
      expect(names(analyze({ [file]: '' }).packageManagers)).toContain(manager);
    });

    it('folds the corepack packageManager field into the detection', () => {
      const stack = analyze({
        'package.json': PKG({ packageManager: 'pnpm@11.17.0' }),
        'pnpm-lock.yaml': 'lockfileVersion: 9',
      });

      const pnpm = named(stack.packageManagers, 'pnpm');
      expect(pnpm?.version).toBe('11.17.0');
      expect(pnpm?.evidence).toContain('packageManager "pnpm@11.17.0" in package.json');
      expect(pnpm?.evidence).toContain('pnpm-lock.yaml present');
      expect(stack.packageManagers.filter((entry) => entry.name === 'pnpm')).toHaveLength(1);
    });
  });

  describe('ci', () => {
    it.each([
      ['GitHub Actions', '.github/workflows/ci.yml'],
      ['GitLab CI', '.gitlab-ci.yml'],
      ['CircleCI', '.circleci/config.yml'],
      ['Travis CI', '.travis.yml'],
      ['Jenkins', 'Jenkinsfile'],
      ['Azure Pipelines', 'azure-pipelines.yml'],
      ['Drone CI', '.drone.yml'],
      ['Woodpecker CI', '.woodpecker.yml'],
    ])('detects %s from %s', (provider, file) => {
      const ci = analyze({ [file]: 'jobs: {}' }).ci;

      expect(names(ci)).toContain(provider);
      expect(named(ci, provider)?.files).toEqual([file]);
    });

    it('does not match a workflow file outside .github/workflows', () => {
      expect(names(analyze({ 'docs/workflows/ci.yml': '' }).ci)).not.toContain('GitHub Actions');
    });
  });

  describe('deployment', () => {
    it.each([
      ['Vercel', 'vercel.json'],
      ['Netlify', 'netlify.toml'],
      ['Fly.io', 'fly.toml'],
      ['Railway', 'railway.json'],
      ['Render', 'render.yaml'],
      ['Heroku', 'Procfile'],
      ['Docker', 'Dockerfile'],
      ['Cloudflare', 'wrangler.toml'],
      ['Firebase', 'firebase.json'],
    ])('detects %s from %s', (target, file) => {
      expect(names(analyze({ [file]: '' }).deployment)).toContain(target);
    });

    it('detects Kubernetes manifests by directory and content', () => {
      const stack = analyze({
        'k8s/deployment.yaml': 'apiVersion: apps/v1\nkind: Deployment\n',
      });

      expect(names(stack.deployment)).toContain('Kubernetes');
    });

    it('detects AWS from a SAM template', () => {
      const stack = analyze({
        'template.yaml': 'Transform: AWS::Serverless-2016-10-31\nResources: {}\n',
      });

      expect(names(stack.deployment)).toContain('AWS');
    });
  });

  describe('testing', () => {
    it.each([
      ['Vitest', { 'package.json': PKG({ devDependencies: { vitest: '^3.2.4' } }) }],
      ['Jest', { 'package.json': PKG({ devDependencies: { jest: '^29.7.0' } }) }],
      ['Mocha', { 'package.json': PKG({ devDependencies: { mocha: '^10.4.0' } }) }],
      [
        'Playwright',
        { 'package.json': PKG({ devDependencies: { '@playwright/test': '^1.55.0' } }) },
      ],
      ['Cypress', { 'package.json': PKG({ devDependencies: { cypress: '^13.11.0' } }) }],
      [
        'Testing Library',
        { 'package.json': PKG({ devDependencies: { '@testing-library/react': '^16.3.0' } }) },
      ],
      ['pytest', { 'requirements.txt': 'pytest==8.2.0\n' }],
      ['unittest', { 'tests/test_app.py': 'import unittest\n' }],
      ['Go testing', { 'main_test.go': 'package main\n' }],
      ['RSpec', { Gemfile: "gem 'rspec-rails'\n" }],
      [
        'PHPUnit',
        { 'composer.json': JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^11' } }) },
      ],
    ])('detects %s', (tool, files) => {
      expect(names(analyze(files).testing)).toContain(tool);
    });

    it('detects JUnit from maven coordinates', () => {
      const stack = analyze({
        'pom.xml':
          '<project><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><scope>test</scope></dependency></dependencies></project>',
      });

      expect(names(stack.testing)).toContain('JUnit');
    });
  });

  describe('databases', () => {
    it.each([
      ['PostgreSQL', { 'package.json': PKG({ dependencies: { pg: '^8.11.5' } }) }],
      ['PostgreSQL', { 'requirements.txt': 'psycopg2-binary==2.9.9\n' }],
      ['MySQL', { 'package.json': PKG({ dependencies: { mysql2: '^3.9.7' } }) }],
      ['SQLite', { 'package.json': PKG({ dependencies: { 'better-sqlite3': '^11.0.0' } }) }],
      ['MongoDB', { 'package.json': PKG({ dependencies: { mongodb: '^6.7.0' } }) }],
      ['Redis', { 'package.json': PKG({ dependencies: { ioredis: '^5.4.1' } }) }],
      [
        'Supabase',
        { 'package.json': PKG({ dependencies: { '@supabase/supabase-js': '^2.43.0' } }) },
      ],
      ['Prisma', { 'package.json': PKG({ dependencies: { '@prisma/client': '^5.14.0' } }) }],
      ['Drizzle', { 'package.json': PKG({ dependencies: { 'drizzle-orm': '^0.31.0' } }) }],
      ['TypeORM', { 'package.json': PKG({ dependencies: { typeorm: '^0.3.20' } }) }],
      ['Sequelize', { 'package.json': PKG({ dependencies: { sequelize: '^6.37.3' } }) }],
      ['Mongoose', { 'package.json': PKG({ dependencies: { mongoose: '^8.4.0' } }) }],
      ['SQLAlchemy', { 'requirements.txt': 'SQLAlchemy==2.0.30\n' }],
      ['ActiveRecord', { 'db/schema.rb': 'ActiveRecord::Schema.define do\nend\n' }],
    ])('detects %s', (database, files) => {
      expect(names(analyze(files).databases)).toContain(database);
    });

    it('detects a database from a connection string alone, at lower confidence', () => {
      const stack = analyze({ '.env.example': 'DATABASE_URL=postgres://user@localhost:5432/db\n' });

      expect(named(stack.databases, 'PostgreSQL')?.confidence).toBe('low');
    });

    it('finds the prisma schema even without the client dependency', () => {
      const stack = analyze({
        'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}',
      });

      expect(named(stack.databases, 'Prisma')?.files).toContain('prisma/schema.prisma');
    });
  });

  describe('runtimes', () => {
    it('reads the Node version from engines', () => {
      const stack = analyze({ 'package.json': PKG({ engines: { node: '>=20.11.0' } }) });
      const node = named(stack.runtimes, 'Node.js');

      expect(node?.version).toBe('20.11.0');
      expect(node?.evidence[0]).toContain('engines.node');
    });

    it('reads the Node version from .nvmrc', () => {
      const stack = analyze({ '.nvmrc': '20.11.0\n', 'package.json': PKG({}) });

      expect(named(stack.runtimes, 'Node.js')?.version).toBe('20.11.0');
    });

    it('reads the Go version from go.mod', () => {
      const stack = analyze({ 'go.mod': 'module x\n\ngo 1.22\n', 'main.go': 'package main\n' });

      expect(named(stack.runtimes, 'Go')?.version).toBe('1.22');
    });

    it('reads requires-python from pyproject.toml', () => {
      const stack = analyze({ 'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n' });

      expect(named(stack.runtimes, 'Python')?.version).toBe('>=3.11');
    });

    it('reads python_requires from setup.py', () => {
      const stack = analyze({ 'setup.py': 'setup(python_requires=">=3.9")\n' });

      expect(named(stack.runtimes, 'Python')?.version).toBe('>=3.9');
    });

    it('reads the Ruby version from .ruby-version', () => {
      const stack = analyze({ '.ruby-version': '3.3.0\n' });

      expect(named(stack.runtimes, 'Ruby')?.version).toBe('3.3.0');
    });

    it('reads the PHP constraint from composer.json', () => {
      const stack = analyze({ 'composer.json': JSON.stringify({ require: { php: '^8.2' } }) });

      expect(named(stack.runtimes, 'PHP')?.version).toBe('8.2');
    });

    it('reads the Java target from pom.xml', () => {
      const stack = analyze({
        'pom.xml': '<project><properties><java.version>21</java.version></properties></project>',
      });

      expect(named(stack.runtimes, 'Java')?.version).toBe('21');
    });

    it('reads the .NET target framework', () => {
      const stack = analyze({
        'src/Api.csproj': '<Project><TargetFramework>net8.0</TargetFramework></Project>',
      });

      expect(named(stack.runtimes, '.NET')?.version).toBe('net8.0');
    });

    it('detects a runtime from source files alone, with no version', () => {
      const stack = analyze({ 'src/main.rs': 'fn main() {}\n' });
      const rust = named(stack.runtimes, 'Rust');

      expect(rust).toBeDefined();
      expect(rust?.version).toBeUndefined();
      expect(rust?.evidence[0]).toContain('Rust source file');
    });

    it('detects Deno and Bun from their own markers', () => {
      expect(names(analyze({ 'deno.json': '{}' }).runtimes)).toContain('Deno');
      expect(names(analyze({ 'bunfig.toml': '' }).runtimes)).toContain('Bun');
    });
  });

  describe('architecture', () => {
    it('recognises a pnpm workspace monorepo', () => {
      const stack = analyze({
        'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
        'package.json': PKG({ workspaces: ['apps/*'] }),
        'apps/web/package.json': PKG({}),
        'apps/api/package.json': PKG({}),
      });

      expect(stack.architecture.style).toBe('monorepo');
      expect(stack.architecture.confidence).toBe('high');
      expect(stack.architecture.evidence).toContain('pnpm-workspace.yaml present');
    });

    it('recognises microservices from services/ plus several Dockerfiles', () => {
      const stack = analyze({
        'services/auth/Dockerfile': 'FROM node:20',
        'services/billing/Dockerfile': 'FROM node:20',
        'services/auth/index.js': '',
      });

      expect(stack.architecture.style).toBe('microservices');
      expect(stack.architecture.evidence.join(' ')).toContain('services/');
    });

    it('recognises a serverless project', () => {
      const stack = analyze({ 'serverless.yml': 'service: demo\n', 'functions/hello.js': '' });

      expect(stack.architecture.style).toBe('serverless');
    });

    it('recognises a CLI from the bin field', () => {
      const stack = analyze({ 'package.json': PKG({ bin: { gitbrain: 'dist/cli.js' } }) });

      expect(stack.architecture.style).toBe('cli');
      expect(stack.architecture.evidence.join(' ')).toContain('gitbrain');
    });

    it('recognises a library from exports with no application surface', () => {
      const stack = analyze({
        'package.json': PKG({ main: 'dist/index.js', exports: { '.': './dist/index.js' } }),
        'src/index.ts': 'export const version = 1;\n',
      });

      expect(stack.architecture.style).toBe('library');
      expect(stack.architecture.confidence).toBe('medium');
    });

    it('recognises a layered structure', () => {
      const stack = analyze({
        'src/controllers/user.ts': '',
        'src/services/user.ts': '',
        'src/repositories/user.ts': '',
      });

      expect(stack.architecture.style).toBe('layered');
    });

    it('recognises a modular structure', () => {
      const stack = analyze({
        'modules/billing/index.ts': '',
        'modules/auth/index.ts': '',
        'modules/search/index.ts': '',
      });

      expect(stack.architecture.style).toBe('modular');
      expect(stack.architecture.evidence.join(' ')).toContain('3 sibling modules');
    });

    it('falls back to monolith for undifferentiated source', () => {
      const stack = analyze({
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': 'export const b = 2;',
      });

      expect(stack.architecture.style).toBe('monolith');
      expect(stack.architecture.confidence).toBe('low');
    });

    it('always explains itself', () => {
      const cases: Record<string, string>[] = [
        {},
        { 'src/a.ts': 'x' },
        { 'turbo.json': '{}' },
        { 'package.json': PKG({ bin: 'cli.js' }) },
      ];

      for (const files of cases) {
        expect(analyze(files).architecture.evidence.length).toBeGreaterThan(0);
      }
    });
  });

  describe('api endpoints', () => {
    it('finds express routes with 1-indexed line numbers', () => {
      const stack = analyze({
        'package.json': PKG({ dependencies: { express: '^4.19.2' } }),
        'src/server.js': [
          "const express = require('express');",
          'const app = express();',
          "app.get('/users', listUsers);",
          "app.post('/users', createUser);",
          "router.delete('/users/:id', removeUser);",
          'module.exports = app;',
        ].join('\n'),
      });

      expect(stack.api.endpoints).toEqual([
        { method: 'GET', path: '/users', file: 'src/server.js', line: 3 },
        { method: 'POST', path: '/users', file: 'src/server.js', line: 4 },
        { method: 'DELETE', path: '/users/:id', file: 'src/server.js', line: 5 },
      ]);
      expect(stack.api.style).toBe('rest');
      expect(stack.api.confidence).toBe('high');
    });

    it('does not mistake a Map lookup for a route', () => {
      const stack = analyze({ 'src/cache.js': "const value = cache.get('user:1');\n" });

      expect(stack.api.endpoints).toEqual([]);
    });

    it('reads Next.js App Router handlers, dropping route groups', () => {
      const stack = analyze({
        'src/app/(admin)/api/users/[id]/route.ts': [
          'export async function GET(request: Request) {}',
          'export async function DELETE(request: Request) {}',
        ].join('\n'),
      });

      expect(stack.api.endpoints).toEqual([
        {
          method: 'GET',
          path: '/api/users/[id]',
          file: 'src/app/(admin)/api/users/[id]/route.ts',
          line: 1,
        },
        {
          method: 'DELETE',
          path: '/api/users/[id]',
          file: 'src/app/(admin)/api/users/[id]/route.ts',
          line: 2,
        },
      ]);
    });

    it('reads Next.js pages/api handlers as ALL', () => {
      const stack = analyze({
        'pages/api/health.ts': 'export default function handler(req, res) {}\n',
        'pages/api/users/index.ts': 'export default function handler(req, res) {}\n',
      });

      expect(stack.api.endpoints.map((endpoint) => endpoint.path).sort()).toEqual([
        '/api/health',
        '/api/users',
      ]);
      expect(stack.api.endpoints.every((endpoint) => endpoint.method === 'ALL')).toBe(true);
    });

    it('reads FastAPI decorators', () => {
      const stack = analyze({
        'requirements.txt': 'fastapi==0.111.0\n',
        'app/main.py': [
          'from fastapi import FastAPI',
          'app = FastAPI()',
          '',
          '@app.get("/items")',
          'def list_items():',
          '    return []',
          '',
          '@router.post("/items/{item_id}")',
          'def create_item(item_id: int):',
          '    return {}',
        ].join('\n'),
      });

      expect(stack.api.endpoints).toEqual([
        { method: 'GET', path: '/items', file: 'app/main.py', line: 4 },
        { method: 'POST', path: '/items/{item_id}', file: 'app/main.py', line: 8 },
      ]);
    });

    it('reads Flask route decorators and their methods argument', () => {
      const stack = analyze({
        'app.py': [
          'from flask import Flask',
          'app = Flask(__name__)',
          '',
          '@app.route("/health")',
          'def health():',
          '    return "ok"',
          '',
          '@app.route("/users", methods=["GET", "POST"])',
          'def users():',
          '    return []',
        ].join('\n'),
      });

      expect(stack.api.endpoints).toEqual([
        { method: 'GET', path: '/health', file: 'app.py', line: 4 },
        { method: 'GET', path: '/users', file: 'app.py', line: 8 },
        { method: 'POST', path: '/users', file: 'app.py', line: 8 },
      ]);
    });

    it('reads Go HandleFunc registrations', () => {
      const stack = analyze({
        'go.mod': 'module x\n\ngo 1.22\n',
        'main.go': [
          'package main',
          '',
          'func main() {',
          '\thttp.HandleFunc("/healthz", healthz)',
          '\tr.GET("/users", listUsers)',
          '}',
        ].join('\n'),
      });

      expect(stack.api.endpoints).toEqual([
        { method: 'ALL', path: '/healthz', file: 'main.go', line: 4 },
        { method: 'GET', path: '/users', file: 'main.go', line: 5 },
      ]);
    });

    it('reads Rails routes, expanding resources', () => {
      const stack = analyze({
        Gemfile: "gem 'rails'\n",
        'config/routes.rb': [
          'Rails.application.routes.draw do',
          "  root to: 'home#index'",
          "  get '/health', to: 'health#show'",
          '  resources :photos',
          'end',
        ].join('\n'),
      });

      expect(stack.api.endpoints).toEqual([
        { method: 'GET', path: '/', file: 'config/routes.rb', line: 2 },
        { method: 'GET', path: '/health', file: 'config/routes.rb', line: 3 },
        { method: 'GET', path: '/photos', file: 'config/routes.rb', line: 4 },
        { method: 'POST', path: '/photos', file: 'config/routes.rb', line: 4 },
        { method: 'GET', path: '/photos/:id', file: 'config/routes.rb', line: 4 },
        { method: 'PATCH', path: '/photos/:id', file: 'config/routes.rb', line: 4 },
        { method: 'DELETE', path: '/photos/:id', file: 'config/routes.rb', line: 4 },
      ]);
    });

    it('skips test files when scanning for routes', () => {
      const stack = analyze({ 'src/server.test.js': "app.get('/users', h);\n" });

      expect(stack.api.endpoints).toEqual([]);
    });
  });

  describe('api style', () => {
    it('prefers GraphQL over REST when both transports are present', () => {
      const stack = analyze({
        'package.json': PKG({ dependencies: { graphql: '^16.9.0', express: '^4.19.2' } }),
        'src/server.js': "app.post('/graphql', handler);\n",
      });

      expect(stack.api.style).toBe('graphql');
      expect(stack.api.endpoints).toHaveLength(1);
      expect(stack.api.evidence.join(' ')).toContain('graphql@^16.9.0');
    });

    it('prefers tRPC over everything else', () => {
      const stack = analyze({
        'package.json': PKG({ dependencies: { '@trpc/server': '^11.0.0', graphql: '^16.9.0' } }),
      });

      expect(stack.api.style).toBe('trpc');
    });

    it('detects gRPC from proto definitions', () => {
      const stack = analyze({ 'proto/user.proto': 'service UserService {}\n' });

      expect(stack.api.style).toBe('grpc');
    });

    it('detects websockets when nothing else is present', () => {
      const stack = analyze({ 'package.json': PKG({ dependencies: { ws: '^8.17.0' } }) });

      expect(stack.api.style).toBe('websocket');
    });

    it('reports none for a repository with code and no API', () => {
      const stack = analyze({
        'src/math.ts': 'export const add = (a: number, b: number) => a + b;',
      });

      expect(stack.api.style).toBe('none');
      expect(stack.api.evidence.length).toBeGreaterThan(0);
    });
  });

  describe('multi-ecosystem repository', () => {
    const stack = analyze({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'package.json': PKG({ packageManager: 'pnpm@11.17.0', workspaces: ['apps/*'] }),
      'apps/web/package.json': PKG({
        dependencies: { next: '16.2.11', react: '19.2.4' },
        devDependencies: { vitest: '^3.2.4' },
      }),
      'apps/web/next.config.ts': 'export default {};',
      'services/api/requirements.txt':
        'fastapi==0.111.0\nSQLAlchemy==2.0.30\npsycopg2-binary==2.9.9\n',
      'services/api/app/main.py':
        'from fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/health")\ndef health():\n    return {}\n',
      'services/worker/go.mod': 'module worker\n\ngo 1.22\n\nrequire github.com/lib/pq v1.10.9\n',
      'services/worker/main.go': 'package main\n\nfunc main() {}\n',
      '.github/workflows/ci.yml': 'name: CI',
      'services/api/Dockerfile': 'FROM python:3.12',
      'services/worker/Dockerfile': 'FROM golang:1.22',
    });

    it('detects frameworks across every ecosystem', () => {
      expect(names(stack.frameworks)).toEqual(
        expect.arrayContaining(['Next.js', 'React', 'FastAPI']),
      );
    });

    it('detects every package manager in use', () => {
      expect(names(stack.packageManagers)).toEqual(
        expect.arrayContaining(['pnpm', 'pip', 'Go modules']),
      );
    });

    it('detects every runtime in use', () => {
      expect(names(stack.runtimes)).toEqual(expect.arrayContaining(['Node.js', 'Python', 'Go']));
    });

    it('detects databases declared by the python service', () => {
      expect(names(stack.databases)).toEqual(expect.arrayContaining(['PostgreSQL', 'SQLAlchemy']));
    });

    it('prefers microservices over monorepo when services own Dockerfiles', () => {
      expect(stack.architecture.style).toBe('microservices');
    });

    it('finds endpoints from the python service', () => {
      expect(stack.api.endpoints).toContainEqual({
        method: 'GET',
        path: '/health',
        file: 'services/api/app/main.py',
        line: 4,
      });
    });
  });
});
