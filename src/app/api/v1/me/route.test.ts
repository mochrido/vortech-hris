import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server.js';
import { createTestDatabase, dropTestDatabase } from '../../../../lib/test/db.ts';
import { runMigrations } from '../../../../lib/db/migrate.ts';
import { closePool } from '../../../../lib/db/pool.ts';
import { hashPassword } from '../../../../lib/auth/password.ts';
import { login } from '../../../../lib/auth/login.ts';
import { GET } from './route.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
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

test('GET /me: returns the current user with roles', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const slug = `acme-${randomBytes(3).toString('hex')}`;
    const email = `me-${randomBytes(3).toString('hex')}@example.com`;
    const tenant = await fixture.pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
      [slug, `${slug} Legal`, `${slug} Display`],
    );
    const user = await fixture.pool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, display_name, email_normalized, phone_e164, password_hash, active)
       VALUES ($1, 'Me User', $2, $3, $4, true) RETURNING id`,
      [tenant.rows[0].id, email, '+628111222333', await hashPassword(PASSWORD)],
    );
    await fixture.pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'employee'), ($1, 'manager')`, [
      user.rows[0].id,
    ]);

    const { token } = await login(slug, email, PASSWORD, {});
    const res = await GET(
      new NextRequest('http://localhost/api/v1/me', { headers: { cookie: `vortech_session=${token}` } }),
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, user.rows[0].id);
    assert.equal(body.user.displayName, 'Me User');
    assert.equal(body.user.emailNormalized, email);
    assert.equal(body.user.phoneE164, '+628111222333');
    assert.deepEqual([...body.user.roles].sort(), ['employee', 'manager']);
  });
});

test('GET /me: unauthenticated → 401 SESSION_EXPIRED', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const res = await GET(new NextRequest('http://localhost/api/v1/me'));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { code: 'SESSION_EXPIRED', message: 'Session expired or invalid' });
  });
});
