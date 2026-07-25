/**
 * Composed security report: secrets, environment hygiene, dangerous sinks,
 * oversized blobs and flagged dependencies, reduced to one score.
 *
 * The sink scanner is the interesting part. `eval(` is trivial to grep for and
 * that is exactly why grep produces garbage: the string `"don't use eval("` in a
 * lint rule, the word in a comment, the identifier in a test fixture. So sinks
 * are matched against the *masked* source from `metrics/complexity` — comments
 * and string interiors blanked — for every rule whose evidence is code.
 *
 * Three rules are the exception and run against raw lines, because their whole
 * signature lives inside a string literal: SQL assembled by concatenation, a
 * shell command built by interpolation, and a permissive CORS header value.
 * Those are guarded by requiring the same line to contain some real code, which
 * excludes pure-comment lines.
 *
 * Every risk cites `file:line` so a reader can verify the claim, and carries a
 * CWE or OWASP reference where one genuinely applies rather than as decoration.
 */

import type {
  DependencyReport,
  LargeFile,
  RepoFile,
  RepoSnapshot,
  SecretFinding,
  SecurityReport,
  SecurityRisk,
  Severity,
} from '../types';
import { isCountableSource } from '../shared/classify';
import { basename } from '../shared/paths';
import { clamp, toLines } from '../shared/text';
import { maskSource } from '../metrics/complexity';
import { scanSecrets } from './secrets';
import { analyzeEnvVars } from './env';

export { scanSecrets } from './secrets';
export { analyzeEnvVars } from './env';

/** Files above this size bloat clones and usually mean a binary was committed. */
const LARGE_FILE_BYTES = 1_048_576;
const MAX_LARGE_FILES = 25;

/** Citations per risk. Enough to act on, short enough to read. */
const MAX_CITED_FILES = 10;

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

// ---------------------------------------------------------------------------
// Dangerous sinks
// ---------------------------------------------------------------------------

interface SinkRule {
  readonly id: string;
  readonly title: string;
  readonly pattern: RegExp;
  readonly severity: Severity;
  readonly detail: string;
  readonly recommendation: string;
  readonly reference?: string;
  /**
   * `code` matches the masked source (comments and strings blanked).
   * `raw` matches the original line, and is only used where the evidence is
   * itself inside a string literal.
   */
  readonly scope: 'code' | 'raw';
  /** Optional veto: a line matching this is not a finding. */
  readonly unless?: RegExp;
}

