/**
 * Committed-credential detection.
 *
 * A secret scanner lives or dies on its false-positive rate. Developers ignore a
 * scanner that cries wolf, and a scanner that is ignored is worse than none at
 * all — so this module spends more code on *suppression* than on detection.
 *
 * The architecture is three layers, applied in order:
 *
 * 1. **File gate.** Whole files are excluded when they exist precisely to hold
 *    fake credentials: `.env.example` and friends, lockfiles (full of integrity
 *    hashes that look like high-entropy tokens), vendored trees and generated
 *    output. Scanning them produces nothing but noise.
 *
 * 2. **Shape rules.** Provider tokens have distinctive, self-identifying
 *    prefixes — `AKIA`, `ghp_`, `xoxb-`, `sk_live_`, `AIza`. These are matched
 *    literally, need no entropy check, and are almost never false positives.
 *
 * 3. **Entropy rule.** For everything with no fixed shape, a contextual
 *    assignment (`password = "…"`) is combined with a Shannon entropy floor of
 *    3.6 bits/char and a 16-character minimum. English prose sits near 2.5 and
 *    `password = "hunter2"` is both too short and too low-entropy, while a real
 *    base64 or hex key comfortably clears 3.6.
 *
 * On top of all three, every candidate value is checked against a placeholder
 * vocabulary (`your-key-here`, `changeme`, `<token>`, `${VAR}`, `process.env.X`)
 * because those appear constantly in real code and are never credentials.
 *
 * `preview` is always produced by `redact()`. There is no code path in GitBrain
 * that emits a usable credential, and there must never be one.
 */

import type { RepoSnapshot, SecretFinding, Severity } from '../types';
import { isGeneratedFile, isTestFile, isVendored } from '../shared/classify';
import { basename } from '../shared/paths';
import { hashString, redact, shannonEntropy } from '../shared/text';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface SecretRule {
  readonly rule: string;
  /** Global regex applied per line. */
  readonly pattern: RegExp;
  /** Capture group holding the credential itself. 0 = the whole match. */
  readonly group: number;
  readonly severity: Severity;
  /** When set, the match is only reported if the value clears this entropy. */
  readonly minEntropy?: number;
  readonly minLength?: number;
}

/**
 * Ordered most-specific first.
 *
 * Order matters because a value matched by two rules is reported once, under the
 * first rule that claimed it — so `sk-ant-…` must be tried before the generic
 * OpenAI `sk-…` shape, and the connection-string rules before generic assignment.
 */
const RULES: readonly SecretRule[] = [
  {
    rule: 'AWS Access Key ID',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    // No fixed shape — 40 base64 characters. Only reported next to an AWS-ish
    // key name and only when the entropy says it is not a sentence.
    rule: 'AWS Secret Access Key',
    pattern:
      /aws[_-]?(?:secret|sec)[_-]?(?:access[_-]?)?key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    group: 1,
    severity: 'critical',
    minEntropy: 3.5,
    minLength: 40,
  },
  {
    rule: 'GitHub Personal Access Token',
    pattern: /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'GitHub OAuth Token',
    pattern: /\bgh[our]_[A-Za-z0-9]{36,}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'GitHub App Token',
    pattern: /\bghs_[A-Za-z0-9]{36,}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'Slack Token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'Slack Incoming Webhook',
    pattern:
      /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9]{16,}/g,
    group: 0,
    severity: 'high',
  },
  {
    rule: 'Stripe Live Secret Key',
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{10,}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    // Publishable by design, so not critical — but a live key in the repo still
    // identifies the production account and belongs in configuration.
    rule: 'Stripe Live Publishable Key',
    pattern: /\bpk_live_[A-Za-z0-9]{10,}\b/g,
    group: 0,
    severity: 'low',
  },
  {
    rule: 'Google API Key',
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    group: 0,
    severity: 'high',
  },
  {
    rule: 'Anthropic API Key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'OpenAI API Key',
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'Private Key Block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'SendGrid API Key',
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'Mailgun API Key',
    pattern: /\bkey-[0-9a-zA-Z]{32}\b/g,
    group: 0,
    severity: 'high',
  },
  {
    rule: 'npm Access Token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'PyPI Upload Token',
    pattern: /\bpypi-[A-Za-z0-9_-]{40,}\b/g,
    group: 0,
    severity: 'critical',
  },
  {
    rule: 'Twilio Auth Token',
    pattern: /twilio[_-]?(?:auth[_-]?)?token\s*[:=]\s*["']([0-9a-f]{32})["']/gi,
    group: 1,
    severity: 'critical',
  },
  {
    rule: 'Twilio API Key',
    pattern: /\bSK[0-9a-f]{32}\b/g,
    group: 0,
    severity: 'high',
  },
  {
    rule: 'Firebase Cloud Messaging Key',
    pattern: /\bAAAA[A-Za-z0-9_-]{7}:APA91b[A-Za-z0-9_-]{100,}\b/g,
    group: 0,
    severity: 'high',
  },
  {
    // Credentials embedded in a connection string. Group 1 is the password.
    rule: 'Database Connection String Credentials',
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|clickhouse):\/\/[^\s:/@'"]+:([^\s@'"]{3,})@[^\s'"]+/gi,
    group: 1,
    severity: 'critical',
  },
  {
    // Three base64url segments. Often a sample token, hence high rather than
    // critical — but a committed JWT is frequently a live session.
    rule: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    group: 0,
    severity: 'medium',
  },
  {
    rule: 'High-Entropy Secret Assignment',
    pattern:
      /\b(?:secret|token|password|passwd|apikey|api_key|access_key|private_key|auth_token|client_secret)\s*[:=]\s*["']([^"'\n]{16,})["']/gi,
    group: 1,
    severity: 'high',
    minEntropy: 3.6,
    minLength: 16,
  },
];

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'pdm.lock',
  'cargo.lock',
  'go.sum',
  'packages.lock.json',
  'mix.lock',
  'pubspec.lock',
]);

