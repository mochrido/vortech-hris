import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { tenantScope } from '../../../../lib/auth/guard.ts';
import { guardRequestFrom, jsonError } from '../../../../lib/api/http.ts';
import { query } from '../../../../lib/db/pool.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface MeRow {
  id: string;
  display_name: string;
  email_normalized: string | null;
  phone_e164: string | null;
}

/** GET /api/v1/me — the session user's profile and roles. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const scope = await tenantScope(guardRequestFrom(req));
    const result = await query<MeRow>(
      `SELECT id, display_name, email_normalized, phone_e164 FROM users WHERE id = $1 AND tenant_id = $2`,
      [scope.userId, scope.tenantId],
    );
    const user = result.rows[0];

    return NextResponse.json(
      {
        user: {
          id: user.id,
          displayName: user.display_name,
          emailNormalized: user.email_normalized,
          phoneE164: user.phone_e164,
          roles: scope.roles,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    return jsonError(err);
  }
}
