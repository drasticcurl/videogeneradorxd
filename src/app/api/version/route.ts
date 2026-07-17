/**
 * GET /api/version -> { version, imageTag, identifier, buildTime }
 *
 * Build identity for quick curl checks and in-product deployment-identity
 * coherence (spec `unir-step-hang`, Property 3). Values are baked at build time
 * via NEXT_PUBLIC_APP_VERSION / NEXT_PUBLIC_APP_IDENTIFIER / NEXT_PUBLIC_BUILD_TIME
 * (see Dockerfile), so the manual identifier shown beside the `AUGC Pipeline`
 * title and this endpoint agree for the same build/revision.
 *
 * The Cloud Run revision (K_REVISION) is logged server-side only for
 * correlation; it is NEVER included in the response body (no secrets, never
 * rendered).
 */
import { getAppVersion, getServerDiagnostics } from "@/lib/version";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Server-side-only diagnostics: correlate the response to the effective
  // revision without exposing it to the client.
  const diagnostics = getServerDiagnostics();
  console.debug("[api/version] served build identity", {
    version: diagnostics.version,
    imageTag: diagnostics.imageTag,
    buildTime: diagnostics.buildTime,
    revision: diagnostics.revision,
  });

  // Client-facing payload never includes the revision.
  return ok(getAppVersion());
}
