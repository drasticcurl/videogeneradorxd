/**
 * Build identity exposed to the client.
 *
 * NEXT_PUBLIC_APP_VERSION and NEXT_PUBLIC_BUILD_TIME are inlined by Next.js at
 * build time (see Dockerfile next-builder stage). Reading them through this
 * helper keeps the fallbacks in one place so the version banner, the header
 * identifier next to `AUGC Pipeline`, and GET /api/version all agree for the
 * same build/revision.
 *
 * Deployment identity (spec `unir-step-hang`, design §"Fix Implementation /
 * Change 1", Property 3): to detect a stale/mismatched revision (Category D)
 * in-product, the displayed `version` combines the baked Docker image tag with
 * an exact, human-readable manual identifier, space-separated:
 *
 *     "<image-tag> v0.9125 kiwi xD"
 *
 * The header beside the title shows the manual identifier, and GET /api/version
 * exposes the same combined `version`, so header and API can be compared for
 * agreement and both correspond to the same build.
 */

/**
 * Exact manual identifier shown next to the `AUGC Pipeline` title and echoed by
 * GET /api/version. Baked once via env (NEXT_PUBLIC_APP_IDENTIFIER, wired through
 * the Dockerfile / cloudbuild build-arg) with this literal as the fallback so
 * standalone/local builds stay coherent.
 */
export const MANUAL_IDENTIFIER = "v0.9125 kiwi xD";

export interface AppVersion {
  /** Combined display identity: "<image-tag> <manual identifier>". */
  version: string;
  /** Baked Docker image tag (NEXT_PUBLIC_APP_VERSION), e.g. the deployed _TAG. */
  imageTag: string;
  /** Exact manual identifier, space-separated from the image tag. */
  identifier: string;
  /** Build moment inlined at build time. */
  buildTime: string;
}

export function getAppVersion(): AppVersion {
  const imageTag = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  const identifier = process.env.NEXT_PUBLIC_APP_IDENTIFIER ?? MANUAL_IDENTIFIER;
  return {
    version: `${imageTag} ${identifier}`,
    imageTag,
    identifier,
    buildTime: process.env.NEXT_PUBLIC_BUILD_TIME ?? "unknown",
  };
}

/**
 * Server-side-only diagnostics. Includes the Cloud Run revision name
 * (K_REVISION) so logs can be correlated to the effective revision serving a
 * request. This is NEVER rendered to the client and MUST NOT expose secrets —
 * K_REVISION is a plain revision label injected by the platform.
 */
export interface ServerDiagnostics extends AppVersion {
  /** Cloud Run revision name (server-side diagnostics only, never rendered). */
  revision: string;
}

export function getServerDiagnostics(): ServerDiagnostics {
  return {
    ...getAppVersion(),
    revision: process.env.K_REVISION ?? "unknown",
  };
}
