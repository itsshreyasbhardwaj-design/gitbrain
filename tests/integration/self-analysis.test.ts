import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { analyzeSnapshot } from '@/core/analyze';
import { isIgnoredPath, looksBinary } from '@/core/ingest/ignore';
import { search } from '@/core/search';
import { extensionOf } from '@/core/shared/languages';
import type { RepoFile, RepoSnapshot } from '@/core/types';

/**
 * Dogfooding, as an integration test.
 *
 * Every other test in this repository feeds the analyzers a hand-built
 * fixture. This one runs the entire pipeline over GitBrain's own source — a
 * real repository with a real module graph, real cycles-or-not, real secrets
 * scanning over files that deliberately contain secret-shaped strings.
 *
 * It has caught what unit tests structurally cannot: crashes that only appear
 * on real input, and analyzers that disagree with each other about the same
 * repository.
 *
 * `node:fs` is used here, which `src/core` itself is forbidden from importing.
 * That is the point: the engine stays portable, and the test supplies the
 * files the way a real caller would.
 */

const ROOT = join(__dirname, '..', '..');

/** Walk the repository the way ingestion would, honouring the ignore rules. */
function readRepository(root: string): RepoFile[] {
  const files: RepoFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const path = relative(root, absolute).split(sep).join('/');
      const stats = statSync(absolute);

      if (stats.isDirectory()) {
        // `isIgnoredPath` only inspects a path's *directory* segments, so a
        // bare directory name has to be probed via a synthetic child for the
        // node_modules / dist / .git rules to apply.
        if (!isIgnoredPath(`${path}/probe`)) walk(absolute);
        continue;
      }

      if (isIgnoredPath(path)) continue;
      if (!stats.isFile() || stats.size > 512 * 1024) continue;

      const raw = readFileSync(absolute);
      const bytes = new Uint8Array(raw);
      const binary = looksBinary(bytes);
      const content = binary ? null : raw.toString('utf8');

      files.push({
        path,
        size: stats.size,
        ext: extensionOf(path),
        isBinary: binary,
        content,
        lines: content ? content.split('\n').length : 0,
      });
    }
  };

  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const files = readRepository(ROOT);

const snapshot: RepoSnapshot = {
  source: {
    kind: 'github',
    owner: 'itsshreyasbhardwaj-design',
    repo: 'gitbrain',
    ref: 'main',
    url: 'https://github.com/itsshreyasbhardwaj-design/gitbrain',
  },
  files,
  totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  truncated: false,
  skipped: { ignored: 0, binary: 0, tooLarge: 0, overBudget: 0 },
  ingestMs: 0,
};

const analysis = analyzeSnapshot(snapshot, { id: 'self', now: () => new Date(0) });

