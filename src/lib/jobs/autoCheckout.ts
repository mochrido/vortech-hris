import type pg from 'pg';
import type { Queryable } from '../db/queryable.ts';
import { workedMinutes } from '../attendance/calc.ts';

/** A pg.Pool additionally exposes connect(); a PoolClient does not. */
interface PoolLike extends Queryable {
  connect(): Promise<pg.PoolClient>;
}

function isPool(client: Queryable): client is PoolLike {
  return typeof (client as PoolLike).connect === 'function';
}

/** A work instance this run failed to close (logged and skipped, not fatal). */
export interface AutoCheckoutFailure {
  instanceId: string;
  error: string;
}

export interface AutoCheckoutSummary {
  /** Number of work instances newly closed by this run. */
  closed: number;
  /** Ids of the work instances closed by this run. */
  instanceIds: string[];
  /** Number of candidate instances that failed to close in this run. */
  failed: number;
  /** Per-instance failure details (instanceId + error message). */
  failures: AutoCheckoutFailure[];
}

interface OpenInstanceRow {
  id: string;
  tenant_id: string;
  user_id: string;
  scheduled_end_at: Date;
  check_in_event_id: string;
}

// ---------------------------------------------------------------------------
// Row helpers (kept tiny and local; mirror the shapes in attendance/events.ts).
// ---------------------------------------------------------------------------

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

/**
 * Closes work instances whose shift ended without a check-out (PRD 7.7,
 * decisions.md #3 — shift-end auto-checkout).
 *
 * An instance is a candidate when it has a check-in linked
 * (check_in_event_id NOT NULL), has NO check-out (check_out_event_id NULL),
 * its scheduled_end_at is strictly before `now`, and it is not already
 * closed. For each candidate, in a single transaction:
 *
 * - inserts a server-authored auto-checkout attendance_event (source
 *   `system_auto_checkout`, type `check_out`, occurred at scheduled_end_at,
 *   no GPS/selfie) under the deterministic idempotency key
 *   `auto-checkout:{work_instance_id}` — re-runs never double-insert;
 * - links it via check_out_event_id, computes worked_minutes =
 *   (check_out − check_in) − break_minutes clamped at ≥ 0 (break is read from
 *   the instance's schedule), sets review_status `needs_review` and status
 *   `auto_closed`;
 * - records an attendance_anomalies row (code `auto_checkout`) and an
 *   audit_events row.
 *
 * Instances that already checked out, or whose shift has not ended yet, are
 * untouched. Running the function twice is idempotent: the second run closes
 * nothing and returns { closed: 0, failed: 0, instanceIds: [], failures: [] }.
 *
 * When handed a pg.Pool, each instance is closed in its own transaction so a
 * failure on one instance does not roll back the others. When handed an
 * already-transactional client, all closures run inline inside the caller's
 * transaction.
 *
 * Per-instance failure isolation: a failure on one instance (including a
 * pathological row such as an orphaned check_in_event_id or a deleted
 * schedule) is logged, tallied in the summary's `failures`, and the run
 * CONTINUES with the next instance — one bad row never aborts the run.
 */
export async function closeOpenWorkInstances(client: Queryable, now: Date): Promise<AutoCheckoutSummary> {
  const candidates = await client.query<OpenInstanceRow>(
    `SELECT id, tenant_id, user_id, scheduled_end_at, check_in_event_id
       FROM work_instances
      WHERE check_in_event_id IS NOT NULL
        AND check_out_event_id IS NULL
        AND scheduled_end_at < $1
        AND status IN ('scheduled', 'in_progress')
      ORDER BY scheduled_end_at, id`,
    [now],
  );

  const instanceIds: string[] = [];
  const failures: AutoCheckoutFailure[] = [];
  for (const row of candidates.rows) {
    // Isolate per-instance failures: one bad row must not abort the run (and
    // wedge every subsequent run behind the same poisoned candidate).
    try {
      await closeOne(client, row);
      instanceIds.push(row.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `auto-checkout: failed to close work instance ${row.id} (tenant ${row.tenant_id}): ${message}`,
      );
      failures.push({ instanceId: row.id, error: message });
    }
  }
  return { closed: instanceIds.length, instanceIds, failed: failures.length, failures };
}

