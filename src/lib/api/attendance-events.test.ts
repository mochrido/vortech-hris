import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import pg from 'pg';
import { NextRequest } from 'next/server.js';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { createSession } from '../auth/session.ts';

import { POST as postEvent } from '../../app/api/v1/attendance/events/route.ts';
import { GET as getEvent } from '../../app/api/v1/attendance/events/[id]/route.ts';
import { GET as getObject } from '../../app/api/v1/objects/[id]/route.ts';
import { GET as getTeamToday } from '../../app/api/v1/manager/team/today/route.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

const TZ = 'Asia/Jakarta'; // UTC+7

// --- Minimal JPEG fixture (SOI, APP0, SOF0, EOI) -----------------------------
function makeJpeg(width: number, height: number): Buffer {
  const bytes: number[] = [0xff, 0xd8];
  bytes.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  bytes.push(0xff, 0xc0, 0x00, 0x08, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x01);
  bytes.push(0xff, 0xd9);
  return Buffer.from(bytes);
}
const SELFIE = makeJpeg(640, 480);

// --- Env / DB fixture ---------------------------------------------------------

type EnvKey = 'DATABASE_URL' | 'SESSION_COOKIE_NAME' | 'STORAGE_DIR';

interface Fixture {
  url: string;
  pool: pg.Pool;
  storageDir: string;
}

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
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

async function setup(t: test.TestContext): Promise<Fixture> {
  await closePool();
  const url = await createTestDatabase();
  const pool = new pg.Pool({ connectionString: url });
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortech-objects-'));
  t.after(async () => {
    await closePool();
    await pool.end();
    await dropTestDatabase(url);
    await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  });
  await runMigrations(pool, migrationsDir);
  return { url, pool, storageDir };
}

function envFor(fx: Fixture): Record<EnvKey, string> {
  return {
    DATABASE_URL: fx.url,
    SESSION_COOKIE_NAME: 'vortech_session',
    STORAGE_DIR: fx.storageDir,
  };
}

// --- Seed helpers -------------------------------------------------------------

async function insertTenant(pool: pg.Pool, opts: { maxAccuracyM?: number } = {}): Promise<string> {
  const slug = `tenant-${randomBytes(4).toString('hex')}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name, max_accuracy_m) VALUES ($1, $2, $3, $4) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`, opts.maxAccuracyM ?? 50],
  );
  return r.rows[0].id;
}

async function insertUser(pool: pg.Pool, tenantId: string, opts: { employmentType?: string; name?: string } = {}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, employment_type, active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [tenantId, opts.name ?? 'Test User', `user-${randomBytes(4).toString('hex')}@example.com`, 'scrypt$1$1$1$AAAA$BBBB', opts.employmentType ?? 'employee'],
  );
  return r.rows[0].id;
}

async function insertRole(pool: pg.Pool, userId: string, role: string): Promise<void> {
  await pool.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [userId, role]);
}

async function insertSchedule(pool: pg.Pool, tenantId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
     VALUES ($1, 'Office Fixed', $2, '09:00', '17:00', false, 10, 60) RETURNING id`,
    [tenantId, TZ],
  );
  const scheduleId = r.rows[0].id;
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await pool.query(`INSERT INTO schedule_days (schedule_id, weekday) VALUES ($1, $2)`, [scheduleId, weekday]);
  }
  return scheduleId;
}

async function assignSchedule(pool: pg.Pool, userId: string, scheduleId: string): Promise<void> {
  await pool.query(
    `INSERT INTO user_schedule_assignments (user_id, schedule_id, effective_from, effective_to) VALUES ($1, $2, '2020-01-01', NULL)`,
    [userId, scheduleId],
  );
}

async function insertLocation(pool: pg.Pool, tenantId: string, opts: { lat: string; lon: string; radiusM?: number }): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO locations (tenant_id, name, latitude, longitude, radius_m, active) VALUES ($1, 'HQ', $2, $3, $4, true) RETURNING id`,
    [tenantId, opts.lat, opts.lon, opts.radiusM ?? 200],
  );
  return r.rows[0].id;
}

