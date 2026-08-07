import type pg from 'pg';
import { getPool } from '../db/pool.ts';
import { getSessionByToken, type ResolvedSession } from './session.ts';
import { AppError, ErrorCodes } from './errors.ts';

const DEFAULT_COOKIE_NAME = 'vortech_session';

/** Minimal request shape: framework-light, testable without Next. */
export interface GuardRequest {
  cookies: Record<string, string | undefined>;
  // Allow extra fields (body, query, headers) so callers can pass richer objects.
  [key: string]: unknown;
}

export interface TenantScope {
  tenantId: string;
  userId: string;
  roles: string[];
}

function sessionCookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? DEFAULT_COOKIE_NAME;
}

function extractToken(req: GuardRequest): string | undefined {
  const name = sessionCookieName();
  return req.cookies?.[name];
}

async function loadRoles(userId: string): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query<{ role: string }>(
    'SELECT role FROM user_roles WHERE user_id = $1',
    [userId],
  );
  return result.rows.map((r) => r.role);
}

/**
 * Resolves the session from the request cookie. Throws AppError(SESSION_EXPIRED)
 * if the cookie is missing, the token is invalid/revoked/expired, or the user
 * is deactivated.
 */
export async function requireSession(req: GuardRequest): Promise<ResolvedSession> {
  const token = extractToken(req);
  if (!token) {
    throw new AppError(ErrorCodes.SESSION_EXPIRED, 'Session expired or invalid', 401);
  }
  const resolved = await getSessionByToken(token);
  if (!resolved) {
    throw new AppError(ErrorCodes.SESSION_EXPIRED, 'Session expired or invalid', 401);
  }
  return resolved;
}

/**
 * Requires that the session's user holds at least one of the given roles.
 * Throws AppError(FORBIDDEN) if not.
 */
export async function requireRole(req: GuardRequest, roles: string[]): Promise<ResolvedSession> {
  const resolved = await requireSession(req);
  const userRoles = await loadRoles(resolved.user.id);
  const hasRole = roles.some((r) => userRoles.includes(r));
  if (!hasRole) {
    throw new AppError(ErrorCodes.FORBIDDEN, 'Insufficient role', 403);
  }
  return resolved;
}

/**
 * Returns the tenant scope derived exclusively from the session — never
 * from client-supplied input.
 */
export async function tenantScope(req: GuardRequest): Promise<TenantScope> {
  const resolved = await requireSession(req);
  const roles = await loadRoles(resolved.user.id);
  return {
    tenantId: resolved.user.tenant_id,
    userId: resolved.user.id,
    roles,
  };
}

/**
 * Runs a query with the session's tenant_id bound as $1, so callers cannot
 * supply a tenant id. Caller params are shifted to $2, $3, ...
 */
export async function tenantQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  req: GuardRequest,
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  const scope = await tenantScope(req);
  const pool = getPool();
  return pool.query<R>(text, [scope.tenantId, ...params]);
}
