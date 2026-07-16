/**
 * GET /api/version -> { version, buildTime }
 *
 * Build identity for quick curl checks. Values are baked at build time via the
 * NEXT_PUBLIC_APP_VERSION / NEXT_PUBLIC_BUILD_TIME env vars (see Dockerfile).
 */
import { getAppVersion } from "@/lib/version";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return ok(getAppVersion());
}
