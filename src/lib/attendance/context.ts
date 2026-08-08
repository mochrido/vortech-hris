import type { Queryable } from '../db/queryable.ts';
import { getEffectiveSchedule, type EffectiveSchedule } from './schedule.ts';
import { getEffectivePolicy, type EffectivePolicy } from './geofence.ts';

/** An assigned, active location as exposed to the member client. */
export interface AttendanceContextLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number | null;
}

/**
 * Everything the member client needs to render check-in/out for "now":
 * the effective schedule, the effective geofence policy, the user's assigned
 * ACTIVE locations, and the server's current time (so clients can detect
 * clock skew). Pure composition of `schedule.ts` / `geofence.ts` — no
 * resolution logic is duplicated here.
 */
export interface AttendanceContext {
  schedule: EffectiveSchedule | null;
  policy: EffectivePolicy;
  locations: AttendanceContextLocation[];
  /** Server time at the moment of the call, ISO 8601. */
  serverNow: string;
}

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
  name: string;
  latitude: string;
  longitude: string;
  radius_m: number | null;
}

/**
 * Composes the attendance context for `userId` in `tenantId`.
 *
 * `atUtc` is the instant used for schedule resolution (defaults to now); tests
 * inject it to pin the resolved work date. `serverNow` is always the REAL
 * server time regardless of `atUtc`.
 *
 * @throws {Error} when the user does not exist in the tenant (callers derive
 *   both ids from the session guard, so this indicates data corruption).
 */
export async function getAttendanceContext(
  client: Queryable,
  tenantId: string,
  userId: string,
  atUtc: Date = new Date(),
): Promise<AttendanceContext> {
  const userResult = await client.query<UserRow>(
    `SELECT id, tenant_id, employment_type FROM users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId],
  );
  const user = userResult.rows[0];
  if (!user) {
    throw new Error(`attendance context: user ${userId} not found in tenant ${tenantId}`);
  }

  const tenantResult = await client.query<TenantRow>(
    `SELECT id, max_accuracy_m FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const tenant = tenantResult.rows[0];
  if (!tenant) {
    throw new Error(`attendance context: tenant ${tenantId} not found`);
  }

  const [schedule, policy, locationResult] = await Promise.all([
    getEffectiveSchedule(client, userId, tenantId, atUtc),
    getEffectivePolicy(client, user, tenant),
    client.query<LocationRow>(
      `SELECT l.id, l.name, l.latitude::text AS latitude, l.longitude::text AS longitude, l.radius_m
         FROM user_locations ul
         JOIN locations l ON l.id = ul.location_id AND l.tenant_id = $2
        WHERE ul.user_id = $1 AND l.active = true
        ORDER BY l.name`,
      [userId, tenantId],
    ),
  ]);

  const locations: AttendanceContextLocation[] = locationResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusM: row.radius_m,
  }));

  return {
    schedule,
    policy,
    locations,
    serverNow: new Date().toISOString(),
  };
}
