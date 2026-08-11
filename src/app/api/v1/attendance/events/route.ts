import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { AppError, ErrorCodes } from '../../../../../lib/auth/errors.ts';
import { tenantScope } from '../../../../../lib/auth/guard.ts';
import { guardRequestFrom, jsonError } from '../../../../../lib/api/http.ts';
import { getPool } from '../../../../../lib/db/pool.ts';
import { validateSelfie } from '../../../../../lib/images/selfie.ts';
import { storeObject } from '../../../../../lib/storage/objects.ts';
import {
  recordAttendanceEvent,
  type AttendanceEventType,
  type RecordAttendanceEventResult,
} from '../../../../../lib/attendance/events.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Small ceiling for the JSON metadata field (raw proof only; never large). */
const METADATA_MAX_CHARS = 8 * 1024;

/** Signed 32-bit integer bounds — the PG `int` columns reject anything wider. */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

interface EventMetadata {
  eventType?: unknown;
  idempotencyKey?: unknown;
  deviceOccurredAt?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  accuracyM?: unknown;
  locationAcquiredAt?: unknown;
  clockOffsetMs?: unknown;
}

function badRequest(message: string): AppError {
  return new AppError(ErrorCodes.VALIDATION_FAILED, message, 400);
}

function coerceNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw badRequest(`${field} must be a finite number`);
  }
  return n;
}

/**
 * These columns are `numeric(9,6)` / `int` in the DB. A value that fits the JS
 * number type but overflows the column raises SQLSTATE 22003 (numeric overflow)
 * on INSERT, which surfaces as a 500. Range-checking here turns that into the
 * correct client error: 400 VALIDATION_FAILED, never a 500.
 */
function coerceLatitude(value: unknown): number | null {
  const n = coerceNumber(value, 'latitude');
  if (n === null) return null;
  if (n < -90 || n > 90) {
    throw badRequest('latitude must be between -90 and 90');
  }
  return n;
}

function coerceLongitude(value: unknown): number | null {
  const n = coerceNumber(value, 'longitude');
  if (n === null) return null;
  if (n < -180 || n > 180) {
    throw badRequest('longitude must be between -180 and 180');
  }
  return n;
}

/** accuracy_m is a non-negative int column; reject negatives and int32 overflow. */
function coerceAccuracyM(value: unknown): number | null {
  const n = coerceNumber(value, 'accuracyM');
  if (n === null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw badRequest('accuracyM must be a non-negative integer');
  }
  if (n > INT32_MAX) {
    throw badRequest(`accuracyM must be at most ${INT32_MAX}`);
  }
  return n;
}

/** clock_offset_ms is a signed int column; reject int32 overflow. */
function coerceClockOffsetMs(value: unknown): number | null {
  const n = coerceNumber(value, 'clockOffsetMs');
  if (n === null) return null;
  if (!Number.isInteger(n)) {
    throw badRequest('clockOffsetMs must be an integer');
  }
  if (n < INT32_MIN || n > INT32_MAX) {
    throw badRequest(`clockOffsetMs must be between ${INT32_MIN} and ${INT32_MAX}`);
  }
  return n;
}

function coerceDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw badRequest(`${field} must be an ISO date string`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw badRequest(`${field} must be a valid ISO date string`);
  }
  return d;
}

/**
 * Parses and validates the multipart metadata field. Tenant/user scope are NOT
 * accepted here — they come from the session guard. Throws AppError on bad input.
 */
function parseMetadata(raw: string): {
  eventType: AttendanceEventType;
  idempotencyKey: string;
  deviceOccurredAt: Date;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locationAcquiredAt: Date | null;
  clockOffsetMs: number | null;
} {
  if (raw.length > METADATA_MAX_CHARS) {
    throw badRequest('metadata is too large');
  }
  let parsed: EventMetadata;
  try {
    parsed = JSON.parse(raw) as EventMetadata;
  } catch {
    throw badRequest('metadata must be valid JSON');
  }

  if (parsed.eventType !== 'check_in' && parsed.eventType !== 'check_out') {
    throw badRequest('eventType must be check_in or check_out');
  }
  if (typeof parsed.idempotencyKey !== 'string' || parsed.idempotencyKey.trim() === '') {
    throw badRequest('idempotencyKey is required');
  }
  const deviceOccurredAt = coerceDate(parsed.deviceOccurredAt, 'deviceOccurredAt');
  if (!deviceOccurredAt) {
    throw badRequest('deviceOccurredAt is required');
  }

  return {
    eventType: parsed.eventType,
    idempotencyKey: parsed.idempotencyKey,
    deviceOccurredAt,
    latitude: coerceLatitude(parsed.latitude),
    longitude: coerceLongitude(parsed.longitude),
    accuracyM: coerceAccuracyM(parsed.accuracyM),
    locationAcquiredAt: coerceDate(parsed.locationAcquiredAt, 'locationAcquiredAt'),
    clockOffsetMs: coerceClockOffsetMs(parsed.clockOffsetMs),
  };
}