async function assignLocation(pool: pg.Pool, userId: string, locationId: string): Promise<void> {
  await pool.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [userId, locationId]);
}

async function makeSession(userId: string): Promise<string> {
  const created = await createSession(userId, {});
  return created.token;
}

function authedReq(url: string, token: string, init: { method?: string; body?: FormData } = {}): NextRequest {
  const headers = new Headers();
  headers.set('cookie', `vortech_session=${token}`);
  return new NextRequest(url, { method: init.method ?? 'GET', body: init.body ?? null, headers });
}

function multipart(metadata: Record<string, unknown>, selfie?: Buffer, fieldName = 'selfie'): FormData {
  const fd = new FormData();
  fd.set('metadata', JSON.stringify(metadata));
  if (selfie) {
    fd.set(fieldName, new Blob([new Uint8Array(selfie)], { type: 'image/jpeg' }), 'selfie.jpg');
  }
  return fd;
}

// 2026-08-06 is a Thursday. 10:00 local (UTC+7) = 03:00 UTC.
const CHECKIN_AT = '2026-08-06T03:00:00.000Z';

interface SeededMember {
  tenantId: string;
  userId: string;
  token: string;
  locationId: string;
}

async function seedMember(fx: Fixture, opts: { employmentType?: string } = {}): Promise<SeededMember> {
  const tenantId = await insertTenant(fx.pool);
  const userId = await insertUser(fx.pool, tenantId, { employmentType: opts.employmentType });
  await insertRole(fx.pool, userId, 'employee');
  const scheduleId = await insertSchedule(fx.pool, tenantId);
  await assignSchedule(fx.pool, userId, scheduleId);
  const locationId = await insertLocation(fx.pool, tenantId, { lat: '-6.200000', lon: '106.816666', radiusM: 200 });
  await assignLocation(fx.pool, userId, locationId);
  const token = await makeSession(userId);
  return { tenantId, userId, token, locationId };
}

const INSIDE = { latitude: -6.2, longitude: 106.816666, accuracyM: 10 };

// --- Tests --------------------------------------------------------------------

test('POST /attendance/events: accepts a valid check-in with selfie and returns 201 + accepted', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const metadata = { eventType: 'check_in', idempotencyKey: 'k-1', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const req = authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) });

    const res = await postEvent(req);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.created, true);
    assert.equal(body.outcome, 'accepted');
    assert.ok(body.event.id);
    assert.equal(body.event.event_type, 'check_in');
    assert.ok(body.event.selfie_object_id, 'selfie should be stored and linked');
    assert.ok(body.workInstance.id);
  });
});

test('POST /attendance/events: requires an idempotency key', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const metadata = { eventType: 'check_in', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const req = authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) });

    const res = await postEvent(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
  });
});

test('POST /attendance/events: rejects an invalid eventType', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const metadata = { eventType: 'lunch', idempotencyKey: 'k-bad', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const req = authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) });

    const res = await postEvent(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
  });
});

test('POST /attendance/events: rejects a non-JPEG / oversized selfie with VALIDATION_FAILED', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const metadata = { eventType: 'check_in', idempotencyKey: 'k-badjpeg', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const notJpeg = Buffer.from('this is not a jpeg at all');
    const req = authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, notJpeg) });

    const res = await postEvent(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'VALIDATION_FAILED');
  });
});

test('POST /attendance/events: duplicate idempotency key returns the ORIGINAL with created:false and HTTP 200', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const metadata = { eventType: 'check_in', idempotencyKey: 'k-dup', deviceOccurredAt: CHECKIN_AT, ...INSIDE };

    const first = await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) }));
    assert.equal(first.status, 201);
    const firstBody = await first.json();

    const second = await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) }));
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.created, false);
    assert.equal(secondBody.event.id, firstBody.event.id, 'original event returned on idempotent replay');

    const count = await fx.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM attendance_events WHERE idempotency_key = 'k-dup'`);
    assert.equal(Number(count.rows[0].count), 1, 'no duplicate row inserted');
  });
});

test('POST /attendance/events: a mandatory-geofence worker outside all locations is blocked (422)', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx); // employee → mandatory
    const metadata = { eventType: 'check_in', idempotencyKey: 'k-blocked', deviceOccurredAt: CHECKIN_AT, latitude: -6.5, longitude: 107.2, accuracyM: 10 };
    const res = await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) }));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.outcome, 'blocked');
    assert.ok(body.verdict);

    const count = await fx.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM attendance_events`);
    assert.equal(Number(count.rows[0].count), 0, 'blocked event must not persist a row');
  });
});

