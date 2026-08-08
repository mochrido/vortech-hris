import type pg from 'pg';
import { isInsideGeofence, haversineMeters, type GeoLocation } from './geo.ts';

/** Minimal queryable surface shared by pg.Pool, pg.Client and pg.PoolClient. */
interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

/**
 * The resolved geofence policy for a worker (PRD 5.2 / 7.3 / 7.5, decisions.md #1–#2).
 *
 * - `geofenceMode` is derived from `employment_type` unless an active
 *   `user_policy_assignments` row overrides it.
 * - `maxAccuracyM` is the tenant default (`tenants.max_accuracy_m`, 50 m by
 *   default) unless the assigned policy sets an explicit override.
 * - `retryCount` defaults to 3 unless the assigned policy overrides it.
 */
export interface EffectivePolicy {
  geofenceMode: 'mandatory' | 'optional';
  maxAccuracyM: number;
  retryCount: number;
  selfieRequired: boolean;
}

interface PolicyAssignmentRow {
  geofence_mode: string;
  selfie_required: boolean;
  max_accuracy_m: number | null;
  retry_count: number;
}

/**
 * Resolves the effective geofence policy for `user` in `tenant`.
 *
 * Resolution order:
 * 1. The active `user_policy_assignments` row (effective range contains
 *    today) joined to its `attendance_policies` row wins when present.
 * 2. Otherwise the employment-type default applies:
 *    - `field_worker` → `optional`
 *    - anything else (including `employee`) → `mandatory`
 * 3. `maxAccuracyM` falls back to the tenant value when the policy leaves it
 *    NULL; `retryCount` and `selfieRequired` come from the policy when
 *    assigned, else the schema defaults (3 / true).
 */
export async function getEffectivePolicy(
  client: Queryable,
  user: { id: string; tenant_id: string; employment_type: string },
  tenant: { id: string; max_accuracy_m: number },
): Promise<EffectivePolicy> {
  // Look for an active policy assignment (effective range contains today).
  const result = await client.query<PolicyAssignmentRow>(
    `SELECT p.geofence_mode,
            p.selfie_required,
            p.max_accuracy_m,
            p.retry_count
       FROM user_policy_assignments upa
       JOIN attendance_policies p
         ON p.id = upa.policy_id
        AND p.tenant_id = $2
      WHERE upa.user_id = $1
        AND upa.effective_from <= CURRENT_DATE
        AND (upa.effective_to IS NULL OR upa.effective_to >= CURRENT_DATE)
      ORDER BY upa.effective_from DESC, upa.created_at DESC
      LIMIT 1`,
    [user.id, tenant.id],
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      geofenceMode: row.geofence_mode === 'optional' ? 'optional' : 'mandatory',
      maxAccuracyM: row.max_accuracy_m ?? tenant.max_accuracy_m,
      retryCount: row.retry_count,
      selfieRequired: row.selfie_required,
    };
  }

  // Fall back to the employment-type default.
  return {
    geofenceMode: user.employment_type === 'field_worker' ? 'optional' : 'mandatory',
    maxAccuracyM: tenant.max_accuracy_m,
    retryCount: 3,
    selfieRequired: true,
  };
}

/** A location enriched with its database id, as required by the verdict. */
export interface GeoLocationWithId extends GeoLocation {
  id: string;
}

/**
 * The outcome of evaluating a GPS fix against a worker's geofence policy.
 *
 * Kinds (PRD 7.3 / 7.5, decisions.md #2):
 * - `inside`                — fix is inside an assigned location.
 * - `outside_blocked`       — fix is outside all assigned locations and the
 *                             policy is `mandatory` (submission blocked).
 * - `outside_accepted`      — fix is outside all assigned locations and the
 *                             policy is `optional` (accepted, flagged).
 * - `no_location_blocked`   — no GPS fix (permission denied) and the policy
 *                             is `mandatory` (blocked).
 * - `no_location_accepted`  — no GPS fix and the policy is `optional`
 *                             (accepted with a missing-location anomaly).
 * - `accuracy_review`       — GPS accuracy exceeds the effective maximum
 *                             after retries; accepted but flagged
 *                             `needs_review` with an accuracy anomaly.
 *
 * Precedence:
 * 1. `accuracy_review` when `accuracyM` is present and exceeds the policy max.
 * 2. `no_location_*` when coordinates are missing.
 * 3. `inside` / `outside_*` based on the geofence math.
 */
export interface GeofenceVerdict {
  kind: 'inside' | 'outside_blocked' | 'outside_accepted' | 'no_location_blocked' | 'no_location_accepted' | 'accuracy_review';
  locationId?: string;
  distanceM?: number;
}

/** Finds the assigned location that contains the point, or the nearest one when outside. */
function nearestLocation(
  lat: number,
  lon: number,
  locations: GeoLocationWithId[],
): { location: GeoLocationWithId; distanceM: number } | null {
  let best: { location: GeoLocationWithId; distanceM: number } | null = null;
  for (const location of locations) {
    if (location.radius_m == null) continue;
    const distanceM = haversineMeters(lat, lon, location.latitude, location.longitude);
    if (!best || distanceM < best.distanceM) {
      best = { location, distanceM };
    }
  }
  return best;
}

/**
 * Pure geofence verdict for a single GPS fix.
 *
 * Delegates the inside/outside decision to `isInsideGeofence` (on-radius
 * counts as inside) and computes distances with `haversineMeters`.
 */
export function evaluateGeofence(args: {
  policy: EffectivePolicy;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locations: GeoLocationWithId[];
}): GeofenceVerdict {
  const { policy, latitude, longitude, accuracyM, locations } = args;

  // 1. Accuracy review takes precedence when we have a fix and the reported
  //    accuracy exceeds the allowed maximum.
  if (latitude != null && longitude != null && accuracyM != null && accuracyM > policy.maxAccuracyM) {
    const nearest = nearestLocation(latitude, longitude, locations);
    if (nearest && nearest.distanceM <= (nearest.location.radius_m ?? 0)) {
      return { kind: 'accuracy_review', locationId: nearest.location.id, distanceM: nearest.distanceM };
    }
    return { kind: 'accuracy_review', distanceM: nearest?.distanceM };
  }

  // 2. No GPS fix (permission denied or unavailable).
  if (latitude == null || longitude == null) {
    return policy.geofenceMode === 'mandatory' ? { kind: 'no_location_blocked' } : { kind: 'no_location_accepted' };
  }

  // 3. Inside / outside evaluation.
  if (isInsideGeofence(latitude, longitude, locations)) {
    const nearest = nearestLocation(latitude, longitude, locations);
    // `nearest` is guaranteed to exist because isInsideGeofence returned true.
    return { kind: 'inside', locationId: nearest!.location.id, distanceM: nearest!.distanceM };
  }

  const nearest = nearestLocation(latitude, longitude, locations);
  if (policy.geofenceMode === 'mandatory') {
    return { kind: 'outside_blocked' };
  }
  return { kind: 'outside_accepted', distanceM: nearest?.distanceM ?? 0 };
}
