import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { closeOpenWorkInstances } from './autoCheckout.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

// Fixed Mon-Fri 09:00-17:00 Asia/Jakarta schedule, grace 10, break 60
// (same fixture shape as src/lib/attendance/events.test.ts).
// 2026-08-06 is a Thursday. 09:00 local = 02:00 UTC; 17:00 local = 10:00 UTC.
const TZ = 'Asia/Jakarta';
const LOC = { latitude: -6.2, longitude: 106.816, radiusM: 150 };
const WORK_DATE = '2026-08-06';
const SCHEDULE_START_UTC = new Date('2026-08-06T02:00:00.000Z'); // 09:00 +0700
const SCHEDULE_END_UTC = new Date('2026-08-06T10:00:00.000Z'); // 17:00 +0700
const BREAK_MINUTES = 60;

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
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, employment_type, active)
     VALUES ($1, $2, $3, $4, 'employee', true) RETURNING id`,
    [tenantId, 'Test User', email, 'scrypt$1$1$1$AAAA$BBBB'],
  );
  return result.rows[0].id;
}

async function insertLocation(pool: pg.Pool, tenantId: string, name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO locations (tenant_id, name, latitude, longitude, radius_m, active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [tenantId, name, LOC.latitude, LOC.longitude, LOC.radiusM],
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

/** Fixed Mon-Fri 09:00-17:00 schedule, break 60. */
async function insertSchedule(pool: pg.Pool, tenantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
     VALUES ($1, $2, $3, $4, $5, false, 10, $6) RETURNING id`,
    [tenantId, 'Office Fixed', TZ, '09:00', '17:00', BREAK_MINUTES],
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
     VALUES ($1, $2, $3, $4, NULL)`,
    [tenantId, userId, scheduleId, '2026-01-01'],
  );
}

/** Cross-midnight Mon-Fri 22:00-06:00 schedule, break 30. */
async function insertNightSchedule(pool: pg.Pool, tenantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
     VALUES ($1, $2, $3, $4, $5, true, 10, 30) RETURNING id`,
    [tenantId, 'Night Shift', TZ, '22:00', '06:00'],
  );
  const scheduleId = result.rows[0].id;
  for (const weekday of [1, 2, 3, 4, 5]) {
    await pool.query(`INSERT INTO schedule_days (schedule_id, weekday) VALUES ($1, $2)`, [scheduleId, weekday]);
  }
  return scheduleId;
}

interface Seed {
  tenantId: string;
  userId: string;
  scheduleId: string;
}

async function seedWorker(pool: pg.Pool, slug: string, email: string): Promise<Seed> {
  const tenantId = await insertTenant(pool, slug);
  const userId = await insertUser(pool, tenantId, email);
  const locationId = await insertLocation(pool, tenantId, 'HQ');
  await assignLocation(pool, tenantId, userId, locationId);
  const scheduleId = await insertSchedule(pool, tenantId);
  await assignSchedule(pool, tenantId, userId, scheduleId);
  return { tenantId, userId, scheduleId };
}

/** Inserts a work instance for WORK_DATE (09:00-17:00 local) with the given status. */
async function insertWorkInstance(pool: pg.Pool, seed: Seed, status: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at, status)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7) RETURNING id`,
    [seed.tenantId, seed.userId, WORK_DATE, seed.scheduleId, SCHEDULE_START_UTC, SCHEDULE_END_UTC, status],
  );
  return result.rows[0].id;
}

/** Records a check-in event at 08:50 local (01:50 UTC) and links it to the instance. */
async function insertCheckIn(pool: pg.Pool, seed: Seed, workInstanceId: string, idempotencyKey: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO attendance_events (
       tenant_id, user_id, work_instance_id, event_type, idempotency_key,
       device_occurred_at, source, latitude, longitude, accuracy_m, geofence_result, status
     ) VALUES ($1, $2, $3, 'check_in', $4, $5, 'web_online', $6, $7, 10, 'inside', 'accepted')
     RETURNING id`,
    [
      seed.tenantId,
      seed.userId,
      workInstanceId,
      idempotencyKey,
      new Date('2026-08-06T01:50:00.000Z'), // 08:50 local
      LOC.latitude,
      LOC.longitude,
    ],
  );
  const eventId = result.rows[0].id;
  await pool.query(`UPDATE work_instances SET check_in_event_id = $1, updated_at = now() WHERE id = $2`, [
    eventId,
    workInstanceId,
  ]);
  return eventId;
}

