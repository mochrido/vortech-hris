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
import { GET } from './route.ts';

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

test('GET /me/dashboard: returns today + recent for the session user', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const slug = `acme-${randomBytes(3).toString('hex')}`;
    const email = `dash-${randomBytes(3).toString('hex')}@example.com`;
    const tenant = await fixture.pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
      [slug, `${slug} Legal`, `${slug} Display`],
    );
    const tenantId = tenant.rows[0].id;
    const user = await fixture.pool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
       VALUES ($1, 'Dash User', $2, $3, true) RETURNING id`,
      [tenantId, email, await hashPassword(PASSWORD)],
    );
    const userId = user.rows[0].id;
    const schedule = await fixture.pool.query<{ id: string }>(
      `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
       VALUES ($1, 'Fixed', 'Asia/Jakarta', '09:00', '17:00', false, 10, 60) RETURNING id`,
      [tenantId],
    );
    const scheduleId = schedule.rows[0].id;
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      await fixture.pool.query(`INSERT INTO schedule_days (schedule_id, weekday) VALUES ($1, $2)`, [scheduleId, weekday]);
    }
    await fixture.pool.query(
      `INSERT INTO user_schedule_assignments (tenant_id, user_id, schedule_id, effective_from) VALUES ($1, $2, $3, '2020-01-01')`,
      [tenantId, userId, scheduleId],
    );

    const { token } = await login(slug, email, PASSWORD, {});
    const res = await GET(
      new NextRequest('http://localhost/api/v1/me/dashboard', { headers: { cookie: `vortech_session=${token}` } }),
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.today, 'today entry present (schedule active every weekday, none dated in the past)');
    assert.equal(body.today.status, 'scheduled');
    assert.equal(body.today.checkInAt, null);
    assert.deepEqual(body.recent, []);
  });
});

test('GET /me/dashboard: unauthenticated → 401 SESSION_EXPIRED', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const res = await GET(new NextRequest('http://localhost/api/v1/me/dashboard'));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { code: 'SESSION_EXPIRED', message: 'Session expired or invalid' });
  });
});
