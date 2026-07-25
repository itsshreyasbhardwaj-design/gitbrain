/**
 * Typed, validated environment access.
 *
 * GitBrain has exactly one hard requirement: none. Every integration below is
 * optional, and the product degrades to a fully local mode rather than
 * crashing on a missing key. That is a deliberate product decision — a repo
 * analyzer that cannot run without four SaaS accounts is not a tool people
 * will actually clone and try.
 *
 * `SERVER_ENV` is validated lazily so importing this module in a client bundle
 * never touches server-only values.
 */

import { z } from 'zod';

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Raises the GitHub API rate limit from 60/hr to 5000/hr. Optional. */
  GITHUB_TOKEN: z.string().min(1).optional(),

  /** Enables LLM-enriched knowledge documents and chat. Optional. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).default('anthropic/claude-3.5-sonnet'),

  /** Enables durable, shared storage. Falls back to in-process storage. */
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  /** Enables per-user accounts and private analyses. */
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1).optional(),

  /** Requests per window, per client, on expensive endpoints. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/**
 * Parse and cache server environment.
 *
 * Unknown or malformed *optional* values are treated as absent rather than
 * fatal, so a stray empty string in a `.env` file disables a feature instead of
 * taking the whole deployment down.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment configuration:\n  ${issues.join('\n  ')}`);
  }

  cached = parsed.data;
  return cached;
}

/** Which optional integrations are actually configured. */
export interface Capabilities {
  /** LLM enrichment for knowledge docs and conversational chat. */
  readonly ai: boolean;
  /** Durable Postgres-backed storage. */
  readonly persistence: boolean;
  /** Per-user accounts. */
  readonly auth: boolean;
  /** Higher GitHub API rate limits. */
  readonly githubToken: boolean;
}

export function capabilities(): Capabilities {
  const env = serverEnv();
  return {
    ai: Boolean(env.OPENROUTER_API_KEY),
    persistence: Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
    auth: Boolean(env.CLERK_SECRET_KEY && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
    githubToken: Boolean(env.GITHUB_TOKEN),
  };
}

export function isProduction(): boolean {
  return serverEnv().NODE_ENV === 'production';
}
