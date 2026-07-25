import { describe, expect, it } from 'vitest';

import { analyzeSecurity } from './index';
import { makeBinaryFile, makeSnapshot, DEFAULT_SOURCE } from '../testing/fixtures';
import type { DependencyReport, RepoSnapshot } from '../types';

// Assembled rather than written literally — see the note in secrets.test.ts.
// A correctly shaped fake key still trips every scanner, including GitHub's
// push protection, so no fixture in this repository spells one out in full.
const AWS_KEY = ['AKIA', 'QYLPMN5HGZR7WJ42'].join('');

function deps(overrides: Partial<DependencyReport> = {}): DependencyReport {
  return {
    dependencies: [],
    manifests: ['package.json'],
    counts: { runtime: 0, dev: 0, peer: 0, optional: 0 },
    flagged: [],
    unpinned: [],
    hasLockfile: true,
    ...overrides,
  };
}

/** A snapshot with a .gitignore that already covers .env, so only the rule under test fires. */
function clean(files: Record<string, string>): RepoSnapshot {
  return makeSnapshot({ '.gitignore': 'node_modules\n.env\n', ...files });
}

function riskIds(snapshot: RepoSnapshot, dependencies = deps()): string[] {
  return analyzeSecurity(snapshot, dependencies).risks.map((risk) => risk.id);
}