/** Runs `fn` in a transaction when `client` is a pool; inline otherwise. */
async function closeOne(client: Queryable, row: OpenInstanceRow): Promise<void> {
  if (isPool(client)) {
    const tx = await client.connect();
    try {
      await tx.query('BEGIN');
      await runClose(tx, row);
      await tx.query('COMMIT');
    } catch (error) {
      // A failed ROLLBACK must not mask the primary error.
      try {
        await tx.query('ROLLBACK');
      } catch {
        // Ignore: the primary error below is the actionable one.
      }
      throw error;
    } finally {
      tx.release();
    }
    return;
  }
  await runClose(client, row);
}

async function runClose(tx: Queryable, row: OpenInstanceRow): Promise<void> {
  const idempotencyKey = `auto-checkout:${row.id}`;

  // Re-check inside the transaction: a worker check-out committed after the
  // candidate scan leaves nothing to do (ON CONFLICT DO NOTHING inserts no
  // row, and the instance keeps its real check-out).
  const eventInsert = await tx.query<{ id: string }>(
    `INSERT INTO attendance_events (
       tenant_id, user_id, work_instance_id, event_type, idempotency_key,
       device_occurred_at, source, geofence_result, status
     ) VALUES ($1, $2, $3, 'check_out', $4, $5, 'system_auto_checkout', 'unverified', 'accepted')
     ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [row.tenant_id, row.user_id, row.id, idempotencyKey, row.scheduled_end_at],
  );
  const eventId = eventInsert.rows.length > 0 ? eventInsert.rows[0].id : null;

  // Single JOIN: check-in timestamp + schedule break in one round-trip.
  // LEFT JOINs so an orphaned check-in event or a deleted schedule surfaces
  // as NULL rather than silently dropping the row.
  const context = await tx.query<{ check_in_at: Date | null; break_minutes: number | null }>(
    `SELECT ci.device_occurred_at AS check_in_at, s.break_minutes
       FROM work_instances wi
       LEFT JOIN attendance_events ci ON ci.id = wi.check_in_event_id
       LEFT JOIN schedules s ON s.id = wi.schedule_id
      WHERE wi.id = $1`,
    [row.id],
  );
  const checkInAt = context.rows[0]?.check_in_at;
  const breakMinutes = context.rows[0]?.break_minutes;
  if (checkInAt == null || breakMinutes == null) {
    throw new Error(
      `cannot auto-close work instance ${row.id}: missing check-in event ${row.check_in_event_id} or schedule row`,
    );
  }
  const worked = workedMinutes(checkInAt, row.scheduled_end_at, breakMinutes);

  // Guard the update on "still has no check-out": if a real check-out won the
  // race, this run must not clobber it (the pre-inserted auto-checkout event
  // above stays orphaned but the instance keeps the worker's event).
  const updated = await tx.query<{ id: string }>(
    `UPDATE work_instances
        SET check_out_event_id = $1,
            worked_minutes = $2,
            status = 'auto_closed',
            review_status = 'needs_review',
            updated_at = now()
      WHERE id = $3
        AND check_out_event_id IS NULL
      RETURNING id`,
    [eventId, worked, row.id],
  );
  if (updated.rows.length === 0) {
    return;
  }

  if (eventId) {
    await insertAnomaly(tx, {
      tenantId: row.tenant_id,
      attendanceEventId: eventId,
      code: 'auto_checkout',
      details: { work_instance_id: row.id, scheduled_end_at: row.scheduled_end_at.toISOString() },
    });

    await insertAudit(tx, {
      tenantId: row.tenant_id,
      actorUserId: row.user_id,
      action: 'attendance.event.auto_checkout',
      entityType: 'attendance_event',
      entityId: eventId,
      after: {
        event_type: 'check_out',
        work_instance_id: row.id,
        source: 'system_auto_checkout',
        worked_minutes: worked,
      },
      reason: 'scheduled_end_passed_without_check_out',
    });
  }
}
