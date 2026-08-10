import { haversineMeters } from '../../lib/attendance/geo.ts';

/**
 * Pure capture-side helpers for the selfie watermark + resize (decisions.md
 * #5, PRD §7.5). Everything here is DOM-free and unit-testable; the DOM/canvas
 * glue lives in `CameraCapture.tsx`.
 *
 * Server contract: the uploaded JPEG must have a longest edge of at most
 * `CAPTURE_MAX_EDGE_PX` (the server re-validates declared dimensions) and must
 * be at most 1MB. The client therefore resizes to `CAPTURE_MAX_EDGE_PX` on the
 * longest edge and re-encodes at `CAPTURE_JPEG_QUALITY`, stepping the quality
 * down until the 1MB ceiling is met (see CameraCapture).
 */

/** decisions.md #5: longest-edge ceiling after client-side resize. */
export const CAPTURE_MAX_EDGE_PX = 1280;
/** decisions.md #5: preferred JPEG re-encode quality. */
export const CAPTURE_JPEG_QUALITY = 0.8;
/** decisions.md #5: hard upload ceiling (mirror of server SELFIE_MAX_BYTES). */
export const CAPTURE_MAX_BYTES = 1024 * 1024;

/** A location as exposed to the member client by /api/v1/attendance/context. */
export interface CaptureLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number | null;
}

export interface WatermarkInput {
  displayName: string;
  /** Instant the watermark reports (typically the capture time). */
  timestamp: Date;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  /** Assigned ACTIVE locations from the attendance context. */
  locations: CaptureLocation[];
  /** IANA timezone used to render the timestamp; defaults to the device zone. */
  timeZone?: string;
}

export interface LocationMatch {
  inside: boolean;
  /** The containing location when inside, else the nearest one; null with no fix / no locations. */
  matched: CaptureLocation | null;
  /** Distance to `matched` in whole meters; null when there is no fix or no usable location. */
  distanceM: number | null;
}

const WIB_LABELS: Record<string, string> = {
  'Asia/Jakarta': 'WIB',
  'Asia/Pontianak': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Ujung_Pandang': 'WITA',
  'Asia/Jayapura': 'WIT',
};

function timezoneLabel(timeZone: string): string {
  return WIB_LABELS[timeZone] ?? '';
}

/**
 * Renders an instant as `DD/MM/YYYY · HH:MM <zone>` in `timeZone` using only
 * formatToParts (no locale-parsing pitfalls). The zone label is appended only
 * for known Indonesian zones.
 */
export function formatWatermarkTimestamp(timestamp: Date, timeZone?: string): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  if (zone) options.timeZone = zone;

  const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(timestamp);
  let day = '';
  let month = '';
  let year = '';
  let hour = '';
  let minute = '';
  for (const part of parts) {
    if (part.type === 'day') day = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'year') year = part.value;
    else if (part.type === 'hour') hour = part.value;
    else if (part.type === 'minute') minute = part.value;
  }
  const label = zone ? timezoneLabel(zone) : '';
  return `${day}/${month}/${year} · ${hour}:${minute}${label ? ` ${label}` : ''}`;
}

function formatCoordinate(value: number): string {
  return value.toFixed(5);
}

/**
 * Finds the assigned location containing the fix (on-radius counts as inside),
 * or the nearest one when outside. Mirrors the server verdict semantics
 * (`evaluateGeofence`) but is intentionally simpler: this only labels the
 * watermark; the server remains authoritative for accept/block.
 */
export function matchLocation(
  latitude: number | null,
  longitude: number | null,
  locations: CaptureLocation[],
): LocationMatch {
  if (latitude == null || longitude == null) {
    return { inside: false, matched: null, distanceM: null };
  }
  let best: { location: CaptureLocation; distanceM: number } | null = null;
  for (const location of locations) {
    if (location.radiusM == null) continue;
    const distanceM = haversineMeters(latitude, longitude, location.latitude, location.longitude);
    if (!best || distanceM < best.distanceM) {
      best = { location, distanceM };
    }
  }
  if (!best) {
    return { inside: false, matched: null, distanceM: null };
  }
  const radius = best.location.radiusM ?? 0;
  return {
    inside: best.distanceM <= radius,
    matched: best.location,
    distanceM: Math.round(best.distanceM),
  };
}

/**
 * The four watermark text lines drawn onto the selfie. Always returns exactly
 * four non-empty lines so the canvas band sizing is deterministic:
 *   1. timestamp (DD/MM/YYYY · HH:MM zone)
 *   2. display name
 *   3. GPS coordinates + accuracy (or "GPS tidak tersedia")
 *   4. matched-location label (inside area / outside + distance / unavailable)
 */
export function buildWatermarkLines(input: WatermarkInput): string[] {
  const lines: string[] = [
    formatWatermarkTimestamp(input.timestamp, input.timeZone),
    input.displayName.trim() === '' ? 'Anggota' : input.displayName.trim(),
  ];

  if (input.latitude == null || input.longitude == null) {
    lines.push('GPS tidak tersedia');
    lines.push('Lokasi tidak diverifikasi');
    return lines;
  }

  const accuracy = input.accuracyM != null ? ` (±${Math.round(input.accuracyM)} m)` : '';
  lines.push(`GPS ${formatCoordinate(input.latitude)}, ${formatCoordinate(input.longitude)}${accuracy}`);

  const match = matchLocation(input.latitude, input.longitude, input.locations);
  if (match.inside && match.matched) {
    lines.push(`Area: ${match.matched.name}`);
  } else if (match.matched) {
    lines.push(`Di luar area terdaftar (${match.distanceM} m dari ${match.matched.name})`);
  } else {
    lines.push('Tidak ada lokasi terdaftar');
  }
  return lines;
}

/**
 * Target capture dimensions with the longest edge capped at
 * `CAPTURE_MAX_EDGE_PX` and the aspect ratio preserved. Images already at or
 * under the cap are returned unchanged. Throws on invalid source dimensions.
 */
export function computeCaptureSize(
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number = CAPTURE_MAX_EDGE_PX,
): { width: number; height: number } {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error(`invalid source dimensions: ${sourceWidth}x${sourceHeight}`);
  }
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= maxEdge) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/**
 * Height of the translucent watermark band at the bottom of the exported
 * image: roughly 14% of the image height, clamped to [56, 140] px so the four
 * lines stay legible on tiny captures and never dominate large ones.
 */
export function computeWatermarkBandHeight(imageHeight: number): number {
  const proportional = Math.round(imageHeight * 0.14);
  return Math.max(56, Math.min(140, proportional));
}
