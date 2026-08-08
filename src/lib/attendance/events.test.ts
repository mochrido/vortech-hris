import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase } from '../test/db.ts';
import { runMigrations } from '../db/migrate.ts';
import { closePool } from '../db/pool.ts';
import { recordAttendanceEvent } from './events.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsDir = path.join(repoRoot, 'migrations');

const TZ = 'Asia/Jakarta'; // UTC+7

// Jakarta location (matches geofence.test.ts fixtures).
const LOC = { latitude: -6.2, longitude: 106.816, radiusM: 150 };

// Fixed Mon-Fri 09:00-17:00 schedule, grace 10, break 60.
// 2026-08-06 is a Thursday. 09:00 local = 02:00 UTC.
const WORK_DATE = '2026-08-06';
const SCHEDULE_START_UTC = new Date('2026-08-06T02:00:00.000Z'); // 09:00 +0700
const GRACE_MINUTES = 10;
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

async function insertUser(
  pool: pg.Pool,
  tenantId: string,
  email: string,
  employmentType: 'employee' | 'field_worker',
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, display_name, email_normalized, password_hash, employment_type, active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [tenantId, 'Test User', email, 'scrypt$1$1$1$AAAA$BBBB', employmentType],
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

async function assignLocation(pool: pg.Pool, userId: string, locationId: string): Promise<void> {
  await pool.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [userId, locationId]);
}

/** Fixed Mon-Fri 09:00-17:00 schedule. */
async function insertSchedule(pool: pg.Pool, tenantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
     VALUES ($1, $2, $3, $4, $5, false, $6, $7) RETURNING id`,
    [tenantId, 'Office Fixed', TZ, '09:00', '17:00', GRACE_MINUTES, BREAK_MINUTES],
  );
  const scheduleId = result.rows[0].id;
  for (const weekday of [1, 2, 3, 4, 5]) {
    await pool.query(`INSERT INTO schedule_days (schedule_id, weekday) VALUES ($1, $2)`, [scheduleId, weekday]);
  }
  return scheduleId;
}

async function assignSchedule(pool: pg.Pool, userId: string, scheduleId: string): Promise<void> {
  await pool.query(
    `INSERT INTO user_schedule_assignments (user_id, schedule_id, effective_from, effective_to)
     VALUES ($1, $2, $3, NULL)`,
    [userId, scheduleId, '2026-01-01'],
  );
}

/** Cross-midnight night schedule 22:00-07:00, grace 10, break 60, Mon-Sat.
 *  The 07:00 end keeps a 06:10 check-out within the shift window (< end_local),
 *  so it attributes to the PRIOR work date; a 22:00-06:00 shift ends at 06:00
 *  and a 06:10 event would already land on the next date. */
async function insertNightSchedule(pool: pg.Pool, tenantId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO schedules (tenant_id, name, timezone, start_local, end_local, crosses_midnight, grace_minutes, break_minutes)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7) RETURNING id`,
    [tenantId, 'Night Shift', TZ, '22:00', '07:00', GRACE_MINUTES, BREAK_MINUTES],
  );
  const scheduleId = result.rows[0].id;
  for (const weekday of [1, 2, 3, 4, 5, 6]) {
    await pool.query(`INSERT INTO schedule_days (schedule_id, weekday) VALUES ($1, $2)`, [scheduleId, weekday]);
  }
  return scheduleId;
}

/** Seeds a mandatory (employee) worker on the night schedule inside the geofence. */
async function seedNightWorker(pool: pg.Pool, slug: string, email: string): Promise<Seed> {
  const tenantId = await insertTenant(pool, slug);
  const userId = await insertUser(pool, tenantId, email, 'employee');
  const locationId = await insertLocation(pool, tenantId, 'HQ');
  await assignLocation(pool, userId, locationId);
  const scheduleId = await insertNightSchedule(pool, tenantId);
  await assignSchedule(pool, userId, scheduleId);
  return { tenantId, userId, locationId, scheduleId };
}

