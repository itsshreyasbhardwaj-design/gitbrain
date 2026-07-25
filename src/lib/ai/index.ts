/**
 * Provider resolution.
 *
 * One rule: if a key is configured, use the model; otherwise use local
 * retrieval. There is no "AI unavailable" error state, because local is not a
 * failure mode — it is the default.
 */

import { serverEnv } from '@/lib/env';
import { LocalReasoner } from './local';
import { OpenRouterProvider } from './openrouter';
import type { ReasoningProvider } from './types';

export * from './types';
export { LocalReasoner } from './local';
export { OpenRouterProvider } from './openrouter';

let cached: ReasoningProvider | null = null;

export function resolveProvider(): ReasoningProvider {
  if (cached) return cached;

  const env = serverEnv();

  cached = env.OPENROUTER_API_KEY
    ? new OpenRouterProvider(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL)
    : new LocalReasoner();

  return cached;
}

/** Test hook — clears the memoised provider between cases. */
export function resetProvider(): void {
  cached = null;
}