/**
 * Points an instance's check_in_event_id at a non-existent event id (an
 * orphaned reference, e.g. as left behind by a partial restore). FK trigger
 * constraints are disabled for the write; the test admin is a superuser.
 */
async function orphanCheckInEventId(pool: pg.Pool, workInstanceId: string): Promise<string> {
  const orphanId = crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = 'replica'`);
    await client.query(`UPDATE work_instances SET check_in_event_id = $1, updated_at = now() WHERE id = $2`, [
      orphanId,
      workInstanceId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return orphanId;
}

interface WorkInstanceSnapshot {
  status: string;
  check_in_event_id: string | null;
  check_out_event_id: string | null;
  worked_minutes: number | null;
  review_status: string;
}

async function snapshot(pool: pg.Pool, workInstanceId: string): Promise<WorkInstanceSnapshot> {
  const result = await pool.query<WorkInstanceSnapshot>(
    `SELECT status, check_in_event_id, check_out_event_id, worked_minutes, review_status
       FROM work_instances WHERE id = $1`,
    [workInstanceId],
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Open past-end instance is closed
// ---------------------------------------------------------------------------
test('autoCheckout: an open in-progress instance past scheduled_end_at is closed with computed worked_minutes', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedWorker(fixture.pool, 'ac-auto', 'open@acme.test');
  const wiId = await insertWorkInstance(fixture.pool, seed, 'in_progress');
  const checkInId = await insertCheckIn(fixture.pool, seed, wiId, 'in-1');

  const now = new Date('2026-08-06T11:00:00.000Z'); // 18:00 local, 1h past end
  const summary = await closeOpenWorkInstances(fixture.pool, now);

  assert.equal(summary.closed, 1);
  assert.deepEqual(summary.instanceIds, [wiId]);

  const wi = await snapshot(fixture.pool, wiId);
  assert.equal(wi.status, 'auto_closed');
  assert.equal(wi.check_in_event_id, checkInId);
  assert.ok(wi.check_out_event_id, 'check_out_event_id must be set');
  assert.equal(wi.review_status, 'needs_review');
  // Check-in 01:50 UTC -> auto-checkout at scheduled_end 10:00 UTC = 490 min
  // elapsed; minus 60 break = 430.
  assert.equal(wi.worked_minutes, 430);

  // The auto-checkout event: check_out, system source, occurred at shift end,
  // server-authored (no GPS/selfie), deterministic idempotency key.
  const events = await fixture.pool.query<{
    id: string;
    event_type: string;
    source: string;
    idempotency_key: string;
    device_occurred_at: Date;
    latitude: string | null;
    selfie_object_id: string | null;
    geofence_result: string;
    status: string;
  }>(`SELECT * FROM attendance_events WHERE work_instance_id = $1 AND event_type = 'check_out'`, [wiId]);
  assert.equal(events.rows.length, 1);
  const event = events.rows[0];
  assert.equal(event.id, wi.check_out_event_id);
  assert.equal(event.source, 'system_auto_checkout');
  assert.equal(event.idempotency_key, `auto-checkout:${wiId}`);
  assert.equal(event.device_occurred_at.toISOString(), SCHEDULE_END_UTC.toISOString());
  assert.equal(event.latitude, null);
  assert.equal(event.selfie_object_id, null);
  assert.equal(event.geofence_result, 'unverified');
  assert.equal(event.status, 'accepted');
});

// ---------------------------------------------------------------------------
// Instance that already checked out is untouched
// ---------------------------------------------------------------------------
test('autoCheckout: an instance that already has a check-out is untouched', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedWorker(fixture.pool, 'ac-done', 'done@acme.test');
  const wiId = await insertWorkInstance(fixture.pool, seed, 'completed');
  await insertCheckIn(fixture.pool, seed, wiId, 'in-1');

  // A normal (web_online) check-out at 17:05 local.
  const checkOut = await fixture.pool.query<{ id: string }>(
    `INSERT INTO attendance_events (
       tenant_id, user_id, work_instance_id, event_type, idempotency_key,
       device_occurred_at, source, latitude, longitude, accuracy_m, geofence_result, status
     ) VALUES ($1, $2, $3, 'check_out', 'out-1', $4, 'web_online', $5, $6, 10, 'inside', 'accepted')
     RETURNING id`,
    [seed.tenantId, seed.userId, wiId, new Date('2026-08-06T10:05:00.000Z'), LOC.latitude, LOC.longitude],
  );
  const checkOutId = checkOut.rows[0].id;
  await fixture.pool.query(
    `UPDATE work_instances SET check_out_event_id = $1, worked_minutes = 435, updated_at = now() WHERE id = $2`,
    [checkOutId, wiId],
  );

  const before = await snapshot(fixture.pool, wiId);
  const summary = await closeOpenWorkInstances(fixture.pool, new Date('2026-08-06T11:00:00.000Z'));

  assert.equal(summary.closed, 0);
  assert.deepEqual(summary.instanceIds, []);

  const after = await snapshot(fixture.pool, wiId);
  assert.deepEqual(after, before);

  // No extra events were written for the instance.
  const events = await fixture.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM attendance_events WHERE work_instance_id = $1`,
    [wiId],
  );
  assert.equal(Number(events.rows[0].count), 2); // the original in + out only
});

