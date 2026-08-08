import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { AppError, ErrorCodes } from '../../../../../lib/auth/errors.ts';
import { requireSession } from '../../../../../lib/auth/guard.ts';
import { guardRequestFrom, jsonError } from '../../../../../lib/api/http.ts';
import { getPool } from '../../../../../lib/db/pool.ts';
import { readObject } from '../../../../../lib/storage/objects.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

function notFound(): AppError {
  return new AppError(ErrorCodes.VALIDATION_FAILED, 'Object not found', 404);
}

/**
 * GET /api/v1/objects/[id] — streams a stored media object (e.g. a selfie) to
 * an authenticated session of the SAME tenant. Unknown, cross-tenant, or
 * soft-deleted ids all return 404 (no existence leak). The bytes are served
 * from the private storage root (never a client-supplied path) with the
 * allowlisted Content-Type, the correct Content-Length, and `Cache-Control:
 * private, no-store` (sensitive media must not be cached/shared).
 */
export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const resolved = await requireSession(guardRequestFrom(req));
    const { id } = await ctx.params;

    let object;
    try {
      object = await readObject(getPool(), { tenantId: resolved.user.tenant_id, id });
    } catch {
      // readObject throws a plain Error for unknown / cross-tenant / soft-deleted
      // / non-UUID / traversal ids; every one of those is a 404 here.
      throw notFound();
    }

    const bytes = new Uint8Array(object.buffer);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': object.mediaType,
        'Content-Length': String(object.buffer.length),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
