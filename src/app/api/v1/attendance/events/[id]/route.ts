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

/**
 * GET /api/v1/attendance/events/[id] — returns the event for the OWNER ONLY
 * (the session user). Another user, another tenant, or an unknown id all get
 * 404 so existence is never leaked across users or tenants.
 */
export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const scope = await tenantScope(guardRequestFrom(req));
    const { id } = await ctx.params;

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
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Event not found', 404);
    }
    return NextResponse.json({ event: row }, { status: 200 });
  } catch (err) {
    return jsonError(err);
  }
}
