import { describe, expect, it } from 'vitest';

import { analyzeReadme, README_SECTION_NAMES } from './index';
import { makeSnapshot } from '../testing/fixtures';
import type { ReadmeReport, RepoSource } from '../types';

/** Triple backtick, kept out of the template literals below for readability. */
const F = '```';

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'demo',
    description: 'Turns a repository into an explained system.',
    license: 'MIT',
    engines: { node: '>=20.11.0' },
    scripts: {
      dev: 'next dev',
      build: 'next build',
      test: 'vitest run',
      lint: 'eslint .',
      'test:coverage': 'vitest run --coverage',
    },
  },
  null,
  2,
);

/** A realistic repository skeleton so generated Markdown has real facts to use. */
const REPO_FILES: Record<string, string> = {
  'package.json': PACKAGE_JSON,
  'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
  Dockerfile: 'FROM node:20-alpine\n',
  '.env.example': 'GITHUB_TOKEN=\nLOG_LEVEL=info\n',
  LICENSE: 'MIT License\n\nCopyright (c) 2026 acme\n',
  '.github/workflows/ci.yml': 'name: CI\non: [push]\n',
  'docs/architecture.md': '# Architecture\n',
  'src/index.ts': 'export const answer = 42;\n',
  'src/index.test.ts': 'it("works", () => {});\n',
};

const EXCELLENT_README = [
  '# demo',
  '',
  '[![CI](https://github.com/acme/demo/actions/workflows/ci.yml/badge.svg)](https://github.com/acme/demo/actions)',
  '[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)',
  '',
  'demo turns any repository into an explained system: it ingests the tree, detects the',
  'stack, maps the module graph, and produces a health score that cites the files behind',
  'every number, so a reviewer can check the conclusion instead of trusting it.',
  '',
  '![Dashboard](docs/images/dashboard.png)',
  '',
  '## Features',
  '',
  '- **Fast** — a full analysis of a mid-size repository finishes in a few seconds.',
  '- **Local** — nothing leaves the machine unless you explicitly ask it to.',
  '- **Explainable** — every score cites the files and lines that produced it.',
  '- **Portable** — the analysis core has no framework dependency whatsoever.',
  '',
  '## Requirements',
  '',
  '- Node.js >= 20.11',
  '- pnpm 11 or newer',
  '',
  '## Installation',
  '',
  F + 'bash',
  'git clone https://github.com/acme/demo.git',
  'cd demo',
  'pnpm install',
  F,
  '',
  '## Usage',
  '',
  'The shortest useful program looks like this:',
  '',
  F + 'ts',
  "import { analyze } from 'demo';",
  '',
  "const report = await analyze('acme/demo');",
  'console.log(report.health.overall);',
  F,
  '',
  '## Configuration',
  '',
  'Copy the committed template and fill in the blanks:',
  '',
  F + 'bash',
  'cp .env.example .env',
  F,
  '',
  '| Variable | Required | Description |',
  '| --- | --- | --- |',
  '| `GITHUB_TOKEN` | yes | Raises the GitHub API rate limit for private repositories. |',
  '| `LOG_LEVEL` | no | One of debug, info, warn or error. Defaults to info. |',
  '',
  '## API',
  '',
  '| Export | Signature | Description |',
  '| --- | --- | --- |',
  '| `analyze` | `(source: string) => Promise<Analysis>` | Runs the full pipeline. |',
  '| `computeHealth` | `(input: HealthInput) => HealthReport` | Scores an analysed repo. |',
  '',
  '## Screenshots',
  '',
  '![Module graph](docs/images/graph.png)',
  '',
  '## Tests',
  '',
  F + 'bash',
  'pnpm test',
  F,
  '',
  '## Roadmap',
  '',
  '- [x] Health scoring across eight dimensions',
  '- [ ] Incremental re-analysis of changed files only',
  '- [ ] A hosted runner for very large repositories',
  '',
  '## Contributing',
  '',
  'Contributions are welcome. Read CONTRIBUTING.md, branch from main, keep the suite',
  'green with `pnpm test`, and open a pull request that links the issue it closes.',
  '',
  '## License',
  '',
  'Licensed under the MIT License. See LICENSE for the full text.',
  '',
  '## Support',
  '',
  'Report bugs at https://github.com/acme/demo/issues and ask questions in',
  'https://github.com/acme/demo/discussions. Never report a vulnerability publicly.',
  '',
].join('\n');