/** `.env.example`, `config.sample.yml`, `secrets.template.json`, `.env.defaults`. */
const TEMPLATE_SUFFIX =
  /(?:^|[.\-_])(example|examples|sample|samples|template|templates|dist|defaults?|tpl)(?:\.[a-z0-9]+)?$/i;

/**
 * Words that mean "fill this in yourself".
 *
 * Checked as substrings on the lowercased value, except `test`, which is checked
 * as a whole word — `test` appears inside plenty of legitimate random strings,
 * but a value whose *segments* include `test` is a fixture.
 */
const PLACEHOLDER_SUBSTRINGS: readonly string[] = [
  'your',
  'changeme',
  'change_me',
  'change-me',
  'example',
  'placeholder',
  'dummy',
  'insert_',
  'insert-',
  'replace',
  'redacted',
  'notreal',
  'fake',
  'sample',
  'todo',
  'xxxx',
  'process.env',
  'os.environ',
  'getenv',
  'secret_here',
  'key_here',
  'here>',
];

/** Interpolation and angle-bracket placeholders: `${API_KEY}`, `<your token>`, `{{ key }}`. */
const INTERPOLATION = /\$\{[^}]*\}|\{\{[^}]*\}\}|<[^>]{2,}>|%\([^)]*\)s/;

/** A value made of one repeated character, like `xxxxxxxxxxxxxxxx` or `----------------`. */
const SINGLE_CHARACTER_RUN = /^(.)\1+$/;

/** True when the whole file is a place where fake credentials legitimately live. */
function isSuppressedFile(path: string, content: string | null): boolean {
  const base = basename(path).toLowerCase();

  if (LOCKFILES.has(base)) return true;
  if (isVendored(path)) return true;
  if (isGeneratedFile(path, content)) return true;
  if (TEMPLATE_SUFFIX.test(base)) return true;
  // `.env.example` has no extension-style suffix on some layouts (`.env-example`).
  if (base.startsWith('.env') && /example|sample|template|default|dist/.test(base)) return true;

  return false;
}

/** True when the matched value is obviously a stand-in rather than a credential. */
export function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (SINGLE_CHARACTER_RUN.test(trimmed)) return true;
  if (INTERPOLATION.test(trimmed)) return true;

  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_SUBSTRINGS.some((word) => lower.includes(word))) return true;

  const segments = lower.split(/[^a-z0-9]+/).filter(Boolean);
  if (segments.includes('test') || segments.includes('demo') || segments.includes('mock')) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** Lines longer than this are minified bundles or data blobs, not hand-written code. */
const MAX_SCAN_LINE = 4000;

/** Payload cap; a repo with more than this has a wholesale credential problem. */
const MAX_FINDINGS = 200;

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Scan every text file for committed credentials. */
/**
 * Severity ladder, one rung down.
 *
 * A credential-shaped string in a test file is reported, but not at full
 * severity. Test suites are full of deliberately fake keys — a security
 * scanner's own fixtures are the extreme case — and ranking those alongside a
 * live production key trains people to ignore the whole report.
 *
 * It is deliberately a downgrade rather than a suppression: a real key
 * committed to a test file is still a leaked key, and still has to be visible.
 */
const SEVERITY_LADDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function downgrade(severity: Severity): Severity {
  const index = SEVERITY_LADDER.indexOf(severity);
  if (index === -1) return severity;
  return SEVERITY_LADDER[Math.min(index + 1, SEVERITY_LADDER.length - 1)] ?? severity;
}

export function scanSecrets(snapshot: RepoSnapshot): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const file of snapshot.files) {
    if (file.isBinary || file.content === null) continue;
    if (isSuppressedFile(file.path, file.content)) continue;

    const lines = file.content.split(/\r?\n/);

    lines.forEach((line, offset) => {
      if (line.length === 0 || line.length > MAX_SCAN_LINE) return;

      for (const rule of RULES) {
        for (const match of line.matchAll(rule.pattern)) {
          const value = (rule.group === 0 ? match[0] : match[rule.group]) ?? '';
          if (value === '') continue;
          if (rule.minLength !== undefined && value.length < rule.minLength) continue;
          if (isPlaceholderValue(value)) continue;

          // One value, one finding: the first (most specific) rule wins.
          const identity = `${file.path}:${offset + 1}:${value}`;
          if (seen.has(identity)) continue;

          let entropy: number | undefined;
          if (rule.minEntropy !== undefined) {
            entropy = Math.round(shannonEntropy(value) * 100) / 100;
            if (entropy < rule.minEntropy) continue;
          }

          seen.add(identity);
          findings.push({
            id: `secret-${hashString(`${rule.rule}:${identity}`)}`,
            rule: isTestFile(file.path) ? `${rule.rule} (test fixture)` : rule.rule,
            file: file.path,
            line: offset + 1,
            preview: redact(value),
            severity: isTestFile(file.path) ? downgrade(rule.severity) : rule.severity,
            ...(entropy === undefined ? {} : { entropy }),
          });
        }
      }
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line,
  );

  return findings.slice(0, MAX_FINDINGS);
}
