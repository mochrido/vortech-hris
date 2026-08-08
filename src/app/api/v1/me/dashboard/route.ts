import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { tenantScope } from '../../../../../lib/auth/guard.ts';
import { guardRequestFrom, jsonError } from '../../../../../lib/api/http.ts';
import { getPool } from '../../../../../lib/db/pool.ts';
import { getMyDashboard } from '../../../../../lib/attendance/me-dashboard.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/v1/me/dashboard — today's attendance status plus recent attendance
 * for the session user (tenant-scoped via the guard, never client input).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const scope = await tenantScope(guardRequestFrom(req));
    const dashboard = await getMyDashboard(getPool(), scope.tenantId, scope.userId);
    return NextResponse.json(dashboard, { status: 200 });
  } catch (err) {
    return jsonError(err);
  }
}
