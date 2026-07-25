/**
 * Optional authentication.
 *
 * Clerk is wired for real, but never on the critical path. With no Clerk keys
 * configured the whole product works anonymously: analyses are public, shared
 * by URL, and owned by nobody. Adding keys turns on per-user ownership without
 * changing a single call site, because every route asks the same question —
 * "who owns this request?" — and accepts `null` as a valid answer.
 *
 * The Clerk module is imported dynamically so its server bundle is never
 * evaluated in a deployment that does not use it.
 */

import { capabilities } from './env';

/**
 * The current user's id, or `null` when auth is disabled or nobody is signed in.
 *
 * Never throws. An auth outage degrades to anonymous access rather than taking
 * the analyze endpoint down with it.
 */
export async function currentOwnerId(): Promise<string | null> {
  if (!capabilities().auth) return null;

  try {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    return userId ?? null;
  } catch (error) {
    console.error('[gitbrain] auth lookup failed, continuing anonymously:', error);
    return null;
  }
}

/** True when accounts are configured, used to decide whether to render auth UI. */
export function authEnabled(): boolean {
  return capabilities().auth;
}
