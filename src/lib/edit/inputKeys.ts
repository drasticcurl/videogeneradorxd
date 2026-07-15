import path from "node:path";

function safeBaseName(fileName: string, fallback: string): string {
  const base = path.posix.basename(fileName.replace(/\\/g, "/")).trim();
  const sanitized = base
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

/**
 * Build a deterministic, flat filename for editor inputs. The ordinal prevents
 * clips with the same basename from overwriting each other on the shared path.
 */
export function editorClipFileName(index: number, fileName: string): string {
  const ordinal = String(index + 1).padStart(4, "0");
  return `clip-${ordinal}-${safeBaseName(fileName, "input.mp4")}`;
}

export function editorMusicFileName(fileName: string): string {
  return `music-${safeBaseName(fileName, "track.bin")}`;
}
