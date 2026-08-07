import { NextResponse } from "next/server";

import { query } from "../../../lib/db/pool.ts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Liveness/readiness probe (PRD 15). Returns 200 when the process is up and the
 * database is reachable; 503 otherwise. Never leaks connection details, error
 * messages, or secrets in the response body.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await query("SELECT 1");
    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