const SINKS: readonly SinkRule[] = [
  {
    id: 'eval',
    title: 'Dynamic code execution via eval()',
    pattern: /\beval\s*\(/g,
    severity: 'high',
    scope: 'code',
    detail: 'Anything reaching this call site becomes executable code.',
    recommendation:
      'Replace eval() with an explicit parser, a lookup table, or JSON.parse for data. If dynamic behaviour is genuinely required, move it behind a whitelist of permitted operations.',
    reference: 'CWE-95: Eval Injection',
  },
  {
    id: 'new-function',
    title: 'Dynamic code execution via new Function()',
    pattern: /\bnew\s+Function\s*\(/g,
    severity: 'high',
    scope: 'code',
    detail: 'The Function constructor compiles its arguments, so it is eval() under another name.',
    recommendation:
      'Build the behaviour statically. If a template engine needs it, use one that compiles ahead of time rather than at request time.',
    reference: 'CWE-95: Eval Injection',
  },
  {
    id: 'dangerously-set-inner-html',
    title: 'Unescaped HTML injected into the DOM',
    pattern: /\bdangerouslySetInnerHTML\b/g,
    severity: 'medium',
    scope: 'code',
    detail: 'React deliberately makes this hard to type; it bypasses all escaping.',
    recommendation:
      'Render the value as text, or sanitize it with a maintained sanitizer (DOMPurify) immediately before it is set.',
    reference: 'CWE-79: Cross-site Scripting',
  },
  {
    id: 'inner-html',
    title: 'Assignment to innerHTML / outerHTML',
    pattern: /\.(?:inner|outer)HTML\s*=/g,
    severity: 'medium',
    scope: 'code',
    detail: 'Any attacker-controlled substring in the assigned value becomes markup.',
    recommendation: 'Use textContent for text, or createElement/append for structure.',
    reference: 'CWE-79: Cross-site Scripting',
  },
  {
    id: 'shell-interpolation',
    title: 'Shell command assembled by string interpolation',
    pattern:
      /\b(?:exec|execSync|spawnSync|popen|system)\s*\(\s*(?:[`"'][^`"']*\$\{|[`"'][^`"']*["']\s*\+)/g,
    severity: 'high',
    scope: 'raw',
    detail: 'A value spliced into a shell string can close the quote and append another command.',
    recommendation:
      'Use the argument-array form (execFile, spawn with an args array, subprocess.run([...]) ) so the shell never parses user input.',
    reference: 'CWE-78: OS Command Injection',
  },
  {
    id: 'python-shell',
    title: 'Shell invoked from Python',
    pattern: /\bos\.system\s*\(|\bsubprocess\.[A-Za-z_]+\([^)]*shell\s*=\s*True/g,
    severity: 'high',
    scope: 'code',
    detail: 'shell=True hands the whole command line to /bin/sh.',
    recommendation: 'Pass a list of arguments and leave shell at its default False.',
    reference: 'CWE-78: OS Command Injection',
  },
  {
    id: 'pickle',
    title: 'Untrusted deserialization via pickle',
    pattern: /\bpickle\.loads?\s*\(|\bcPickle\.loads?\s*\(/g,
    severity: 'high',
    scope: 'code',
    detail: 'Unpickling executes arbitrary constructors; it is remote code execution by design.',
    recommendation:
      'Use JSON or another data-only format for anything crossing a trust boundary. Reserve pickle for data your own process wrote.',
    reference: 'CWE-502: Deserialization of Untrusted Data',
  },
  {
    id: 'yaml-load',
    title: 'yaml.load() without a safe loader',
    pattern: /\byaml\.load\s*\(/g,
    unless: /SafeLoader|BaseLoader|CSafeLoader|safe_load/,
    severity: 'high',
    scope: 'code',
    detail: 'The default loader instantiates arbitrary Python objects named in the document.',
    recommendation: 'Call yaml.safe_load(), or pass Loader=yaml.SafeLoader explicitly.',
    reference: 'CWE-502: Deserialization of Untrusted Data',
  },
  {
    id: 'sql-concat',
    title: 'SQL built by string concatenation or interpolation',
    pattern:
      /(?:["'`][^"'`]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"'`]*["'`]\s*[+.]|`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|f["'][^"']*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{|%\s*\([^)]*\)s?[^;]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b)/gi,
    severity: 'high',
    scope: 'raw',
    detail: 'A query assembled from strings cannot distinguish data from syntax.',
    recommendation:
      'Use parameterized queries or the query builder your driver provides. Never interpolate a value into SQL, not even one you believe is an integer.',
    reference: 'CWE-89: SQL Injection',
  },
  {
    id: 'weak-password-hash',
    title: 'Password hashed with MD5 or SHA-1',
    pattern:
      /\b(?:md5|sha1|sha-1)\b[^\n]{0,80}\b(?:password|passwd|pwd|secret|credential)\b|\b(?:password|passwd|pwd|secret|credential)\b[^\n]{0,80}\b(?:md5|sha1|sha-1)\b/gi,
    severity: 'high',
    scope: 'code',
    detail: 'Both are fast and unsalted by default, so a stolen table is brute-forced in hours.',
    recommendation:
      'Use bcrypt, scrypt or Argon2id with a per-password salt and a tuned work factor.',
    reference: 'CWE-327: Use of a Broken Cryptographic Algorithm',
  },
  {
    id: 'tls-verification-disabled',
    title: 'TLS certificate verification disabled',
    pattern:
      /\bverify\s*=\s*False\b|\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\b|\bInsecureSkipVerify\s*:\s*true\b|\bcurl\s+[^\n]*(?:-k\b|--insecure\b)/g,
    severity: 'high',
    scope: 'code',
    detail: 'Disabling verification makes the connection trivially interceptable.',
    recommendation:
      'Trust the correct CA bundle instead. For self-signed certificates in development, add the CA to the trust store rather than turning verification off.',
    reference: 'CWE-295: Improper Certificate Validation',
  },
];

interface SinkHit {
  readonly file: string;
  readonly line: number;
}

/**
 * Non-global copies of every sink pattern, compiled once.
 *
 * `RegExp.test` on a `/g` regex advances `lastIndex`, so reusing the declared
 * patterns across lines would silently skip matches on every other line.
 */
const SINK_MATCHERS: ReadonlyMap<string, RegExp> = new Map(
  SINKS.map((rule) => [
    rule.id,
    new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')),
  ]),
);

/** Scan source files for every sink rule, returning hits keyed by rule id. */
function scanSinks(snapshot: RepoSnapshot): Map<string, SinkHit[]> {
  const hits = new Map<string, SinkHit[]>();

  for (const file of snapshot.files) {
    if (file.isBinary || file.content === null) continue;
    if (!isCountableSource(file.path, file.content)) continue;

    const raw = toLines(file.content);
    const { code } = maskSource(file.content, file.path);

    for (const rule of SINKS) {
      const source = rule.scope === 'code' ? code : raw;
      const matcher = SINK_MATCHERS.get(rule.id);
      if (!matcher) continue;

      source.forEach((line, offset) => {
        if (line.length === 0 || line.length > 4000) return;
        // Raw-scope rules must still ignore comment-only lines.
        if (rule.scope === 'raw' && (code[offset] ?? '').trim() === '') return;
        if (rule.unless?.test(line)) return;
        if (!matcher.test(line)) return;

        const bucket = hits.get(rule.id);
        if (bucket) bucket.push({ file: file.path, line: offset + 1 });
        else hits.set(rule.id, [{ file: file.path, line: offset + 1 }]);
      });
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Environment-file hygiene
// ---------------------------------------------------------------------------

/** `.env`, `.env.local`, `.env.production` — real secrets, never templates. */
function isRealEnvFile(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (!base.startsWith('.env')) return false;
  return !/example|sample|template|default|dist/.test(base);
}

/** True when a `.gitignore` anywhere in the repo excludes env files. */
function gitignoreCoversEnv(snapshot: RepoSnapshot): { present: boolean; covered: boolean } {
  const ignores = snapshot.files.filter(
    (file) => basename(file.path) === '.gitignore' && file.content !== null,
  );
  if (ignores.length === 0) return { present: false, covered: false };

  const covered = ignores.some((file) =>
    toLines(file.content ?? '').some((line) => {
      const rule = line.trim();
      if (rule === '' || rule.startsWith('#')) return false;
      return /^!?\.?\/?\.env(\*|\.\*)?$/.test(rule) || rule === '*.env' || rule === '.env*';
    }),
  );

  return { present: true, covered };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Security score, 0–100, where 100 means nothing was found.
 *
 * The model is a flat deduction per risk, weighted by severity:
 *
 * | Severity | Deduction |
 * |----------|-----------|
 * | critical | 30        |
 * | high     | 15        |
 * | medium   | 6         |
 * | low      | 2         |
 * | info     | 0         |
 *
 * Plus 3 points per committed secret beyond the first, capped at 20 — because
 * fifty leaked keys is a categorically worse situation than one, and the risk
 * list collapses them into a single entry.
 *
 * Weights are chosen so that a single critical finding cannot be averaged away
 * (one committed AWS key drops a repository to 70 on its own) while a handful of
 * medium-severity code smells still leaves the score in a readable band.
 */
const DEDUCTIONS: Readonly<Record<Severity, number>> = {
  critical: 30,
  high: 15,
  medium: 6,
  low: 2,
  info: 0,
};

/** Compose the full security picture for a snapshot. */
export function analyzeSecurity(snapshot: RepoSnapshot, deps: DependencyReport): SecurityReport {
  const secrets = scanSecrets(snapshot);
  const { envVars, undocumented } = analyzeEnvVars(snapshot);
  const largeFiles = collectLargeFiles(snapshot.files);
  const risks = buildRisks(snapshot, deps, secrets, undocumented);

  const deducted =
    risks.reduce((sum, risk) => sum + DEDUCTIONS[risk.severity], 0) +
    Math.min(20, Math.max(0, secrets.length - 1) * 3);

  return {
    secrets,
    envVars,
    undocumentedEnvVars: undocumented,
    largeFiles,
    flaggedDependencies: deps.flagged,
    risks,
    score: Math.round(clamp(100 - deducted, 0, 100)),
  };
}

function collectLargeFiles(files: readonly RepoFile[]): LargeFile[] {
  return files
    .filter((file) => file.size > LARGE_FILE_BYTES)
    .map((file) => ({ path: file.path, size: file.size }))
    .sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1))
    .slice(0, MAX_LARGE_FILES);
}

function buildRisks(
  snapshot: RepoSnapshot,
  deps: DependencyReport,
  secrets: readonly SecretFinding[],
  undocumented: readonly string[],
): SecurityRisk[] {
  const risks: SecurityRisk[] = [];

  // --- committed environment files ---
  const envFiles = snapshot.files.filter((file) => isRealEnvFile(file.path));
  if (envFiles.length > 0) {
    risks.push({
      id: 'risk-committed-env-file',
      title: `${envFiles.length} environment file${envFiles.length === 1 ? '' : 's'} committed to the repository`,
      detail:
        `${envFiles.map((file) => file.path).join(', ')} ${envFiles.length === 1 ? 'is' : 'are'} tracked in version control. ` +
        `Environment files hold live credentials by convention, and git history keeps them after deletion.`,
      severity: 'critical',
      files: envFiles.map((file) => file.path).slice(0, MAX_CITED_FILES),
      recommendation:
        'Remove the file from the working tree, add it to .gitignore, purge it from history (git filter-repo or BFG), and rotate every credential it contained.',
      reference: 'CWE-540: Inclusion of Sensitive Information in Source Code',
    });
  }

  const gitignore = gitignoreCoversEnv(snapshot);
  if (!gitignore.covered) {
    risks.push({
      id: 'risk-gitignore-env',
      title: gitignore.present
        ? '.gitignore does not exclude .env files'
        : 'Repository has no .gitignore',
      detail: gitignore.present
        ? 'No .gitignore rule matches `.env`, so the next developer to create one will commit it by accident.'
        : 'Without a .gitignore, build output, local environment files and editor state are all one `git add .` away from being committed.',
      severity: 'medium',
      files: [],
      recommendation: 'Add `.env` and `.env.*` (with a `!.env.example` exception) to .gitignore.',
      reference: 'CWE-540: Inclusion of Sensitive Information in Source Code',
    });
  }

  // --- hardcoded secrets ---
  if (secrets.length > 0) {
    const worst = secrets.reduce<Severity>(
      (max, finding) =>
        SEVERITY_RANK[finding.severity] > SEVERITY_RANK[max] ? finding.severity : max,
      'low',
    );
    const rules = [...new Set(secrets.map((finding) => finding.rule))];

    risks.push({
      id: 'risk-hardcoded-secrets',
      title: `${secrets.length} hardcoded credential${secrets.length === 1 ? '' : 's'} in source`,
      detail:
        `Rules triggered: ${rules.slice(0, 6).join(', ')}. First occurrences: ` +
        `${secrets
          .slice(0, 5)
          .map((finding) => `${finding.file}:${finding.line} (${finding.rule}, ${finding.preview})`)
          .join('; ')}.`,
      severity: worst,
      files: [...new Set(secrets.map((finding) => finding.file))].slice(0, MAX_CITED_FILES),
      recommendation:
        'Rotate every credential listed — assume each is compromised — then load them from the environment or a secret manager and scrub them from git history.',
      reference: 'CWE-798: Use of Hard-coded Credentials',
    });
  }

  // --- dangerous sinks ---
  const hits = scanSinks(snapshot);
  for (const rule of SINKS) {
    const found = hits.get(rule.id);
    if (!found || found.length === 0) continue;

    risks.push({
      id: `risk-sink-${rule.id}`,
      title: rule.title,
      detail:
        `${found.length} occurrence${found.length === 1 ? '' : 's'}: ` +
        `${found
          .slice(0, 5)
          .map((hit) => `${hit.file}:${hit.line}`)
          .join(', ')}. ${rule.detail}`,
      severity: rule.severity,
      files: [...new Set(found.map((hit) => hit.file))].slice(0, MAX_CITED_FILES),
      recommendation: rule.recommendation,
      ...(rule.reference === undefined ? {} : { reference: rule.reference }),
    });
  }

  // --- permissive CORS ---
  const cors = permissiveCorsFiles(snapshot);
  if (cors.length > 0) {
    risks.push({
      id: 'risk-permissive-cors',
      title: 'Wildcard CORS origin combined with credentials',
      detail:
        `${cors.join(', ')} allow${cors.length === 1 ? 's' : ''} any origin while also allowing credentials. ` +
        `Browsers reject that combination, so in practice it means either the policy is broken or the origin is reflected back, which is worse.`,
      severity: 'high',
      files: cors.slice(0, MAX_CITED_FILES),
      recommendation:
        'Replace the wildcard with an explicit allow-list of origins, and only enable credentials for origins you control.',
      reference: 'CWE-942: Permissive Cross-domain Policy with Untrusted Domains',
    });
  }

  // --- dependencies ---
  if (deps.flagged.length > 0) {
    const worst = deps.flagged.reduce<Severity>(
      (max, flag) => (SEVERITY_RANK[flag.severity] > SEVERITY_RANK[max] ? flag.severity : max),
      'low',
    );
    risks.push({
      id: 'risk-flagged-dependencies',
      title: `${deps.flagged.length} dependenc${deps.flagged.length === 1 ? 'y is' : 'ies are'} deprecated or known-unsafe`,
      detail: deps.flagged
        .slice(0, 8)
        .map((flag) => `${flag.name}: ${flag.reason}`)
        .join('; '),
      severity: worst,
      files: deps.manifests.slice(0, MAX_CITED_FILES),
      recommendation:
        'Replace each flagged package with its maintained successor, or pin and vendor it if no successor exists and removal is not yet possible.',
      reference: 'OWASP A06:2021 – Vulnerable and Outdated Components',
    });
  }

  // --- informational ---
  if (undocumented.length > 0) {
    risks.push({
      id: 'risk-undocumented-env',
      title: `${undocumented.length} environment variable${undocumented.length === 1 ? ' is' : 's are'} referenced but undocumented`,
      detail:
        `${undocumented.slice(0, 12).join(', ')} ${undocumented.length === 1 ? 'is' : 'are'} read by the code but appear in no ` +
        `.env.example, README or Compose file. Undocumented configuration is how production ends up running with a default nobody chose.`,
      severity: 'info',
      files: [],
      recommendation:
        'Add every referenced variable to a committed .env.example with a comment describing its purpose and whether it is required.',
    });
  }

  risks.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return risks;
}

const CORS_WILDCARD = /Access-Control-Allow-Origin["'\s:=]+["']?\*|origin\s*:\s*["']\*["']/i;
const CORS_CREDENTIALS =
  /Access-Control-Allow-Credentials["'\s:=]+["']?true|credentials\s*:\s*true/i;

/** Files that both allow any origin and allow credentials. */
function permissiveCorsFiles(snapshot: RepoSnapshot): string[] {
  const found: string[] = [];

  for (const file of snapshot.files) {
    if (file.isBinary || file.content === null) continue;
    if (!isCountableSource(file.path, file.content)) continue;
    if (CORS_WILDCARD.test(file.content) && CORS_CREDENTIALS.test(file.content)) {
      found.push(file.path);
    }
  }

  return found.sort();
}
