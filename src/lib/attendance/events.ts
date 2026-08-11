import type pg from 'pg';
import type { Queryable } from '../db/queryable.ts';
import { getEffectiveSchedule, type EffectiveSchedule } from './schedule.ts';
import { getEffectivePolicy, evaluateGeofence, verdictToOutcome, type GeofenceVerdict, type GeoLocationWithId } from './geofence.ts';
import { lateMinutes, workedMinutes } from './calc.ts';

/** A pg.Pool additionally exposes connect(); a PoolClient does not. */
interface PoolLike extends Queryable {
  connect(): Promise<pg.PoolClient>;
}

function isPool(client: Queryable): client is PoolLike {
  return typeof (client as PoolLike).connect === 'function';
}

export type AttendanceEventType = 'check_in' | 'check_out';

export type RecordOutcome = 'accepted' | 'needs_review' | 'blocked' | 'rejected';

export interface RecordAttendanceEventArgs {
  tenantId: string;
  userId: string;
  eventType: AttendanceEventType;
  idempotencyKey: string;
  deviceOccurredAt: Date;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locationAcquiredAt: Date | null;
  clockOffsetMs: number | null;
  /** Already-stored selfie object id (Task 5); NULL when not captured/attached. */
  selfieObjectId: string | null;
}

/** The attendance_events row as persisted. */
export interface AttendanceEventRow {
  id: string;
  tenant_id: string;
  user_id: string;
  work_instance_id: string;
  event_type: string;
  idempotency_key: string;
  device_occurred_at: Date;
  server_received_at: Date;
  source: string;
  latitude: string | null;
  longitude: string | null;
  accuracy_m: number | null;
  distance_m: number | null;
  location_id: string | null;
  geofence_result: string;
  selfie_object_id: string | null;
  clock_offset_ms: number | null;
  status: string;
}

/** The work_instances row as persisted. */
export interface WorkInstanceRow {
  id: string;
  tenant_id: string;
  user_id: string;
  work_date: string;
  schedule_id: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  status: string;
  check_in_event_id: string | null;
  check_out_event_id: string | null;
  worked_minutes: number | null;
  late_minutes: number;
  review_status: string;
}

export interface RecordAttendanceEventResult {
  /** True when a NEW attendance_events row was inserted by this call. */
  created: boolean;
  outcome: RecordOutcome;
  /** The (existing or newly-created) event; undefined when blocked or rejected with no row. */
  event?: AttendanceEventRow;
  /** The work instance, when one was resolved/created. */
  workInstance?: WorkInstanceRow;
  verdict?: GeofenceVerdict;
}

// ---------------------------------------------------------------------------
// Row shapes returned by SQL (snake_case). latitude/longitude come back as
// strings from numeric(9,6); keep them as-is for the persisted-row contract.
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  tenant_id: string;
  employment_type: string;
}

interface TenantRow {
  id: string;
  max_accuracy_m: number;
}

interface LocationRow {
  id: string;
  latitude: string;
  longitude: string;
  radius_m: number | null;
}

interface IdempotencyRow extends AttendanceEventRow {
  // joined work instance columns
  wi_id: string;
  wi_work_date: string;
  wi_schedule_id: string;
  wi_scheduled_start_at: Date;
  wi_scheduled_end_at: Date;
  wi_status: string;
  wi_check_in_event_id: string | null;
  wi_check_out_event_id: string | null;
  wi_worked_minutes: number | null;
  wi_late_minutes: number;
  wi_review_status: string;
}

function deriveGeofenceResult(verdict: GeofenceVerdict): string {
  if (verdict.inside === null) return 'unverified';
  return verdict.inside ? 'inside' : 'outside';
}

/** True when `error` is a Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/** True when `error` is a Postgres foreign-key violation (SQLSTATE 23503). */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503';
}

/** True when the unique violation hit the (tenant_id, user_id, idempotency_key) constraint. */
function isIdempotencyViolation(error: unknown): boolean {
  return (
    isUniqueViolation(error) &&
    (error as { constraint?: unknown }).constraint === 'attendance_events_tenant_user_idempotency_key'
  );
}

async function insertAudit(
  client: Queryable,
  args: {
    tenantId: string;
    actorUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    after?: Record<string, unknown>;
    reason?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (tenant_id, actor_user_id, action, entity_type, entity_id, after_json, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.tenantId,
      args.actorUserId,
      args.action,
      args.entityType,
      args.entityId,
      args.after ? JSON.stringify(args.after) : null,
      args.reason ?? null,
    ],
  );
}

