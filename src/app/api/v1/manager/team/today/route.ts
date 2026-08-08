import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { requireRole } from '../../../../../../lib/auth/guard.ts';
import { guardRequestFrom, jsonError } from '../../../../../../lib/api/http.ts';
import { getPool } from '../../../../../../lib/db/pool.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface MemberRow {
  user_id: string;
  display_name: string;
  team_id: string;
  team_name: string;
  work_date: string | null;
  status: string | null;
  check_in_at: Date | null;
  check_out_at: Date | null;
  late_minutes: number | null;
  worked_minutes: number | null;
  review_status: string | null;
}

/**
 * GET /api/v1/manager/team/today — today's attendance status for every member
 * of the teams assigned to the SESSION manager (manager_teams → team_members →
 * users), left-joined to that member's work instance for today's work date and
 * its accepted check-in/check-out events. Scoped strictly to the session
 * tenant; a manager only ever sees their OWN assigned teams. Non-managers → 403.
 * One row per MEMBER: a member in two of the manager's teams appears exactly
 * once (see the DISTINCT ON note below).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await requireRole(guardRequestFrom(req), ['manager']);
    const tenantId = resolved.user.tenant_id;

    // "Today" is the member's work date: derived in their schedule's timezone
    // when they have one, else the tenant-agnostic UTC date. Members with no
    // work instance today still appear (LEFT JOIN) with null status fields.
    // SHAPE DECISION (code-quality): one row per MEMBER, not per (member, team).
    // A member belonging to two of the manager's teams must appear exactly once.
    // DISTINCT ON (u.id) collapses the per-team duplicates the team_members join
    // would otherwise produce; the leading ORDER BY u.id is required by Postgres
    // for DISTINCT ON, and the first tiebreak (t.name, then t.id for determinism)
    // picks which single team label surfaces for a multi-team member. The
    // member's own fields (schedule, work instance, check-in/out) are per-user,
    // so they are identical across the collapsed rows and unaffected by the pick.
    // The outer SELECT re-orders the deduped members by team label + name.
    const result = await getPool().query<MemberRow>(
      `SELECT user_id, display_name, team_id, team_name, work_date, status,
              check_in_at, check_out_at, late_minutes, worked_minutes, review_status
         FROM (
           SELECT DISTINCT ON (u.id)
                  u.id AS user_id,
                  u.display_name,
                  t.id AS team_id,
                  t.name AS team_name,
                  (now() AT TIME ZONE COALESCE(sched.timezone, 'UTC'))::date::text AS work_date,
                  wi.status,
                  ci.device_occurred_at AS check_in_at,
                  co.device_occurred_at AS check_out_at,
                  wi.late_minutes,
                  wi.worked_minutes,
                  wi.review_status
             FROM manager_teams mt
             JOIN teams t
               ON t.id = mt.team_id AND t.tenant_id = $2
             JOIN team_members tm
               ON tm.team_id = mt.team_id
             JOIN users u
               ON u.id = tm.user_id AND u.tenant_id = $2
             LEFT JOIN LATERAL (
               SELECT s.timezone
                 FROM user_schedule_assignments usa
                 JOIN schedules s ON s.id = usa.schedule_id AND s.tenant_id = $2
                WHERE usa.user_id = u.id
                  AND usa.effective_from::text <= CURRENT_DATE::text
                  AND (usa.effective_to IS NULL OR usa.effective_to::text >= CURRENT_DATE::text)
                ORDER BY usa.effective_from DESC
                LIMIT 1
             ) sched ON true
             LEFT JOIN work_instances wi
               ON wi.tenant_id = $2
              AND wi.user_id = u.id
              AND wi.work_date = (now() AT TIME ZONE COALESCE(sched.timezone, 'UTC'))::date
             LEFT JOIN attendance_events ci ON ci.id = wi.check_in_event_id
             LEFT JOIN attendance_events co ON co.id = wi.check_out_event_id
            WHERE mt.manager_user_id = $1
            ORDER BY u.id, t.name, t.id
         ) deduped
        ORDER BY team_name, display_name`,
      [resolved.user.id, tenantId],
    );

    const members = result.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      teamId: row.team_id,
      teamName: row.team_name,
      workDate: row.work_date,
      // Members with no work instance yet today surface as 'scheduled'.
      status: row.status ?? 'scheduled',
      checkInAt: row.check_in_at ? row.check_in_at.toISOString() : null,
      checkOutAt: row.check_out_at ? row.check_out_at.toISOString() : null,
      lateMinutes: row.late_minutes ?? 0,
      workedMinutes: row.worked_minutes,
      reviewStatus: row.review_status ?? 'clean',
    }));

    return NextResponse.json({ members }, { status: 200 });
  } catch (err) {
    return jsonError(err);
  }
}
