'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GEOLOCATION_MAX_ACCURACY_M,
  GEOLOCATION_MAX_ATTEMPTS,
  decideGeoAcquisition,
  decideRetryAfterError,
  geoErrorCodeFromCode,
  type GeoErrorCode,
} from './geolocation.ts';

/**
 * React hook wrapping navigator.geolocation for attendance capture
 * (decisions.md #2). Permission is requested IN CONTEXT — the hook never
 * touches the API until `request()` is called (i.e. when the member opens the
 * capture dialog), never on page load.
 *
 * Behaviour (all decisions delegated to the pure `geolocation.ts` helpers):
 * - watchPosition stream; a fix with accuracy <= maxAccuracyM resolves
 *   immediately (`status: 'ready'`).
 * - Poor-accuracy fixes retry until maxAttempts total tries; the best fix seen
 *   is then surfaced with `status: 'accuracy_review'` (the server will accept
 *   and flag it for review).
 * - permission_denied resolves immediately as a failure (no retry).
 * - timeout / position_unavailable retry within the same attempt budget, then
 *   surface as `status: 'timeout' | 'unavailable'` with the best fix (if any)
 *   so the caller may still submit without coordinates.
 */

export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  /** ISO instant the fix was acquired (device clock). */
  acquiredAt: string;
}

export type GeolocationStatus =
  | 'idle'
  | 'requesting'
  | 'ready'
  | 'accuracy_review'
  | 'permission_denied'
  | 'unavailable'
  | 'timeout'
  | 'unsupported';

export interface UseGeolocationResult {
  status: GeolocationStatus;
  /** The accepted fix, or the best fix seen on accuracy_review/timeout/unavailable. */
  position: GeoFix | null;
  accuracyM: number | null;
  acquiredAt: string | null;
  /** Number of fixes/errors processed in the current request cycle. */
  attempt: number;
  /** Stable failure code when status is a failure. */
  errorCode: GeoErrorCode | 'unsupported' | null;
  /** User-facing failure message when status is a failure; null otherwise. */
  error: string | null;
  /** Starts acquisition from scratch (initial ask). */
  request: () => void;
  /** Alias of `request` — the retry entry point after a failure. */
  retry: () => void;
}

const GEO_FAILURE_MESSAGES: Record<GeoErrorCode, string> = {
  permission_denied: 'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini, lalu coba lagi.',
  position_unavailable: 'Lokasi tidak tersedia. Pastikan GPS aktif dan sinyal tidak terhalang.',
  timeout: 'Pengambilan lokasi melebihi batas waktu. Coba lagi di tempat terbuka.',
};

const UNSUPPORTED_MESSAGE = 'Geolokasi tidak didukung peramban ini.';

export function geoFailureMessage(code: GeoErrorCode): string {
  return GEO_FAILURE_MESSAGES[code];
}

export interface UseGeolocationOptions {
  maxAccuracyM?: number;
  maxAttempts?: number;
  /** Per-fix timeout handed to the Geolocation API. */
  fixTimeoutMs?: number;
}

export function useGeolocation(options?: UseGeolocationOptions): UseGeolocationResult {
  const maxAccuracyM = options?.maxAccuracyM ?? GEOLOCATION_MAX_ACCURACY_M;
  const maxAttempts = options?.maxAttempts ?? GEOLOCATION_MAX_ATTEMPTS;
  const fixTimeoutMs = options?.fixTimeoutMs ?? 20000;

  const [status, setStatus] = useState<GeolocationStatus>('idle');
  const [position, setPosition] = useState<GeoFix | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [errorCode, setErrorCode] = useState<GeoErrorCode | 'unsupported' | null>(null);

  const watchIdRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const bestFixRef = useRef<GeoFix | null>(null);
  const settledRef = useRef(false);

  const stopWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  // Stop the hardware watch when the owning component (capture dialog) unmounts.
  useEffect(() => stopWatch, [stopWatch]);

  const request = useCallback(() => {
    stopWatch();
    attemptRef.current = 0;
    bestFixRef.current = null;
    settledRef.current = false;
    setAttempt(0);
    setPosition(null);
    setErrorCode(null);

    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setStatus('unsupported');
      setErrorCode('unsupported');
      return;
    }
    setStatus('requesting');

    const settle = (next: GeolocationStatus, fix: GeoFix | null, code: GeoErrorCode | 'unsupported' | null) => {
      if (settledRef.current) return;
      settledRef.current = true;
      stopWatch();
      setPosition(fix);
      setStatus(next);
      setErrorCode(code);
    };

    const rememberBest = (fix: GeoFix) => {
      if (!bestFixRef.current || fix.accuracyM < bestFixRef.current.accuracyM) {
        bestFixRef.current = fix;
      }
    };

    const bumpAttempt = () => {
      attemptRef.current += 1;
      setAttempt(attemptRef.current);
      return attemptRef.current;
    };

    const onSuccess = (raw: GeolocationPosition) => {
      if (settledRef.current) return;
      const fix: GeoFix = {
        latitude: raw.coords.latitude,
        longitude: raw.coords.longitude,
        accuracyM: Math.round(raw.coords.accuracy),
        acquiredAt: new Date(raw.timestamp).toISOString(),
      };
      const currentAttempt = bumpAttempt();
      const decision = decideGeoAcquisition({
        attempt: currentAttempt,
        accuracyM: fix.accuracyM,
        maxAccuracyM,
        maxAttempts,
      });
      if (decision === 'fix') {
        settle('ready', fix, null);
        return;
      }
      rememberBest(fix);
      if (decision === 'exhausted') {
        // Budget spent with only poor fixes: submit the best one; the server
        // flags an accuracy anomaly (decisions.md #2).
        settle('accuracy_review', bestFixRef.current, null);
      }
      // 'retry': keep the watch running for another fix.
    };

    const onError = (raw: GeolocationPositionError) => {
      if (settledRef.current) return;
      const code = geoErrorCodeFromCode(raw.code);
      const currentAttempt = bumpAttempt();
      const decision = decideRetryAfterError({ attempt: currentAttempt, code, maxAttempts });
      if (decision === 'retry') return; // keep the watch running
      settle(code === 'timeout' ? 'timeout' : code === 'permission_denied' ? 'permission_denied' : 'unavailable', bestFixRef.current, code);
    };

    try {
      watchIdRef.current = navigator.geolocation.watchPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: fixTimeoutMs,
      });
    } catch {
      settle('unsupported', null, 'unsupported');
    }
  }, [fixTimeoutMs, maxAccuracyM, maxAttempts, stopWatch]);

  const error =
    errorCode === null
      ? null
      : errorCode === 'unsupported'
        ? UNSUPPORTED_MESSAGE
        : geoFailureMessage(errorCode);

  return {
    status,
    position,
    accuracyM: position ? position.accuracyM : null,
    acquiredAt: position ? position.acquiredAt : null,
    attempt,
    errorCode,
    error,
    request,
    retry: request,
  };
}
