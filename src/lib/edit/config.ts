/**
 * Edit-mode configuration for the generator ↔ editor integration.
 *
 * Controls whether the generator talks to the internal editor process in "cloud"
 * mode (one combined Cloud Run container) or "local" mode (standalone processes).
 *
 * Durable output storage config is inherited from videogeneradorxd's existing
 * storage configuration (OUTPUT_DIR / GCS FUSE mount). No dedicated edit bucket.
 *
 * Requirements: 7, 9, 10
 */

export type EditMode = "local" | "cloud";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

// ---------------------------------------------------------------------------
// Configuration values
// ---------------------------------------------------------------------------

/**
 * EDIT_MODE controls the deployment topology:
 *  - "local": both apps run standalone, editor reached over loopback, filesystem I/O.
 *  - "cloud": one combined Cloud Run container; editor reached over localhost,
 *             shared filesystem scratch for I/O, existing Output_Store for persistence.
 *
 * Default: "local" (standalone development without external services).
 */
export function getEditMode(): EditMode {
  const raw = env("EDIT_MODE", "local").toLowerCase();
  if (raw === "cloud") return "cloud";
  return "local";
}

/**
 * Whether the system is running in cloud mode.
 * Convenience predicate for gating cloud-only code paths.
 */
export function isCloudMode(): boolean {
  return getEditMode() === "cloud";
}

/**
 * Base URL of the editor service.
 * In cloud mode this is localhost (the editor process in the same container).
 * In local mode this defaults to http://127.0.0.1:8000 (the editor's default port).
 */
export function getEditorBaseUrl(): string {
  return env("EDITOR_BASE_URL", "http://127.0.0.1:8000");
}

/**
 * TTL (in seconds) for signed URLs when serving edited outputs via redirect.
 * Only relevant in cloud mode when GCS signed URLs are used.
 * Must be between 60 and 3600 seconds (validated at use-site).
 * Default: 3600 (1 hour).
 */
export function getSignedUrlTtlSec(): number {
  return envInt("EDIT_SIGNED_URL_TTL_SEC", 3600);
}

/**
 * Maximum size (in bytes) for a single b-roll clip upload.
 * Default: 500 MB (500 * 1024 * 1024).
 */
export function getMaxBrollBytes(): number {
  return envInt("MAX_BROLL_BYTES", 500 * 1024 * 1024);
}

/**
 * Maximum number of clips (generated + b-roll combined) per edit job.
 * Default: 500.
 */
export function getMaxClipsPerJob(): number {
  return envInt("MAX_CLIPS_PER_JOB", 500);
}

// ---------------------------------------------------------------------------
// Aggregate config object (for convenience / snapshot logging)
// ---------------------------------------------------------------------------

export const editConfig = {
  get mode() {
    return getEditMode();
  },
  get isCloud() {
    return isCloudMode();
  },
  get editorBaseUrl() {
    return getEditorBaseUrl();
  },
  get signedUrlTtlSec() {
    return getSignedUrlTtlSec();
  },
  get maxBrollBytes() {
    return getMaxBrollBytes();
  },
  get maxClipsPerJob() {
    return getMaxClipsPerJob();
  },
} as const;
