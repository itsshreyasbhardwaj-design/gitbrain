/**
 * GitHub repository resolution.
 *
 * GitBrain deliberately does NOT shell out to `git clone`. Fetching the
 * zipball instead means:
 *   - no git binary, no temp directories, no filesystem at all
 *   - it runs unchanged on Vercel, in an edge runtime, or in a test
 *   - one archive code path serves both "paste a URL" and "upload a ZIP"
 *   - we transfer one compressed snapshot instead of the full object history
 *
 * The cost is losing commit history, which the current feature set does not use.
 */

/** A repository coordinate parsed from user input. */
export interface GitHubRef {
  readonly owner: string;
  readonly repo: string;
  /** `null` means "whatever the default branch is". */
  readonly ref: string | null;
}

/** GitHub's own limits: 39 chars for owners, 100 for repos. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** Refs may not contain path traversal, spaces, or control characters. */
const REF_PATTERN = /^[A-Za-z0-9._\-/]{1,255}$/;

export class InvalidRepositoryUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRepositoryUrlError';
  }
}

/**
 * Parse the many shapes users actually paste.
 *
 * Accepts `owner/repo`, full https URLs, `.git` suffixes, `git@` SSH form, and
 * deep links like `/tree/<branch>` or `/blob/<branch>/path`, from which the
 * branch is recovered.
 *
 * Rejects anything that is not github.com. This is a hard security boundary:
 * the value flows into a server-side fetch, so allowing arbitrary hosts would
 * turn the analyze endpoint into an SSRF primitive.
 */
export function parseRepositoryUrl(input: string): GitHubRef {
  const trimmed = input.trim();
  if (!trimmed) throw new InvalidRepositoryUrlError('Enter a repository URL.');

  let path: string;

  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed)) {
    // Bare `owner/repo` shorthand.
    path = trimmed;
  } else {
    const sshMatch = /^git@github\.com:(.+)$/.exec(trimmed);
    if (sshMatch?.[1]) {
      path = sshMatch[1];
    } else {
      let url: URL;
      try {
        url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
      } catch {
        throw new InvalidRepositoryUrlError('That does not look like a valid URL.');
      }

      const host = url.hostname.toLowerCase();
      if (host !== 'github.com' && host !== 'www.github.com') {
        throw new InvalidRepositoryUrlError(
          'Only github.com repositories are supported. Upload a ZIP for anything else.',
        );
      }
      path = url.pathname;
    }
  }

  const segments = path
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  const owner = segments[0];
  const repo = segments[1];

  if (!owner || !repo) {
    throw new InvalidRepositoryUrlError('Expected a URL like https://github.com/owner/repo.');
  }
  if (!OWNER_PATTERN.test(owner)) {
    throw new InvalidRepositoryUrlError(`"${owner}" is not a valid GitHub owner name.`);
  }
  if (!REPO_PATTERN.test(repo)) {
    throw new InvalidRepositoryUrlError(`"${repo}" is not a valid GitHub repository name.`);
  }

  // `/tree/<ref>/...` and `/blob/<ref>/...` carry the branch we should analyze.
  let ref: string | null = null;
  if ((segments[2] === 'tree' || segments[2] === 'blob') && segments[3]) {
    const candidate = segments.slice(3).join('/');
    ref = REF_PATTERN.test(candidate) ? candidate : null;
  }

  return { owner, repo, ref };
}

/** Canonical browse URL for a parsed reference. */
export function repositoryUrl(ref: GitHubRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}`;
}

/**
 * Archive endpoints to try, in order.
 *
 * `codeload` serves zipballs without consuming the API rate limit, but unlike
 * the API's `/zipball/{ref}` it will not resolve an ambiguous ref for us — the
 * caller must say whether `v1.2.0` is a branch, a tag or a SHA. Rather than
 * spend an API call to find out, we try each shape and take the first hit.
 *
 * With no explicit ref, `HEAD` resolves to the default branch in one request.
 */
export function zipballCandidates(ref: GitHubRef): string[] {
  const base = `https://codeload.github.com/${ref.owner}/${ref.repo}/zip`;
  if (!ref.ref) return [`${base}/HEAD`];

  const candidates = [`${base}/refs/heads/${ref.ref}`, `${base}/refs/tags/${ref.ref}`];

  // A full or abbreviated commit SHA is passed through verbatim.
  if (/^[0-9a-f]{7,40}$/i.test(ref.ref)) candidates.push(`${base}/${ref.ref}`);

  return candidates;
}

