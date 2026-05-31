/**
 * GET /api/files/<projectId>/<relPath...>
 * Sirve archivos generados desde ./output/<projectId>/ (imagenes, clips, final.mp4,
 * manifest.json). Con guardia anti path-traversal y soporte basico de Range (video).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { safeResolve } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".json": "application/json",
};

export async function GET(
  req: Request,
  { params }: { params: { path: string[] } }
) {
  const segments = params.path ?? [];
  if (segments.length < 2) {
    return new Response("Path invalido", { status: 400 });
  }
  const [projectId, ...rest] = segments;
  const relPath = rest.join("/");
  const abs = safeResolve(projectId, relPath);
  if (!abs) {
    return new Response("Acceso denegado", { status: 403 });
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return new Response("No encontrado", { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response("No encontrado", { status: 404 });
  }

  const ext = path.extname(abs).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const range = req.headers.get("range");

  // Soporte de Range (util para seek de video).
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start <= end && end < stat.size) {
        const chunk = await readRange(abs, start, end);
        return new Response(new Uint8Array(chunk), {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-store",
          },
        });
      }
    }
  }

  const data = await fsp.readFile(abs);
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}

async function readRange(
  filePath: string,
  start: number,
  end: number
): Promise<Buffer> {
  const fd = await fsp.open(filePath, "r");
  try {
    const length = end - start + 1;
    const buf = Buffer.alloc(length);
    await fd.read(buf, 0, length, start);
    return buf;
  } finally {
    await fd.close();
  }
}