interface Seed {
  tenantId: string;
  userId: string;
  locationId: string;
  scheduleId: string;
}

/** Seeds a mandatory (employee) worker inside the geofence with an active schedule. */
async function seedMandatoryWorker(pool: pg.Pool, slug: string, email: string): Promise<Seed> {
  const tenantId = await insertTenant(pool, slug);
  const userId = await insertUser(pool, tenantId, email, 'employee');
  const locationId = await insertLocation(pool, tenantId, 'HQ');
  await assignLocation(pool, userId, locationId);
  const scheduleId = await insertSchedule(pool, tenantId);
  await assignSchedule(pool, userId, scheduleId);
  return { tenantId, userId, locationId, scheduleId };
}

/** Seeds an optional (field_worker) worker with an active schedule and assigned location. */
async function seedFieldWorker(pool: pg.Pool, slug: string, email: string): Promise<Seed> {
  const tenantId = await insertTenant(pool, slug);
  const userId = await insertUser(pool, tenantId, email, 'field_worker');
  const locationId = await insertLocation(pool, tenantId, 'HQ');
  await assignLocation(pool, userId, locationId);
  const scheduleId = await insertSchedule(pool, tenantId);
  await assignSchedule(pool, userId, scheduleId);
  return { tenantId, userId, locationId, scheduleId };
}

function baseArgs(seed: Seed, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tenantId: seed.tenantId,
    userId: seed.userId,
    eventType: 'check_in' as const,
    idempotencyKey: 'idem-1',
    deviceOccurredAt: new Date('2026-08-06T01:50:00.000Z'), // 08:50 local (on time)
    latitude: LOC.latitude,
    longitude: LOC.longitude,
    accuracyM: 10,
    locationAcquiredAt: new Date('2026-08-06T01:50:00.000Z'),
    clockOffsetMs: 12,
    selfieObjectId: null,
    ...overrides,
  };
}

