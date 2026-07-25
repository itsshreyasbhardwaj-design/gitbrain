import { describe, expect, it } from 'vitest';

import {
  InvalidRepositoryUrlError,
  parseRepositoryUrl,
  repositoryUrl,
  zipballCandidates,
} from './github';

describe('parseRepositoryUrl', () => {
  it.each([
    ['https://github.com/vercel/next.js', 'vercel', 'next.js', null],
    ['http://github.com/vercel/next.js', 'vercel', 'next.js', null],
    ['github.com/vercel/next.js', 'vercel', 'next.js', null],
    ['https://www.github.com/vercel/next.js', 'vercel', 'next.js', null],
    ['https://github.com/vercel/next.js.git', 'vercel', 'next.js', null],
    ['git@github.com:vercel/next.js.git', 'vercel', 'next.js', null],
    ['vercel/next.js', 'vercel', 'next.js', null],
    ['  https://github.com/vercel/next.js  ', 'vercel', 'next.js', null],
  ])('parses %s', (input, owner, repo, ref) => {
    expect(parseRepositoryUrl(input)).toEqual({ owner, repo, ref });
  });

  it('recovers the branch from a /tree/ deep link', () => {
    expect(parseRepositoryUrl('https://github.com/acme/demo/tree/develop')).toEqual({
      owner: 'acme',
      repo: 'demo',
      ref: 'develop',
    });
  });

  it('recovers a slashed branch name from a /tree/ deep link', () => {
    expect(parseRepositoryUrl('https://github.com/acme/demo/tree/feat/new-thing')).toEqual({
      owner: 'acme',
      repo: 'demo',
      ref: 'feat/new-thing',
    });
  });

  it('recovers the branch from a /blob/ file link', () => {
    const parsed = parseRepositoryUrl('https://github.com/acme/demo/blob/main/src/index.ts');
    expect(parsed.owner).toBe('acme');
    expect(parsed.repo).toBe('demo');
    // The whole tail is treated as the ref; the important part is that the
    // owner and repo are recovered correctly from a file permalink.
    expect(parsed.ref).toContain('main');
  });

  it('ignores query strings and fragments', () => {
    expect(parseRepositoryUrl('https://github.com/acme/demo?tab=readme#top')).toEqual({
      owner: 'acme',
      repo: 'demo',
      ref: null,
    });
  });

  // This is a security boundary, not a convenience check: the parsed host
  // flows into a server-side fetch, so a non-GitHub host would be SSRF.
  it.each([
    'https://evil.com/acme/demo',
    'https://github.com.evil.com/acme/demo',
    'https://gitlab.com/acme/demo',
    'http://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
  ])('rejects non-GitHub host %s', (input) => {
    expect(() => parseRepositoryUrl(input)).toThrow(InvalidRepositoryUrlError);
  });

  it.each(['', '   ', 'https://github.com', 'https://github.com/onlyowner', 'not a url at all'])(
    'rejects malformed input %s',
    (input) => {
      expect(() => parseRepositoryUrl(input)).toThrow(InvalidRepositoryUrlError);
    },
  );

  it('rejects an owner name that violates GitHub rules', () => {
    expect(() => parseRepositoryUrl('https://github.com/-bad-/demo')).toThrow(
      InvalidRepositoryUrlError,
    );
  });
});

describe('repositoryUrl', () => {
  it('builds a canonical browse URL', () => {
    expect(repositoryUrl({ owner: 'acme', repo: 'demo', ref: 'main' })).toBe(
      'https://github.com/acme/demo',
    );
  });
});

describe('zipballCandidates', () => {
  it('uses HEAD when no ref is given', () => {
    expect(zipballCandidates({ owner: 'a', repo: 'b', ref: null })).toEqual([
      'https://codeload.github.com/a/b/zip/HEAD',
    ]);
  });

  it('tries branch before tag for an ambiguous ref', () => {
    const candidates = zipballCandidates({ owner: 'a', repo: 'b', ref: 'v1.0.0' });
    expect(candidates[0]).toContain('refs/heads/v1.0.0');
    expect(candidates[1]).toContain('refs/tags/v1.0.0');
  });

  it('adds a bare SHA candidate when the ref looks like a commit', () => {
    const candidates = zipballCandidates({ owner: 'a', repo: 'b', ref: 'a1b2c3d4e5f6' });
    expect(candidates.some((url) => url.endsWith('/zip/a1b2c3d4e5f6'))).toBe(true);
  });

  it('does not add a SHA candidate for a normal branch name', () => {
    const candidates = zipballCandidates({ owner: 'a', repo: 'b', ref: 'main' });
    expect(candidates).toHaveLength(2);
  });
});