// ---------------------------------------------------------------------------
// Instance not yet past scheduled_end_at is untouched
// ---------------------------------------------------------------------------
test('autoCheckout: an open instance NOT yet past scheduled_end_at is untouched', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedWorker(fixture.pool, 'ac-early', 'early@acme.test');
  const wiId = await insertWorkInstance(fixture.pool, seed, 'in_progress');
  await insertCheckIn(fixture.pool, seed, wiId, 'in-1');

  // 15:00 local: the shift is still running (ends 17:00 local).
  const summary = await closeOpenWorkInstances(fixture.pool, new Date('2026-08-06T08:00:00.000Z'));

  assert.equal(summary.closed, 0);
  assert.deepEqual(summary.instanceIds, []);

  const wi = await snapshot(fixture.pool, wiId);
  assert.equal(wi.status, 'in_progress');
  assert.equal(wi.check_out_event_id, null);
  assert.equal(wi.worked_minutes, null);
  assert.equal(wi.review_status, 'clean');
});

// ---------------------------------------------------------------------------
// Idempotency: second run closes nothing new
// ---------------------------------------------------------------------------
test('autoCheckout: running twice is idempotent (second run closes nothing and double-inserts nothing)', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedWorker(fixture.pool, 'ac-idem', 'idem@acme.test');
  const wiId = await insertWorkInstance(fixture.pool, seed, 'in_progress');
  await insertCheckIn(fixture.pool, seed, wiId, 'in-1');

  const now = new Date('2026-08-06T11:00:00.000Z');
  const first = await closeOpenWorkInstances(fixture.pool, now);
  const second = await closeOpenWorkInstances(fixture.pool, now);

  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
  assert.deepEqual(second.instanceIds, []);

  // Exactly ONE check-out event exists for the instance.
  const events = await fixture.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM attendance_events
      WHERE work_instance_id = $1 AND event_type = 'check_out'`,
    [wiId],
  );
  assert.equal(Number(events.rows[0].count), 1);
});

// ---------------------------------------------------------------------------
// Anomaly + audit rows are written
// ---------------------------------------------------------------------------
test('autoCheckout: closing an instance writes an auto_checkout anomaly and an audit_events row', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedWorker(fixture.pool, 'ac-trail', 'trail@acme.test');
  const wiId = await insertWorkInstance(fixture.pool, seed, 'in_progress');
  await insertCheckIn(fixture.pool, seed, wiId, 'in-1');

  await closeOpenWorkInstances(fixture.pool, new Date('2026-08-06T11:00:00.000Z'));

  const wi = await snapshot(fixture.pool, wiId);
  const anomalies = await fixture.pool.query<{ code: string; attendance_event_id: string }>(
    `SELECT code, attendance_event_id FROM attendance_anomalies WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.equal(anomalies.rows.length, 1);
  assert.equal(anomalies.rows[0].code, 'auto_checkout');
  assert.equal(anomalies.rows[0].attendance_event_id, wi.check_out_event_id);

  const audits = await fixture.pool.query<{ action: string; entity_type: string; entity_id: string }>(
    `SELECT action, entity_type, entity_id FROM audit_events WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.ok(
    audits.rows.some((row) => row.action.includes('auto') && row.entity_id === wi.check_out_event_id),
    `expected an audit row for the auto-checkout event, got: ${JSON.stringify(audits.rows)}`,
  );
});

// ---------------------------------------------------------------------------
// worked_minutes never negative
// ---------------------------------------------------------------------------
test('autoCheckout: a very short shift computes worked_minutes clamped at 0', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedWorker(fixture.pool, 'ac-short', 'short@acme.test');
  const wiId = await insertWorkInstance(fixture.pool, seed, 'in_progress');

  // Check-in only 30 minutes before the scheduled end (break alone is 60).
  const checkIn = await fixture.pool.query<{ id: string }>(
    `INSERT INTO attendance_events (
       tenant_id, user_id, work_instance_id, event_type, idempotency_key,
       device_occurred_at, source, latitude, longitude, accuracy_m, geofence_result, status
     ) VALUES ($1, $2, $3, 'check_in', 'in-late', $4, 'web_online', $5, $6, 10, 'inside', 'accepted')
     RETURNING id`,
    [seed.tenantId, seed.userId, wiId, new Date('2026-08-06T09:30:00.000Z'), LOC.latitude, LOC.longitude],
  );
  await fixture.pool.query(`UPDATE work_instances SET check_in_event_id = $1, updated_at = now() WHERE id = $2`, [
    checkIn.rows[0].id,
    wiId,
  ]);

  const summary = await closeOpenWorkInstances(fixture.pool, new Date('2026-08-06T11:00:00.000Z'));
  assert.equal(summary.closed, 1);

  const wi = await snapshot(fixture.pool, wiId);
  assert.equal(wi.worked_minutes, 0); // max(0, 30 - 60)
});

// ---------------------------------------------------------------------------
// Per-instance failure isolation: one bad row does not abort the run
// ---------------------------------------------------------------------------
test('autoCheckout: a pathological candidate is tallied as a failure and later instances still close', async (t) => {
  const fixture = await setupDb(t);
  // Separate workers: UNIQUE(tenant_id, user_id, work_date, schedule_id) means
  // one worker can only hold one instance per (date, schedule).
  const badSeed = await seedWorker(fixture.pool, 'ac-iso-bad', 'bad@acme.test');
  const okSeed = await seedWorker(fixture.pool, 'ac-iso-ok', 'ok@acme.test');
  const wiId = await insertWorkInstance(fixture.pool, badSeed, 'in_progress');

  // Pathological row: an orphaned check_in_event_id pointing at a non-existent
  // event. runClose's JOIN finds no check-in row and raises a per-instance
  // failure instead of crashing the run.
  await orphanCheckInEventId(fixture.pool, wiId);

  // A healthy instance whose scheduled_end_at sorts AFTER the pathological
  // one, so the scan hits the bad row first.
  const healthyWi = await insertWorkInstance(fixture.pool, okSeed, 'in_progress');
  await insertCheckIn(fixture.pool, okSeed, healthyWi, 'in-healthy');
  await fixture.pool.query(
    `UPDATE work_instances SET scheduled_end_at = $1, updated_at = now() WHERE id = $2`,
    [new Date('2026-08-06T10:30:00.000Z'), healthyWi], // 17:30 local, still past `now`
  );

  const now = new Date('2026-08-06T11:00:00.000Z'); // 18:00 local
  const summary = await closeOpenWorkInstances(fixture.pool, now);

  // The run did NOT abort: the healthy instance closed.
  assert.equal(summary.closed, 1);
  assert.deepEqual(summary.instanceIds, [healthyWi]);
  // The pathological row was tallied as a failure, not thrown.
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].instanceId, wiId);
  assert.match(summary.failures[0].error, /missing check-in event|schedule/i);

  // The healthy instance really closed; the pathological one is untouched.
  const healthy = await snapshot(fixture.pool, healthyWi);
  assert.equal(healthy.status, 'auto_closed');
  assert.ok(healthy.check_out_event_id);

  const pathological = await snapshot(fixture.pool, wiId);
  assert.equal(pathological.status, 'in_progress');
  assert.equal(pathological.check_out_event_id, null);

  // Re-running does not wedge: the pathological row fails again, the healthy
  // one is already closed and untouched.
  const second = await closeOpenWorkInstances(fixture.pool, now);
  assert.equal(second.closed, 0);
  assert.equal(second.failed, 1);
  assert.equal(second.failures[0].instanceId, wiId);
});

// ---------------------------------------------------------------------------
// Pathological row: missing schedule is a tallied failure, not an abort
// ---------------------------------------------------------------------------
test('autoCheckout: a candidate whose schedule row is missing is tallied as a failure', async (t) => {
  const fixture = await setupDb(t);
  // An orphaned check_in_event_id (a dangling reference, e.g. left behind by a
  // partial restore) makes runClose's JOIN find no check-in row.
  const seed = await seedWorker(fixture.pool, 'ac-nosched', 'nosched@acme.test');
  const workInstanceId = await insertWorkInstance(fixture.pool, seed, 'in_progress');
  await orphanCheckInEventId(fixture.pool, workInstanceId);

  const summary = await closeOpenWorkInstances(fixture.pool, new Date('2026-08-06T11:00:00.000Z'));

  assert.equal(summary.closed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0].instanceId, workInstanceId);
  assert.match(summary.failures[0].error, /missing check-in event|schedule/i);

  const wi = await snapshot(fixture.pool, workInstanceId);
  assert.equal(wi.status, 'in_progress');
  assert.equal(wi.check_out_event_id, null);
});

// ---------------------------------------------------------------------------
// A worker's real check-out committed mid-run is NOT clobbered
// ---------------------------------------------------------------------------
test('autoCheckout: a real check-out committed while the job runs is not clobbered', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedWorker(fixture.pool, 'ac-race', 'race@acme.test');
  const wiId = await insertWorkInstance(fixture.pool, seed, 'in_progress');
  await insertCheckIn(fixture.pool, seed, wiId, 'in-1');

  // Worker 1: open a job transaction and pre-insert the auto-checkout event
  // (the candidate has already been scanned). Pause BEFORE the guarded UPDATE.
  const worker = await fixture.pool.connect();
  const autoEventId = `auto-checkout:${wiId}`;
  try {
    await worker.query('BEGIN');
    await worker.query(
      `INSERT INTO attendance_events (
         tenant_id, user_id, work_instance_id, event_type, idempotency_key,
         device_occurred_at, source, geofence_result, status
       ) VALUES ($1, $2, $3, 'check_out', $4, $5, 'system_auto_checkout', 'unverified', 'accepted')
       ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING`,
      [seed.tenantId, seed.userId, wiId, autoEventId, SCHEDULE_END_UTC],
    );

    // Interleave on worker 2: the worker's REAL check-out commits first.
    const real = await fixture.pool.query<{ id: string }>(
      `INSERT INTO attendance_events (
         tenant_id, user_id, work_instance_id, event_type, idempotency_key,
         device_occurred_at, source, latitude, longitude, accuracy_m, geofence_result, status
       ) VALUES ($1, $2, $3, 'check_out', 'out-real', $4, 'web_online', $5, $6, 10, 'inside', 'accepted')
       RETURNING id`,
      [seed.tenantId, seed.userId, wiId, new Date('2026-08-06T10:05:00.000Z'), LOC.latitude, LOC.longitude],
    );
    const realCheckOutId = real.rows[0].id;
    await fixture.pool.query(
      `UPDATE work_instances SET check_out_event_id = $1, worked_minutes = 435, status = 'completed', updated_at = now() WHERE id = $2`,
      [realCheckOutId, wiId],
    );

    // Back on worker 1: the guarded UPDATE must affect 0 rows because
    // check_out_event_id is no longer NULL.
    const autoEvent = await worker.query<{ id: string }>(
      `SELECT id FROM attendance_events WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3`,
      [seed.tenantId, seed.userId, autoEventId],
    );
    const guarded = await worker.query<{ id: string }>(
      `UPDATE work_instances
          SET check_out_event_id = $1, worked_minutes = 430, status = 'auto_closed',
              review_status = 'needs_review', updated_at = now()
        WHERE id = $2 AND check_out_event_id IS NULL
        RETURNING id`,
      [autoEvent.rows[0].id, wiId],
    );
    assert.equal(guarded.rows.length, 0, "the job's guarded update must not clobber the worker's check-out");
    await worker.query('COMMIT');

    // The instance keeps the worker's real check-out and is NOT auto_closed.
    const wi = await snapshot(fixture.pool, wiId);
    assert.equal(wi.check_out_event_id, realCheckOutId);
    assert.equal(wi.status, 'completed');
    assert.equal(wi.review_status, 'clean');
    assert.equal(wi.worked_minutes, 435);
  } finally {
    worker.release();
  }
});

// ---------------------------------------------------------------------------
// Cross-midnight schedule: scheduled_end_at lands the next day
// ---------------------------------------------------------------------------
test('autoCheckout: a cross-midnight instance closes with worked_minutes spanning into the next day', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedWorker(fixture.pool, 'ac-night', 'night@acme.test');
  const nightSchedule = await insertNightSchedule(fixture.pool, seed.tenantId);

  // Night shift 2026-08-06 22:00 -> 2026-08-07 06:00 Asia/Jakarta.
  // 22:00 +0700 = 15:00 UTC (8/6); 06:00 +0700 next day = 23:00 UTC (8/6).
  const result = await fixture.pool.query<{ id: string }>(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at, status)
     VALUES ($1, $2, $3::date, $4, $5, $6, 'in_progress') RETURNING id`,
    [
      seed.tenantId,
      seed.userId,
      WORK_DATE,
      nightSchedule,
      new Date('2026-08-06T15:00:00.000Z'), // 22:00 local start
      new Date('2026-08-06T23:00:00.000Z'), // 06:00 local NEXT day end
    ],
  );
  const wiId = result.rows[0].id;

  // Check-in at 21:55 local (14:55 UTC).
  const checkIn = await fixture.pool.query<{ id: string }>(
    `INSERT INTO attendance_events (
       tenant_id, user_id, work_instance_id, event_type, idempotency_key,
       device_occurred_at, source, latitude, longitude, accuracy_m, geofence_result, status
     ) VALUES ($1, $2, $3, 'check_in', 'in-night', $4, 'web_online', $5, $6, 10, 'inside', 'accepted')
     RETURNING id`,
    [seed.tenantId, seed.userId, wiId, new Date('2026-08-06T14:55:00.000Z'), LOC.latitude, LOC.longitude],
  );
  await fixture.pool.query(`UPDATE work_instances SET check_in_event_id = $1, updated_at = now() WHERE id = $2`, [
    checkIn.rows[0].id,
    wiId,
  ]);

  // 07:00 local next day (00:00 UTC 8/7): the shift ended an hour ago.
  const summary = await closeOpenWorkInstances(fixture.pool, new Date('2026-08-07T00:00:00.000Z'));

  assert.equal(summary.closed, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.instanceIds, [wiId]);

  const wi = await snapshot(fixture.pool, wiId);
  assert.equal(wi.status, 'auto_closed');
  assert.ok(wi.check_out_event_id);
  // 14:55 UTC -> 23:00 UTC = 485 min elapsed; minus 30 break = 455.
  assert.equal(wi.worked_minutes, 455);

  // The auto-checkout event occurred at the cross-midnight scheduled end.
  const event = await fixture.pool.query<{ device_occurred_at: Date }>(
    `SELECT device_occurred_at FROM attendance_events WHERE id = $1`,
    [wi.check_out_event_id],
  );
  assert.equal(event.rows[0].device_occurred_at.toISOString(), '2026-08-06T23:00:00.000Z');
});
