/**
 * Store resolution. Supabase when configured, in-process memory otherwise.
 */

import { MemoryStore } from './memory';
import { tryCreateSupabaseStore } from './supabase';
import type { AnalysisStore } from './types';

export * from './types';
export { MemoryStore, clearMemoryStore } from './memory';
export { SupabaseStore } from './supabase';

let cached: AnalysisStore | null = null;

export function resolveStore(): AnalysisStore {
  if (cached) return cached;
  cached = tryCreateSupabaseStore() ?? new MemoryStore();
  return cached;
}

/** Test hook. */
export function resetStore(): void {
  cached = null;
}
