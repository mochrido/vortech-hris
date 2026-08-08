import type { Queryable } from '../db/queryable.ts';

/**
 * The resolved effective schedule for a user at a given instant.
 *
 * Contract (PRD 7.4 / 7.6):
 * - `null` is returned when the user has NO active schedule assignment at
 *   `atUtc` (no assignment, expired, future-dated, or inactive schedule) AND
 *   when the computed local work date falls on a weekday that is not one of
 *   the schedule's working days. In both cases there is no work instance.
 * - A non-null result with `isHoliday: true` means the schedule WAS resolved
 *   (a working weekday with an active assignment) but the computed work date
 *   matches an Indonesian national holiday (tenant_id NULL) or a holiday of
 *   the user's own tenant. Callers treat this as a non-working day while
 *   still having the schedule bounds available.
 * - `workDate` is the local (schedule-timezone) calendar date of the shift
 *   START. For a `crossesMidnight` schedule, events after local midnight but
 *   before `end_local` are attributed to the PRIOR start date.
 */
export interface EffectiveSchedule {
  scheduleId: string;
  /** Local calendar date of the shift start, `YYYY-MM-DD`. */
  workDate: string;
  /** Shift start as an absolute instant (timestamptz). */
  scheduledStartAt: Date;
  /** Shift end as an absolute instant (timestamptz); next day when crossing midnight. */
  scheduledEndAt: Date;
  crossesMidnight: boolean;
  graceMinutes: number;
  breakMinutes: number;
  isHoliday: boolean;
}

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface AssignmentRow {
  schedule_id: string;
  timezone: string;
  start_local: string;
  end_local: string;
  crosses_midnight: boolean;
  grace_minutes: number;
  break_minutes: number;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Returns the { year, month, day, minutesSinceMidnight } of `atUtc` expressed
 * in `timeZone`, using the built-in Intl API (no dependency).
 */
function localParts(atUtc: Date, timeZone: string): { year: number; month: number; day: number; minutes: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(atUtc);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { year, month, day, minutes: hour * 60 + minute };
}

/** Formats a local calendar date as `YYYY-MM-DD`. */
function formatDate(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Parses an `HH:MM[:SS]` local time string into minutes since midnight.
 * Throws on malformed input so callers fail loudly rather than compute with
 * `NaN`.
 */
export function parseLocalMinutes(local: string): number {
  const [h, m] = local.split(':');
  const minutes = Number(h) * 60 + Number(m);
  // `Number('') === 0`, so a missing hour (`':30'`) or a missing minute
  // (`'09'`) would silently parse; require both components to be present.
  if (h === undefined || m === undefined || h === '' || m === '' || !Number.isFinite(minutes)) {
    throw new Error(`Invalid local time: ${JSON.stringify(local)} (expected HH:MM[:SS])`);
  }
  return minutes;
}

/** Local calendar date (YYYY-MM-DD) of `atUtc` in `timeZone`. */
function localDateString(atUtc: Date, timeZone: string): string {
  const p = localParts(atUtc, timeZone);
  return formatDate(p.year, p.month, p.day);
}

/**
 * Converts a local wall-clock time (`HH:MM` on `localDate`, a `YYYY-MM-DD`
 * string) in `timeZone` to the corresponding UTC instant.
 *
 * Strategy: start from the UTC instant obtained by interpreting the wall time
 * as UTC, then iteratively shift by the discrepancy between the target wall
 * time and the wall time the timezone shows. The day component of that
 * discrepancy is the TRUE calendar day difference between the shown local
 * date and the target date (computed from full y/m/d), so it is correct
 * across month boundaries. Convergence is then VALIDATED: after the loop the
 * local wall time is re-derived and must match the requested date and
 * time-of-day exactly.
 *
 * DST behavior (fail loud, never silently wrong):
 * - Normal and fixed-offset zones (e.g. Asia/Jakarta, no DST) converge and
 *   are returned.
 * - The spring-forward NONEXISTENT hour (a wall time that never occurs) fails
 *   the post-loop convergence check and THROWS.
 * - The fall-back AMBIGUOUS hour (a wall time that occurs twice) converges to
 *   one of the two instants but fails the occurrence-count check and THROWS.
 *
 * @throws {Error} when the requested local wall time is nonexistent or
 *   ambiguous (i.e. does not resolve to exactly one instant for the requested
 *   date/time-of-day).
 */
export function localTimeToUtc(localDate: string, localTime: string, timeZone: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  const targetMinutes = parseLocalMinutes(localTime);

  // Whole-day difference between two calendar dates, correct across month and
  // year boundaries (unlike `shown.day - day`, which breaks at month ends).
  const dayDiff = (sy: number, sm: number, sd: number): number =>
    Math.round((Date.UTC(sy, sm - 1, sd) - Date.UTC(year, month - 1, day)) / MS_PER_DAY);

  const matches = (p: { year: number; month: number; day: number; minutes: number }): boolean =>
    p.year === year && p.month === month && p.day === day && p.minutes === targetMinutes;

  let utcMs = Date.UTC(year, month - 1, day, 0, 0, 0) + targetMinutes * 60_000;
  for (let i = 0; i < 5; i += 1) {
    const shown = localParts(new Date(utcMs), timeZone);
    // Express the shown wall time as minutes relative to the target date so a
    // day-boundary wrap shows up as a multiple of MINUTES_PER_DAY.
    const shownMinutes = shown.minutes + dayDiff(shown.year, shown.month, shown.day) * MINUTES_PER_DAY;
    const diffMinutes = targetMinutes - shownMinutes;
    if (diffMinutes === 0) break;
    utcMs += diffMinutes * 60_000;
  }

  // Post-loop validation: re-derive the local wall time and require an exact
  // match with the requested date and time-of-day. A mismatch means the wall
  // time never occurs (spring-forward gap); fail loud.
  if (!matches(localParts(new Date(utcMs), timeZone))) {
    throw new Error(
      `Cannot resolve local time ${localDate} ${localTime} in ${timeZone}: ` +
        `that wall-clock time does not exist (spring-forward DST gap).`,
    );
  }

  // Ambiguity validation: a wall time that occurs twice (fall-back DST
  // transition) has no single correct instant, so fail loud. Count the UTC
  // instants that display this wall time on a minute grid over a ±2 hour
  // window (any single DST offset change is ≤ 1 hour, and ±2h covers every
  // real-world offset change); exactly one is required to be unambiguous.
  let occurrences = 0;
  for (let deltaMin = -120; deltaMin <= 120; deltaMin += 1) {
    if (matches(localParts(new Date(utcMs + deltaMin * 60_000), timeZone))) {
      occurrences += 1;
    }
  }
  if (occurrences !== 1) {
    throw new Error(
      `Cannot resolve local time ${localDate} ${localTime} in ${timeZone}: ` +
        `that wall-clock time is ambiguous (occurs ${occurrences} times during the fall-back DST transition).`,
    );
  }
  return new Date(utcMs);
}

/** Local date string of the day BEFORE `localDate` (YYYY-MM-DD), in `timeZone`. */
function shiftLocalDate(localDate: string, timeZone: string, deltaDays: number): string {
  const noonUtc = localTimeToUtc(localDate, '12:00', timeZone);
  const shifted = new Date(noonUtc.getTime() + deltaDays * MS_PER_DAY);
  return localDateString(shifted, timeZone);
}

/** Weekday (0=Sunday..6=Saturday) of a `YYYY-MM-DD` local calendar date. */
function localWeekday(localDate: string): number {
  const [year, month, day] = localDate.split('-').map(Number);
  // Calendar weekday is timezone-independent for a fixed local calendar date.
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Resolves the single effective schedule for `userId` in `tenantId` at the
 * instant `atUtc`.
 *
 * - Considers only assignments whose `[effective_from, effective_to]` range
 *   contains the local work date, choosing the latest `effective_from` (and
 *   latest `created_at` as tiebreaker) when several overlap — deterministic.
 * - Computes the local work date in the schedule's timezone; a
 *   `crosses_midnight` schedule attributes post-midnight times to the prior
 *   start date.
 * - Returns `null` when there is no active assignment or the computed work
 *   date is not a working weekday for the schedule.
 * - Returns a result with `isHoliday: true` when the work date matches a
 *   national (`tenant_id IS NULL`) or tenant-specific holiday.
 */
export async function getEffectiveSchedule(
  client: Queryable,
  userId: string,
  tenantId: string,
  atUtc: Date,
): Promise<EffectiveSchedule | null> {
  // 1. Load candidate active assignments joined to their schedule. Because
  //    the schedule timezone (needed to derive the local work date) is only
  //    known per row, we use a generous ±1 day window around the UTC date and
  //    refine against the true local work date in JS below.
  const assignmentResult = await client.query<AssignmentRow>(
    `SELECT s.id AS schedule_id,
            s.timezone,
            s.start_local::text AS start_local,
            s.end_local::text AS end_local,
            s.crosses_midnight,
            s.grace_minutes,
            s.break_minutes,
            usa.effective_from::text AS effective_from,
            usa.effective_to::text AS effective_to
       FROM user_schedule_assignments usa
       JOIN schedules s ON s.id = usa.schedule_id AND s.tenant_id = $2
      WHERE usa.user_id = $1
        AND s.active = true
        AND usa.effective_from <= ($3::timestamptz AT TIME ZONE s.timezone)::date + 1
        AND (usa.effective_to IS NULL OR usa.effective_to >= ($3::timestamptz AT TIME ZONE s.timezone)::date - 1)
      ORDER BY usa.effective_from DESC, usa.created_at DESC`,
    [userId, tenantId, atUtc.toISOString()],
  );

  // 2. For each candidate, compute its local work date and keep only those
  //    whose effective range truly contains that work date; pick the latest
  //    effective_from among the survivors (already ordered DESC).
  let chosen: { row: AssignmentRow; workDate: string } | null = null;
  for (const row of assignmentResult.rows) {
    const timeZone = row.timezone;
    const localNow = localParts(atUtc, timeZone);
    const todayLocal = formatDate(localNow.year, localNow.month, localNow.day);
    const endMinutes = parseLocalMinutes(row.end_local);

    let workDate = todayLocal;
    if (row.crosses_midnight && localNow.minutes < endMinutes) {
      workDate = shiftLocalDate(todayLocal, timeZone, -1);
    }

    const fromOk = row.effective_from <= workDate;
    const toOk = row.effective_to === null || row.effective_to >= workDate;
    if (fromOk && toOk) {
      chosen = { row, workDate };
      break; // rows are ordered by effective_from DESC already
    }
  }

  if (!chosen) {
    return null;
  }

  const { row, workDate } = chosen;
  const timeZone = row.timezone;

  // 3. The work date must be a working weekday for this schedule.
  const weekday = localWeekday(workDate);
  const dayResult = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM schedule_days WHERE schedule_id = $1 AND weekday = $2) AS present`,
    [row.schedule_id, weekday],
  );
  if (!dayResult.rows[0].present) {
    return null;
  }

  // 4. Holiday check: national (tenant_id NULL) or this tenant's.
  const holidayResult = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM holidays
        WHERE holiday_date = $1::date
          AND (tenant_id IS NULL OR tenant_id = $2)
     ) AS present`,
    [workDate, tenantId],
  );
  const isHoliday = holidayResult.rows[0].present;

  // 5. Compute absolute shift bounds in the schedule timezone.
  const scheduledStartAt = localTimeToUtc(workDate, row.start_local, timeZone);
  const endDate = row.crosses_midnight ? shiftLocalDate(workDate, timeZone, 1) : workDate;
  const scheduledEndAt = localTimeToUtc(endDate, row.end_local, timeZone);

  return {
    scheduleId: row.schedule_id,
    workDate,
    scheduledStartAt,
    scheduledEndAt,
    crossesMidnight: row.crosses_midnight,
    graceMinutes: row.grace_minutes,
    breakMinutes: row.break_minutes,
    isHoliday,
  };
}
