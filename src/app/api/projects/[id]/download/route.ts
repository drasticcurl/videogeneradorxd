/**
 * GET /api/projects/:id/download
 *
 * Empaqueta TODO el proyecto en un .zip y lo devuelve para descargar:
 *   - images/ (aprobadas), clips/ (incluye segmentos __extK de las extensiones),
 *     references/, manifest.json, pipeline.log
 *   - stitch.sh / stitch.bat / concat-list.txt  -> para unir los clips con ffmpeg LOCAL
 *   - LEEME.txt con instrucciones
 *
 * El stitch (final.mp4) NO se hace en el servidor: lo corre el usuario en su PC con
 * ffmpeg, asi la nube solo genera y no gasta CPU encodeando video.
 *
 * El ZIP se arma en streaming (archiver, nivel "store") para no cargar todo en memoria.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { projectsDb } from "@/lib/db";
import { projectDir, slugify } from "@/lib/storage";
import { notFound, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Lista recursivamente los archivos de un dir -> [{ abs, rel }] (rel con separadores POSIX). */
async function walk(
  root: string,
  rel = ""
): Promise<{ abs: string; rel: string }[]> {
  const dirAbs = path.join(root, rel);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { abs: string; rel: string }[] = [];
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    // No incluimos las variantes candidatas no aprobadas (bloat).
    if (e.isDirectory() && childRel === "images/_candidates") continue;
    if (e.isDirectory()) {
      out.push(...(await walk(root, childRel)));
    } else if (e.isFile()) {
      out.push({ abs: path.join(root, childRel), rel: childRel });
    }
  }
  return out;
}

/** Construye el comando ffmpeg (filter_complex concat) para unir los clips en orden. */
function buildFfmpegConcat(clipFiles: string[]): string {
  const W = 1080;
  const H = 1920;
  const inputs = clipFiles.map((f) => `-i "${f}"`).join(" ");
  const scale = clipFiles
    .map(
      (_f, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`
    )
    .join(";");
  const concatIn = clipFiles.map((_f, i) => `[v${i}][${i}:a]`).join("");
  const filter = `${scale};${concatIn}concat=n=${clipFiles.length}:v=1:a=1[outv][outa]`;
  return (
    `ffmpeg -y ${inputs} -filter_complex "${filter}" ` +
    `-map "[outv]" -map "[outa]" -c:v libx264 -crf 18 -preset medium ` +
    `-pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart final.mp4`
  );
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const project = projectsDb.get(params.id);
    if (!project) return notFound("Proyecto no encontrado");

    const root = projectDir(project.id);
    if (!fs.existsSync(root)) {
      return notFound("El proyecto todavia no tiene archivos generados.");
    }

    const files = await walk(root);

    // Clips ordenados por nombre de archivo: "NN_slug.mp4" y luego "NN_slug__extK.mp4"
    // quedan adyacentes y en orden correcto (el '.' ordena antes que '_').
    const clipFiles = files
      .filter((f) => f.rel.startsWith("clips/") && f.rel.toLowerCase().endsWith(".mp4"))
      .map((f) => f.rel)
      .sort((a, b) => a.localeCompare(b, "en"));

    const archive = new ZipArchive({ zlib: { level: 0 } }); // store: mp4/png ya estan comprimidos

    // Archivos reales del proyecto.
    for (const f of files) {
      archive.file(f.abs, { name: f.rel });
    }

    // Scripts de stitch local (solo si hay clips).
    if (clipFiles.length > 0) {
      const ffmpegCmd = buildFfmpegConcat(clipFiles);
      const concatList =
        clipFiles.map((f) => `file '${f}'`).join("\n") + "\n";

      archive.append(`#!/usr/bin/env bash\nset -e\ncd "$(dirname "$0")"\n${ffmpegCmd}\n`, {
        name: "stitch.sh",
        mode: 0o755,
      });
      archive.append(
        `@echo off\r\ncd /d "%~dp0"\r\n${ffmpegCmd}\r\npause\r\n`,
        { name: "stitch.bat" }
      );
      archive.append(concatList, { name: "concat-list.txt" });
    }

    archive.append(buildReadme(project.name, clipFiles), { name: "LEEME.txt" });

    archive.finalize();

    const filename = `${slugify(project.name) || project.id}.zip`;
    const webStream = Readable.toWeb(archive) as unknown as ReadableStream;
    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return serverError(err);
  }
}

function buildReadme(name: string, clipFiles: string[]): string {
  return [
    `Proyecto: ${name}`,
    ``,
    `Este ZIP tiene todo lo generado en la nube:`,
    `  images/      imagenes aprobadas`,
    `  clips/       videos por clip (incluye segmentos __extK de las extensiones +7s)`,
    `  references/  fotos de referencia (si subiste avatares)`,
    `  manifest.json  metadata del proyecto`,
    ``,
    `UNIR LOS CLIPS EN UN final.mp4 (en tu PC, necesitas ffmpeg instalado):`,
    ``,
    `  Linux / Mac:   bash stitch.sh`,
    `  Windows:       doble click en stitch.bat`,
    ``,
    `Eso genera final.mp4 en esta misma carpeta, uniendo los ${clipFiles.length} clips`,
    `en orden, normalizados a 1080x1920 (9:16), con su audio.`,
    ``,
    `Alternativa rapida (si todos los clips ya tienen el mismo codec/resolucion):`,
    `  ffmpeg -f concat -safe 0 -i concat-list.txt -c copy final.mp4`,
    ``,
    `Nota: el script asume que cada clip tiene pista de audio (los de Veo la tienen).`,
  ].join("\n");
}
