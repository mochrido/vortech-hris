import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import {
  createSession,
  getSessionByToken,
  revokeSession,
  revokeUserSessions,
  hashToken,
  type SessionCookie,
} from './session.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs fn while capturing console.warn output, then restores the original.
 * Returns whatever fn produced plus the list of warning messages emitted.
 */
async function withCapturedWarn<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

// --- Env helpers -----------------------------------------------------------

type EnvKey = 'DATABASE_URL' | 'APP_ORIGIN' | 'SESSION_TTL_HOURS' | 'SESSION_COOKIE_NAME';

function withEnv<T>(overrides: Partial<Record<EnvKey, string>>, fn: () => T | Promise<T>): Promise<T> | T {
  const saved = new Map<EnvKey, string | undefined>();
  for (const key of Object.keys(overrides) as EnvKey[]) {
    saved.set(key, process.env[key]);
    process.env[key] = overrides[key] as string;
  }
  const restore = (): void => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

// --- Shared database fixture ------------------------------------------------

interface DbFixture {
  url: string;
  pool: pg.Pool;
}

async function setupDb(t: test.TestContext): Promise<DbFixture> {
  // Reset the shared pool cache so each test DB gets its own pool.
  await closePool();
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  t.after(async () => {
    await closePool();
    await pool.end();
    await dropTestDatabase(url);
  });
  await runMigrations(pool, migrationsDir);
  return { url, pool };
}

function envFor(fixture: DbFixture): Record<EnvKey, string> {
  return {
    DATABASE_URL: fixture.url,
    APP_ORIGIN: 'https://hris.example.com',
    SESSION_TTL_HOURS: '720',
    SESSION_COOKIE_NAME: 'vortech_session',
  };
}

async function insertTenant(pool: pg.Pool, slug?: string): Promise<string> {
  const tenantSlug = slug ?? `tenant-${randomBytes(4).toString('hex')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [tenantSlug, `${tenantSlug} Legal`, `${tenantSlug} Display`],
  );
  return result.rows[0].id;
}

async function insertUser(
  pool: pg.Pool,
  tenantId: string,
  opts: { email?: string; active?: boolean } = {},
): Promise<string> {
  const email = opts.email ?? `user-${randomBytes(4).toString('hex')}@example.com`;
  const active = opts.active ?? true;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantId, 'Test User', email, 'scrypt$1$1$1$AAAA$BBBB', active],
  );
  return result.rows[0].id;
}

// --- Tests ------------------------------------------------------------------

test('createSession inserts a row storing ONLY the token hash and returns the raw token', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const created = await createSession(userId, {
      userAgent: 'Mozilla/5.0 Test',
      deviceLabel: 'Test Laptop',
      ip: '203.0.113.10',
    });

    assert.match(created.token, /^[A-Za-z0-9_-]{43}$/, 'raw token must be 32 bytes base64url');
    assert.ok(created.session.id, 'session id must be returned');
    assert.equal(created.session.user_id, userId);
    assert.equal(created.session.tenant_id, tenantId);

    const rows = await fixture.pool.query<{ token_hash: string; user_agent: string; device_label: string; ip: string }>(
      'SELECT token_hash, user_agent, device_label, ip::text AS ip FROM sessions WHERE id = $1',
      [created.session.id],
    );
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0];

    assert.notEqual(row.token_hash, created.token, 'raw token must never be stored');
    assert.equal(row.token_hash, hashToken(created.token), 'stored value must be sha256 hex of the token');
    assert.match(row.token_hash, /^[0-9a-f]{64}$/, 'token_hash must be sha256 hex');
    const stored = JSON.stringify(row);
    assert.ok(!stored.includes(created.token), 'raw token must not appear anywhere in the stored row');

    assert.equal(row.user_agent, 'Mozilla/5.0 Test');
    assert.equal(row.device_label, 'Test Laptop');
    // inet returns CIDR notation for IPv4 (/32); strip it for comparison
    assert.equal(row.ip.split('/')[0], '203.0.113.10');
  });
});

test('createSession sets expiry from SESSION_TTL_HOURS', async (t) => {
  const fixture = await setupDb(t);
  await withEnv({ ...envFor(fixture), SESSION_TTL_HOURS: '1' }, async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const before = Date.now();
    const created = await createSession(userId, {});
    const after = Date.now();

    const expiresMs = created.session.expires_at.getTime();
    assert.ok(expiresMs >= before + 3_599_000, `expires_at too early: ${created.session.expires_at}`);
    assert.ok(expiresMs <= after + 3_601_000, `expires_at too late: ${created.session.expires_at}`);
  });
});

test('createSession returns cookie attributes: httpOnly, lax, path /, secure from APP_ORIGIN, maxAge from TTL', async (t) => {
  const fixture = await setupDb(t);
  await withEnv({ ...envFor(fixture), APP_ORIGIN: 'https://hris.example.com', SESSION_TTL_HOURS: '720' }, async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const created = await createSession(userId, {});
    const cookie: SessionCookie = created.cookie;

    assert.equal(cookie.name, 'vortech_session');
    assert.equal(cookie.value, created.token);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'lax');
    assert.equal(cookie.path, '/');
    assert.equal(cookie.secure, true, 'secure must be true when APP_ORIGIN is https');
    assert.equal(cookie.maxAge, 720 * 3600);
  });
});

test('createSession cookie secure=false when APP_ORIGIN is http', async (t) => {
  const fixture = await setupDb(t);
  await withEnv({ ...envFor(fixture), APP_ORIGIN: 'http://localhost:3000' }, async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const created = await createSession(userId, {});
    assert.equal(created.cookie.secure, false, 'secure must be false for http origins');
  });
});

test('createSession cookie is secure and emits no warning for an https APP_ORIGIN', async (t) => {
  const fixture = await setupDb(t);
  await withEnv({ ...envFor(fixture), APP_ORIGIN: 'https://hris.example.com' }, async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const { result: created, warnings } = await withCapturedWarn(() => createSession(userId, {}));
    assert.equal(created.cookie.secure, true, 'secure must be true for an https origin');
    assert.equal(warnings.length, 0, 'no insecure-cookie warning must be emitted for https');
  });
});

test('createSession warns about a non-Secure cookie for a non-localhost http origin', async (t) => {
  const fixture = await setupDb(t);
  await withEnv({ ...envFor(fixture), APP_ORIGIN: 'http://hris.internal.example.com' }, async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const { result: created, warnings } = await withCapturedWarn(() => createSession(userId, {}));
    assert.equal(created.cookie.secure, false, 'secure must be false for an http origin');
    assert.ok(
      warnings.some((w) => /without the secure flag/i.test(w)),
      `a warning about the missing Secure flag must be emitted; got: ${JSON.stringify(warnings)}`,
    );
  });
});

test('createSession stays quiet for a loopback http origin (localhost dev)', async (t) => {
  const fixture = await setupDb(t);
  await withEnv({ ...envFor(fixture), APP_ORIGIN: 'http://127.0.0.1:3000' }, async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const { result: created, warnings } = await withCapturedWarn(() => createSession(userId, {}));
    assert.equal(created.cookie.secure, false, 'secure must be false for an http loopback origin');
    assert.equal(warnings.length, 0, 'no insecure-cookie warning must be emitted for loopback dev');
  });
});

test('getSessionByToken returns the session and user for a valid token', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const created = await createSession(userId, { userAgent: 'UA' });
    const found = await getSessionByToken(created.token);

    assert.ok(found, 'valid token must resolve');
    assert.equal(found?.session.id, created.session.id);
    assert.equal(found?.session.user_id, userId);
    assert.equal(found?.user.id, userId);
    assert.equal(found?.user.tenant_id, tenantId);
    assert.equal(found?.user.active, true);
  });
});

test('getSessionByToken returns null for an unknown token', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const unknown = randomBytes(32).toString('base64url');
    const found = await getSessionByToken(unknown);
    assert.equal(found, null);
  });
});

test('getSessionByToken returns null for a revoked session', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const created = await createSession(userId, {});
    await revokeSession(created.session.id);

    const found = await getSessionByToken(created.token);
    assert.equal(found, null, 'revoked session must not resolve');
  });
});

test('getSessionByToken returns null for an expired session', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const created = await createSession(userId, {});
    await fixture.pool.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [created.session.id],
    );

    const found = await getSessionByToken(created.token);
    assert.equal(found, null, 'expired session must not resolve');
  });
});

test('getSessionByToken returns null for a deactivated user', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId, { active: false });

    const created = await createSession(userId, {});
    const found = await getSessionByToken(created.token);
    assert.equal(found, null, 'deactivated user must not be able to use a session');
  });
});

test('getSessionByToken populates last_seen_at when NULL, then throttles immediate repeat calls', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);
    const created = await createSession(userId, {});

    // Sanity: a freshly created session has never been seen.
    const initial = await fixture.pool.query<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM sessions WHERE id = $1',
      [created.session.id],
    );
    assert.equal(initial.rows[0].last_seen_at, null, 'last_seen_at must start NULL');

    // First resolution: last_seen_at is NULL so the throttled UPDATE fires.
    await getSessionByToken(created.token);
    await sleep(150); // allow the fire-and-forget UPDATE to commit

    const afterFirst = await fixture.pool.query<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM sessions WHERE id = $1',
      [created.session.id],
    );
    assert.ok(afterFirst.rows[0].last_seen_at, 'first resolution must populate last_seen_at');
    const firstValue = afterFirst.rows[0].last_seen_at!.getTime();

    // Immediate second resolution: last_seen_at is fresh (< 60s), so the UPDATE
    // is a no-op and the stored value must NOT be rewritten.
    await getSessionByToken(created.token);
    await sleep(150);

    const afterSecond = await fixture.pool.query<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM sessions WHERE id = $1',
      [created.session.id],
    );
    assert.equal(
      afterSecond.rows[0].last_seen_at!.getTime(),
      firstValue,
      'an immediate repeat call must not rewrite last_seen_at (throttled)',
    );
  });
});

test('getSessionByToken refreshes last_seen_at once it is older than the throttle threshold', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);
    const created = await createSession(userId, {});

    // Simulate a session last seen well beyond the 60-second throttle window.
    const stale = new Date('2000-01-01T00:00:00.000Z');
    await fixture.pool.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [
      stale,
      created.session.id,
    ]);

    await getSessionByToken(created.token);
    await sleep(150); // allow the fire-and-forget UPDATE to commit

    const after = await fixture.pool.query<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM sessions WHERE id = $1',
      [created.session.id],
    );
    assert.ok(after.rows[0].last_seen_at, 'last_seen_at must be set after resolution');
    assert.ok(
      after.rows[0].last_seen_at!.getTime() > stale.getTime(),
      `last_seen_at must be refreshed past the stale value; got ${after.rows[0].last_seen_at}`,
    );
  });
});

test('revokeSession sets revoked_at', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const created = await createSession(userId, {});
    await revokeSession(created.session.id);

    const rows = await fixture.pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE id = $1',
      [created.session.id],
    );
    assert.ok(rows.rows[0].revoked_at, 'revoked_at must be set');
  });
});

test('revokeUserSessions revokes all sessions for a user', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool);
    const userId = await insertUser(fixture.pool, tenantId);

    const s1 = await createSession(userId, {});
    const s2 = await createSession(userId, {});
    const s3 = await createSession(userId, {});

    await revokeUserSessions(userId, tenantId);

    for (const s of [s1, s2, s3]) {
      const found = await getSessionByToken(s.token);
      assert.equal(found, null, `session ${s.session.id} must be revoked`);
    }

    const rows = await fixture.pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM sessions WHERE user_id = $1',
      [userId],
    );
    assert.equal(rows.rows.length, 3);
    for (const row of rows.rows) {
      assert.ok(row.revoked_at, 'every session must have revoked_at set');
    }
  });
});