describe('GitBrain analyzing itself', () => {
  it('reads a non-trivial number of its own files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('completes the whole pipeline without throwing', () => {
    expect(analysis.id).toBe('self');
  });

  it('finishes fast enough to feel interactive', () => {
    // A guard against an accidental quadratic. Generous, so it fails on a real
    // regression rather than on a slow CI runner.
    expect(analysis.analysisMs).toBeLessThan(30_000);
  });

  it('identifies TypeScript as the primary language', () => {
    expect(analysis.languages[0]?.language).toBe('TypeScript');
  });

  it('detects Next.js as a framework, with evidence', () => {
    const next = analysis.stack.frameworks.find((f) => f.name.toLowerCase().includes('next'));
    expect(next).toBeDefined();
    expect(next?.evidence.length).toBeGreaterThan(0);
  });

  it('detects pnpm as the package manager', () => {
    expect(analysis.stack.packageManagers.map((p) => p.name)).toContain('pnpm');
  });

  it('detects Vitest and Playwright', () => {
    const testing = analysis.stack.testing.map((t) => t.name);
    expect(testing).toContain('Vitest');
    expect(testing).toContain('Playwright');
  });

  it('detects GitHub Actions', () => {
    expect(analysis.stack.ci.map((c) => c.name)).toContain('GitHub Actions');
  });

  it('finds real entry points', () => {
    expect(analysis.entryPoints.length).toBeGreaterThan(0);
    for (const entry of analysis.entryPoints) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('builds a connected module graph', () => {
    expect(analysis.graph.nodes.length).toBeGreaterThan(30);
    expect(analysis.graph.edges.length).toBeGreaterThan(30);
  });

  it('resolves graph edges to nodes that actually exist', () => {
    const ids = new Set(analysis.graph.nodes.map((node) => node.id));
    for (const edge of analysis.graph.edges) {
      expect(ids, `edge from ${edge.from}`).toContain(edge.from);
      expect(ids, `edge to ${edge.to}`).toContain(edge.to);
    }
  });

  it('reports no undeclared external dependencies', () => {
    // If this fails, the repository imports a package it never declared —
    // which would break a clean install. Worth failing CI over.
    const undeclared = analysis.graph.externals.filter((external) => external.undeclared);
    expect(undeclared.map((e) => e.name)).toEqual([]);
  });

  it('has no circular dependencies of its own', () => {
    // A tool that reports circular dependencies should not have any.
    expect(analysis.graph.cycles).toEqual([]);
  });

  it('generates all eighteen knowledge documents', () => {
    expect(analysis.knowledge.docs).toHaveLength(18);
    for (const doc of analysis.knowledge.docs) {
      expect(doc.markdown.trim().length, doc.id).toBeGreaterThan(80);
    }
  });

  it('cites only files that exist in the repository', () => {
    const known = new Set(files.map((file) => file.path));
    for (const doc of analysis.knowledge.docs) {
      for (const citation of doc.citations) {
        expect(known, `${doc.id} cites ${citation.file}`).toContain(citation.file);
      }
    }
  });

  it('finds no hardcoded secrets in its shipping source', () => {
    // This repository is full of secret-SHAPED strings: detection patterns,
    // `.env.example` keys, and the scanner's own fixtures. None of the
    // *shipping* code may produce a finding — a failure here means the scanner
    // cries wolf on ordinary application code.
    const leaked = analysis.security.secrets
      .filter((secret) => !secret.file.includes('.test.'))
      .map((secret) => `${secret.rule} at ${secret.file}:${secret.line}`);

    expect(leaked).toEqual([]);
  });

  it('de-ranks the fake credentials in its own scanner fixtures', () => {
    // The scanner's test files deliberately contain AWS keys, Stripe keys and
    // private key blocks. They must still be reported — a real key in a test
    // file is still leaked — but never at critical severity, or every security
    // tool analyzed with GitBrain would look like a breach.
    const fixtures = analysis.security.secrets.filter((secret) => secret.file.includes('.test.'));

    expect(fixtures.length).toBeGreaterThan(0);
    for (const finding of fixtures) {
      expect(finding.severity, `${finding.rule} at ${finding.file}`).not.toBe('critical');
      expect(finding.rule).toContain('test fixture');
    }
  });

  it('never emits an unredacted credential, whatever it finds', () => {
    for (const secret of analysis.security.secrets) {
      expect(secret.preview).toMatch(/\*/);
    }
  });

  it('documents every environment variable it reads', () => {
    // `.env.example` is committed, so an undocumented variable is a genuine
    // onboarding bug in this repository, not a false positive.
    expect(analysis.security.undocumentedEnvVars).toEqual([]);
  });

  it('scores its own health in a defensible range', () => {
    expect(analysis.health.overall).toBeGreaterThan(55);
    expect(analysis.health.overall).toBeLessThanOrEqual(100);
  });

  it('scores testing well, because it has tests', () => {
    const testing = analysis.health.scores.find((score) => score.dimension === 'testing');
    expect(testing?.score).toBeGreaterThan(50);
  });

  it('builds a searchable index of its own code', () => {
    expect(analysis.search.totalDocuments).toBeGreaterThan(100);
  });

  it('answers "where is rate limiting implemented" with the right file', () => {
    // The end-to-end promise of the product, tested against a repository whose
    // correct answer we already know.
    const files = search(analysis.search, 'rate limiting', 5).map((hit) => hit.document.file);
    expect(files.join(' ')).toMatch(/rate-limit/);
  });

  it('answers "where is the search index built" with the right file', () => {
    const files = search(analysis.search, 'build search index bm25', 5).map(
      (hit) => hit.document.file,
    );
    expect(files.join(' ')).toMatch(/core\/search/);
  });

  it('produces a fully serializable analysis', () => {
    // The store round-trips this through JSON; a Map or a cycle would break it.
    expect(() => JSON.stringify(analysis)).not.toThrow();
  });
});