describe('analyzeSecurity', () => {
  it('scores a clean repository at 100', () => {
    const report = analyzeSecurity(
      clean({
        'src/a.ts': 'export const a = 1;',
        'README.md': '# Demo',
      }),
      deps(),
    );

    expect(report.risks).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.secrets).toEqual([]);
    expect(report.largeFiles).toEqual([]);
  });

  it('flags a committed .env file as critical but not its example sibling', () => {
    const report = analyzeSecurity(
      clean({ '.env': 'API_KEY=1\n', '.env.example': 'API_KEY=\n' }),
      deps(),
    );

    const risk = report.risks.find((entry) => entry.id === 'risk-committed-env-file');
    expect(risk?.severity).toBe('critical');
    expect(risk?.files).toEqual(['.env']);
    expect(risk?.reference).toContain('CWE-540');
    expect(risk?.detail).not.toContain('.env.example');
  });

  it('flags a .gitignore that does not cover .env, and a missing .gitignore', () => {
    const uncovered = analyzeSecurity(
      makeSnapshot({ '.gitignore': 'node_modules\ndist\n', 'src/a.ts': 'export const a = 1;' }),
      deps(),
    );
    const missing = analyzeSecurity(makeSnapshot({ 'src/a.ts': 'export const a = 1;' }), deps());

    expect(uncovered.risks.find((risk) => risk.id === 'risk-gitignore-env')?.title).toContain(
      'does not exclude',
    );
    expect(missing.risks.find((risk) => risk.id === 'risk-gitignore-env')?.title).toContain(
      'no .gitignore',
    );
    expect(riskIds(clean({ 'src/a.ts': 'export const a = 1;' }))).not.toContain(
      'risk-gitignore-env',
    );
  });

  it('accepts a .env* wildcard as coverage', () => {
    expect(
      riskIds(makeSnapshot({ '.gitignore': '.env*\n!.env.example\n', 'src/a.ts': 'const a = 1;' })),
    ).not.toContain('risk-gitignore-env');
  });

  it('summarizes hardcoded secrets and cites the redacted preview', () => {
    const report = analyzeSecurity(clean({ 'src/config.ts': `const k = "${AWS_KEY}";` }), deps());

    const risk = report.risks.find((entry) => entry.id === 'risk-hardcoded-secrets');
    expect(risk?.severity).toBe('critical');
    expect(risk?.detail).toContain('src/config.ts:1');
    expect(risk?.detail).toContain('AWS Access Key ID');
    expect(risk?.reference).toContain('CWE-798');
    expect(JSON.stringify(report)).not.toContain(AWS_KEY.slice(4));
  });

  it('detects eval and the Function constructor in code but not in comments or strings', () => {
    const flagged = riskIds(
      clean({ 'src/a.ts': 'const out = eval(input);\nconst f = new Function(body);' }),
    );
    expect(flagged).toContain('risk-sink-eval');
    expect(flagged).toContain('risk-sink-new-function');

    const quiet = riskIds(
      clean({
        'src/b.ts': [
          '// never call eval( on user input',
          `const advice = "do not use eval(x) or new Function(y)";`,
          'run();',
        ].join('\n'),
      }),
    );
    expect(quiet).not.toContain('risk-sink-eval');
    expect(quiet).not.toContain('risk-sink-new-function');
  });

  it('detects unsafe DOM sinks', () => {
    const ids = riskIds(
      clean({
        'src/a.tsx': 'const el = <div dangerouslySetInnerHTML={{ __html: body }} />;',
        'src/b.ts': 'node.innerHTML = untrusted;',
      }),
    );

    expect(ids).toContain('risk-sink-dangerously-set-inner-html');
    expect(ids).toContain('risk-sink-inner-html');
  });

  it('detects shell command interpolation and Python shell execution', () => {
    const ids = riskIds(
      clean({
        'src/a.ts': 'exec(`git checkout ${branch}`);',
        'src/b.py': 'os.system("rm -rf " + target)\nsubprocess.run(cmd, shell=True)',
      }),
    );

    expect(ids).toContain('risk-sink-shell-interpolation');
    expect(ids).toContain('risk-sink-python-shell');
  });

  it('detects unsafe deserialization, and respects a SafeLoader', () => {
    const unsafe = riskIds(
      clean({
        'src/a.py': 'data = pickle.loads(payload)\nconfig = yaml.load(raw)',
      }),
    );
    expect(unsafe).toContain('risk-sink-pickle');
    expect(unsafe).toContain('risk-sink-yaml-load');

    const safe = riskIds(clean({ 'src/b.py': 'config = yaml.load(raw, Loader=yaml.SafeLoader)' }));
    expect(safe).not.toContain('risk-sink-yaml-load');
  });

  it('detects SQL assembled from strings in several languages', () => {
    const ids = riskIds(
      clean({
        'src/a.ts': 'const q = "SELECT * FROM users WHERE id = " + id;',
        'src/b.ts': 'const q2 = `SELECT * FROM orders WHERE id = ${id}`;',
        'src/c.py': 'q = f"SELECT * FROM carts WHERE id = {cart_id}"',
      }),
    );

    expect(ids).toContain('risk-sink-sql-concat');
  });

  it('detects weak password hashing and disabled TLS verification', () => {
    const ids = riskIds(
      clean({
        'src/a.py': 'digest = hashlib.md5(password.encode()).hexdigest()',
        'src/b.py': 'requests.get(url, verify=False)',
        'src/c.ts': 'const agent = new https.Agent({ rejectUnauthorized: false });',
      }),
    );

    expect(ids).toContain('risk-sink-weak-password-hash');
    expect(ids).toContain('risk-sink-tls-verification-disabled');
  });

  it('detects a wildcard CORS origin combined with credentials', () => {
    const permissive = riskIds(
      clean({
        'src/server.ts': ['app.use(cors({', `  origin: '*',`, '  credentials: true,', '}));'].join(
          '\n',
        ),
      }),
    );
    expect(permissive).toContain('risk-permissive-cors');

    const scoped = riskIds(
      clean({
        'src/server.ts': `app.use(cors({ origin: 'https://app.example.com', credentials: true }));`,
      }),
    );
    expect(scoped).not.toContain('risk-permissive-cors');
  });

  it('passes flagged dependencies through and raises a risk for them', () => {
    const flagged: DependencyReport = deps({
      flagged: [
        {
          name: 'request',
          reason: 'unmaintained since 2020',
          severity: 'high',
          replacement: 'undici',
        },
      ],
    });

    const report = analyzeSecurity(clean({ 'src/a.ts': 'const a = 1;' }), flagged);

    expect(report.flaggedDependencies).toEqual(flagged.flagged);
    const risk = report.risks.find((entry) => entry.id === 'risk-flagged-dependencies');
    expect(risk?.severity).toBe('high');
    expect(risk?.reference).toContain('OWASP');
  });

  it('reports undocumented environment variables as informational only', () => {
    const report = analyzeSecurity(
      clean({ 'src/a.ts': 'const a = process.env.SHADOW_TOKEN;' }),
      deps(),
    );

    const risk = report.risks.find((entry) => entry.id === 'risk-undocumented-env');
    expect(risk?.severity).toBe('info');
    expect(report.undocumentedEnvVars).toEqual(['SHADOW_TOKEN']);
    // info-severity risks deduct nothing.
    expect(report.score).toBe(100);
  });

  it('lists files over one megabyte, largest first, capped at 25', () => {
    const files = [
      ...makeSnapshot({ 'src/a.ts': 'const a = 1;' }).files,
      ...Array.from({ length: 30 }, (_, i) =>
        makeBinaryFile(`assets/blob${i}.bin`, 1_048_577 + i * 1000),
      ),
      makeBinaryFile('assets/small.bin', 1000),
    ];

    const snapshot: RepoSnapshot = {
      source: DEFAULT_SOURCE,
      files,
      totalBytes: 0,
      truncated: false,
      skipped: { ignored: 0, binary: 0, tooLarge: 0, overBudget: 0 },
      ingestMs: 0,
    };

    const report = analyzeSecurity(snapshot, deps());

    expect(report.largeFiles).toHaveLength(25);
    expect(report.largeFiles[0]?.path).toBe('assets/blob29.bin');
    expect(report.largeFiles.every((file) => file.size > 1_048_576)).toBe(true);
  });

  it('deducts by severity and never leaves the 0-100 range', () => {
    const oneCritical = analyzeSecurity(clean({ '.env': 'A=1\n' }), deps());
    expect(oneCritical.score).toBe(70);

    const everything = analyzeSecurity(
      makeSnapshot({
        '.env': `AWS_ACCESS_KEY_ID=${AWS_KEY}\n`,
        'src/a.ts': [
          'const out = eval(input);',
          'const f = new Function(body);',
          'node.innerHTML = untrusted;',
          'const q = "SELECT * FROM users WHERE id = " + id;',
          'exec(`git checkout ${branch}`);',
        ].join('\n'),
        'src/b.py': 'data = pickle.loads(payload)\nconfig = yaml.load(raw)',
      }),
      deps({ flagged: [{ name: 'request', reason: 'unmaintained', severity: 'high' }] }),
    );

    expect(everything.score).toBe(0);
  });

  it('sorts risks by severity', () => {
    const report = analyzeSecurity(
      clean({
        '.env': 'A=1\n',
        'src/a.ts': 'node.innerHTML = untrusted;\nconst b = process.env.SHADOW;',
      }),
      deps(),
    );

    const rank = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as const;
    for (let i = 1; i < report.risks.length; i++) {
      const previous = report.risks[i - 1];
      const current = report.risks[i];
      if (!previous || !current) continue;
      expect(rank[previous.severity]).toBeGreaterThanOrEqual(rank[current.severity]);
    }
  });

  it('carries the secret and env sub-reports through unchanged', () => {
    const report = analyzeSecurity(
      clean({
        'src/config.ts': `const k = "${AWS_KEY}";\nconst url = process.env.API_URL;`,
        '.env.example': 'API_URL=https://example.test\n',
      }),
      deps(),
    );

    expect(report.secrets).toHaveLength(1);
    expect(report.envVars).toEqual([
      { name: 'API_URL', files: ['src/config.ts'], documented: true },
    ]);
    expect(report.undocumentedEnvVars).toEqual([]);
  });
});