test('POST /attendance/events: a second different check-in for the same work instance is rejected (409)', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const first = { eventType: 'check_in', idempotencyKey: 'k-a', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(first, SELFIE) }));

    const second = { eventType: 'check_in', idempotencyKey: 'k-b', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const res = await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(second, SELFIE) }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.outcome, 'rejected');
  });
});

test('POST /attendance/events: unauthenticated request returns 401', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const metadata = { eventType: 'check_in', idempotencyKey: 'k-noauth', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const req = new NextRequest('http://localhost/api/v1/attendance/events', { method: 'POST', body: multipart(metadata, SELFIE) });
    const res = await postEvent(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'SESSION_EXPIRED');
  });
});

test('POST /attendance/events: tenant scope comes from the session — a tenant-B session cannot write into tenant A', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    // Two fully-provisioned tenants, each with a member + schedule + location.
    const a = await seedMember(fx);
    const b = await seedMember(fx);
    assert.notEqual(a.tenantId, b.tenantId, 'distinct tenants seeded');

    // Authenticate as tenant B's user. The metadata JSON even carries a decoy
    // tenantId pointing at tenant A; the route parses NO tenantId from metadata
    // (scope is session-derived), so it must be ignored entirely.
    const metadata = {
      eventType: 'check_in',
      idempotencyKey: 'k-xtenant',
      deviceOccurredAt: CHECKIN_AT,
      ...INSIDE,
      tenantId: a.tenantId, // decoy: must be ignored
    };
    const res = await postEvent(authedReq('http://localhost/api/v1/attendance/events', b.token, { method: 'POST', body: multipart(metadata, SELFIE) }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.created, true);

    // The created event belongs to tenant B and tenant B's user — never A.
    assert.equal(body.event.tenant_id, b.tenantId, 'event tenant_id is the session tenant (B), not the decoy (A)');
    assert.notEqual(body.event.tenant_id, a.tenantId);
    assert.equal(body.event.user_id, b.userId, 'event user_id is the session user (B)');

    // The DB agrees: the row was written under tenant B, and tenant A has none.
    const bRows = await fx.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM attendance_events WHERE tenant_id = $1`, [b.tenantId]);
    assert.equal(Number(bRows.rows[0].count), 1, 'exactly one event written, under tenant B');
    const aRows = await fx.pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM attendance_events WHERE tenant_id = $1`, [a.tenantId]);
    assert.equal(Number(aRows.rows[0].count), 0, 'no event row created under tenant A');
  });
});

test('GET /attendance/events/[id]: returns the event for the owner only', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const metadata = { eventType: 'check_in', idempotencyKey: 'k-own', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const created = await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) }));
    const createdBody = await created.json();
    const eventId = createdBody.event.id as string;

    const ok = await getEvent(authedReq(`http://localhost/api/v1/attendance/events/${eventId}`, m.token), { params: Promise.resolve({ id: eventId }) });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.event.id, eventId);
    assert.equal(okBody.event.user_id, m.userId);
  });
});

test('GET /attendance/events/[id]: another user in the same tenant gets 404 (no existence leak)', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const other = await insertUser(fx.pool, m.tenantId);
    await insertRole(fx.pool, other, 'employee');
    const otherToken = await makeSession(other);

    const metadata = { eventType: 'check_in', idempotencyKey: 'k-private', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const created = await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) }));
    const eventId = (await created.json()).event.id as string;

    const res = await getEvent(authedReq(`http://localhost/api/v1/attendance/events/${eventId}`, otherToken), { params: Promise.resolve({ id: eventId }) });
    assert.equal(res.status, 404);
  });
});

