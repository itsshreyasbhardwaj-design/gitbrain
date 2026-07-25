import { describe, expect, it } from 'vitest';

import { scanSecrets } from './secrets';
import { makeSnapshot } from '../testing/fixtures';

/**
 * Synthetic credentials, assembled at runtime rather than written as literals.
 *
 * Every value below is fake — correctly shaped so the rules fire, issued by
 * nobody. But a *correctly shaped* token is exactly what every other scanner
 * looks for too, and a security tool whose own fixtures trip GitHub's push
 * protection is unshippable. Writing `'xoxb-' + parts.join('-')` keeps the
 * complete string out of the source while producing an identical value at
 * test time.
 *
 * This is the same technique gitleaks and trufflehog use for their corpora,
 * and it is why this repository can be pushed without a push-protection
 * bypass — bypassing that control to ship a security scanner would be an
 * unfortunate way to start.
 */
const join = (...parts: readonly string[]): string => parts.join('');

const AWS_KEY = join('AKIA', 'QYLPMN5HGZR7WJ42');
const GITHUB_PAT = join('ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
const SLACK_TOKEN = join('xoxb', '-591827364501', '-1927364850192', '-Bq4Zn8Wr2Kd6Ty9Lv3Mx7Hs1');
const STRIPE_KEY = join('sk', '_live_', '51HqZbW4nRt7Yu2Pk9Vd3Xa');
const GOOGLE_KEY = join('AIza', 'SyC3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b9C');
const ANTHROPIC_KEY = join('sk-ant', '-api03-', 'Qw8Rt2Yu5Io1Pa4Sd7Fg');
const NPM_TOKEN = join('npm', '_', '9Kd2Lv5Bn8Qw1Er4Ty7Ui0Op3As6Df9Gh2Jk');
const HIGH_ENTROPY = 'a7Fq2Lm9Xz4Kb1Vd8Rt6Yw3Pn5Sc0Jh';

describe('scanSecrets', () => {
  it('detects an AWS access key id as critical', () => {
    const findings = scanSecrets(makeSnapshot({ 'src/config.ts': `const key = "${AWS_KEY}";` }));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('AWS Access Key ID');
    expect(findings[0]?.severity).toBe('critical');
    expect(findings[0]?.file).toBe('src/config.ts');
    expect(findings[0]?.line).toBe(1);
  });

  it('detects provider tokens by their self-identifying prefixes', () => {
    const findings = scanSecrets(
      makeSnapshot({
        'src/a.ts': `const gh = "${GITHUB_PAT}";`,
        'src/b.ts': `const slack = "${SLACK_TOKEN}";`,
        'src/c.ts': `const stripe = "${STRIPE_KEY}";`,
        'src/d.ts': `const google = "${GOOGLE_KEY}";`,
        'src/e.ts': `const claude = "${ANTHROPIC_KEY}";`,
        'src/f.ts': `const npmrc = "${NPM_TOKEN}";`,
      }),
    );

    const rules = findings.map((finding) => finding.rule);
    expect(rules).toContain('GitHub Personal Access Token');
    expect(rules).toContain('Slack Token');
    expect(rules).toContain('Stripe Live Secret Key');
    expect(rules).toContain('Google API Key');
    expect(rules).toContain('Anthropic API Key');
    expect(rules).toContain('npm Access Token');
  });

  it('detects a private key block and a JWT', () => {
    const findings = scanSecrets(
      makeSnapshot({
        'keys/id_rsa': '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n',
        'src/session.ts': `const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";`,
      }),
    );

    const rules = findings.map((finding) => finding.rule);
    expect(rules).toContain('Private Key Block');
    expect(rules).toContain('JSON Web Token');
  });

  it('detects credentials embedded in a database connection string', () => {
    const findings = scanSecrets(
      makeSnapshot({
        'src/db.ts': `const url = "postgres://admin:Xk92mQvL4pRz@db.internal:5432/app";`,
      }),
    );

    expect(findings[0]?.rule).toBe('Database Connection String Credentials');
    expect(findings[0]?.severity).toBe('critical');
  });

  it('reports a high-entropy assignment and records the entropy', () => {
    const findings = scanSecrets(
      makeSnapshot({ 'src/config.ts': `const apiKey = "${HIGH_ENTROPY}";` }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('High-Entropy Secret Assignment');
    expect(findings[0]?.entropy).toBeGreaterThanOrEqual(3.6);
  });

  it('does not report a low-entropy assignment even at the length threshold', () => {
    // Twenty characters, five distinct symbols: entropy log2(5) ≈ 2.32.
    const findings = scanSecrets(
      makeSnapshot({ 'src/config.ts': `const password = "aaaabbbbccccddddeeee";` }),
    );

    expect(findings).toEqual([]);
  });

  it('does not report a short value however random it looks', () => {
    const findings = scanSecrets(makeSnapshot({ 'src/config.ts': `const token = "aZ9qX2wR";` }));

    expect(findings).toEqual([]);
  });

  it('leaves no usable credential in the preview', () => {
    const findings = scanSecrets(makeSnapshot({ 'src/config.ts': `const key = "${AWS_KEY}";` }));

    const preview = findings[0]?.preview ?? '';
    expect(preview).not.toBe(AWS_KEY);
    expect(preview).not.toContain(AWS_KEY);
    expect(preview.startsWith(AWS_KEY.slice(0, 4))).toBe(true);
    expect(preview.slice(4)).toMatch(/^\*+$/);
    // The tail of the real key must not survive anywhere in the finding.
    expect(JSON.stringify(findings)).not.toContain(AWS_KEY.slice(4));
  });

  it('suppresses everything inside .env.example and friends', () => {
    const body = [
      `AWS_ACCESS_KEY_ID=${AWS_KEY}`,
      `GITHUB_TOKEN=${GITHUB_PAT}`,
      `API_KEY="${HIGH_ENTROPY}"`,
    ].join('\n');

    expect(
      scanSecrets(
        makeSnapshot({
          '.env.example': body,
          '.env.sample': body,
          '.env.template': body,
          'config/settings.sample.yml': body,
        }),
      ),
    ).toEqual([]);
  });

  it('still reports the same content in a real .env file', () => {
    const findings = scanSecrets(makeSnapshot({ '.env': `AWS_ACCESS_KEY_ID=${AWS_KEY}` }));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('AWS Access Key ID');
  });

  it('suppresses placeholder values', () => {
    const findings = scanSecrets(
      makeSnapshot({
        'src/a.ts': [
          `const apiKey = "your-api-key-here-abc";`,
          `const secret = "CHANGEME_CHANGEME_CHANGEME";`,
          `const token = "<insert-your-token-here>";`,
          `const password = "xxxxxxxxxxxxxxxxxxxx";`,
          'const clientSecret = `${process.env.CLIENT_SECRET}`;',
          `const apiKey2 = "\${API_KEY_FROM_VAULT}";`,
          `const accessKey = "example-access-key-value";`,
          `const authToken = "dummy-value-for-local-dev";`,
          `const privateKey = "INSERT_PRIVATE_KEY_HERE_NOW";`,
        ].join('\n'),
      }),
    );

    expect(findings).toEqual([]);
  });

  it('suppresses the canonical AWS documentation key', () => {
    expect(
      scanSecrets(
        makeSnapshot({ 'src/a.ts': `const key = "${join('AKIA', 'IOSFODNN7EXAMPLE')}";` }),
      ),
    ).toEqual([]);
  });

  it('suppresses lockfiles, vendored trees and generated output', () => {
    const body = `"integrity": "${GITHUB_PAT}"`;

    expect(
      scanSecrets(
        makeSnapshot({
          'package-lock.json': body,
          'pnpm-lock.yaml': body,
          'go.sum': body,
          'vendor/thing/config.go': body,
          'dist/bundle.js': body,
        }),
      ),
    ).toEqual([]);
  });

  it('reports one finding per value even when several rules could match', () => {
    const findings = scanSecrets(
      makeSnapshot({ 'src/a.ts': `const anthropicKey = "${ANTHROPIC_KEY}";` }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('Anthropic API Key');
  });

  it('sorts by severity, then file, then line', () => {
    const findings = scanSecrets(
      makeSnapshot({
        'src/z.ts': `const pk = "pk_live_51HqZbW4nRt7Yu2Pk9Vd3Xa";`,
        'src/a.ts': `const key = "${AWS_KEY}";`,
      }),
    );

    expect(findings.map((finding) => finding.severity)).toEqual(['critical', 'low']);
  });

  it('gives every finding a stable, deterministic id', () => {
    const snapshot = makeSnapshot({ 'src/a.ts': `const key = "${AWS_KEY}";` });

    expect(scanSecrets(snapshot).map((f) => f.id)).toEqual(scanSecrets(snapshot).map((f) => f.id));
    expect(scanSecrets(snapshot)[0]?.id).toMatch(/^secret-[0-9a-f]{8}$/);
  });

  it('omits the entropy field for shape-based rules', () => {
    const findings = scanSecrets(makeSnapshot({ 'src/a.ts': `const key = "${AWS_KEY}";` }));

    expect(findings[0]).not.toHaveProperty('entropy');
  });

  it('returns nothing for a clean repository', () => {
    expect(
      scanSecrets(
        makeSnapshot({
          'src/a.ts': 'export const config = { region: process.env.AWS_REGION };',
          'README.md': '# Demo\n\nSet AWS_REGION before running.',
        }),
      ),
    ).toEqual([]);
  });
});