const MINIMAL_README = [
  '# demo',
  '',
  'A tiny command line tool for turning CSV files into JSON documents quickly.',
  '',
  'Run `demo input.csv` to get started.',
  '',
].join('\n');

function analyze(readme: string | null, extra: Record<string, string> = {}): ReadmeReport {
  const files: Record<string, string> = { ...REPO_FILES, ...extra };
  if (readme !== null) files['README.md'] = readme;
  return analyzeReadme(makeSnapshot(files));
}

function sectionByName(report: ReadmeReport, name: string): boolean {
  return report.sections.some((section) => section.name === name && section.present);
}

describe('analyzeReadme — section catalogue', () => {
  it('evaluates all fifteen sections with weights summing to exactly 1', () => {
    const report = analyze(MINIMAL_README);

    expect(report.sections).toHaveLength(15);
    expect(report.sections.map((section) => section.name)).toEqual([...README_SECTION_NAMES]);

    const total = report.sections.reduce((sum, section) => sum + section.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('attaches a suggestion to every missing section and none to present ones', () => {
    const report = analyze(MINIMAL_README);

    for (const section of report.sections) {
      if (section.present) expect(section.suggestion).toBeUndefined();
      else expect(section.suggestion?.length ?? 0).toBeGreaterThan(20);
    }
  });
});

describe('analyzeReadme — no README', () => {
  const report = analyze(null);

  it('reports absence honestly', () => {
    expect(report.exists).toBe(false);
    expect(report.path).toBeNull();
    expect(report.score).toBe(0);
    expect(report.wordCount).toBe(0);
    expect(report.hasBadges).toBe(false);
    expect(report.hasCodeExamples).toBe(false);
    expect(report.hasImages).toBe(false);
  });

  it('marks every section missing', () => {
    expect(report.missingSections).toHaveLength(15);
    expect(report.sections.every((section) => !section.present)).toBe(true);
  });

  it('generates a complete starter README', () => {
    expect(report.generatedSections).toHaveLength(15);
    expect(report.generatedSections.map((section) => section.name)).toEqual([
      ...README_SECTION_NAMES,
    ]);

    for (const section of report.generatedSections) {
      expect(section.markdown.trim().length).toBeGreaterThan(40);
      expect(section.markdown).not.toContain('TODO');
      expect(section.markdown).not.toContain('FIXME');
      expect(section.markdown).not.toContain('<!--');
      expect(section.markdown).not.toContain('XXX');
    }
  });

  it('leads with a suggestion to create the file at all', () => {
    expect(report.suggestions[0]).toContain('README.md');
    expect(report.suggestions.length).toBeGreaterThan(10);
  });
});

describe('analyzeReadme — generated Markdown is repository-aware', () => {
  const generated = new Map(
    analyze(null).generatedSections.map((section) => [section.name, section.markdown]),
  );

  it('uses the real clone URL and package manager in Installation', () => {
    const markdown = generated.get('Installation') ?? '';
    expect(markdown).toContain('git clone https://github.com/acme/demo.git');
    expect(markdown).toContain('cd demo');
    expect(markdown).toContain('pnpm install');
    expect(markdown).toContain('Node.js >=20.11.0');
    expect(markdown).toContain('docker build -t demo .');
  });

  it('uses the manifest description in the Title', () => {
    const markdown = generated.get('Title') ?? '';
    expect(markdown).toContain('# demo');
    expect(markdown).toContain('Turns a repository into an explained system.');
  });

  it('uses the real issue, discussion and advisory URLs in Support', () => {
    const markdown = generated.get('Support') ?? '';
    expect(markdown).toContain('https://github.com/acme/demo/issues');
    expect(markdown).toContain('https://github.com/acme/demo/discussions');
    expect(markdown).toContain('https://github.com/acme/demo/security/advisories/new');
  });

  it('names the detected licence rather than guessing', () => {
    const markdown = generated.get('License') ?? '';
    expect(markdown).toContain('MIT');
    expect(markdown).toContain('https://github.com/acme/demo/blob/main/LICENSE');
  });

  it('lists the variables from the committed env template in Configuration', () => {
    const markdown = generated.get('Configuration') ?? '';
    expect(markdown).toContain('GITHUB_TOKEN');
    expect(markdown).toContain('LOG_LEVEL');
    expect(markdown).toContain('cp .env.example .env');
  });

  it('lists the scripts that actually exist in Tests', () => {
    const markdown = generated.get('Tests') ?? '';
    expect(markdown).toContain('pnpm test');
    expect(markdown).toContain('pnpm run test:coverage');
    expect(markdown).toContain('pnpm run lint');
  });

  it('derives Features from committed evidence, not boilerplate', () => {
    const markdown = generated.get('Features') ?? '';
    expect(markdown).toContain('TypeScript');
    expect(markdown).toContain('Dockerfile');
    expect(markdown).toContain('CI');
  });

  it('checks off roadmap items the repository has already achieved', () => {
    const markdown = generated.get('Roadmap') ?? '';
    expect(markdown).toContain('- [x] Licensed under MIT');
    expect(markdown).toContain('- [x] Continuous integration on every push');
    expect(markdown).toContain('- [ ] Ship a documented `1.0.0` release');
  });
});

describe('analyzeReadme — generated Markdown adapts to the ecosystem', () => {
  it('produces Python commands for a Python repository', () => {
    const report = analyzeReadme(
      makeSnapshot({
        'requirements.txt': 'flask==3.0.0\n',
        'main.py': 'print("hi")\n',
      }),
    );
    const generated = new Map(
      report.generatedSections.map((section) => [section.name, section.markdown]),
    );

    expect(generated.get('Installation')).toContain('pip install -r requirements.txt');
    expect(generated.get('Usage')).toContain('python main.py');
    expect(generated.get('Usage')).toContain('from demo import main');
    expect(generated.get('Tests')).toContain('pytest');
    expect(generated.get('Requirements')).toContain('Python 3.10 or newer');
  });

  it('produces Rust commands for a Cargo repository', () => {
    const report = analyzeReadme(makeSnapshot({ 'Cargo.toml': '[package]\nname = "demo"\n' }));
    const generated = new Map(
      report.generatedSections.map((section) => [section.name, section.markdown]),
    );

    expect(generated.get('Installation')).toContain('cargo build');
    expect(generated.get('Tests')).toContain('cargo test');
    expect(generated.get('Requirements')).toContain('Rust 1.75 or newer');
  });

  it('warns when no licence can be found anywhere', () => {
    const report = analyzeReadme(makeSnapshot({ 'go.mod': 'module demo\n' }));
    const license = report.generatedSections.find((section) => section.name === 'License');

    expect(license?.markdown).toContain('does not declare a license');
    expect(license?.markdown).toContain('MIT');
    expect(license?.markdown).toContain('Apache-2.0');
  });

  it('derives a project name from an uploaded archive', () => {
    const source: RepoSource = { kind: 'upload', filename: 'my-tool-main.zip' };
    const report = analyzeReadme(makeSnapshot({ 'go.mod': 'module my-tool\n' }, source));
    const title = report.generatedSections.find((section) => section.name === 'Title');

    expect(title?.markdown).toContain('# my-tool');
    expect(
      report.generatedSections.find((section) => section.name === 'Support')?.markdown,
    ).not.toContain('github.com');
  });
});

describe('analyzeReadme — excellent README', () => {
  const report = analyze(EXCELLENT_README);

  it('scores in the A range with nothing missing', () => {
    expect(report.exists).toBe(true);
    expect(report.path).toBe('README.md');
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.missingSections).toEqual([]);
    expect(report.generatedSections).toEqual([]);
  });

  it('detects badges, code examples and images', () => {
    expect(report.hasBadges).toBe(true);
    expect(report.hasCodeExamples).toBe(true);
    expect(report.hasImages).toBe(true);
  });

  it('counts more than the hundred-word floor, excluding code blocks', () => {
    expect(report.wordCount).toBeGreaterThan(100);
    // The fenced blocks contain `pnpm`, `cargo`-style tokens that must not be counted.
    expect(report.wordCount).toBeLessThan(400);
  });

  it('finds every individual section', () => {
    for (const name of README_SECTION_NAMES) {
      expect(sectionByName(report, name), `expected section ${name} to be present`).toBe(true);
    }
  });

  it('offers no section suggestions when nothing is missing', () => {
    expect(report.suggestions).toEqual([]);
  });
});

describe('analyzeReadme — minimal README', () => {
  const report = analyze(MINIMAL_README);

  it('exists but scores far below a usable README', () => {
    expect(report.exists).toBe(true);
    expect(report.score).toBeGreaterThan(0);
    expect(report.score).toBeLessThan(35);
  });

  it('credits only the title and the pitch paragraph', () => {
    expect(sectionByName(report, 'Title')).toBe(true);
    expect(sectionByName(report, 'Description')).toBe(true);
    expect(sectionByName(report, 'Installation')).toBe(false);
    expect(sectionByName(report, 'Usage')).toBe(false);
    expect(sectionByName(report, 'License')).toBe(false);
  });

  it('flags the length, the missing code block and the missing badges', () => {
    const joined = report.suggestions.join('\n');
    expect(joined).toContain('100-word floor');
    expect(joined).toContain('fenced code block');
    expect(joined).toContain('status badges');
  });

  it('generates Markdown for every missing section and nothing else', () => {
    expect(report.generatedSections.map((section) => section.name)).toEqual(report.missingSections);
    expect(report.generatedSections.length).toBe(13);
  });

  it('scores strictly below the excellent README', () => {
    expect(report.score).toBeLessThan(analyze(EXCELLENT_README).score);
  });
});

describe('analyzeReadme — file discovery', () => {
  it('matches README filenames case-insensitively', () => {
    const report = analyzeReadme(makeSnapshot({ 'readme.md': MINIMAL_README }));
    expect(report.exists).toBe(true);
    expect(report.path).toBe('readme.md');
  });

  it('accepts .rst and reads its setext headings', () => {
    const rst = [
      'demo',
      '====',
      '',
      'A repository intelligence engine that reads a project and explains it to you',
      'in plain language, with citations back into the source tree.',
      '',
      'Installation',
      '------------',
      '',
      'Run ``pip install demo`` to get the latest release from PyPI.',
      '',
      'License',
      '-------',
      '',
      'Licensed under the MIT License.',
      '',
    ].join('\n');

    const report = analyzeReadme(makeSnapshot({ 'README.rst': rst }));

    expect(report.path).toBe('README.rst');
    expect(sectionByName(report, 'Title')).toBe(true);
    expect(sectionByName(report, 'Installation')).toBe(true);
    expect(sectionByName(report, 'License')).toBe(true);
  });

  it('ignores READMEs that are not at the repository root', () => {
    const report = analyzeReadme(makeSnapshot({ 'docs/README.md': EXCELLENT_README }));
    expect(report.exists).toBe(false);
  });

  it('prefers README.md when several root candidates exist', () => {
    const report = analyzeReadme(
      makeSnapshot({ 'README.txt': 'old', 'README.md': MINIMAL_README }),
    );
    expect(report.path).toBe('README.md');
  });
});

describe('analyzeReadme — content signals', () => {
  it('credits Installation from a code block even without a matching heading', () => {
    const readme = ['# demo', '', '## Get going', '', F + 'bash', 'npm install demo', F, ''].join(
      '\n',
    );

    expect(
      sectionByName(analyzeReadme(makeSnapshot({ 'README.md': readme })), 'Installation'),
    ).toBe(true);
  });

  it('credits Tests from a test command in a code block', () => {
    const readme = ['# demo', '', F + 'bash', 'pytest -q', F, ''].join('\n');
    expect(sectionByName(analyzeReadme(makeSnapshot({ 'README.md': readme })), 'Tests')).toBe(true);
  });

  it('credits Usage from a real code example rather than a shell recipe', () => {
    const shellOnly = ['# demo', '', F + 'bash', 'ls -la', F, ''].join('\n');
    const withExample = ['# demo', '', F + 'ts', 'const x = 1;', F, ''].join('\n');

    expect(sectionByName(analyzeReadme(makeSnapshot({ 'README.md': shellOnly })), 'Usage')).toBe(
      false,
    );
    expect(sectionByName(analyzeReadme(makeSnapshot({ 'README.md': withExample })), 'Usage')).toBe(
      true,
    );
  });

  it('credits Features from a bullet list of four or more items', () => {
    const three = ['# demo', '', '- one', '- two', '- three', ''].join('\n');
    const four = ['# demo', '', '- one', '- two', '- three', '- four', ''].join('\n');

    expect(sectionByName(analyzeReadme(makeSnapshot({ 'README.md': three })), 'Features')).toBe(
      false,
    );
    expect(sectionByName(analyzeReadme(makeSnapshot({ 'README.md': four })), 'Features')).toBe(
      true,
    );
  });

  it('credits Roadmap from task-list checkboxes', () => {
    const readme = ['# demo', '', '- [x] shipped', '- [ ] next', ''].join('\n');
    expect(sectionByName(analyzeReadme(makeSnapshot({ 'README.md': readme })), 'Roadmap')).toBe(
      true,
    );
  });
});

describe('analyzeReadme — badges, images and word count', () => {
  it('only counts badges near the top of the document', () => {
    const badge = '[![Build](https://img.shields.io/badge/build-passing-green.svg)](https://ci)';

    const top = analyzeReadme(makeSnapshot({ 'README.md': ['# demo', '', badge, ''].join('\n') }));
    const bottom = analyzeReadme(
      makeSnapshot({
        'README.md': ['# demo', ...Array.from({ length: 40 }, () => 'filler'), badge, ''].join(
          '\n',
        ),
      }),
    );

    expect(top.hasBadges).toBe(true);
    expect(bottom.hasBadges).toBe(false);
    expect(bottom.hasImages).toBe(true);
  });

  it('recognises HTML <img> tags as images', () => {
    const readme = ['# demo', '', '<img src="docs/hero.png" alt="hero">', ''].join('\n');
    expect(analyzeReadme(makeSnapshot({ 'README.md': readme })).hasImages).toBe(true);
  });

  it('excludes fenced code blocks from the word count', () => {
    const words = ['# demo', '', 'Exactly five words here now.', ''].join('\n');
    const withCode = [
      '# demo',
      '',
      'Exactly five words here now.',
      '',
      F + 'ts',
      ...Array.from({ length: 50 }, (_unused, index) => `const variable${index} = compute(index);`),
      F,
      '',
    ].join('\n');

    const plain = analyzeReadme(makeSnapshot({ 'README.md': words }));
    const coded = analyzeReadme(makeSnapshot({ 'README.md': withCode }));

    expect(plain.wordCount).toBe(coded.wordCount);
    expect(coded.hasCodeExamples).toBe(true);
  });

  it('handles an unterminated code fence without losing the block', () => {
    const readme = ['# demo', '', F + 'bash', 'pnpm install', ''].join('\n');
    const report = analyzeReadme(makeSnapshot({ 'README.md': readme }));

    expect(report.hasCodeExamples).toBe(true);
    expect(sectionByName(report, 'Installation')).toBe(true);
  });
});

describe('analyzeReadme — scoring behaviour', () => {
  it('is deterministic', () => {
    const first = analyze(EXCELLENT_README);
    const second = analyze(EXCELLENT_README);
    expect(first).toEqual(second);
  });

  it('never leaves the 0–100 range', () => {
    for (const readme of [EXCELLENT_README, MINIMAL_README, '', '#']) {
      const report = analyzeReadme(makeSnapshot({ 'README.md': readme }));
      expect(report.score).toBeGreaterThanOrEqual(0);
      expect(report.score).toBeLessThanOrEqual(100);
    }
  });

  it('rises monotonically as sections are added', () => {
    const base = ['# demo', '', 'A repository intelligence engine that explains any codebase.'];
    const withInstall = [...base, '', '## Installation', '', F + 'bash', 'pnpm install', F];
    const withUsage = [
      ...withInstall,
      '',
      '## Usage',
      '',
      F + 'ts',
      "import { analyze } from 'demo';",
      F,
    ];

    const scores = [base, withInstall, withUsage].map(
      (lines) => analyzeReadme(makeSnapshot({ 'README.md': lines.join('\n') })).score,
    );

    expect(scores[1] ?? 0).toBeGreaterThan(scores[0] ?? 0);
    expect(scores[2] ?? 0).toBeGreaterThan(scores[1] ?? 0);
  });

  it('handles an empty README without throwing', () => {
    const report = analyzeReadme(makeSnapshot({ 'README.md': '' }));
    expect(report.exists).toBe(true);
    expect(report.score).toBe(0);
    expect(report.wordCount).toBe(0);
    expect(report.generatedSections).toHaveLength(15);
  });
});
