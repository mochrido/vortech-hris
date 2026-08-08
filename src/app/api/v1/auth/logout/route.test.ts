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
import { login } from '../../../../../lib/auth/login.ts';
import { getSessionByToken } from '../../../../../lib/auth/session.ts';
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

async function seedAndLogin(pool: pg.Pool): Promise<{ userId: string; token: string }> {
  const slug = `acme-${randomBytes(3).toString('hex')}`;
  const email = `u-${randomBytes(3).toString('hex')}@example.com`;
  const tenant = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
     VALUES ($1, 'Logout User', $2, $3, true) RETURNING id`,
    [tenant.rows[0].id, email, await hashPassword(PASSWORD)],
  );
  const result = await login(slug, email, PASSWORD, {});
  return { userId: user.rows[0].id, token: result.token };
}

test('POST /auth/logout: revokes the session and clears the cookie', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const { token } = await seedAndLogin(fixture.pool);
    assert.ok(await getSessionByToken(token), 'session live before logout');

    const req = new NextRequest('http://localhost/api/v1/auth/logout', {
      method: 'POST',
      headers: { cookie: `vortech_session=${token}` },
    });
    const res = await POST(req);

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    assert.equal(await getSessionByToken(token), null, 'session revoked after logout');

    const setCookies = res.headers.getSetCookie();
    assert.equal(setCookies.length, 1);
    assert.match(setCookies[0], /^vortech_session=;/, 'cookie cleared to empty value');
    assert.match(setCookies[0], /Max-Age=0/, 'cookie expired immediately');
  });
});

test('POST /auth/logout: no session cookie → 401 SESSION_EXPIRED', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const req = new NextRequest('http://localhost/api/v1/auth/logout', { method: 'POST' });
    const res = await POST(req);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { code: 'SESSION_EXPIRED', message: 'Session expired or invalid' });
  });
});
