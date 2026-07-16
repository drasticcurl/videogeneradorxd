"use client";
/**
 * VersionBanner — tiny, unobtrusive build-identity chip.
 *
 * Fixed to the bottom-right corner so it is visible on every page (mounted in
 * the root layout) but never blocks interaction (pointer-events-none). Shows
 * `version · buildTime` from the build-time NEXT_PUBLIC_* env vars so a deploy
 * that actually shipped is instantly recognizable.
 */
import { getAppVersion } from "@/lib/version";

export function VersionBanner() {
  const { version, buildTime } = getAppVersion();
  return (
    <div
      className="pointer-events-none fixed bottom-1 right-1 z-50 select-none rounded bg-slate-900/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-slate-400/70"
      title={`Versión ${version} · build ${buildTime}`}
      aria-hidden="true"
    >
      {version} · {buildTime}
    </div>
  );
}
