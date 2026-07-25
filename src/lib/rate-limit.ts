/**
 * Sliding-window rate limiting.
 *
 * In-process and dependency-free. On a single Vercel instance or a self-hosted
 * container this is genuinely effective; across many serverless instances it is
 * best-effort, because each instance holds its own window. That tradeoff is
 * stated rather than hidden — the honest alternative would be requiring Redis,
 * which contradicts the zero-configuration goal.
 *
 * A sliding window is used over a fixed window because fixed windows allow a
 * 2x burst across a boundary: 20 requests at 0:59 and 20 more at 1:01.
 */

import { serverEnv } from './env';

interface Window {
  /** Request timestamps within the current window, oldest first. */
  timestamps: number[];
}

const globalForLimiter = globalThis as unknown as { __gitbrainLimiter?: Map<string, Window> };
const windows: Map<string, Window> = (globalForLimiter.__gitbrainLimiter ??= new Map());

/** Bound the key space so a flood of unique IPs cannot exhaust memory. */
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Unix ms at which the oldest request leaves the window. */
  readonly resetAt: number;
  /** Seconds the client should wait. Only meaningful when `allowed` is false. */
  readonly retryAfter: number;
}

export interface RateLimitOptions {
  readonly limit?: number;
  readonly windowMs?: number;
}

export function rateLimit(key: string, options: RateLimitOptions = {}): RateLimitResult {
  const env = serverEnv();
  const limit = options.limit ?? env.RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;

  const now = Date.now();
  const cutoff = now - windowMs;

  if (windows.size > MAX_TRACKED_KEYS) sweep(cutoff);

  const window = windows.get(key) ?? { timestamps: [] };

  // Drop timestamps that have aged out of the window.
  let firstLive = 0;
  while (firstLive < window.timestamps.length && (window.timestamps[firstLive] ?? 0) <= cutoff) {
    firstLive++;
  }
  if (firstLive > 0) window.timestamps = window.timestamps.slice(firstLive);

  const oldest = window.timestamps[0];
  const resetAt = oldest === undefined ? now + windowMs : oldest + windowMs;

  if (window.timestamps.length >= limit) {
    windows.set(key, window);
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  window.timestamps.push(now);
  windows.set(key, window);

  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - window.timestamps.length),
    resetAt,
    retryAfter: 0,
  };
}

/** Drop every window with no live timestamps. */
function sweep(cutoff: number): void {
  for (const [key, window] of windows) {
    const last = window.timestamps[window.timestamps.length - 1];
    if (last === undefined || last <= cutoff) windows.delete(key);
  }
}

/**
 * Derive a stable client key from a request.
 *
 * Behind a proxy the socket address is the proxy, so forwarded headers are
 * preferred. Only the FIRST entry of `x-forwarded-for` is used — the rest are
 * client-controlled and trivially spoofable.
 */
export function clientKey(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip =
    forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    request.headers.get('cf-connecting-ip')?.trim() ||
    'unknown';

  return `${scope}:${ip}`;
}

/** Standard rate-limit response headers. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
  if (!result.allowed) headers['Retry-After'] = String(result.retryAfter);
  return headers;
}

/** Test hook. */
export function clearRateLimits(): void {
  windows.clear();
}
