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

test('GET /attendance/context: returns schedule/policy/locations/serverNow for the session user', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const slug = `acme-${randomBytes(3).toString('hex')}`;
    const email = `ctx-${randomBytes(3).toString('hex')}@example.com`;
    const tenant = await fixture.pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
      [slug, `${slug} Legal`, `${slug} Display`],
    );
    const tenantId = tenant.rows[0].id;
    const user = await fixture.pool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
       VALUES ($1, 'Ctx User', $2, $3, true) RETURNING id`,
      [tenantId, email, await hashPassword(PASSWORD)],
    );
    const userId = user.rows[0].id;
    const loc = await fixture.pool.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, name, latitude, longitude, radius_m, active)
       VALUES ($1, 'HQ', '-6.200000', '106.816666', 150, true) RETURNING id`,
      [tenantId],
    );
    await fixture.pool.query(`INSERT INTO user_locations (tenant_id, user_id, location_id) VALUES ($1, $2, $3)`, [
      tenantId,
      userId,
      loc.rows[0].id,
    ]);

    const { token } = await login(slug, email, PASSWORD, {});
    const res = await GET(
      new NextRequest('http://localhost/api/v1/attendance/context', {
        headers: { cookie: `vortech_session=${token}` },
      }),
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.policy.geofenceMode, 'mandatory', 'employee default');
    assert.equal(body.policy.maxAccuracyM, 50);
    assert.equal(body.locations.length, 1);
    assert.equal(body.locations[0].name, 'HQ');
    assert.equal(body.locations[0].latitude, -6.2);
    assert.equal(body.locations[0].radiusM, 150);
    assert.ok(typeof body.serverNow === 'string' && !Number.isNaN(Date.parse(body.serverNow)), 'serverNow ISO');
    assert.ok('schedule' in body, 'schedule key present (null when no assignment)');
    assert.equal(body.schedule, null);
  });
});

test('GET /attendance/context: unauthenticated → 401 SESSION_EXPIRED', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const res = await GET(new NextRequest('http://localhost/api/v1/attendance/context'));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { code: 'SESSION_EXPIRED', message: 'Session expired or invalid' });
  });
});
