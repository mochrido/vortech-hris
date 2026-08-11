import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { getMyDashboard } from './me-dashboard.ts';

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

async function insertTenant(pool: pg.Pool): Promise<string> {
  const slug = `tenant-${randomBytes(4).toString('hex')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `${slug} Legal`, `${slug} Display`],
  );
  return result.rows[0].id;
}

async function insertUser(pool: pg.Pool, tenantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, active)
     VALUES ($1, 'Test User', $2, 'scrypt$1$1$1$AAAA$BBBB', true) RETURNING id`,
    [tenantId, `user-${randomBytes(4).toString('hex')}@example.com`],
  );
  return result.rows[0].id;
}

async function insertSchedule(pool: pg.Pool, tenantId: string, opts: { weekdays?: number[] } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
     VALUES ($1, 'Office Fixed', $2, '09:00', '17:00', false, 10, 60) RETURNING id`,
    [tenantId, TZ],
  );
  const scheduleId = result.rows[0].id;
  for (const weekday of opts.weekdays ?? [1, 2, 3, 4, 5]) {
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

async function insertWorkInstance(
  pool: pg.Pool,
  args: {
    tenantId: string;
    userId: string;
    workDate: string;
    scheduleId: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    status: string;
    lateMinutes?: number;
    workedMinutes?: number | null;
    reviewStatus?: string;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at,
                                 status, late_minutes, worked_minutes, review_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      args.tenantId,
      args.userId,
      args.workDate,
      args.scheduleId,
      args.scheduledStartAt,
      args.scheduledEndAt,
      args.status,
      args.lateMinutes ?? 0,
      args.workedMinutes ?? null,
      args.reviewStatus ?? 'clean',
    ],
  );
  return result.rows[0].id;
}

async function insertEvent(
  pool: pg.Pool,
  args: {
    tenantId: string;
    userId: string;
    workInstanceId: string;
    eventType: 'check_in' | 'check_out';
    idempotencyKey: string;
    deviceOccurredAt: string;
    status?: string;
    geofenceResult?: string;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO attendance_events (tenant_id, user_id, work_instance_id, event_type, idempotency_key,
                                    device_occurred_at, source, geofence_result, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'web_online', $7, $8) RETURNING id`,
    [
      args.tenantId,
      args.userId,
      args.workInstanceId,
      args.eventType,
      args.idempotencyKey,
      args.deviceOccurredAt,
      args.geofenceResult ?? 'inside',
      args.status ?? 'accepted',
    ],
  );
  return result.rows[0].id;
}

// 2026-08-06 is a Thursday. 10:00 local (UTC+7) = 03:00 UTC.
const NOW = new Date('2026-08-06T03:00:00.000Z');

test('dashboard: today shows the work instance with check-in/out times; recent lists prior days newest-first', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);
  const scheduleId = await insertSchedule(fixture.pool, tenantId);
  await assignSchedule(fixture.pool, tenantId, userId,scheduleId);

  // Today's instance: checked in at 09:05 local (02:05 UTC), not yet out.
  const todayWi = await insertWorkInstance(fixture.pool, {
    tenantId,
    userId,
    workDate: '2026-08-06',
    scheduleId,
    scheduledStartAt: '2026-08-06T02:00:00.000Z',
    scheduledEndAt: '2026-08-06T10:00:00.000Z',
    status: 'in_progress',
    lateMinutes: 5,
  });
  const checkInId = await insertEvent(fixture.pool, {
    tenantId,
    userId,
    workInstanceId: todayWi,
    eventType: 'check_in',
    idempotencyKey: 'today-in',
    deviceOccurredAt: '2026-08-06T02:05:00.000Z',
  });
  await fixture.pool.query(`UPDATE work_instances SET check_in_event_id = $1 WHERE id = $2`, [checkInId, todayWi]);

  // Yesterday's completed instance with both events.
  const yesterdayWi = await insertWorkInstance(fixture.pool, {
    tenantId,
    userId,
    workDate: '2026-08-05',
    scheduleId,
    scheduledStartAt: '2026-08-05T02:00:00.000Z',
    scheduledEndAt: '2026-08-05T10:00:00.000Z',
    status: 'completed',
    lateMinutes: 0,
    workedMinutes: 420,
  });
  const yIn = await insertEvent(fixture.pool, {
    tenantId,
    userId,
    workInstanceId: yesterdayWi,
    eventType: 'check_in',
    idempotencyKey: 'y-in',
    deviceOccurredAt: '2026-08-05T02:00:00.000Z',
  });
  const yOut = await insertEvent(fixture.pool, {
    tenantId,
    userId,
    workInstanceId: yesterdayWi,
    eventType: 'check_out',
    idempotencyKey: 'y-out',
    deviceOccurredAt: '2026-08-05T10:00:00.000Z',
  });
  await fixture.pool.query(`UPDATE work_instances SET check_in_event_id = $1, check_out_event_id = $2 WHERE id = $3`, [
    yIn,
    yOut,
    yesterdayWi,
  ]);

  const dash = await getMyDashboard(fixture.pool, tenantId, userId, NOW);

  assert.ok(dash.today, 'today entry expected');
  assert.equal(dash.today.workDate, '2026-08-06');
  assert.equal(dash.today.status, 'in_progress');
  assert.equal(dash.today.lateMinutes, 5);
  assert.equal(dash.today.checkInAt, '2026-08-06T02:05:00.000Z');
  assert.equal(dash.today.checkOutAt, null);
  assert.equal(dash.today.scheduledStartAt, '2026-08-06T02:00:00.000Z');
  assert.equal(dash.today.isHoliday, false);

  assert.equal(dash.recent.length, 1);
  const y = dash.recent[0];
  assert.equal(y.workDate, '2026-08-05');
  assert.equal(y.status, 'completed');
  assert.equal(y.checkInAt, '2026-08-05T02:00:00.000Z');
  assert.equal(y.checkOutAt, '2026-08-05T10:00:00.000Z');
  assert.equal(y.workedMinutes, 420);
});

