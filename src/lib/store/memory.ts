/**
 * In-process analysis store.
 *
 * The zero-configuration default. It is a bounded LRU rather than an unbounded
 * Map because a full `Analysis` for a large repository is measured in megabytes
 * and a long-lived server would otherwise leak until it was OOM-killed.
 *
 * Entries are also time-limited: an analysis nobody has opened in an hour is
 * almost certainly abandoned, and re-running it is cheap.
 */

import type { Analysis, AnalysisSummary } from '@/core/types';
import { toSummary, type AnalysisStore } from './types';

interface Entry {
  readonly analysis: Analysis;
  readonly ownerId: string | null;
  lastAccess: number;
}

const MAX_ENTRIES = 24;
const TTL_MS = 60 * 60 * 1000;

/**
 * Module-level so it survives hot reloads in development, where Next.js
 * re-evaluates route modules on every request but keeps the module registry.
 */
const globalForStore = globalThis as unknown as { __gitbrainStore?: Map<string, Entry> };
const entries: Map<string, Entry> = (globalForStore.__gitbrainStore ??= new Map());

export class MemoryStore implements AnalysisStore {
  readonly kind = 'memory' as const;
  readonly durable = false;

  async save(analysis: Analysis, ownerId: string | null): Promise<void> {
    evictExpired();

    entries.set(analysis.id, { analysis, ownerId, lastAccess: Date.now() });

    // Evict least-recently-accessed until back within budget.
    while (entries.size > MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;

      for (const [key, entry] of entries) {
        if (entry.lastAccess < oldestAt) {
          oldestAt = entry.lastAccess;
          oldestKey = key;
        }
      }

      if (!oldestKey) break;
      entries.delete(oldestKey);
    }
  }

  async get(id: string, ownerId: string | null): Promise<Analysis | null> {
    evictExpired();

    const entry = entries.get(id);
    if (!entry) return null;
    if (!canAccess(entry, ownerId)) return null;

    entry.lastAccess = Date.now();
    return entry.analysis;
  }

  async list(ownerId: string | null, limit = 20): Promise<AnalysisSummary[]> {
    evictExpired();

    return [...entries.values()]
      .filter((entry) => canAccess(entry, ownerId))
      .sort((a, b) => b.lastAccess - a.lastAccess)
      .slice(0, limit)
      .map((entry) => toSummary(entry.analysis));
  }

  async delete(id: string, ownerId: string | null): Promise<boolean> {
    const entry = entries.get(id);
    if (!entry || !canAccess(entry, ownerId)) return false;
    return entries.delete(id);
  }
}

/**
 * Ownership check.
 *
 * With auth disabled every analysis is anonymous (`ownerId === null`) and
 * shared, which is correct for a local single-user deployment. With auth
 * enabled, an owned analysis is visible only to its owner, while anonymous
 * ones stay public — that is what makes a shareable report link work.
 */
function canAccess(entry: Entry, ownerId: string | null): boolean {
  if (entry.ownerId === null) return true;
  return entry.ownerId === ownerId;
}

function evictExpired(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, entry] of entries) {
    if (entry.lastAccess < cutoff) entries.delete(key);
  }
}

/** Test hook. */
export function clearMemoryStore(): void {
  entries.clear();
}
