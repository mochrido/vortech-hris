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
    latitude: coerceNumber(parsed.latitude, 'latitude'),
    longitude: coerceNumber(parsed.longitude, 'longitude'),
    accuracyM: coerceNumber(parsed.accuracyM, 'accuracyM'),
    locationAcquiredAt: coerceDate(parsed.locationAcquiredAt, 'locationAcquiredAt'),
    clockOffsetMs: coerceNumber(parsed.clockOffsetMs, 'clockOffsetMs'),
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
