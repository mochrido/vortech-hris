import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { tenantScope } from '../../../../../lib/auth/guard.ts';
import { guardRequestFrom, jsonError } from '../../../../../lib/api/http.ts';
import { getPool } from '../../../../../lib/db/pool.ts';
import { getAttendanceContext } from '../../../../../lib/attendance/context.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/v1/attendance/context — the member's attendance context: effective
 * schedule, effective geofence policy, assigned active locations, server time.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const scope = await tenantScope(guardRequestFrom(req));
    const context = await getAttendanceContext(getPool(), scope.tenantId, scope.userId);
    return NextResponse.json(context, { status: 200 });
  } catch (err) {
    return jsonError(err);
  }
}
