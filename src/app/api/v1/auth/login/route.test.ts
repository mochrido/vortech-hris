import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server.js';
import { createTestDatabase, dropTestDatabase } from '../../../../../lib/test/db.ts';
import { runMigrations } from '../../../../../lib/db/migrate.ts';
import { closePool } from '../../../../../lib/db/pool.ts';
import { hashPassword } from '../../../../../lib/auth/password.ts';
import { POST } from './route.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

const PASSWORD = 'S3cure!Passphrase';

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

async function seedUser(pool: pg.Pool, slug: string, email: string): Promise<{ tenantId: string; userId: string }> {
  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
     VALUES ($1, 'Route User', $2, $3, true) RETURNING id`,
    [tenant.rows[0].id, email, await hashPassword(PASSWORD)],
  );
  await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'employee')`, [user.rows[0].id]);
  return { tenantId: tenant.rows[0].id, userId: user.rows[0].id };
}

function loginRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('POST /auth/login: 200 with user summary + roles and an httpOnly session cookie', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const slug = `acme-${randomBytes(3).toString('hex')}`;
    const { userId } = await seedUser(fixture.pool, slug, 'route@example.com');

    const res = await POST(
      loginRequest(
        { tenantSlug: slug, identifier: 'route@example.com', password: PASSWORD },
        { 'user-agent': 'RouteTest/1.0', 'x-forwarded-for': '203.0.113.10' },
      ),
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, userId);
    assert.equal(body.user.displayName, 'Route User');
    assert.equal(body.user.emailNormalized, 'route@example.com');
    assert.deepEqual(body.user.roles, ['employee']);

    const setCookies = res.headers.getSetCookie();
    assert.equal(setCookies.length, 1, 'exactly one Set-Cookie');
    const cookie = setCookies[0];
    assert.match(cookie, /^vortech_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=lax/i);
    assert.match(cookie, /Path=\//);

    // The session row carries the request metadata.
    const sessions = await fixture.pool.query<{ user_agent: string; ip: string }>(
      'SELECT user_agent, ip::text AS ip FROM sessions WHERE user_id = $1',
      [userId],
    );
    assert.equal(sessions.rows[0].user_agent, 'RouteTest/1.0');
    assert.equal(sessions.rows[0].ip.split('/')[0], '203.0.113.10');
  });
});

test('POST /auth/login: wrong password → 401 INVALID_CREDENTIALS and NO cookie', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const slug = `acme-${randomBytes(3).toString('hex')}`;
    await seedUser(fixture.pool, slug, 'route2@example.com');

    const res = await POST(loginRequest({ tenantSlug: slug, identifier: 'route2@example.com', password: 'nope' }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' });
    assert.equal(res.headers.getSetCookie().length, 0, 'no session cookie on failure');
  });
});

test('POST /auth/login: malformed body → 400 VALIDATION_FAILED', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const res = await POST(loginRequest({ tenantSlug: 'acme', identifier: 'a@b.c' }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
  });
});
