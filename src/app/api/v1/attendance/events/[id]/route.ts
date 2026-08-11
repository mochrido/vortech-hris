import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { AppError, ErrorCodes } from '../../../../../../lib/auth/errors.ts';
import { tenantScope } from '../../../../../../lib/auth/guard.ts';
import { guardRequestFrom, jsonError } from '../../../../../../lib/api/http.ts';
import { getPool } from '../../../../../../lib/db/pool.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Same UUID gate as lib/storage/objects.ts — anything else is hostile input. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * GET /api/v1/attendance/events/[id] — returns the event for the OWNER ONLY
 * (the session user). Another user, another tenant, or an unknown id all get
 * 404 so existence is never leaked across users or tenants.
 */
export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const scope = await tenantScope(guardRequestFrom(req));
    const { id } = await ctx.params;

    // A malformed (non-UUID) id would make the `id = $1` comparison raise
    // SQLSTATE 22P02 (invalid_text_representation) → 500. Gate it BEFORE the
    // query and return 404, matching the objects route and the no-existence-leak
    // contract: an id that can never exist is indistinguishable from a missing one.
    if (!UUID_RE.test(id)) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Event not found', 404);
    }

    const result = await getPool().query(
      `SELECT id, tenant_id, user_id, work_instance_id, event_type, idempotency_key,
              device_occurred_at, server_received_at, source, latitude, longitude,
              accuracy_m, distance_m, location_id, geofence_result, selfie_object_id,
              clock_offset_ms, status
         FROM attendance_events
        WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [id, scope.tenantId, scope.userId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Event not found', 404);
    }
    return NextResponse.json({ event: row }, { status: 200 });
  } catch (err) {
    return jsonError(err);
  }
}