async function insertAnomaly(
  client: Queryable,
  args: { tenantId: string; attendanceEventId: string; code: string; details?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `INSERT INTO attendance_anomalies (tenant_id, attendance_event_id, code, details_json)
     VALUES ($1, $2, $3, $4)`,
    [args.tenantId, args.attendanceEventId, args.code, JSON.stringify(args.details ?? {})],
  );
}

// Phase-scoped deferrals (deliberate, not gaps in Tasks 5/7):
// - `selfieRequired` from the resolved policy is not enforced here: the real
//   client always attaches a selfie, and policy-driven enforcement (rejecting a
//   submission with no selfie when the policy requires one) is a Phase 3 admin/
//   policy concern. The selfie object id is simply nullable on the row.
// - `locationAcquiredAt` freshness is not checked against the event time yet;
//   a stale-fix check belongs with Phase 2 clock-movement/freshness work (PRD 7.7).

/**
 * Records an attendance event (check-in / check-out) transactionally.
 *
 * Behavior (PRD 7.5 / 7.6, decisions.md #12):
 * - Idempotency: a repeated (tenant_id, user_id, idempotency_key) returns the
 *   ORIGINAL event with `created:false` and inserts nothing. A CONCURRENT
 *   insert racing past the idempotency lookup hits the unique constraint
 *   (SQLSTATE 23505); the violation is caught and the original event is
 *   re-read and returned with `created:false` instead of surfacing a raw
 *   database error.
 * - Blocked: a mandatory-geofence worker outside all assigned locations (or
 *   with no GPS fix) is rejected BEFORE any event/work-instance write.
 * - First-event-wins: the first accepted check-in wins; a second DIFFERENT
 *   check-in for the same work instance is rejected and audited (NOT inserted
 *   as an attendance row). Same for check-out. Check-out requires a check-in.
 * - needs_review: an accuracy anomaly (or other review flags) accepts the
 *   event but flags review and records attendance_anomalies.
 * - late_minutes from schedule grace; worked_minutes = out − in − break ≥ 0.
 * - Server is authoritative for receipt time (server_received_at = now()).
 *
 * Everything runs in ONE transaction; a failure rolls the whole write back.
 */
export async function recordAttendanceEvent(
  client: Queryable,
  args: RecordAttendanceEventArgs,
): Promise<RecordAttendanceEventResult> {
  // When handed a Pool, open a dedicated client and wrap the whole write in
  // BEGIN/COMMIT (rolling back on error). When handed an already-transactional
  // client (e.g. a PoolClient inside a caller's transaction), run inline so the
  // caller retains transactional control.
  if (isPool(client)) {
    const tx = await client.connect();
    try {
      await tx.query('BEGIN');
      const result = await runRecord(tx, args);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      // A failed ROLLBACK (e.g. lost connection) must not mask the primary
      // error: swallow it and rethrow the original.
      try {
        await tx.query('ROLLBACK');
      } catch {
        // Ignore: the primary error below is the actionable one.
      }
      throw error;
    } finally {
      tx.release();
    }
  }
  return runRecord(client, args);
}

/**
 * Re-runs the idempotency lookup and, when a row exists, returns the
 * idempotent-replay result (`created:false` with the original event and its
 * work instance). Returns `null` when no row is stored under the key.
 */
async function findExistingResult(
  tx: Queryable,
  args: RecordAttendanceEventArgs,
): Promise<RecordAttendanceEventResult | null> {
  const existing = await tx.query<IdempotencyRow>(
    `SELECT e.*,
            wi.id AS wi_id,
            wi.work_date::text AS wi_work_date,
            wi.schedule_id AS wi_schedule_id,
            wi.scheduled_start_at AS wi_scheduled_start_at,
            wi.scheduled_end_at AS wi_scheduled_end_at,
            wi.status AS wi_status,
            wi.check_in_event_id AS wi_check_in_event_id,
            wi.check_out_event_id AS wi_check_out_event_id,
            wi.worked_minutes AS wi_worked_minutes,
            wi.late_minutes AS wi_late_minutes,
            wi.review_status AS wi_review_status
       FROM attendance_events e
       JOIN work_instances wi
         ON wi.id = e.work_instance_id AND wi.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.user_id = $2 AND e.idempotency_key = $3`,
    [args.tenantId, args.userId, args.idempotencyKey],
  );

  if (existing.rows.length === 0) {
    return null;
  }

  const row = existing.rows[0];
  const workInstance: WorkInstanceRow = {
    id: row.wi_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    work_date: row.wi_work_date,
    schedule_id: row.wi_schedule_id,
    scheduled_start_at: row.wi_scheduled_start_at,
    scheduled_end_at: row.wi_scheduled_end_at,
    status: row.wi_status,
    check_in_event_id: row.wi_check_in_event_id,
    check_out_event_id: row.wi_check_out_event_id,
    worked_minutes: row.wi_worked_minutes,
    late_minutes: row.wi_late_minutes,
    review_status: row.wi_review_status,
  };
  // The event columns of the joined row ARE the persisted attendance_events
  // row (SELECT e.*); reuse them directly as the public event shape.
  const event: AttendanceEventRow = { ...row };
  return {
    created: false,
    outcome: event.status === 'needs_review' ? 'needs_review' : 'accepted',
    event,
    workInstance,
  };
}

