import type { Queryable } from '../db/queryable.ts';
import { getEffectiveSchedule } from './schedule.ts';

/** One day of a member's attendance as shown on their dashboard. */
export interface DashboardEntry {
  workDate: string;
  status: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  lateMinutes: number;
  workedMinutes: number | null;
  reviewStatus: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  isHoliday: boolean;
}

/** The member's dashboard: today's status plus recent prior work instances. */
export interface MyDashboard {
  today: DashboardEntry | null;
  recent: DashboardEntry[];
}

const RECENT_LIMIT = 7;

interface RecentRow {
  work_date: string;
  status: string;
  late_minutes: number;
  worked_minutes: number | null;
  review_status: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  check_in_at: Date | null;
  check_out_at: Date | null;
}

function toEntry(row: RecentRow, isHoliday: boolean): DashboardEntry {
  return {
    workDate: row.work_date,
    status: row.status,
    checkInAt: row.check_in_at ? row.check_in_at.toISOString() : null,
    checkOutAt: row.check_out_at ? row.check_out_at.toISOString() : null,
    lateMinutes: row.late_minutes,
    workedMinutes: row.worked_minutes,
    reviewStatus: row.review_status,
    scheduledStartAt: row.scheduled_start_at.toISOString(),
    scheduledEndAt: row.scheduled_end_at.toISOString(),
    isHoliday,
  };
}

/**
 * Composes the member dashboard for `userId` in `tenantId` at `atUtc`:
 *
 * - `today` — the work instance for the effective work date when one exists;
 *   otherwise a "scheduled" placeholder derived from the effective schedule
 *   (so the client can show today's shift bounds before check-in); `null`
 *   when today is not a working day and no instance exists.
 * - `recent` — prior work instances, newest first, each with its accepted
 *   check-in/check-out times (submitted via `attendance_events`).
 */
export async function getMyDashboard(
  client: Queryable,
  tenantId: string,
  userId: string,
  atUtc: Date = new Date(),
): Promise<MyDashboard> {
  const schedule = await getEffectiveSchedule(client, userId, tenantId, atUtc);

  let today: DashboardEntry | null = null;
  if (schedule) {
    const todayResult = await client.query<RecentRow>(
      `SELECT wi.work_date::text AS work_date, wi.status, wi.late_minutes, wi.worked_minutes, wi.review_status,
              wi.scheduled_start_at, wi.scheduled_end_at,
              ci.device_occurred_at AS check_in_at,
              co.device_occurred_at AS check_out_at
         FROM work_instances wi
         LEFT JOIN attendance_events ci ON ci.id = wi.check_in_event_id
         LEFT JOIN attendance_events co ON co.id = wi.check_out_event_id
        WHERE wi.tenant_id = $1 AND wi.user_id = $2 AND wi.work_date = $3::date`,
      [tenantId, userId, schedule.workDate],
    );
    const row = todayResult.rows[0];
    if (row) {
      today = toEntry(row, schedule.isHoliday);
    } else {
      today = {
        workDate: schedule.workDate,
        status: 'scheduled',
        checkInAt: null,
        checkOutAt: null,
        lateMinutes: 0,
        workedMinutes: null,
        reviewStatus: 'clean',
        scheduledStartAt: schedule.scheduledStartAt.toISOString(),
        scheduledEndAt: schedule.scheduledEndAt.toISOString(),
        isHoliday: schedule.isHoliday,
      };
    }
  }

  const recentResult = await client.query<RecentRow>(
    `SELECT wi.work_date::text AS work_date, wi.status, wi.late_minutes, wi.worked_minutes, wi.review_status,
            wi.scheduled_start_at, wi.scheduled_end_at,
            ci.device_occurred_at AS check_in_at,
            co.device_occurred_at AS check_out_at
       FROM work_instances wi
       LEFT JOIN attendance_events ci ON ci.id = wi.check_in_event_id
       LEFT JOIN attendance_events co ON co.id = wi.check_out_event_id
      WHERE wi.tenant_id = $1 AND wi.user_id = $2
      ORDER BY wi.work_date DESC
      LIMIT $3`,
    [tenantId, userId, RECENT_LIMIT + 1],
  );
  const recent = recentResult.rows
    .filter((row) => row.work_date !== today?.workDate)
    .slice(0, RECENT_LIMIT)
    .map((row) => toEntry(row, false));

  return { today, recent };
}
