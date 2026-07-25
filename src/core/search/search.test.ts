import { describe, expect, it } from 'vitest';

import { makeSnapshot } from '../testing/fixtures';
import { buildSearchIndex, extractSymbols, groupHitsByFile, search } from './index';

const AUTH_SOURCE = `
import { sign, verify } from 'jsonwebtoken';

/** Issue a signed session token for a user. */
export function createSessionToken(userId: string): string {
  return sign({ sub: userId }, process.env.JWT_SECRET as string, { expiresIn: '7d' });
}

export function verifySessionToken(token: string): string | null {
  try {
    const payload = verify(token, process.env.JWT_SECRET as string);
    return typeof payload === 'object' && payload.sub ? String(payload.sub) : null;
  } catch {
    return null;
  }
}
`;

const BILLING_SOURCE = `
import Stripe from 'stripe';

export class BillingService {
  async createCheckoutSession(customerId: string, priceId: string) {
    return this.stripe.checkout.sessions.create({ customer: customerId, line_items: [{ price: priceId }] });
  }
}
`;

const UNRELATED_SOURCE = `
export function formatBytes(value: number): string {
  return value > 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B';
}
`;

const snapshot = makeSnapshot({
  'src/auth/session.ts': AUTH_SOURCE,
  'src/billing/service.ts': BILLING_SOURCE,
  'src/utils/format.ts': UNRELATED_SOURCE,
  'README.md': '# Demo\n\nA demo project with authentication and billing.\n',
});

const index = buildSearchIndex(snapshot);

describe('buildSearchIndex', () => {
  it('indexes every source and documentation file', () => {
    const files = new Set(index.documents.map((doc) => doc.file));
    expect(files).toContain('src/auth/session.ts');
    expect(files).toContain('README.md');
  });

  it('records line ranges that map back to the real file', () => {
    const doc = index.documents.find((d) => d.file === 'src/auth/session.ts');
    expect(doc?.startLine).toBe(1);
    expect(doc?.endLine).toBeGreaterThan(1);
  });

  it('produces a non-empty postings list', () => {
    expect(Object.keys(index.postings).length).toBeGreaterThan(10);
  });

  it('is serializable, so it can travel with the analysis', () => {
    expect(() => JSON.parse(JSON.stringify(index))).not.toThrow();
  });

  it('handles an empty repository without throwing', () => {
    const empty = buildSearchIndex(makeSnapshot({}));
    expect(empty.totalDocuments).toBe(0);
    expect(search(empty, 'anything')).toEqual([]);
  });

  // Regression: these identifiers resolve to inherited Object.prototype members
  // on a plain object, so `postings[term] ??= []` used to see a function and
  // never assign an array, throwing "postings[term].push is not a function" on
  // any real-world repository that used them.
  it('indexes identifiers that collide with Object.prototype', () => {
    const source = `
      export class Thing {
        constructor(private valueOf: string) {}
        toString() { return this.valueOf; }
        hasOwnProperty(key: string) { return key in this; }
      }
      const proto = { __proto__: null, constructor: 1, toString: 2, valueOf: 3 };
    `;

    expect(() => buildSearchIndex(makeSnapshot({ 'src/thing.ts': source }))).not.toThrow();
  });

  it('searches for a prototype-colliding term without throwing', () => {
    const built = buildSearchIndex(
      makeSnapshot({ 'src/thing.ts': 'export function constructor() { return 1; }' }),
    );

    for (const term of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(() => search(built, term), term).not.toThrow();
    }
  });

  it('survives a round trip through JSON, as the durable store performs', () => {
    const built = buildSearchIndex(makeSnapshot({ 'src/a.ts': 'export const authToken = 1;' }));
    const rehydrated = JSON.parse(JSON.stringify(built)) as typeof built;

    expect(search(rehydrated, 'authToken').length).toBeGreaterThan(0);
    expect(() => search(rehydrated, 'constructor')).not.toThrow();
  });
});

describe('extractSymbols', () => {
  it('finds exported function declarations', () => {
    expect(extractSymbols(AUTH_SOURCE)).toContain('createSessionToken');
  });

  it('finds class declarations', () => {
    expect(extractSymbols(BILLING_SOURCE)).toContain('BillingService');
  });

  it('finds Python and Go declarations', () => {
    expect(extractSymbols('def handle_request(req):\n  pass')).toContain('handle_request');
    expect(extractSymbols('func ServeHTTP(w http.ResponseWriter) {}')).toContain('ServeHTTP');
  });

  it('returns an empty list for prose', () => {
    expect(extractSymbols('Just some words in a sentence.')).toEqual([]);
  });
});

describe('search', () => {
  it('ranks the authentication file first for an auth question', () => {
    const hits = search(index, 'where is authentication implemented');
    expect(hits[0]?.document.file).toBe('src/auth/session.ts');
  });

  it('finds code by identifier', () => {
    const hits = search(index, 'createSessionToken');
    expect(hits[0]?.document.file).toBe('src/auth/session.ts');
  });

  it('matches a camelCase identifier from one of its parts', () => {
    const hits = search(index, 'checkout');
    expect(hits.map((h) => h.document.file)).toContain('src/billing/service.ts');
  });

  it('returns nothing for a term absent from the repository', () => {
    expect(search(index, 'kubernetes helm chart rollout')).toHaveLength(0);
  });

  it('respects the result limit', () => {
    expect(search(index, 'export function', 2).length).toBeLessThanOrEqual(2);
  });

  it('returns highlight ranges that fall inside the document text', () => {
    const hit = search(index, 'session')[0];
    expect(hit).toBeDefined();
    for (const [start, end] of hit?.highlights ?? []) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(hit?.document.text.length ?? 0);
      expect(end).toBeGreaterThan(start);
    }
  });

  it('produces non-overlapping, ascending highlight ranges', () => {
    const hit = search(index, 'token session')[0];
    const ranges = hit?.highlights ?? [];
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]?.[0]).toBeGreaterThanOrEqual(ranges[i - 1]?.[1] ?? 0);
    }
  });

  it('scores hits in descending order', () => {
    const scores = search(index, 'token').map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('ignores a query made entirely of stop words', () => {
    expect(search(index, 'the a an of to')).toEqual([]);
  });
});

describe('groupHitsByFile', () => {
  it('collapses multiple chunks from one file into a single group', () => {
    // A realistic long file: one identifier recurring throughout, rather than
    // 200 unique ones. The latter is a pathological case that the expansion
    // cap deliberately limits.
    const long = Array.from(
      { length: 200 },
      (_, i) => `export function handleInvoice${i % 4}(invoice: Invoice) { return invoice.total; }`,
    ).join('\n');

    const bigIndex = buildSearchIndex(makeSnapshot({ 'src/big.ts': long }));
    const groups = groupHitsByFile(search(bigIndex, 'invoice', 20));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.hits.length).toBeGreaterThan(1);
  });

  it('orders groups by their best hit', () => {
    const groups = groupHitsByFile(search(index, 'session token'));
    const scores = groups.map((g) => g.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});
