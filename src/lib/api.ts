/**
 * Shared route helpers: validation, error shaping, and safe responses.
 *
 * Every API route in GitBrain funnels through these so that error bodies have
 * one shape, internal errors never leak stack traces to clients, and security
 * headers cannot be forgotten on a new endpoint.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

export interface ApiErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
    readonly details?: unknown;
  };
}

/** An error whose message is safe to show a user. */
export class PublicError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'bad_request') {
    super(message);
    this.name = 'PublicError';
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(
  message: string,
  status: number,
  code: string,
  extraHeaders: Record<string, string> = {},
  details?: unknown,
): NextResponse<ApiErrorBody> {
  return NextResponse.json<ApiErrorBody>(
    { error: { message, code, ...(details === undefined ? {} : { details }) } },
    { status, headers: { ...securityHeaders(), ...extraHeaders } },
  );
}

export function jsonResponse<T>(
  body: T,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse<T> {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: { ...securityHeaders(), ...init.headers },
  });
}

/**
 * Convert any thrown value into a response.
 *
 * Unknown errors deliberately produce a generic message: an unhandled
 * exception's text can contain file paths, connection strings or upstream
 * payloads that must never reach a client. The real error is logged instead.
 */
export function handleError(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof PublicError) {
    return errorResponse(error.message, error.status, error.code);
  }

  if (error instanceof z.ZodError) {
    return errorResponse(
      'The request body was not valid.',
      422,
      'validation_failed',
      {},
      error.issues,
    );
  }

  // Domain errors from the ingest layer carry user-safe messages by design.
  if (error instanceof Error) {
    const named = error.name;
    if (named === 'InvalidRepositoryUrlError')
      return errorResponse(error.message, 400, 'invalid_url');
    if (named === 'ArchiveError') return errorResponse(error.message, 400, 'invalid_archive');
    if (named === 'RepositoryFetchError') {
      const status = 'status' in error && typeof error.status === 'number' ? error.status : 502;
      return errorResponse(error.message, status, 'repository_unavailable');
    }
    if (named === 'AbortError') return errorResponse('The request was cancelled.', 499, 'aborted');
  }

  console.error('[gitbrain] unhandled route error:', error);
  return errorResponse('Something went wrong on our end.', 500, 'internal_error');
}

/** Parse and validate a JSON body, rejecting oversized or malformed payloads. */
export async function parseJson<T extends z.ZodType>(
  request: Request,
  schema: T,
  maxBytes = 256 * 1024,
): Promise<z.infer<T>> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > maxBytes) {
    throw new PublicError('The request body is too large.', 413, 'payload_too_large');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new PublicError('The request body must be valid JSON.', 400, 'invalid_json');
  }

  return schema.parse(raw);
}

/**
 * Headers applied to every API response.
 *
 * The page-level CSP lives in `next.config.ts`; these cover the API surface,
 * which serves only JSON and event streams and should never be framed,
 * sniffed, or cached by an intermediary.
 */
export function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store, max-age=0',
  };
}
