/**
 * Build identity exposed to the client.
 *
 * NEXT_PUBLIC_APP_VERSION and NEXT_PUBLIC_BUILD_TIME are inlined by Next.js at
 * build time (see Dockerfile next-builder stage). Reading them through this
 * helper keeps the fallbacks in one place so the version banner and
 * GET /api/version agree.
 */
export interface AppVersion {
  version: string;
  buildTime: string;
}

export function getAppVersion(): AppVersion {
  return {
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
    buildTime: process.env.NEXT_PUBLIC_BUILD_TIME ?? "unknown",
  };
}
