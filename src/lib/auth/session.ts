import { randomBytes, createHash } from 'node:crypto';
import { getPool } from '../db/pool.ts';

const DEFAULT_TTL_HOURS = 720;
const DEFAULT_COOKIE_NAME = 'vortech_session';
// Minimum interval between last_seen_at writes for a given session. Requests
// arriving more frequently than this reuse the existing last_seen_at.
const LAST_SEEN_THROTTLE_SECONDS = 60;

export interface SessionMeta {
  userAgent?: string;
  deviceLabel?: string;
  ip?: string;
}

export interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  token_hash: string;
  user_agent: string | null;
  device_label: string | null;
  ip: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface UserRow {
  id: string;
  tenant_id: string;
  display_name: string;
  email_normalized: string | null;
  phone_e164: string | null;
  active: boolean;
}

export interface SessionCookie {
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  secure: boolean;
  maxAge: number;
}

export interface CreatedSession {
  session: SessionRow;
  token: string;
  cookie: SessionCookie;
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

/** SHA-256 hex of a raw session token. Only this hash is ever stored. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function ttlHours(): number {
  const raw = process.env.SESSION_TTL_HOURS;
  if (!raw) return DEFAULT_TTL_HOURS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_HOURS;
  return parsed;
}

function cookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? DEFAULT_COOKIE_NAME;
}

function isSecureOrigin(): boolean {
  const origin = process.env.APP_ORIGIN ?? '';
  return origin.startsWith('https://');
}

/**
 * True when APP_ORIGIN points at a loopback host (localhost / 127.0.0.1 / [::1]),
 * where an http:// (non-Secure) cookie is expected and harmless in development.
 * Fail-closed: any unparseable origin returns false so the warning still fires.
 */
function isLocalhostOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Creates a new session for a user. Generates a random 32-byte raw token,
 * stores ONLY its SHA-256 hash in the DB, and returns the raw token plus
 * cookie attributes suitable for an HttpOnly Set-Cookie header.
 */
export async function createSession(userId: string, meta: SessionMeta): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const ttl = ttlHours();
  const maxAgeSeconds = Math.floor(ttl * 3600);
  const expiresAt = new Date(Date.now() + ttl * 3600 * 1000);

  const pool = getPool();

  // Resolve the user's tenant so the session row is tenant-scoped.
  const userResult = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM users WHERE id = $1',
    [userId],
  );
  if (userResult.rows.length === 0) {
    throw new Error(`user not found: ${userId}`);
  }
  const tenantId = userResult.rows[0].tenant_id;

  const insert = await pool.query<SessionRow>(
    `INSERT INTO sessions (tenant_id, user_id, token_hash, user_agent, device_label, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, user_id, token_hash, user_agent, device_label, ip::text AS ip, created_at, last_seen_at, expires_at, revoked_at`,
    [tenantId, userId, tokenHash, meta.userAgent ?? null, meta.deviceLabel ?? null, meta.ip ?? null, expiresAt],
  );

  const session = insert.rows[0];

  const secure = isSecureOrigin();
  const appOrigin = process.env.APP_ORIGIN ?? '';
  if (!secure && !isLocalhostOrigin(appOrigin)) {
    // Loud signal for a misconfiguration that is easy to miss: a non-localhost
    // http:// origin means the session cookie is sent without the Secure flag,
    // exposing it to network interception. Loopback dev origins stay quiet.
    console.warn(
      `[vortech-hris] WARNING: session cookie will be sent WITHOUT the Secure flag. ` +
        `APP_ORIGIN is "${appOrigin || '(unset)'}" which is not https and not localhost. ` +
        `Set APP_ORIGIN to an https:// origin in any non-local environment.`,
    );
  }

  const cookie: SessionCookie = {
    name: cookieName(),
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: maxAgeSeconds,
  };

  return { session, token, cookie };
}

/**
 * Resolves a session by raw token. Returns the session joined with its user,
 * or null if the token is unknown, revoked, expired, or the user is inactive.
 */
export async function getSessionByToken(token: string): Promise<ResolvedSession | null> {
  const tokenHash = hashToken(token);
  const pool = getPool();

  const result = await pool.query<SessionRow & { user_id_join: string; user_tenant_id: string; user_display_name: string; user_email: string | null; user_phone: string | null; user_active: boolean }>(
    `SELECT
       s.id, s.tenant_id, s.user_id, s.token_hash, s.user_agent, s.device_label, s.ip::text AS ip,
       s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
       u.id AS user_id_join, u.tenant_id AS user_tenant_id, u.display_name AS user_display_name,
       u.email_normalized AS user_email, u.phone_e164 AS user_phone, u.active AS user_active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.active = true`,
    [tokenHash],
  );

  if (result.rows.length === 0) return null;

  // Throttled last_seen_at touch: avoid a write on every request. Only update
  // when last_seen_at is NULL or older than LAST_SEEN_THROTTLE_SECONDS. The
  // freshness predicate lives in the UPDATE's WHERE clause so the decision is
  // atomic in Postgres (no read-then-write race). The row resolved above is
  // already known valid, so this is a best-effort, single-statement touch.
  pool
    .query(
      `UPDATE sessions
          SET last_seen_at = now()
        WHERE token_hash = $1
          AND (last_seen_at IS NULL OR last_seen_at < now() - ($2 * interval '1 second'))`,
      [tokenHash, LAST_SEEN_THROTTLE_SECONDS],
    )
    .catch(() => {
      // Swallow errors: failing to refresh last_seen_at must never fail the
      // session resolution itself.
    });

  const row = result.rows[0];
  const session: SessionRow = {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    token_hash: row.token_hash,
    user_agent: row.user_agent,
    device_label: row.device_label,
    ip: row.ip,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
  const user: UserRow = {
    id: row.user_id_join,
    tenant_id: row.user_tenant_id,
    display_name: row.user_display_name,
    email_normalized: row.user_email,
    phone_e164: row.user_phone,
    active: row.user_active,
  };

  return { session, user };
}

/** Revokes a single session by id (sets revoked_at). */
export async function revokeSession(id: string): Promise<void> {
  const pool = getPool();
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
}

/** Revokes all active sessions for a user within a tenant. */
export async function revokeUserSessions(userId: string, tenantId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL',
    [userId, tenantId],
  );
}