/** Public metadata endpoint, used to resolve the default branch and size. */
export function apiUrl(ref: GitHubRef): string {
  return `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
}

export interface RepositoryMetadata {
  readonly defaultBranch: string;
  readonly description: string | null;
  readonly stars: number;
  /** Repository size in kilobytes, as reported by GitHub. */
  readonly sizeKb: number;
  readonly isPrivate: boolean;
  readonly license: string | null;
  readonly topics: readonly string[];
  readonly pushedAt: string | null;
}

export class RepositoryFetchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RepositoryFetchError';
    this.status = status;
  }
}

interface GitHubApiRepo {
  default_branch?: unknown;
  description?: unknown;
  stargazers_count?: unknown;
  size?: unknown;
  private?: unknown;
  license?: { spdx_id?: unknown } | null;
  topics?: unknown;
  pushed_at?: unknown;
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * Fetch public repository metadata.
 *
 * Unauthenticated requests are rate-limited to 60/hour per IP by GitHub. A
 * `GITHUB_TOKEN` raises that to 5000/hour and is used when present, but is
 * never required — GitBrain must work with zero configuration.
 */
export async function fetchRepositoryMetadata(
  ref: GitHubRef,
  options: { readonly token?: string | undefined; readonly signal?: AbortSignal } = {},
): Promise<RepositoryMetadata> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'GitBrain',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(apiUrl(ref), {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 404) {
    throw new RepositoryFetchError(
      `Repository ${ref.owner}/${ref.repo} was not found, or it is private.`,
      404,
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new RepositoryFetchError(
      'GitHub rate limit reached. Set GITHUB_TOKEN to raise the limit, or try again shortly.',
      429,
    );
  }
  if (!response.ok) {
    throw new RepositoryFetchError(`GitHub returned ${response.status}.`, response.status);
  }

  const body = (await response.json()) as GitHubApiRepo;

  return {
    defaultBranch: asString(body.default_branch) ?? 'main',
    description: asString(body.description),
    stars: asNumber(body.stargazers_count),
    sizeKb: asNumber(body.size),
    isPrivate: body.private === true,
    license: asString(body.license?.spdx_id),
    topics: Array.isArray(body.topics)
      ? body.topics.filter((t): t is string => typeof t === 'string')
      : [],
    pushedAt: asString(body.pushed_at),
  };
}

/**
 * Download the repository zipball.
 *
 * `maxBytes` is enforced twice: once against the advertised `Content-Length`
 * so an oversized repo fails immediately, and again while streaming, because
 * `Content-Length` is advisory and a hostile or misconfigured server can omit
 * or understate it.
 */
export async function fetchZipball(
  ref: GitHubRef,
  options: {
    readonly maxBytes: number;
    readonly token?: string | undefined;
    readonly signal?: AbortSignal;
  },
): Promise<Uint8Array> {
  const headers: Record<string, string> = { 'User-Agent': 'GitBrain' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const candidates = zipballCandidates(ref);
  let response: Response | null = null;

  for (const url of candidates) {
    const attempt = await fetch(url, {
      headers,
      redirect: 'follow',
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (attempt.ok) {
      response = attempt;
      break;
    }

    // Drain the body so the connection can be reused for the next candidate.
    await attempt.body?.cancel();

    // Anything other than "no such ref" is a real failure worth surfacing now.
    if (attempt.status !== 404) {
      throw new RepositoryFetchError(
        `Could not download the repository (${attempt.status}).`,
        attempt.status,
      );
    }
  }

  if (!response) {
    throw new RepositoryFetchError(
      ref.ref
        ? `No branch, tag or commit named "${ref.ref}" exists in ${ref.owner}/${ref.repo}.`
        : `Repository ${ref.owner}/${ref.repo} was not found, or it is private.`,
      404,
    );
  }

  const advertised = Number(response.headers.get('content-length') ?? '0');
  if (advertised > options.maxBytes) {
    throw new RepositoryFetchError(
      `That repository is ${formatMb(advertised)} compressed, over the ${formatMb(options.maxBytes)} limit.`,
      413,
    );
  }

  const body = response.body;
  if (!body) throw new RepositoryFetchError('GitHub returned an empty response.', 502);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    received += value.length;
    if (received > options.maxBytes) {
      await reader.cancel();
      throw new RepositoryFetchError(
        `That repository exceeds the ${formatMb(options.maxBytes)} download limit.`,
        413,
      );
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(0)} MB`;
}
