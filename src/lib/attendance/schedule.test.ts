import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { getEffectiveSchedule } from './schedule.ts';

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

async function insertTenant(pool: pg.Pool, slug: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`],
  );
  return result.rows[0].id;
}

async function insertUser(pool: pg.Pool, tenantId: string, email: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [tenantId, 'Test User', email, 'scrypt$1$1$1$AAAA$BBBB'],
  );
  return result.rows[0].id;
}

/** Fixed schedule. weekdays: 0=Sun..6=Sat. */
async function insertSchedule(
  pool: pg.Pool,
  tenantId: string,
  opts: {
    name: string;
    startLocal: string;
    endLocal: string;
    crossesMidnight?: boolean;
    graceMinutes?: number;
    breakMinutes?: number;
    weekdays: number[];
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      tenantId,
      opts.name,
      TZ,
      opts.startLocal,
      opts.endLocal,
      opts.crossesMidnight ?? false,
      opts.graceMinutes ?? 0,
      opts.breakMinutes ?? 0,
    ],
  );
  const scheduleId = result.rows[0].id;
  for (const weekday of opts.weekdays) {
    await pool.query(`INSERT INTO schedule_days (schedule_id, weekday) VALUES ($1, $2)`, [scheduleId, weekday]);
  }
  return scheduleId;
}

async function assignSchedule(
  pool: pg.Pool,
  tenantId: string,
  userId: string,
  scheduleId: string,
  effectiveFrom: string,
  effectiveTo: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_schedule_assignments (tenant_id, user_id, schedule_id, effective_from, effective_to)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, userId, scheduleId, effectiveFrom, effectiveTo],
  );
}

async function insertHoliday(
  pool: pg.Pool,
  tenantId: string | null,
  date: string,
  name: string,
  kind: string,
): Promise<void> {
  await pool.query(`INSERT INTO holidays (tenant_id, holiday_date, name, kind) VALUES ($1, $2, $3, $4)`, [
    tenantId,
    date,
    name,
    kind,
  ]);
}

// ---------------------------------------------------------------------------
// 1. Fixed Mon-Fri 09:00-17:00 schedule on a working weekday
//    2026-08-06 is a Thursday.
// ---------------------------------------------------------------------------
test('getEffectiveSchedule returns schedule with computed work_date and bounds on a working weekday', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'acme');
  const userId = await insertUser(fixture.pool, tenantId, 'alice@acme.test');
  const scheduleId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Office Fixed',
    startLocal: '09:00',
    endLocal: '17:00',
    graceMinutes: 10,
    breakMinutes: 60,
    weekdays: [1, 2, 3, 4, 5], // Mon-Fri
  });
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId, '2026-01-01', null);

  // 2026-08-06 10:00 local (Asia/Jakarta = UTC+7) => 03:00 UTC
  const atUtc = new Date('2026-08-06T03:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.ok(result, 'expected a schedule for a working weekday');
  assert.equal(result.scheduleId, scheduleId);
  assert.equal(result.workDate, '2026-08-06');
  assert.equal(result.isHoliday, false);
  assert.equal(result.crossesMidnight, false);
  assert.equal(result.graceMinutes, 10);
  assert.equal(result.breakMinutes, 60);

  // scheduled_start_at = 2026-08-06 09:00 +07:00 = 02:00 UTC
  assert.equal(result.scheduledStartAt.toISOString(), '2026-08-06T02:00:00.000Z');
  // scheduled_end_at = 2026-08-06 17:00 +07:00 = 10:00 UTC
  assert.equal(result.scheduledEndAt.toISOString(), '2026-08-06T10:00:00.000Z');
});

// ---------------------------------------------------------------------------
// 2. Cross-midnight 22:00-06:00; an event at 02:00 local belongs to the
//    PRIOR work date (the scheduled start date).
//    Schedule active on weekday 4 (Thursday 2026-08-06). Event at
//    2026-08-07 02:00 local => work_date 2026-08-06.
// ---------------------------------------------------------------------------
test('getEffectiveSchedule attributes post-midnight times of a cross-midnight shift to the prior work date', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'night');
  const userId = await insertUser(fixture.pool, tenantId, 'bob@night.test');
  // Night shift active Thursday (4) and Friday (5)
  const scheduleId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Night Shift',
    startLocal: '22:00',
    endLocal: '06:00',
    crossesMidnight: true,
    weekdays: [4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId, '2026-01-01', null);

  // 2026-08-07 02:00 local => 2026-08-06 19:00 UTC
  const atUtc = new Date('2026-08-06T19:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.ok(result, 'expected a schedule for a cross-midnight shift');
  assert.equal(result.scheduleId, scheduleId);
  assert.equal(result.crossesMidnight, true);
  // Work date must be the start date: Thursday 2026-08-06
  assert.equal(result.workDate, '2026-08-06');
  // scheduled_start_at = 2026-08-06 22:00 +07:00 = 15:00 UTC
  assert.equal(result.scheduledStartAt.toISOString(), '2026-08-06T15:00:00.000Z');
  // scheduled_end_at = 2026-08-07 06:00 +07:00 = 2026-08-06 23:00 UTC
  assert.equal(result.scheduledEndAt.toISOString(), '2026-08-06T23:00:00.000Z');
  assert.equal(result.isHoliday, false);
});

// Same cross-midnight schedule, but the event is on the start-date evening
// (2026-08-06 23:00 local) => work_date is still 2026-08-06.
test('getEffectiveSchedule cross-midnight evening event resolves to same-day work date', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'night2');
  const userId = await insertUser(fixture.pool, tenantId, 'carol@night2.test');
  const scheduleId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Night Shift',
    startLocal: '22:00',
    endLocal: '06:00',
    crossesMidnight: true,
    weekdays: [4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId, '2026-01-01', null);

  // 2026-08-06 23:00 local => 16:00 UTC
  const atUtc = new Date('2026-08-06T16:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.ok(result);
  assert.equal(result.workDate, '2026-08-06');
  assert.equal(result.scheduledStartAt.toISOString(), '2026-08-06T15:00:00.000Z');
  assert.equal(result.scheduledEndAt.toISOString(), '2026-08-06T23:00:00.000Z');
});

// ---------------------------------------------------------------------------
// 3. Holiday: a date matching a national holiday (tenant_id NULL) yields a
//    non-working result with isHoliday true.
//    2026-08-17 is Indonesian Independence Day.
//    2026-08-17 is a Monday (weekday 1).
// ---------------------------------------------------------------------------
test('getEffectiveSchedule returns isHoliday true for a national holiday (tenant_id NULL)', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'hol');
  const userId = await insertUser(fixture.pool, tenantId, 'dave@hol.test');
  const scheduleId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Office Fixed',
    startLocal: '09:00',
    endLocal: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId, '2026-01-01', null);
  await insertHoliday(fixture.pool, null, '2026-08-17', 'Hari Kemerdekaan', 'national');

  // 2026-08-17 10:00 local => 03:00 UTC
  const atUtc = new Date('2026-08-17T03:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.ok(result, 'a holiday still returns the resolved schedule, flagged');
  assert.equal(result.scheduleId, scheduleId);
  assert.equal(result.isHoliday, true);
  assert.equal(result.workDate, '2026-08-17');
});

// Tenant-specific holiday (kind company) also yields isHoliday true.
test('getEffectiveSchedule returns isHoliday true for a tenant-specific holiday', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'hol2');
  const userId = await insertUser(fixture.pool, tenantId, 'erin@hol2.test');
  const scheduleId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Office Fixed',
    startLocal: '09:00',
    endLocal: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId, '2026-01-01', null);
  await insertHoliday(fixture.pool, tenantId, '2026-09-01', 'Company Anniversary', 'company');

  // 2026-09-01 is a Tuesday (weekday 2). 10:00 local => 03:00 UTC.
  const atUtc = new Date('2026-09-01T03:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.ok(result);
  assert.equal(result.isHoliday, true);
  assert.equal(result.workDate, '2026-09-01');
});

// A holiday belonging to a DIFFERENT tenant must not affect this user.
test('getEffectiveSchedule ignores a holiday belonging to a different tenant', async (t) => {
  const fixture = await setupDb(t);
  const tenantA = await insertTenant(fixture.pool, 'ten-a');
  const tenantB = await insertTenant(fixture.pool, 'ten-b');
  const userA = await insertUser(fixture.pool, tenantA, 'frank@ten-a.test');
  const scheduleId = await insertSchedule(fixture.pool, tenantA, {
    name: 'Office Fixed',
    startLocal: '09:00',
    endLocal: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  await assignSchedule(fixture.pool, tenantA, userA,scheduleId, '2026-01-01', null);
  // Holiday only for tenant B
  await insertHoliday(fixture.pool, tenantB, '2026-08-17', 'B Only Day', 'company');

  const atUtc = new Date('2026-08-17T03:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userA, tenantA, atUtc);

  assert.ok(result);
  assert.equal(result.isHoliday, false, 'another tenant holiday must not mark this as holiday');
});

// ---------------------------------------------------------------------------
// 4. Non-working weekday (not in schedule_days) → null.
//    2026-08-08 is a Saturday (weekday 6); schedule is Mon-Fri only.
// ---------------------------------------------------------------------------
test('getEffectiveSchedule returns null on a non-working weekday', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'wknd');
  const userId = await insertUser(fixture.pool, tenantId, 'gina@wknd.test');
  const scheduleId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Office Fixed',
    startLocal: '09:00',
    endLocal: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId, '2026-01-01', null);

  // Saturday 2026-08-08 10:00 local => 03:00 UTC
  const atUtc = new Date('2026-08-08T03:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.equal(result, null, 'expected null on a non-working weekday');
});

// ---------------------------------------------------------------------------
// 5. No active schedule assignment for the user → null.
// ---------------------------------------------------------------------------
test('getEffectiveSchedule returns null when the user has no active assignment', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'none');
  const userId = await insertUser(fixture.pool, tenantId, 'heidi@none.test');
  // Schedule exists but not assigned to this user.
  await insertSchedule(fixture.pool, tenantId, {
    name: 'Office Fixed',
    startLocal: '09:00',
    endLocal: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });

  const atUtc = new Date('2026-08-06T03:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.equal(result, null, 'expected null with no assignment');
});

// Assignment exists but is expired (effective_to in the past) → null.
test('getEffectiveSchedule returns null when the assignment is expired', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'expired');
  const userId = await insertUser(fixture.pool, tenantId, 'ivan@expired.test');
  const scheduleId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Office Fixed',
    startLocal: '09:00',
    endLocal: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId, '2026-01-01', '2026-06-30');

  const atUtc = new Date('2026-08-06T03:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.equal(result, null, 'expected null when the only assignment has expired');
});

// Assignment effective_from in the future → null.
test('getEffectiveSchedule returns null when the assignment has not started yet', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'future');
  const userId = await insertUser(fixture.pool, tenantId, 'judy@future.test');
  const scheduleId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Office Fixed',
    startLocal: '09:00',
    endLocal: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId, '2027-01-01', null);

  const atUtc = new Date('2026-08-06T03:00:00.000Z');
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.equal(result, null, 'expected null when the only assignment is future-dated');
});

// ---------------------------------------------------------------------------
// 6. Two overlapping active assignments → deterministically pick the one
//    with the latest effective_from; never return multiple.
// ---------------------------------------------------------------------------
test('getEffectiveSchedule picks the single latest effective_from among overlapping active assignments', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool, 'overlap');
  const userId = await insertUser(fixture.pool, tenantId, 'kate@overlap.test');

  // Older assignment: morning shift, effective from 2026-01-01.
  const morningId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Morning',
    startLocal: '09:00',
    endLocal: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,morningId, '2026-01-01', null);

  // Newer assignment: afternoon shift, effective from 2026-07-01 (overlaps).
  const afternoonId = await insertSchedule(fixture.pool, tenantId, {
    name: 'Afternoon',
    startLocal: '13:00',
    endLocal: '21:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  await assignSchedule(fixture.pool, tenantId, userId,afternoonId, '2026-07-01', null);

  const atUtc = new Date('2026-08-06T03:00:00.000Z'); // Thursday
  const result = await getEffectiveSchedule(fixture.pool, userId, tenantId, atUtc);

  assert.ok(result, 'expected exactly one effective schedule');
  assert.equal(result.scheduleId, afternoonId, 'must pick the assignment with the latest effective_from');
  // Afternoon shift: 13:00 +07:00 = 06:00 UTC
  assert.equal(result.scheduledStartAt.toISOString(), '2026-08-06T06:00:00.000Z');
});