async function countEvents(pool: pg.Pool, workInstanceId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM attendance_events WHERE work_instance_id = $1`,
    [workInstanceId],
  );
  return Number(result.rows[0].count);
}

/** Narrows an optional result field, failing loudly when absent. */
function must<T>(value: T | undefined, label: string): T {
  assert.ok(value !== undefined, `expected ${label} to be present`);
  return value;
}

// ---------------------------------------------------------------------------
// Check-in happy path
// ---------------------------------------------------------------------------
test('events: check-in creates work_instance + event, sets check_in_event_id and late_minutes', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'acme', 'alice@acme.test');

  const result = await recordAttendanceEvent(fixture.pool, baseArgs(seed));

  assert.equal(result.created, true);
  assert.equal(result.outcome, 'accepted');
  const event = must(result.event, 'event');
  const workInstance = must(result.workInstance, 'workInstance');
  assert.equal(event.event_type, 'check_in');
  assert.equal(event.status, 'accepted');
  assert.equal(event.source, 'web_online');
  assert.equal(event.geofence_result, 'inside');
  assert.equal(event.location_id, seed.locationId);
  assert.equal(event.idempotency_key, 'idem-1');

  // server_received_at is set by the DB (now()), not the client.
  assert.ok(event.server_received_at instanceof Date);
  assert.equal(event.device_occurred_at.toISOString(), '2026-08-06T01:50:00.000Z');

  // work_instance created and linked.
  assert.ok(workInstance.id);
  assert.equal(workInstance.work_date, WORK_DATE);
  assert.equal(workInstance.schedule_id, seed.scheduleId);
  assert.equal(workInstance.check_in_event_id, event.id);
  assert.equal(workInstance.check_out_event_id, null);

  // 08:50 local is on time => late_minutes 0.
  assert.equal(workInstance.late_minutes, 0);
  assert.equal(workInstance.review_status, 'clean');

  // Verify persisted in DB.
  const wi = await fixture.pool.query<{ check_in_event_id: string; late_minutes: number }>(
    `SELECT check_in_event_id, late_minutes FROM work_instances WHERE id = $1`,
    [workInstance.id],
  );
  assert.equal(wi.rows[0].check_in_event_id, event.id);
  assert.equal(wi.rows[0].late_minutes, 0);
});

test('events: late check-in computes late_minutes from schedule grace', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'late', 'late@acme.test');

  // 09:25 local = 02:25 UTC; grace end = 09:10; late = 15 min.
  const lateAt = new Date('2026-08-06T02:25:00.000Z');
  const result = await recordAttendanceEvent(fixture.pool, baseArgs(seed, { deviceOccurredAt: lateAt, idempotencyKey: 'idem-late' }));

  assert.equal(result.created, true);
  assert.equal(must(result.workInstance, 'workInstance').late_minutes, 15);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------
test('events: same idempotency_key returns the ORIGINAL event with no duplicate row', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'idem', 'idem@acme.test');

  const first = await recordAttendanceEvent(fixture.pool, baseArgs(seed));
  const second = await recordAttendanceEvent(fixture.pool, baseArgs(seed));

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(must(second.event, 'event').id, must(first.event, 'event').id);
  assert.equal(must(second.workInstance, 'workInstance').id, must(first.workInstance, 'workInstance').id);

  // Only one event row exists for the work instance.
  assert.equal(await countEvents(fixture.pool, must(first.workInstance, 'workInstance').id), 1);
});

// ---------------------------------------------------------------------------
// First-event-wins (a SECOND DIFFERENT check-in is rejected)
// ---------------------------------------------------------------------------
test('events: a second different check-in for the same work instance is rejected and audited, not inserted', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'few', 'few@acme.test');

  const first = await recordAttendanceEvent(fixture.pool, baseArgs(seed, { idempotencyKey: 'checkin-a' }));
  assert.equal(first.created, true);

  // A SECOND, DIFFERENT check-in (different idempotency key) for the same instance.
  const second = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { idempotencyKey: 'checkin-b', deviceOccurredAt: new Date('2026-08-06T01:55:00.000Z') }),
  );

  assert.equal(second.created, false);
  assert.equal(second.outcome, 'rejected');

  // Still exactly ONE check-in event for the work instance.
  const firstWiId = must(first.workInstance, 'workInstance').id;
  assert.equal(await countEvents(fixture.pool, firstWiId), 1);
  const wi = await fixture.pool.query<{ check_in_event_id: string }>(
    `SELECT check_in_event_id FROM work_instances WHERE id = $1`,
    [firstWiId],
  );
  assert.equal(wi.rows[0].check_in_event_id, must(first.event, 'event').id);

  // The rejection was recorded in audit_events (security/application log), not as an attendance row.
  const audits = await fixture.pool.query<{ action: string; entity_type: string }>(
    `SELECT action, entity_type FROM audit_events WHERE tenant_id = $1 ORDER BY occurred_at`,
    [seed.tenantId],
  );
  assert.ok(
    audits.rows.some((row) => row.action.includes('reject') || row.action.includes('duplicate')),
    `expected an audit row recording the rejected duplicate check-in, got: ${JSON.stringify(audits.rows)}`,
  );
});

// ---------------------------------------------------------------------------
// Check-out ordering + worked minutes
// ---------------------------------------------------------------------------
test('events: check-out before check-in is rejected', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'earlyout', 'early@acme.test');

  const result = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { eventType: 'check_out', idempotencyKey: 'out-1', deviceOccurredAt: new Date('2026-08-06T09:00:00.000Z') }),
  );

  assert.equal(result.created, false);
  assert.equal(result.outcome, 'rejected');

  // No event rows and no work_instance check_out link.
  const events = await fixture.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM attendance_events WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.equal(Number(events.rows[0].count), 0);
});

test('events: check-out after check-in computes worked_minutes (minus break) and sets check_out_event_id', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'full', 'full@acme.test');

  // Check-in 08:50 local (01:50 UTC), check-out 17:00 local (10:00 UTC).
  const checkIn = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { idempotencyKey: 'in-1', deviceOccurredAt: new Date('2026-08-06T01:50:00.000Z') }),
  );
  assert.equal(checkIn.created, true);

  const checkOut = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { eventType: 'check_out', idempotencyKey: 'out-1', deviceOccurredAt: new Date('2026-08-06T10:00:00.000Z') }),
  );

  assert.equal(checkOut.created, true);
  const outEvent = must(checkOut.event, 'event');
  const outWi = must(checkOut.workInstance, 'workInstance');
  assert.equal(outEvent.event_type, 'check_out');
  assert.equal(outWi.check_out_event_id, outEvent.id);

  // 01:50 -> 10:00 UTC = 490 min elapsed; minus 60 break = 430.
  assert.equal(outWi.worked_minutes, 430);

  // Persisted.
  const wi = await fixture.pool.query<{ worked_minutes: number; check_out_event_id: string; status: string }>(
    `SELECT worked_minutes, check_out_event_id, status FROM work_instances WHERE id = $1`,
    [outWi.id],
  );
  assert.equal(wi.rows[0].worked_minutes, 430);
  assert.equal(wi.rows[0].check_out_event_id, outEvent.id);
  assert.equal(wi.rows[0].status, 'completed');
});

// ---------------------------------------------------------------------------
// Blocked geofence (mandatory worker outside)
// ---------------------------------------------------------------------------
test('events: blocked geofence (mandatory worker outside) creates NO event and NO work_instance', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'blocked', 'blocked@acme.test');

  // Far outside the geofence (0,0).
  const result = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { latitude: 0, longitude: 0, idempotencyKey: 'blocked-1' }),
  );

  assert.equal(result.created, false);
  assert.equal(result.outcome, 'blocked');

  // No attendance event rows.
  const events = await fixture.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM attendance_events WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.equal(Number(events.rows[0].count), 0);

  // No work_instances created.
  const wis = await fixture.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM work_instances WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.equal(Number(wis.rows[0].count), 0);
});

// ---------------------------------------------------------------------------
// needs_review (accuracy anomaly)
// ---------------------------------------------------------------------------
test('events: accuracy anomaly -> accepted with needs_review + accuracy anomaly row', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'accuracy', 'accuracy@acme.test');

  // Inside geofence but accuracy 100 > 50 max.
  const result = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { accuracyM: 100, idempotencyKey: 'acc-1' }),
  );

  assert.equal(result.created, true);
  assert.equal(result.outcome, 'needs_review');
  assert.equal(must(result.event, 'event').status, 'needs_review');
  assert.equal(must(result.workInstance, 'workInstance').review_status, 'needs_review');

  // An accuracy anomaly row was recorded.
  const anomalies = await fixture.pool.query<{ code: string }>(
    `SELECT code FROM attendance_anomalies WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.ok(
    anomalies.rows.some((row) => row.code.includes('accuracy')),
    `expected an accuracy anomaly, got: ${JSON.stringify(anomalies.rows)}`,
  );
});

