/**
 * Pure geolocation retry/accuracy decision logic (decisions.md #2). Kept
 * DOM-free so it is unit-testable without a real Geolocation API; the
 * `useGeolocation` hook wires these decisions to `navigator.geolocation`.
 *
 * Rules:
 * - A fix is acceptable when accuracy <= maxAccuracyM (default 50 m).
 * - A poor fix is retried up to `maxAttempts` (default 3) total tries; after
 *   the budget is exhausted the caller submits the best fix it got and the
 *   server flags `needs_review` (accuracy anomaly).
 * - permission_denied is permanent: never retried, surfaced immediately.
 * - timeout / position_unavailable are transient: retried within the budget,
 *   then surfaced as a failure so the caller can submit WITHOUT coordinates
 *   (the server applies the no-location policy outcome).
 */

/** decisions.md #2: 3 capture retries (total attempts). */
export const GEOLOCATION_MAX_ATTEMPTS = 3;
/** decisions.md #2: 50 m accuracy ceiling. */
export const GEOLOCATION_MAX_ACCURACY_M = 50;

export type GeoErrorCode = 'permission_denied' | 'position_unavailable' | 'timeout';

/** What the hook should do with a successful fix. */
export type GeoFixDecision = 'fix' | 'retry' | 'exhausted';
/** What the hook should do after a geolocation error callback. */
export type GeoErrorDecision = 'retry' | 'failed';

/** True when a fix's accuracy is within the acceptable ceiling. */
export function isAccuracyAcceptable(accuracyM: number, maxAccuracyM: number = GEOLOCATION_MAX_ACCURACY_M): boolean {
  return accuracyM <= maxAccuracyM;
}

/**
 * Decides what to do with a successful fix on 1-based `attempt`:
 * - 'fix'       — accuracy is acceptable; use it and stop.
 * - 'retry'     — accuracy is poor but attempts remain; try again.
 * - 'exhausted' — accuracy is poor and the attempt budget is spent; submit
 *   this best-known fix and let the server flag an accuracy review.
 */
export function decideGeoAcquisition(args: {
  attempt: number;
  accuracyM: number;
  maxAccuracyM?: number;
  maxAttempts?: number;
}): GeoFixDecision {
  const maxAccuracyM = args.maxAccuracyM ?? GEOLOCATION_MAX_ACCURACY_M;
  const maxAttempts = args.maxAttempts ?? GEOLOCATION_MAX_ATTEMPTS;
  if (isAccuracyAcceptable(args.accuracyM, maxAccuracyM)) return 'fix';
  return args.attempt < maxAttempts ? 'retry' : 'exhausted';
}

/**
 * Decides what to do after a geolocation error on 1-based `attempt`:
 * permission_denied is permanent ('failed' immediately); transient errors
 * ('timeout' / 'position_unavailable') retry while attempts remain.
 */
export function decideRetryAfterError(args: {
  attempt: number;
  code: GeoErrorCode;
  maxAttempts?: number;
}): GeoErrorDecision {
  if (args.code === 'permission_denied') return 'failed';
  const maxAttempts = args.maxAttempts ?? GEOLOCATION_MAX_ATTEMPTS;
  return args.attempt < maxAttempts ? 'retry' : 'failed';
}

/** Maps a DOM GeolocationPositionError.code to a stable failure code. */
export function geoErrorCodeFromCode(code: number): GeoErrorCode {
  if (code === 1) return 'permission_denied';
  if (code === 3) return 'timeout';
  return 'position_unavailable';
}