test('GET /objects/[id]: streams the selfie to an authorized same-tenant session', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const metadata = { eventType: 'check_in', idempotencyKey: 'k-obj', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const created = await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) }));
    const objectId = (await created.json()).event.selfie_object_id as string;

    const res = await getObject(authedReq(`http://localhost/api/v1/objects/${objectId}`, m.token), { params: Promise.resolve({ id: objectId }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('content-length'), String(SELFIE.length));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, SELFIE);
  });
});

test('GET /objects/[id]: cross-tenant session gets 404', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const metadata = { eventType: 'check_in', idempotencyKey: 'k-xobj', deviceOccurredAt: CHECKIN_AT, ...INSIDE };
    const created = await postEvent(authedReq('http://localhost/api/v1/attendance/events', m.token, { method: 'POST', body: multipart(metadata, SELFIE) }));
    const objectId = (await created.json()).event.selfie_object_id as string;

    // A different tenant's user.
    const otherTenant = await insertTenant(fx.pool);
    const outsider = await insertUser(fx.pool, otherTenant);
    await insertRole(fx.pool, outsider, 'employee');
    const outsiderToken = await makeSession(outsider);

    const res = await getObject(authedReq(`http://localhost/api/v1/objects/${objectId}`, outsiderToken), { params: Promise.resolve({ id: objectId }) });
    assert.equal(res.status, 404);
  });
});

test('GET /objects/[id]: unknown object id returns 404', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const m = await seedMember(fx);
    const missing = '00000000-0000-0000-0000-000000000000';
    const res = await getObject(authedReq(`http://localhost/api/v1/objects/${missing}`, m.token), { params: Promise.resolve({ id: missing }) });
    assert.equal(res.status, 404);
  });
});

test('GET /manager/team/today: returns only the manager assigned-team members today status', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const tenantId = await insertTenant(fx.pool);
    const scheduleId = await insertSchedule(fx.pool, tenantId);

    const manager = await insertUser(fx.pool, tenantId, { name: 'Mgr' });
    await insertRole(fx.pool, manager, 'manager');
    const member = await insertUser(fx.pool, tenantId, { name: 'Member' });
    await insertRole(fx.pool, member, 'employee');
    await assignSchedule(fx.pool, member, scheduleId);

    // A team assigned to the manager containing the member.
    const team = await fx.pool.query<{ id: string }>(`INSERT INTO teams (tenant_id, name) VALUES ($1, 'Alpha') RETURNING id`, [tenantId]);
    await fx.pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [team.rows[0].id, member]);
    await fx.pool.query(`INSERT INTO manager_teams (manager_user_id, team_id) VALUES ($1, $2)`, [manager, team.rows[0].id]);

    // An unrelated team NOT assigned to the manager.
    const otherMember = await insertUser(fx.pool, tenantId, { name: 'Other' });
    const otherTeam = await fx.pool.query<{ id: string }>(`INSERT INTO teams (tenant_id, name) VALUES ($1, 'Beta') RETURNING id`, [tenantId]);
    await fx.pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [otherTeam.rows[0].id, otherMember]);

    const managerToken = await makeSession(manager);
    const res = await getTeamToday(authedReq('http://localhost/api/v1/manager/team/today', managerToken));
    assert.equal(res.status, 200);
    const body = await res.json();
    const names = body.members.map((x: { displayName: string }) => x.displayName);
    assert.ok(names.includes('Member'), 'assigned team member present');
    assert.ok(!names.includes('Other'), 'unassigned team member excluded');
    const memberEntry = body.members.find((x: { displayName: string }) => x.displayName === 'Member');
    assert.ok(memberEntry.workDate, 'today work date present');
  });
});

test('GET /manager/team/today: a non-manager gets 403', async (t) => {
  const fx = await setup(t);
  await withEnv(envFor(fx), async () => {
    const tenantId = await insertTenant(fx.pool);
    const plain = await insertUser(fx.pool, tenantId);
    await insertRole(fx.pool, plain, 'employee');
    const token = await makeSession(plain);

    const res = await getTeamToday(authedReq('http://localhost/api/v1/manager/team/today', token));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'FORBIDDEN');
  });
});