/**
 * Maps a recordAttendanceEvent result to a JSON response with a stable shape:
 *   { created, outcome, event?, workInstance?, verdict? }
 *
 * Status mapping (documented):
 *   accepted / needs_review, created  → 201
 *   duplicate idempotency (created:false) → 200 (returns the ORIGINAL)
 *   blocked (geofence)                → 422
 *   rejected (first-event-wins etc.)  → 409
 */
function toEventResponse(result: RecordAttendanceEventResult): NextResponse {
  const payload = {
    created: result.created,
    outcome: result.outcome,
    ...(result.event ? { event: result.event } : {}),
    ...(result.workInstance ? { workInstance: result.workInstance } : {}),
    ...(result.verdict ? { verdict: result.verdict } : {}),
  };

  if (result.outcome === 'blocked') {
    return NextResponse.json({ code: 'BLOCKED', message: 'Event blocked by geofence policy', ...payload }, { status: 422 });
  }
  if (result.outcome === 'rejected') {
    return NextResponse.json({ code: 'REJECTED', message: 'Event rejected', ...payload }, { status: 409 });
  }
  // accepted / needs_review
  return NextResponse.json(payload, { status: result.created ? 201 : 200 });
}

/**
 * POST /api/v1/attendance/events — records a check-in / check-out from raw
 * proof (multipart: `metadata` JSON + `selfie` file). Tenant/user scope come
 * exclusively from the session; the selfie is validated, stored, and linked.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const scope = await tenantScope(guardRequestFrom(req));

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw badRequest('request must be multipart/form-data');
    }

    const metadataField = form.get('metadata');
    if (typeof metadataField !== 'string') {
      throw badRequest('metadata field is required');
    }
    const meta = parseMetadata(metadataField);

    // Selfie (optional): validate before touching storage.
    let selfieObjectId: string | null = null;
    const selfieField = form.get('selfie');
    const pool = getPool();

    if (selfieField instanceof Blob && selfieField.size > 0) {
      const buffer = Buffer.from(await selfieField.arrayBuffer());
      const verdict = validateSelfie(buffer);
      if (!verdict.ok) {
        throw badRequest(verdict.error);
      }
      // ATOMICITY DECISION: the selfie is stored (file + stored_objects row,
      // committed) BEFORE recordAttendanceEvent runs, and the resulting id is
      // handed to the event transaction as selfieObjectId. A single shared
      // transaction cannot make the on-disk file participate in the DB commit,
      // so true file+event atomicity is impossible; this ordering instead
      // guarantees (a) the event never references a missing object, and (b) a
      // blocked/rejected event leaves at worst an unreferenced, tenant-scoped
      // blob+row that is never served cross-tenant and is reclaimed by the
      // retention sweep. The two writes are independent commits, so an event
      // rollback never produces an orphaned object ROW pointing at a file.
      const stored = await storeObject(pool, {
        tenantId: scope.tenantId,
        kind: 'selfie',
        buffer,
        mediaType: 'image/jpeg',
      });
      selfieObjectId = stored.id;
    }

    const result = await recordAttendanceEvent(pool, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      eventType: meta.eventType,
      idempotencyKey: meta.idempotencyKey,
      deviceOccurredAt: meta.deviceOccurredAt,
      latitude: meta.latitude,
      longitude: meta.longitude,
      accuracyM: meta.accuracyM,
      locationAcquiredAt: meta.locationAcquiredAt,
      clockOffsetMs: meta.clockOffsetMs,
      selfieObjectId,
    });

    return toEventResponse(result);
  } catch (err) {
    return jsonError(err);
  }
}
