import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { getAttendanceContext } from './context.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

const TZ = 'Asia/Jakarta'; // UTC+7

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

async function insertTenant(pool: pg.Pool, opts: { maxAccuracyM?: number } = {}): Promise<string> {
  const slug = `tenant-${randomBytes(4).toString('hex')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name, max_accuracy_m) VALUES ($1, $2, $3, $4) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`, opts.maxAccuracyM ?? 50],
  );
  return result.rows[0].id;
}

async function insertUser(
  pool: pg.Pool,
  tenantId: string,
  opts: { employmentType?: string } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, employment_type, active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [
      tenantId,
      'Test User',
      `user-${randomBytes(4).toString('hex')}@example.com`,
      'scrypt$1$1$1$AAAA$BBBB',
      opts.employmentType ?? 'employee',
    ],
  );
  return result.rows[0].id;
}

async function insertSchedule(pool: pg.Pool, tenantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
     VALUES ($1, 'Office Fixed', $2, '09:00', '17:00', false, 10, 60) RETURNING id`,
    [tenantId, TZ],
  );
  const scheduleId = result.rows[0].id;
  for (const weekday of [1, 2, 3, 4, 5]) {
    await pool.query(`INSERT INTO schedule_days (schedule_id, weekday) VALUES ($1, $2)`, [scheduleId, weekday]);
  }
  return scheduleId;
}

async function assignSchedule(pool: pg.Pool, tenantId: string, userId: string, scheduleId: string): Promise<void> {
  await pool.query(
    `INSERT INTO user_schedule_assignments (tenant_id, user_id, schedule_id, effective_from, effective_to)
     VALUES ($1, $2, $3, '2026-01-01', NULL)`,
    [tenantId, userId, scheduleId],
  );
}

async function insertLocation(
  pool: pg.Pool,
  tenantId: string,
  opts: { name: string; lat: string; lon: string; radiusM?: number | null; active?: boolean },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO locations (tenant_id, name, latitude, longitude, radius_m, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, opts.name, opts.lat, opts.lon, opts.radiusM ?? 100, opts.active ?? true],
  );
  return result.rows[0].id;
}

async function assignLocation(pool: pg.Pool, tenantId: string, userId: string, locationId: string): Promise<void> {
  await pool.query(`INSERT INTO user_locations (tenant_id, user_id, location_id) VALUES ($1, $2, $3)`, [
    tenantId,
    userId,
    locationId,
  ]);
}

// 2026-08-06 is a Thursday. 10:00 local (UTC+7) = 03:00 UTC.
const NOW = new Date('2026-08-06T03:00:00.000Z');

test('context: returns schedule, policy, assigned active locations, and server time', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, { maxAccuracyM: 50 });
  const userId = await insertUser(fixture.pool, tenantId);
  const scheduleId = await insertSchedule(fixture.pool, tenantId);
  await assignSchedule(fixture.pool, tenantId, userId, scheduleId);
  const locA = await insertLocation(fixture.pool, tenantId, { name: 'HQ', lat: '-6.200000', lon: '106.816666', radiusM: 150 });
  const locB = await insertLocation(fixture.pool, tenantId, { name: 'Branch', lat: '-6.300000', lon: '106.800000', radiusM: 75 });
  await assignLocation(fixture.pool, tenantId, userId, locA);
  await assignLocation(fixture.pool, tenantId, userId, locB);

  const before = Date.now();
  const ctx = await getAttendanceContext(fixture.pool, tenantId, userId, NOW);
  const after = Date.now();

  // Schedule composed from schedule.ts (Mon-Fri 09:00-17:00, Thu 2026-08-06).
  assert.ok(ctx.schedule, 'expected an effective schedule');
  assert.equal(ctx.schedule.scheduleId, scheduleId);
  assert.equal(ctx.schedule.workDate, '2026-08-06');
  assert.equal(ctx.schedule.graceMinutes, 10);
  assert.equal(ctx.schedule.breakMinutes, 60);
  assert.equal(ctx.schedule.scheduledStartAt.toISOString(), '2026-08-06T02:00:00.000Z');

  // Policy: employee with no assignment → tenant-default mandatory.
  assert.equal(ctx.policy.geofenceMode, 'mandatory');
  assert.equal(ctx.policy.maxAccuracyM, 50);
  assert.equal(ctx.policy.retryCount, 3);
  assert.equal(ctx.policy.selfieRequired, true);

  // Both assigned ACTIVE locations, with numeric coordinates and tenant filter.
  assert.equal(ctx.locations.length, 2);
  const byName = new Map(ctx.locations.map((l) => [l.name, l]));
  const hq = byName.get('HQ');
  assert.ok(hq);
  assert.equal(hq.id, locA);
  assert.equal(hq.latitude, -6.2);
  assert.equal(hq.longitude, 106.816666);
  assert.equal(hq.radiusM, 150);
  assert.ok(byName.has('Branch'));

  // Server time is "now" (within the call window), not the schedule instant.
  const serverNowMs = new Date(ctx.serverNow).getTime();
  assert.ok(serverNowMs >= before - 1000 && serverNowMs <= after + 1000, `serverNow ${ctx.serverNow} not near real now`);
});

test('context: schedule is null when the user has no schedule assignment', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);

  const ctx = await getAttendanceContext(fixture.pool, tenantId, userId, NOW);
  assert.equal(ctx.schedule, null);
  assert.equal(ctx.locations.length, 0);
  // Policy still resolves from the employment-type default.
  assert.equal(ctx.policy.geofenceMode, 'mandatory');
});

test('context: schedule resolves null on a non-working weekday (Saturday)', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);
  const scheduleId = await insertSchedule(fixture.pool, tenantId);
  await assignSchedule(fixture.pool, tenantId, userId, scheduleId);

  // 2026-08-08 is a Saturday: 10:00 local = 03:00 UTC.
  const saturday = new Date('2026-08-08T03:00:00.000Z');
  const ctx = await getAttendanceContext(fixture.pool, tenantId, userId, saturday);
  assert.equal(ctx.schedule, null, 'Mon-Fri schedule must not resolve on Saturday');
});

test('context: schedule resolves with isHoliday true on a tenant holiday', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);
  const scheduleId = await insertSchedule(fixture.pool, tenantId);
  await assignSchedule(fixture.pool, tenantId, userId, scheduleId);
  await fixture.pool.query(
    `INSERT INTO holidays (tenant_id, holiday_date, name, kind) VALUES ($1, '2026-08-06', 'Company Day', 'company')`,
    [tenantId],
  );

  const ctx = await getAttendanceContext(fixture.pool, tenantId, userId, NOW);
  assert.ok(ctx.schedule, 'schedule still resolves on a holiday');
  assert.equal(ctx.schedule.isHoliday, true);
});

test('context: field_worker resolves the optional geofence default', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId, { employmentType: 'field_worker' });

  const ctx = await getAttendanceContext(fixture.pool, tenantId, userId, NOW);
  assert.equal(ctx.policy.geofenceMode, 'optional');
});

test('context: an active policy assignment overrides the employment-type default', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId, { employmentType: 'field_worker' });
  const policy = await fixture.pool.query<{ id: string }>(
    `INSERT INTO attendance_policies (tenant_id, name, geofence_mode, selfie_required, max_accuracy_m, retry_count)
     VALUES ($1, 'Strict', 'mandatory', false, 25, 5) RETURNING id`,
    [tenantId],
  );
  await fixture.pool.query(
    `INSERT INTO user_policy_assignments (tenant_id, user_id, policy_id, effective_from, effective_to)
     VALUES ($1, $2, $3, '2026-01-01', NULL)`,
    [tenantId, userId, policy.rows[0].id],
  );

  const ctx = await getAttendanceContext(fixture.pool, tenantId, userId, NOW);
  assert.equal(ctx.policy.geofenceMode, 'mandatory');
  assert.equal(ctx.policy.maxAccuracyM, 25);
  assert.equal(ctx.policy.retryCount, 5);
  assert.equal(ctx.policy.selfieRequired, false);
});

test('context: inactive and unassigned locations are excluded', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);
  const activeLoc = await insertLocation(fixture.pool, tenantId, { name: 'Active', lat: '-6.2', lon: '106.8', radiusM: 100 });
  const inactiveLoc = await insertLocation(fixture.pool, tenantId, { name: 'Inactive', lat: '-6.3', lon: '106.9', radiusM: 100, active: false });
  const otherUserLoc = await insertLocation(fixture.pool, tenantId, { name: 'Other', lat: '-6.4', lon: '107.0', radiusM: 100 });
  await assignLocation(fixture.pool, tenantId, userId, activeLoc);
  await assignLocation(fixture.pool, tenantId, userId, inactiveLoc);
  // Assigned to a DIFFERENT user — must not leak into this user's context.
  const otherUser = await insertUser(fixture.pool, tenantId);
  await assignLocation(fixture.pool, tenantId, otherUser, otherUserLoc);

  const ctx = await getAttendanceContext(fixture.pool, tenantId, userId, NOW);
  assert.deepEqual(ctx.locations.map((l) => l.name), ['Active']);
});

test('context: locations never leak across tenants', async (t) => {
  const fixture = await setupDb(t);
  const tenantA = await insertTenant(fixture.pool);
  const tenantB = await insertTenant(fixture.pool);
  const userA = await insertUser(fixture.pool, tenantA);
  const locB = await insertLocation(fixture.pool, tenantB, { name: 'B-Loc', lat: '-6.2', lon: '106.8', radiusM: 100 });
  // Pathological: user A (tenant A) is assigned to tenant B's location. The
  // composite tenant FK (0007) makes the inconsistency impossible at the
  // database level.
  await assert.rejects(assignLocation(fixture.pool, tenantA, userA, locB), (error: unknown) => {
    assert.equal((error as { code?: string }).code, '23503');
    return true;
  });

  const ctx = await getAttendanceContext(fixture.pool, tenantA, userA, NOW);
  assert.equal(ctx.locations.length, 0, 'a location from another tenant must never be returned');
});