// ---------------------------------------------------------------------------
// Outside optional geofence -> accepted + flagged anomaly
// ---------------------------------------------------------------------------
test('events: outside optional geofence (field_worker) -> accepted + outside_geofence anomaly', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedFieldWorker(fixture.pool, 'field', 'field@acme.test');

  // Outside the geofence, good accuracy so no accuracy anomaly.
  const result = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { latitude: 0, longitude: 0, accuracyM: 10, idempotencyKey: 'field-1' }),
  );

  assert.equal(result.created, true);
  assert.equal(result.outcome, 'accepted');
  assert.equal(must(result.event, 'event').geofence_result, 'outside');

  // An outside_geofence anomaly recorded.
  const anomalies = await fixture.pool.query<{ code: string }>(
    `SELECT code FROM attendance_anomalies WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.ok(
    anomalies.rows.some((row) => row.code.includes('outside')),
    `expected an outside_geofence anomaly, got: ${JSON.stringify(anomalies.rows)}`,
  );
});

// ---------------------------------------------------------------------------
// Missing location (optional) -> accepted + missing-location anomaly
// ---------------------------------------------------------------------------
test('events: optional worker with no GPS fix -> accepted + missing location anomaly', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedFieldWorker(fixture.pool, 'nofix', 'nofix@acme.test');

  const result = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { latitude: null, longitude: null, accuracyM: null, locationAcquiredAt: null, idempotencyKey: 'nofix-1' }),
  );

  assert.equal(result.created, true);
  assert.equal(result.outcome, 'accepted');
  assert.equal(must(result.event, 'event').geofence_result, 'unverified');

  const anomalies = await fixture.pool.query<{ code: string }>(
    `SELECT code FROM attendance_anomalies WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.ok(
    anomalies.rows.some((row) => row.code.includes('location') || row.code.includes('missing')),
    `expected a missing-location anomaly, got: ${JSON.stringify(anomalies.rows)}`,
  );
});

