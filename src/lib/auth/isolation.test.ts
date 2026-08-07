import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { createSession } from './session.ts';
import { requireSession, requireRole, tenantScope, tenantQuery } from './guard.ts';
import { AppError, ErrorCodes } from './errors.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

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

async function insertTenant(pool: pg.Pool, slug: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`],
  );
  return result.rows[0].id;
}

async function insertUser(
  pool: pg.Pool,
  tenantId: string,
  email: string,
  roles: string[] = [],
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [tenantId, 'Test User', email, 'scrypt$1$1$1$AAAA$BBBB'],
  );
  const userId = result.rows[0].id;
  for (const role of roles) {
    await pool.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [userId, role]);
  }
  return userId;
}

test('requireSession resolves the session and user from the cookie token', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, 'alice@acme.test', ['member']);

    const created = await createSession(userId, {});
    const req = { cookies: { vortech_session: created.token } };

    const resolved = await requireSession(req);
    assert.equal(resolved.session.user_id, userId);
    assert.equal(resolved.user.id, userId);
    assert.equal(resolved.user.tenant_id, tenantId);
  });
});

test('requireSession throws SESSION_EXPIRED for a missing cookie', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const req = { cookies: {} };
    await assert.rejects(
      () => requireSession(req),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal((err as AppError).code, ErrorCodes.SESSION_EXPIRED);
        return true;
      },
    );
  });
});

test('requireSession throws SESSION_EXPIRED for an invalid token', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const req = { cookies: { vortech_session: randomBytes(32).toString('base64url') } };
    await assert.rejects(
      () => requireSession(req),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal((err as AppError).code, ErrorCodes.SESSION_EXPIRED);
        return true;
      },
    );
  });
});

test('requireSession throws SESSION_EXPIRED for a revoked session', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, 'alice@acme.test');

    const created = await createSession(userId, {});
    await fixture.pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [created.session.id]);

    const req = { cookies: { vortech_session: created.token } };
    await assert.rejects(
      () => requireSession(req),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal((err as AppError).code, ErrorCodes.SESSION_EXPIRED);
        return true;
      },
    );
  });
});

test('requireRole allows a user who has the role', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, 'admin@acme.test', ['admin']);

    const created = await createSession(userId, {});
    const req = { cookies: { vortech_session: created.token } };

    const resolved = await requireRole(req, ['admin']);
    assert.equal(resolved.user.id, userId);
  });
});

test('requireRole rejects a user who lacks the role', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, 'member@acme.test', ['member']);

    const created = await createSession(userId, {});
    const req = { cookies: { vortech_session: created.token } };

    await assert.rejects(
      () => requireRole(req, ['admin']),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal((err as AppError).code, ErrorCodes.FORBIDDEN);
        return true;
      },
    );
  });
});

test('requireRole allows a user who has any of the required roles', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, 'manager@acme.test', ['manager']);

    const created = await createSession(userId, {});
    const req = { cookies: { vortech_session: created.token } };

    const resolved = await requireRole(req, ['admin', 'manager']);
    assert.equal(resolved.user.id, userId);
  });
});

test('tenantScope returns tenantId, userId, and roles from the session only', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantId = await insertTenant(fixture.pool, 'acme');
    const userId = await insertUser(fixture.pool, tenantId, 'admin@acme.test', ['admin', 'manager']);

    const created = await createSession(userId, {});
    const req = { cookies: { vortech_session: created.token } };

    const scope = await tenantScope(req);
    assert.equal(scope.tenantId, tenantId);
    assert.equal(scope.userId, userId);
    assert.deepEqual(scope.roles.sort(), ['admin', 'manager']);
  });
});

test('tenantQuery returns only Tenant A rows for a Tenant A session, never Tenant B rows', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantA = await insertTenant(fixture.pool, 'tenant-a');
    const tenantB = await insertTenant(fixture.pool, 'tenant-b');
    const userA = await insertUser(fixture.pool, tenantA, 'a@tenant-a.test', ['member']);
    await insertUser(fixture.pool, tenantB, 'b@tenant-b.test', ['member']);

    const created = await createSession(userA, {});
    const req = { cookies: { vortech_session: created.token } };

    // Tenant-scoped query: helper must bind the session tenant_id, never client input
    const result = await tenantQuery(
      req,
      'SELECT id, email_normalized FROM users WHERE tenant_id = $1',
      [],
    );

    assert.equal(result.rows.length, 1, 'must return only Tenant A users');
    assert.equal(result.rows[0].email_normalized, 'a@tenant-a.test');
    assert.equal(result.rows[0].id, userA);

    // Verify Tenant B data exists but is not returned
    const allUsers = await fixture.pool.query('SELECT id FROM users');
    assert.ok(allUsers.rows.length >= 2, 'both tenants should have users');
  });
});

test('tenantQuery never uses a client-supplied tenant id', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantA = await insertTenant(fixture.pool, 'tenant-a');
    const tenantB = await insertTenant(fixture.pool, 'tenant-b');
    const userA = await insertUser(fixture.pool, tenantA, 'a@tenant-a.test');
    await insertUser(fixture.pool, tenantB, 'b@tenant-b.test');

    const created = await createSession(userA, {});
    // Simulate a malicious client trying to pass tenant B id — the helper must ignore it
    const req = {
      cookies: { vortech_session: created.token },
      body: { tenantId: tenantB },
      query: { tenant_id: tenantB },
    };

    const result = await tenantQuery(
      req,
      'SELECT id, email_normalized FROM users WHERE tenant_id = $1',
      [],
    );

    assert.equal(result.rows.length, 1, 'must return only session tenant rows');
    assert.equal(result.rows[0].email_normalized, 'a@tenant-a.test');
  });
});

test('tenantQuery binds tenant_id as $1 and shifts caller params', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const tenantA = await insertTenant(fixture.pool, 'tenant-a');
    const userA = await insertUser(fixture.pool, tenantA, 'a@tenant-a.test');
    await insertUser(fixture.pool, tenantA, 'other@tenant-a.test');

    const created = await createSession(userA, {});
    const req = { cookies: { vortech_session: created.token } };

    // Caller param ($2 after binding) filters by email
    const result = await tenantQuery(
      req,
      'SELECT id, email_normalized FROM users WHERE tenant_id = $1 AND email_normalized = $2',
      ['other@tenant-a.test'],
    );

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].email_normalized, 'other@tenant-a.test');
  });
});
