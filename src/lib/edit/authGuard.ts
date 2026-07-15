/**
 * Auth guard for /api/edit/* routes — defense-in-depth.
 *
 * The primary auth enforcement happens in Next.js middleware (src/middleware.ts).
 * This module provides an additional inline check that route handlers can call
 * for defense-in-depth (e.g., if middleware is ever misconfigured or bypassed).
 *
 * In local/dev mode when auth is not configured (no APP_PASSWORD + APP_AUTH_SECRET),
 * the guard is a no-op (passes through).
 *
 * Requirements: 9.2, 9.3
 */

import { cookies } from "next/headers";
import { AUTH_COOKIE, authConfigured, verifySession } from "@/lib/auth";
import { NextResponse } from "next/server";

/**
 * Returns a 401 response if the request is unauthenticated.
 * Returns null if the request is authenticated (caller should proceed).
 *
 * Usage in a route handler:
 *   const authError = await checkEditAuth();
 *   if (authError) return authError;
 *   // ... proceed with handler logic
 */
export async function checkEditAuth(): Promise<Response | null> {
  // If auth is not configured (local/dev), skip the check
  if (!authConfigured()) return null;

  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  const valid = await verifySession(token);

  if (!valid) {
    return NextResponse.json(
      { error: "No autorizado. Iniciá sesión." },
      { status: 401 }
    );
  }

  return null;
}