test('dashboard: today reflects the effective schedule even before any work instance exists', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);
  await assignSchedule(fixture.pool, tenantId, userId,await insertSchedule(fixture.pool, tenantId));

  const dash = await getMyDashboard(fixture.pool, tenantId, userId, NOW);

  assert.ok(dash.today, 'today entry expected from the resolved schedule');
  assert.equal(dash.today.workDate, '2026-08-06');
  assert.equal(dash.today.status, 'scheduled', 'no work instance yet → scheduled');
  assert.equal(dash.today.checkInAt, null);
  assert.equal(dash.today.checkOutAt, null);
  assert.equal(dash.today.lateMinutes, 0);
  assert.equal(dash.recent.length, 0);
});

test('dashboard: today is null on a non-working weekday when no work instance exists', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);
  await assignSchedule(fixture.pool, tenantId, userId,await insertSchedule(fixture.pool, tenantId)); // Mon-Fri only

  // 2026-08-08 is a Saturday: 10:00 local = 03:00 UTC.
  const saturday = new Date('2026-08-08T03:00:00.000Z');
  const dash = await getMyDashboard(fixture.pool, tenantId, userId, saturday);
  assert.equal(dash.today, null);
});

test('dashboard: today flags isHoliday from the effective schedule', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);
  await assignSchedule(fixture.pool, tenantId, userId,await insertSchedule(fixture.pool, tenantId));
  await fixture.pool.query(
    `INSERT INTO holidays (tenant_id, holiday_date, name, kind) VALUES ($1, '2026-08-06', 'Company Day', 'company')`,
    [tenantId],
  );

  const dash = await getMyDashboard(fixture.pool, tenantId, userId, NOW);
  assert.ok(dash.today);
  assert.equal(dash.today.isHoliday, true);
});

test('dashboard: recent attendance is newest-first and never leaks other users or tenants', async (t) => {
  const fixture = await setupDb(t);
  const tenantId = await insertTenant(fixture.pool);
  const userId = await insertUser(fixture.pool, tenantId);
  const scheduleId = await insertSchedule(fixture.pool, tenantId);

  for (const [workDate, suffix] of [
    ['2026-08-03', 'a'],
    ['2026-08-05', 'b'],
    ['2026-08-04', 'c'],
  ] as const) {
    await insertWorkInstance(fixture.pool, {
      tenantId,
      userId,
      workDate,
      scheduleId,
      scheduledStartAt: `${workDate}T02:00:00.000Z`,
      scheduledEndAt: `${workDate}T10:00:00.000Z`,
      status: 'completed',
    });
    void suffix;
  }

  // Another user in the same tenant, and a user in ANOTHER tenant.
  const otherUser = await insertUser(fixture.pool, tenantId);
  await insertWorkInstance(fixture.pool, {
    tenantId,
    userId: otherUser,
    workDate: '2026-08-05',
    scheduleId,
    scheduledStartAt: '2026-08-05T02:00:00.000Z',
    scheduledEndAt: '2026-08-05T10:00:00.000Z',
    status: 'completed',
  });
  const tenantB = await insertTenant(fixture.pool);
  const userB = await insertUser(fixture.pool, tenantB);
  const scheduleB = await insertSchedule(fixture.pool, tenantB);
  await insertWorkInstance(fixture.pool, {
    tenantId: tenantB,
    userId: userB,
    workDate: '2026-08-05',
    scheduleId: scheduleB,
    scheduledStartAt: '2026-08-05T02:00:00.000Z',
    scheduledEndAt: '2026-08-05T10:00:00.000Z',
    status: 'completed',
  });

  const dash = await getMyDashboard(fixture.pool, tenantId, userId, NOW);
  assert.deepEqual(
    dash.recent.map((r) => r.workDate),
    ['2026-08-05', '2026-08-04', '2026-08-03'],
    'newest-first, only this user in this tenant',
  );
});
