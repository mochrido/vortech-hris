import { query } from '../db/pool.ts';
import { verifyPassword } from './password.ts';
import { checkRateLimit, resetRateLimit } from './rate-limit.ts';
import { AppError, ErrorCodes } from './errors.ts';
import { createSession, type SessionCookie, type SessionMeta, type SessionRow } from './session.ts';

/** Failed-login budget per tenant+identifier key: 5 attempts per 15 minutes. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Pre-computed `scrypt$16384$8$1` hash of a random 32-byte secret. Verifying a
// candidate against this costs exactly the same as verifying a real account,
// so unknown tenants/users/deactivated accounts are indistinguishable by
// timing (anti-enumeration; PRD security requirements).
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$WJh5icpa+w69UvEQMbW/4g==$xCTs8T0q8fyOGkb1B1cLhOO7wyYulllF0gaGBcjqvIY=';

export interface LoginUserSummary {
  id: string;
  displayName: string;
  emailNormalized: string | null;
  phoneE164: string | null;
  roles: string[];
}

export interface LoginResult {
  session: SessionRow;
  token: string;
  cookie: SessionCookie;
  user: LoginUserSummary;
}

interface TenantRow {
  id: string;
}

interface CredentialRow {
  id: string;
  display_name: string;
  email_normalized: string | null;
  phone_e164: string | null;
  password_hash: string;
  active: boolean;
}

function invalidCredentials(): AppError {
  // Single generic message for every failure mode: wrong password, unknown
  // user, unknown tenant, and deactivated account are indistinguishable.
  return new AppError(ErrorCodes.INVALID_CREDENTIALS, 'Invalid credentials', 401);
}

function rateLimitKey(tenantSlug: string, identifier: string): string {
  return `login:${tenantSlug}:${identifier}`;
}

/**
 * Authenticates a user within a tenant and opens a session.
 *
 * - `identifier` may be the account's email (matched case-insensitively
 *   against `email_normalized`) or its `phone_e164`.
 * - Anti-enumeration: a scrypt verify ALWAYS runs — against a dummy hash when
 *   no usable credential row exists — and every failure mode throws the same
 *   generic INVALID_CREDENTIALS AppError.
 * - Rate limiting: failures accumulate on a `tenant+identifier` fixed window;
 *   once exhausted, even correct credentials are rejected with RATE_LIMITED
 *   until the window expires. A successful login clears the bucket.
 *
 * @throws {AppError} INVALID_CREDENTIALS (401) / RATE_LIMITED (429)
 */
export async function login(
  tenantSlug: string,
  identifier: string,
  password: string,
  meta: SessionMeta,
): Promise<LoginResult> {
  const slug = tenantSlug.trim();
  const ident = identifier.trim().toLowerCase();
  const key = rateLimitKey(slug, ident);

  const tenantResult = await query<TenantRow>('SELECT id FROM tenants WHERE slug = $1', [slug]);
  const tenantId = tenantResult.rows[0]?.id ?? null;

  let user: CredentialRow | null = null;
  if (tenantId !== null) {
    const userResult = await query<CredentialRow>(
      `SELECT id, display_name, email_normalized, phone_e164, password_hash, active
         FROM users
        WHERE tenant_id = $1
          AND (email_normalized = $2 OR phone_e164 = $2)`,
      [tenantId, ident],
    );
    user = userResult.rows[0] ?? null;
  }

  // Always pay the scrypt cost: a missing tenant/user or a deactivated
  // account verifies against the dummy hash so timing reveals nothing.
  const storedHash = user !== null && user.active ? user.password_hash : DUMMY_PASSWORD_HASH;
  const passwordOk = await verifyPassword(storedHash, password);

  if (user === null || !user.active || !passwordOk) {
    const limit = checkRateLimit(key, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);
    if (!limit.allowed) {
      throw new AppError(ErrorCodes.RATE_LIMITED, 'Too many login attempts; try again later', 429);
    }
    throw invalidCredentials();
  }

  resetRateLimit(key);

  const roleResult = await query<{ role: string }>('SELECT role FROM user_roles WHERE user_id = $1', [user.id]);
  const roles = roleResult.rows.map((row) => row.role);

  const created = await createSession(user.id, meta);

  return {
    session: created.session,
    token: created.token,
    cookie: created.cookie,
    user: {
      id: user.id,
      displayName: user.display_name,
      emailNormalized: user.email_normalized,
      phoneE164: user.phone_e164,
      roles,
    },
  };
}
