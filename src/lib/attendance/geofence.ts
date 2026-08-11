import { isInsideGeofence, haversineMeters, type GeoLocation } from './geo.ts';
import type { Queryable } from '../db/queryable.ts';

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
 * 1. The active `user_policy_assignments` row (effective range contains the
 *    effective date) joined to its `attendance_policies` row wins when present.
 * 2. Otherwise the employment-type default applies:
 *    - `field_worker` → `optional`
 *    - anything else (including `employee`) → `mandatory`
 * 3. `maxAccuracyM` falls back to the tenant value when the policy leaves it
 *    NULL; `retryCount` and `selfieRequired` come from the policy when
 *    assigned, else the schema defaults (3 / true).
 *
 * `effectiveDate` (`YYYY-MM-DD`) is the date the policy must be effective ON.
 * Callers recording an attendance event pass the resolved work date so a
 * backdated or cross-midnight event uses the policy in force on the work
 * date, not on the server's current date. It defaults to CURRENT_DATE for
 * back-compat. Date comparisons are done in text form (`::text` on the
 * columns) so the `YYYY-MM-DD` parameter never round-trips through pg's
 * DATE parser (which interprets bare dates as local midnight).
 */
export async function getEffectivePolicy(
  client: Queryable,
  user: { id: string; tenant_id: string; employment_type: string },
  tenant: { id: string; max_accuracy_m: number },
  effectiveDate?: string,
): Promise<EffectivePolicy> {
  // Look for an active policy assignment (effective range contains the date).
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
        AND upa.effective_from::text <= COALESCE($3::date, CURRENT_DATE)::text
        AND (upa.effective_to IS NULL OR upa.effective_to::text >= COALESCE($3::date, CURRENT_DATE)::text)
      ORDER BY upa.effective_from DESC, upa.created_at DESC
      LIMIT 1`,
    [user.id, tenant.id, effectiveDate ?? null],
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
 * Decision #12 (PRD 7.5): poor GPS accuracy and the inside/outside geofence
 * result are INDEPENDENT facts, not an either/or verdict. The verdict therefore
 * carries both as separate fields instead of a single `kind`:
 *
 * - `inside`          — `true` when the fix is within at least one assigned
 *                       location (on-radius counts as inside), `false` when it
 *                       is outside all of them, `null` when there is no GPS fix
 *                       (coordinates missing).
 * - `blocked`         — `true` ONLY when the policy is `mandatory` AND the fix
 *                       is outside all assigned locations (or there is no fix).
 *                       A mandatory block applies even when accuracy was poor.
 * - `accuracyAnomaly` — `true` when `accuracyM` is present and exceeds the
 *                       effective `maxAccuracyM`. Recorded independently of
 *                       inside/outside so reviewers keep the accuracy signal.
 * - `locationId`      — the id of the containing location when the fix is
 *                       inside one; `undefined` otherwise.
 * - `distanceM`       — distance to the NEAREST assigned location when a fix is
 *                       present; `undefined` (NOT 0) when there are no valid
 *                       locations or no fix.
 *
 * How `events.ts` should interpret it (see also `verdictToOutcome`):
 * - `blocked === true`                → reject the submission (`blocked`).
 * - `!blocked && accuracyAnomaly`     → accept, flag `needs_review` (accuracy).
 * - otherwise                         → accept.
 * The inside/outside fact (`inside`) is always recorded for review context,
 * especially for `optional` (field_worker) submissions.
 */
export interface GeofenceVerdict {
  inside: boolean | null;
  blocked: boolean;
  accuracyAnomaly: boolean;
  locationId?: string;
  distanceM?: number;
}

/**
 * Maps a verdict to the single accept/block/needs_review outcome `events.ts`
 * acts on. Kept tiny and pure so the interpretation is explicit and testable.
 *
 * - `blocked`       → submission rejected (mandatory outside / no fix).
 * - `needs_review`  → accepted but flagged (accuracy anomaly).
 * - `accepted`      → accepted.
 */
export function verdictToOutcome(verdict: GeofenceVerdict): 'accepted' | 'blocked' | 'needs_review' {
  if (verdict.blocked) return 'blocked';
  if (verdict.accuracyAnomaly) return 'needs_review';
  return 'accepted';
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
 * Accuracy and inside/outside are computed as INDEPENDENT facts (decision #12):
 * `isInsideGeofence` is the single source of truth for the inside test
 * (on-radius counts as inside) and `distanceM`/`locationId` are derived from
 * the same nearest-location pass, never from a duplicated radius re-check.
 */
export function evaluateGeofence(args: {
  policy: EffectivePolicy;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locations: GeoLocationWithId[];
}): GeofenceVerdict {
  const { policy, latitude, longitude, accuracyM, locations } = args;
  const mandatory = policy.geofenceMode === 'mandatory';

  // No GPS fix (permission denied or unavailable): there is no inside/outside
  // fact and no accuracy to evaluate. Mandatory blocks, optional accepts.
  if (latitude == null || longitude == null) {
    return { inside: null, blocked: mandatory, accuracyAnomaly: false };
  }

  const accuracyAnomaly = accuracyM != null && accuracyM > policy.maxAccuracyM;
  const inside = isInsideGeofence(latitude, longitude, locations);
  const nearest = nearestLocation(latitude, longitude, locations);

  const verdict: GeofenceVerdict = {
    inside,
    blocked: mandatory && !inside,
    accuracyAnomaly,
  };
  // `nearest` is null only when no location has a usable radius; leave
  // distanceM undefined (NOT 0) in that case.
  if (nearest) {
    verdict.distanceM = nearest.distanceM;
    if (inside) {
      verdict.locationId = nearest.location.id;
    }
  }
  return verdict;
}
