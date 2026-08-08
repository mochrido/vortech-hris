import { NextResponse } from 'next/server.js';
import type { GuardRequest } from '../auth/guard.ts';
import { toErrorResponse, type AppError } from '../auth/errors.ts';

/**
 * Shared plumbing for the /api/v1 route handlers (Phase 0/1 constraint: tenant
 * scope ALWAYS comes from the session guard, so every handler adapts the
 * incoming request into the framework-light GuardRequest shape first).
 */

/** Minimal incoming-request surface shared by NextRequest and plain Requests. */
export interface IncomingRequest {
  headers: Headers;
}

/**
 * Adapts an incoming request into the GuardRequest shape the Phase 0 guard
 * (`requireSession` / `tenantScope` / `tenantQuery`) consumes. Only the cookie
 * jar is bridged; the guard never needs anything else.
 */
export function guardRequestFrom(req: IncomingRequest): GuardRequest {
  const cookies: Record<string, string | undefined> = {};
  const header = req.headers.get('cookie');
  if (header) {
    for (const pair of header.split(';')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      if (!name) continue;
      cookies[name] = pair.slice(eq + 1).trim();
    }
  }
  return { cookies };
}

/**
 * Maps a thrown error to a JSON NextResponse via `toErrorResponse`, taking the
 * HTTP status from AppError.status and defaulting to 500 for anything else.
 * Internal error details never reach the client.
 */
export function jsonError(err: unknown): NextResponse {
  const status =
    typeof err === 'object' && err !== null && 'status' in err && typeof (err as AppError).status === 'number'
      ? (err as AppError).status
      : 500;
  return NextResponse.json(toErrorResponse(err), { status });
}

/**
 * Best-effort client IP for rate limiting / session metadata. Prefers the
 * first (client-most) `x-forwarded-for` entry, then `x-real-ip`. Undefined
 * when no proxy header is present (direct connections in dev).
 */
export function extractClientIp(req: IncomingRequest): string | undefined {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') ?? undefined;
}
