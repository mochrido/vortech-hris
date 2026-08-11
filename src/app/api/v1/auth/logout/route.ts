import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { requireSession } from '../../../../../lib/auth/guard.ts';
import { revokeSession } from '../../../../../lib/auth/session.ts';
import { guardRequestFrom, jsonError } from '../../../../../lib/api/http.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_COOKIE_NAME = 'vortech_session';

/**
 * POST /api/v1/auth/logout — revokes the caller's session and clears the
 * session cookie. Requires a valid session (401 otherwise).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { session } = await requireSession(guardRequestFrom(req));
    await revokeSession(session.id);

    const res = NextResponse.json({ ok: true }, { status: 200 });
    res.cookies.set(process.env.SESSION_COOKIE_NAME ?? DEFAULT_COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: (process.env.APP_ORIGIN ?? '').startsWith('https://'),
      maxAge: 0,
    });
    return res;
  } catch (err) {
    return jsonError(err);
  }
}
