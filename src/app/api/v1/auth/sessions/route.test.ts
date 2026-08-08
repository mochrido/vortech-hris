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

function authedGet(url: string, token: string): NextRequest {
  return new NextRequest(url, { headers: { cookie: `vortech_session=${token}` } });
}

test('GET /auth/sessions: lists only the caller’s sessions, never token_hash', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const slug = `acme-${randomBytes(3).toString('hex')}`;
    const email = `u-${randomBytes(3).toString('hex')}@example.com`;
    const tenant = await fixture.pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
      [slug, `${slug} Legal`, `${slug} Display`],
    );
    const user = await fixture.pool.query<{ id: string }>(
      `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
       VALUES ($1, 'Sessions User', $2, $3, true) RETURNING id`,
      [tenant.rows[0].id, email, await hashPassword(PASSWORD)],
    );

    const s1 = await login(slug, email, PASSWORD, { userAgent: 'UA-one', deviceLabel: 'Phone', ip: '203.0.113.1' });
    const s2 = await login(slug, email, PASSWORD, { userAgent: 'UA-two' });

    const res = await GET(authedGet('http://localhost/api/v1/auth/sessions', s1.token));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sessions.length, 2, 'both of the user’s sessions listed');

    const ids = new Set(body.sessions.map((s: { id: string }) => s.id));
    assert.ok(ids.has(s1.session.id));
    assert.ok(ids.has(s2.session.id));

    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('token_hash'), 'token_hash must never be exposed');
    assert.ok(!raw.includes(s1.token), 'raw token must never be exposed');
    assert.ok(!raw.includes(s2.token), 'raw token must never be exposed');

    const first = body.sessions.find((s: { id: string }) => s.id === s1.session.id);
    assert.equal(first.userAgent, 'UA-one');
    assert.equal(first.deviceLabel, 'Phone');
    assert.ok(first.ip.startsWith('203.0.113.1'));
    assert.ok(first.createdAt);
    assert.ok(first.expiresAt);
    assert.ok(Object.hasOwn(first, 'lastSeenAt'), 'lastSeenAt key present');
  });
});

test('GET /auth/sessions: unauthenticated → 401 SESSION_EXPIRED', async (t) => {
  const fixture = await setupDb(t);
  await withEnv(envFor(fixture), async () => {
    const res = await GET(new NextRequest('http://localhost/api/v1/auth/sessions'));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { code: 'SESSION_EXPIRED', message: 'Session expired or invalid' });
  });
});