async function runRecord(
  tx: Queryable,
  args: RecordAttendanceEventArgs,
): Promise<RecordAttendanceEventResult> {
  // (a) Idempotency lookup: same key → return the original event.
  const replay = await findExistingResult(tx, args);
  if (replay) {
    return replay;
  }

  // Load the user + tenant for policy resolution.
  const userResult = await tx.query<UserRow>(
    `SELECT id, tenant_id, employment_type FROM users WHERE tenant_id = $1 AND id = $2`,
    [args.tenantId, args.userId],
  );
  if (userResult.rows.length === 0) {
    throw new Error(`user ${args.userId} not found in tenant ${args.tenantId}`);
  }
  const user = userResult.rows[0];

  const tenantResult = await tx.query<TenantRow>(
    `SELECT id, max_accuracy_m FROM tenants WHERE id = $1`,
    [args.tenantId],
  );
  if (tenantResult.rows.length === 0) {
    throw new Error(`tenant ${args.tenantId} not found`);
  }
  const tenant = tenantResult.rows[0];

  // (b) Resolve the effective schedule at the device timestamp.
  const schedule: EffectiveSchedule | null = await getEffectiveSchedule(tx, args.userId, args.tenantId, args.deviceOccurredAt);
  if (!schedule) {
    // No working schedule for this date → there is no work instance to
    // attach to. Record and reject (not an attendance row).
    await insertAudit(tx, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: 'attendance.event.rejected',
      entityType: 'attendance_event',
      entityId: '00000000-0000-0000-0000-000000000000',
      reason: 'no_effective_schedule',
      after: { event_type: args.eventType, idempotency_key: args.idempotencyKey },
    });
    return { created: false, outcome: 'rejected' };
  }

  // (c) Resolve policy + evaluate geofence against assigned active locations.
  //     The policy must be the one effective on the resolved WORK DATE, not
  //     on the server's current date (backdated / cross-midnight events).
  const policy = await getEffectivePolicy(tx, user, tenant, schedule.workDate);
  const locationResult = await tx.query<LocationRow>(
    `SELECT l.id, l.latitude::text AS latitude, l.longitude::text AS longitude, l.radius_m
       FROM user_locations ul
       JOIN locations l ON l.id = ul.location_id AND l.tenant_id = $2
      WHERE ul.user_id = $1 AND l.active = true`,
    [args.userId, args.tenantId],
  );
  const locations: GeoLocationWithId[] = locationResult.rows.map((row) => ({
    id: row.id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radius_m: row.radius_m,
  }));

  const verdict = evaluateGeofence({
    policy,
    latitude: args.latitude,
    longitude: args.longitude,
    accuracyM: args.accuracyM,
    locations,
  });
  const geofenceOutcome = verdictToOutcome(verdict);

  // (d) Blocked: reject BEFORE any event/work-instance write.
  if (geofenceOutcome === 'blocked') {
    await insertAudit(tx, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: 'attendance.event.blocked',
      entityType: 'attendance_event',
      entityId: '00000000-0000-0000-0000-000000000000',
      reason: 'geofence_blocked',
      after: {
        event_type: args.eventType,
        idempotency_key: args.idempotencyKey,
        inside: verdict.inside,
        distance_m: verdict.distanceM === undefined ? null : Math.round(verdict.distanceM),
      },
    });
    return { created: false, outcome: 'blocked', verdict };
  }

  // (e) Upsert the work instance (UNIQUE tenant/user/work_date/schedule).
  const wiInsert = await tx.query<WorkInstanceRow>(
    `INSERT INTO work_instances (
       tenant_id, user_id, work_date, schedule_id, scheduled_start_at, scheduled_end_at, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
     ON CONFLICT (tenant_id, user_id, work_date, schedule_id) DO NOTHING
     RETURNING *`,
    [args.tenantId, args.userId, schedule.workDate, schedule.scheduleId, schedule.scheduledStartAt, schedule.scheduledEndAt],
  );

  let workInstance: WorkInstanceRow;
  if (wiInsert.rows.length > 0) {
    workInstance = wiInsert.rows[0];
  } else {
    const wiSelect = await tx.query<WorkInstanceRow>(
      `SELECT id, tenant_id, user_id, work_date::text AS work_date, schedule_id,
              scheduled_start_at, scheduled_end_at, status, check_in_event_id,
              check_out_event_id, worked_minutes, late_minutes, review_status
         FROM work_instances
        WHERE tenant_id = $1 AND user_id = $2 AND work_date = $3 AND schedule_id = $4`,
      [args.tenantId, args.userId, schedule.workDate, schedule.scheduleId],
    );
    workInstance = wiSelect.rows[0];
  }

  // (f) First-event-wins enforcement.
  if (args.eventType === 'check_in' && workInstance.check_in_event_id) {
    await insertAudit(tx, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: 'attendance.event.rejected',
      entityType: 'attendance_event',
      entityId: workInstance.id,
      reason: 'duplicate_check_in',
      after: { idempotency_key: args.idempotencyKey, existing_event_id: workInstance.check_in_event_id },
    });
    return { created: false, outcome: 'rejected', workInstance, verdict };
  }
  if (args.eventType === 'check_out') {
    if (!workInstance.check_in_event_id) {
      await insertAudit(tx, {
        tenantId: args.tenantId,
        actorUserId: args.userId,
        action: 'attendance.event.rejected',
        entityType: 'attendance_event',
        entityId: workInstance.id,
        reason: 'check_out_before_check_in',
        after: { idempotency_key: args.idempotencyKey },
      });
      return { created: false, outcome: 'rejected', workInstance, verdict };
    }
    if (workInstance.check_out_event_id) {
      await insertAudit(tx, {
        tenantId: args.tenantId,
        actorUserId: args.userId,
        action: 'attendance.event.rejected',
        entityType: 'attendance_event',
        entityId: workInstance.id,
        reason: 'duplicate_check_out',
        after: { idempotency_key: args.idempotencyKey, existing_event_id: workInstance.check_out_event_id },
      });
      return { created: false, outcome: 'rejected', workInstance, verdict };
    }
  }

  // (g) Insert the attendance event. Server is authoritative for receipt
  // time (server_received_at defaults to now() in the DB).
  const status = geofenceOutcome === 'needs_review' ? 'needs_review' : 'accepted';
  const geofenceResult = deriveGeofenceResult(verdict);
  // attendance_events.distance_m is an int column; the haversine distance is
  // a float, so round to the nearest whole meter (undefined stays NULL).
  const distanceM = verdict.distanceM === undefined ? null : Math.round(verdict.distanceM);

  // A constraint violation would normally abort the whole transaction
  // (SQLSTATE 25P02), so run the insert behind a SAVEPOINT: on a handled
  // violation we roll back ONLY to the savepoint and keep the enclosing
  // transaction usable. Unrelated errors propagate and roll everything back.
  await tx.query('SAVEPOINT attendance_event_insert');
  let event: AttendanceEventRow;
  try {
    const eventInsert = await tx.query<AttendanceEventRow>(
      `INSERT INTO attendance_events (
         tenant_id, user_id, work_instance_id, event_type, idempotency_key,
         device_occurred_at, source, latitude, longitude, accuracy_m, distance_m,
         location_id, geofence_result, selfie_object_id, clock_offset_ms, status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'web_online', $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        args.tenantId,
        args.userId,
        workInstance.id,
        args.eventType,
        args.idempotencyKey,
        args.deviceOccurredAt,
        args.latitude,
        args.longitude,
        args.accuracyM,
        distanceM,
        verdict.locationId ?? null,
        geofenceResult,
        args.selfieObjectId,
        args.clockOffsetMs,
        status,
      ],
    );
    event = eventInsert.rows[0];
  } catch (error) {
    if (isUniqueViolation(error) || isForeignKeyViolation(error)) {
      // Undo only the failed insert so the transaction stays usable.
      await tx.query('ROLLBACK TO SAVEPOINT attendance_event_insert');
      if (isIdempotencyViolation(error)) {
        // A concurrent submission with the same idempotency key won the race
        // and committed first. Re-run the idempotency lookup and return the
        // original event instead of surfacing a raw 23505 error.
        const replay = await findExistingResult(tx, args);
        if (replay) {
          return replay;
        }
        // The winner rolled back or was not visible: the row no longer
        // exists, so fall through to rethrow the violation rather than
        // silently swallowing it.
      } else if (isForeignKeyViolation(error)) {
        // First-event-wins race (or a work-instance link removed mid-write):
        // reject cleanly instead of surfacing a raw 23503 error.
        await insertAudit(tx, {
          tenantId: args.tenantId,
          actorUserId: args.userId,
          action: 'attendance.event.rejected',
          entityType: 'attendance_event',
          entityId: workInstance.id,
          reason: 'event_insert_conflict',
          after: { event_type: args.eventType, idempotency_key: args.idempotencyKey },
        });
        return { created: false, outcome: 'rejected', workInstance, verdict };
      }
    }
    // Anything else (including an idempotency race whose winner vanished) is
    // not ours to interpret: rethrow so the whole write rolls back.
    throw error;
  }
  await tx.query('RELEASE SAVEPOINT attendance_event_insert');

  // (h) Update the work instance links + computed minutes + review status.
  let reviewStatus = workInstance.review_status;
  if (status === 'needs_review') reviewStatus = 'needs_review';

  if (args.eventType === 'check_in') {
    const late = lateMinutes(args.deviceOccurredAt, schedule.scheduledStartAt, schedule.graceMinutes);
    const updated = await tx.query<WorkInstanceRow>(
      `UPDATE work_instances
          SET check_in_event_id = $1,
              late_minutes = $2,
              status = 'in_progress',
              review_status = $3,
              updated_at = now()
        WHERE id = $4
        RETURNING id, tenant_id, user_id, work_date::text AS work_date, schedule_id,
                  scheduled_start_at, scheduled_end_at, status, check_in_event_id,
                  check_out_event_id, worked_minutes, late_minutes, review_status`,
      [event.id, late, reviewStatus, workInstance.id],
    );
    workInstance = updated.rows[0];
  } else {
    // check_out: compute worked minutes from the linked check-in.
    const checkInEvent = await tx.query<{ device_occurred_at: Date }>(
      `SELECT device_occurred_at FROM attendance_events WHERE id = $1`,
      [workInstance.check_in_event_id],
    );
    const worked = workedMinutes(checkInEvent.rows[0].device_occurred_at, args.deviceOccurredAt, schedule.breakMinutes);
    const updated = await tx.query<WorkInstanceRow>(
      `UPDATE work_instances
          SET check_out_event_id = $1,
              worked_minutes = $2,
              status = 'completed',
              review_status = $3,
              updated_at = now()
        WHERE id = $4
        RETURNING id, tenant_id, user_id, work_date::text AS work_date, schedule_id,
                  scheduled_start_at, scheduled_end_at, status, check_in_event_id,
                  check_out_event_id, worked_minutes, late_minutes, review_status`,
      [event.id, worked, reviewStatus, workInstance.id],
    );
    workInstance = updated.rows[0];
  }

  // (i) Insert anomalies.
  if (verdict.accuracyAnomaly) {
    await insertAnomaly(tx, {
      tenantId: args.tenantId,
      attendanceEventId: event.id,
      code: 'accuracy_exceeded',
      details: { accuracy_m: args.accuracyM, max_accuracy_m: policy.maxAccuracyM },
    });
  }
  if (verdict.inside === false) {
    // Outside geofence but accepted (optional policy).
    await insertAnomaly(tx, {
      tenantId: args.tenantId,
      attendanceEventId: event.id,
      code: 'outside_geofence',
      details: { distance_m: distanceM },
    });
  }
  if (verdict.inside === null) {
    // No GPS fix but accepted (optional policy): missing location.
    await insertAnomaly(tx, {
      tenantId: args.tenantId,
      attendanceEventId: event.id,
      code: 'missing_location',
      details: {},
    });
  }

  // (j) Audit the accepted insert.
  await insertAudit(tx, {
    tenantId: args.tenantId,
    actorUserId: args.userId,
    action: 'attendance.event.created',
    entityType: 'attendance_event',
    entityId: event.id,
    after: {
      event_type: args.eventType,
      work_instance_id: workInstance.id,
      status,
      geofence_result: geofenceResult,
    },
  });

  return {
    created: true,
    outcome: status === 'needs_review' ? 'needs_review' : 'accepted',
    event,
    workInstance,
    verdict,
  };
}
