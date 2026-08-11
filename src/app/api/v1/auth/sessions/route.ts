import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { requireSession } from '../../../../../lib/auth/guard.ts';
import { query } from '../../../../../lib/db/pool.ts';
import { guardRequestFrom, jsonError } from '../../../../../lib/api/http.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface SessionListRow {
  id: string;
  device_label: string | null;
  user_agent: string | null;
  ip: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
}

/**
 * GET /api/v1/auth/sessions — lists the caller's sessions for their tenant
 * (newest first). The token hash is NEVER selected, let alone returned.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { session, user } = await requireSession(guardRequestFrom(req));
    const result = await query<SessionListRow>(
      `SELECT id, device_label, user_agent, ip::text AS ip, created_at, last_seen_at, expires_at
         FROM sessions
        WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [user.tenant_id, user.id],
    );

    return NextResponse.json(
      {
        sessions: result.rows.map((row) => ({
          id: row.id,
          deviceLabel: row.device_label,
          userAgent: row.user_agent,
          ip: row.ip,
          createdAt: row.created_at.toISOString(),
          lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
          expiresAt: row.expires_at.toISOString(),
          current: row.id === session.id,
        })),
      },
      { status: 200 },
    );
  } catch (err) {
    return jsonError(err);
  }
}
