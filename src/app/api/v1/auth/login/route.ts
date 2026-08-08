import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { AppError, ErrorCodes } from '../../../../../lib/auth/errors.ts';
import { login } from '../../../../../lib/auth/login.ts';
import { extractClientIp, jsonError } from '../../../../../lib/api/http.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface LoginBody {
  tenantSlug?: unknown;
  identifier?: unknown;
  password?: unknown;
  deviceLabel?: unknown;
}

/**
 * POST /api/v1/auth/login — authenticates with { tenantSlug, identifier,
 * password } (identifier = email or phone), sets the session cookie, and
 * returns the user summary + roles. All failures map through the shared
 * error surface (INVALID_CREDENTIALS / RATE_LIMITED / VALIDATION_FAILED).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let body: LoginBody;
    try {
      body = (await req.json()) as LoginBody;
    } catch {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Invalid JSON body', 400);
    }

    const { tenantSlug, identifier, password, deviceLabel } = body;
    if (
      typeof tenantSlug !== 'string' || tenantSlug.trim() === '' ||
      typeof identifier !== 'string' || identifier.trim() === '' ||
      typeof password !== 'string' || password === ''
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'tenantSlug, identifier and password are required',
        400,
      );
    }

    const result = await login(tenantSlug, identifier, password, {
      userAgent: req.headers.get('user-agent') ?? undefined,
      deviceLabel: typeof deviceLabel === 'string' ? deviceLabel : undefined,
      ip: extractClientIp(req),
    });

    const res = NextResponse.json({ user: result.user }, { status: 200 });
    res.cookies.set(result.cookie.name, result.cookie.value, {
      httpOnly: result.cookie.httpOnly,
      sameSite: result.cookie.sameSite,
      path: result.cookie.path,
      secure: result.cookie.secure,
      maxAge: result.cookie.maxAge,
    });
    return res;
  } catch (err) {
    return jsonError(err);
  }
}