// ---------------------------------------------------------------------------
// Audit event written for accepted insert
// ---------------------------------------------------------------------------
test('events: an accepted attendance insert writes an audit_events row', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'audit', 'audit@acme.test');

  const result = await recordAttendanceEvent(fixture.pool, baseArgs(seed));
  assert.equal(result.created, true);

  const audits = await fixture.pool.query<{ action: string; entity_type: string; entity_id: string }>(
    `SELECT action, entity_type, entity_id FROM audit_events WHERE tenant_id = $1`,
    [seed.tenantId],
  );
  assert.ok(
    audits.rows.some((row) => row.entity_type === 'attendance_event' && row.entity_id === must(result.event, 'event').id),
    `expected an audit_events row for the attendance_event insert, got: ${JSON.stringify(audits.rows)}`,
  );
});

// ---------------------------------------------------------------------------
// I-1: concurrent same-key submission hits the unique constraint and replays
// ---------------------------------------------------------------------------
test('events: a concurrent same-key insert returns the original event (created:false) instead of a raw 23505', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedMandatoryWorker(fixture.pool, 'race', 'race@acme.test');

  // Simulate the race: a "winner" transaction has inserted the event row for
  // the idempotency key but not yet committed, so the concurrent submission's
  // idempotency lookup finds nothing. Its INSERT then blocks on the winner's
  // uncommitted unique-key row and fails with 23505 once the winner commits;
  // the SAVEPOINT recovery must catch it and re-run the idempotency lookup.
  const winner = await fixture.pool.connect();
  let winnerReleased = false;
  t.after(() => {
    if (!winnerReleased) winner.release();
  });

  await winner.query('BEGIN');
  const wiInsert = await winner.query<{ id: string }>(
    `INSERT INTO work_instances (tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at, status)
     VALUES ($1, $2, $3::date, $4, $5, $6, 'scheduled') RETURNING id`,
    [seed.tenantId, seed.userId, WORK_DATE, seed.scheduleId, SCHEDULE_START_UTC, new Date('2026-08-06T10:00:00.000Z')],
  );
  const winnerWiId = wiInsert.rows[0].id;
  await winner.query(
    `INSERT INTO attendance_events (
       tenant_id, user_id, work_instance_id, event_type, idempotency_key,
       device_occurred_at, source, geofence_result, status
     ) VALUES ($1, $2, $3, 'check_in', $4, $5, 'web_online', 'inside', 'accepted')`,
    [seed.tenantId, seed.userId, winnerWiId, 'idem-1', baseArgs(seed).deviceOccurredAt],
  );

  // The loser's insert parks on the winner's uncommitted key; commit the
  // winner 100 ms in so the loser wakes up with 23505 while the call is live.
  const loserPromise = recordAttendanceEvent(fixture.pool, baseArgs(seed));
  const winnerDone = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await winner.query('COMMIT');
  })();

  const result = await loserPromise;
  await winnerDone;
  winner.release();
  winnerReleased = true;

  assert.equal(result.created, false);
  assert.equal(result.outcome, 'accepted');
  const event = must(result.event, 'event');
  assert.equal(event.idempotency_key, 'idem-1');
  assert.equal(must(result.workInstance, 'workInstance').id, winnerWiId);

  // Still exactly ONE event row for the key: the loser inserted nothing.
  const events = await fixture.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM attendance_events
      WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = 'idem-1'`,
    [seed.tenantId, seed.userId],
  );
  assert.equal(Number(events.rows[0].count), 1);
});

// ---------------------------------------------------------------------------
// M-1: cross-midnight night shift — check-in before midnight, check-out after
// ---------------------------------------------------------------------------
test('events: cross-midnight night shift yields ONE work instance on the PRIOR work date with both events linked', async (t) => {
  const fixture = await setupDb(t);
  const seed = await seedNightWorker(fixture.pool, 'night', 'night@acme.test');

  // 2026-08-06 is a Thursday; the 22:00-06:00 shift starts Thursday and ends
  // Friday morning. Check-in 21:55 local on 2026-08-06 = 14:55 UTC.
  const checkIn = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, { idempotencyKey: 'night-in', deviceOccurredAt: new Date('2026-08-06T14:55:00.000Z') }),
  );
  assert.equal(checkIn.created, true);
  const inWi = must(checkIn.workInstance, 'workInstance');
  assert.equal(inWi.work_date, '2026-08-06');
  assert.equal(inWi.late_minutes, 0); // 21:55 is before the 22:10 grace end

  // Check-out 06:10 local the NEXT day (Fri 2026-08-07 06:10 +07:00 = 2026-08-06 23:10 UTC).
  // 06:10 < 07:00 shift end, so it attributes to the PRIOR work date (Thu 2026-08-06).
  const checkOut = await recordAttendanceEvent(
    fixture.pool,
    baseArgs(seed, {
      eventType: 'check_out',
      idempotencyKey: 'night-out',
      deviceOccurredAt: new Date('2026-08-06T23:10:00.000Z'),
    }),
  );
  assert.equal(checkOut.created, true);
  const outEvent = must(checkOut.event, 'event');
  const outWi = must(checkOut.workInstance, 'workInstance');

  // A SINGLE work instance, attributed to the PRIOR work date (shift start).
  assert.equal(outWi.id, inWi.id);
  assert.equal(outWi.work_date, '2026-08-06');
  assert.equal(outWi.check_in_event_id, must(checkIn.event, 'event').id);
  assert.equal(outWi.check_out_event_id, outEvent.id);
  assert.equal(outWi.status, 'completed');

  // 14:55 -> 23:10 UTC = 495 min elapsed; minus 60 break = 435.
  assert.equal(outWi.worked_minutes, 435);

  // Persisted: exactly one work instance for the user, on the prior date.
  const wis = await fixture.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM work_instances WHERE tenant_id = $1 AND user_id = $2`,
    [seed.tenantId, seed.userId],
  );
  assert.equal(Number(wis.rows[0].count), 1);
  const persisted = await fixture.pool.query<{
    work_date: string;
    check_in_event_id: string;
    check_out_event_id: string;
    worked_minutes: number;
  }>(
    `SELECT work_date::text AS work_date, check_in_event_id, check_out_event_id, worked_minutes
       FROM work_instances WHERE id = $1`,
    [outWi.id],
  );
  assert.equal(persisted.rows[0].work_date, '2026-08-06');
  assert.equal(persisted.rows[0].check_in_event_id, must(checkIn.event, 'event').id);
  assert.equal(persisted.rows[0].check_out_event_id, outEvent.id);
  assert.equal(persisted.rows[0].worked_minutes, 435);
});
