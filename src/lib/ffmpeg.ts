/**
 * Stitch OPCIONAL con ffmpeg: une los clips en orden en un unico final.mp4 dentro
 * de la carpeta del proyecto. Si ffmpeg no esta instalado, se salta este paso.
 *
 * Por robustez (los clips pueden tener distintos codecs/audio), normalizamos cada
 * entrada (escala + pad al formato) y concatenamos solo video. Cada clip individual
 * conserva su propio audio; el final.mp4 es un preview unido.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { projectsDb, jobsDb } from "./db";
import { buildManifest, absPathFor, projectDir } from "./storage";
import { dimsForAspect, hasFfmpeg } from "./providers/placeholder";

export interface StitchResult {
  ok: boolean;
  finalPath?: string; // relativo: "final.mp4"
  skipped?: boolean;
  reason?: string;
}

export function stitchProject(projectId: string): StitchResult {
  if (!hasFfmpeg()) {
    return {
      ok: false,
      skipped: true,
      reason:
        "ffmpeg no esta instalado. Instalalo para unir los clips en final.mp4 (paso opcional).",
    };
  }

  const project = projectsDb.get(projectId);
  if (!project) return { ok: false, reason: "Proyecto no encontrado." };

  const manifest = buildManifest(project, jobsDb.byProject(projectId));
  const ordered = manifest.clips
    .filter((c) => c.file && fs.existsSync(absPathFor(projectId, c.file)))
    .sort((a, b) => a.orden - b.orden);

  if (ordered.length === 0) {
    return {
      ok: false,
      reason: "No hay clips generados/subidos todavia para unir.",
    };
  }

  const { w, h } = dimsForAspect(project.plan.global.formato || "9:16");

  const inputs: string[] = [];
  const filters: string[] = [];
  ordered.forEach((clip, i) => {
    inputs.push("-i", absPathFor(projectId, clip.file!));
    // Escalamos manteniendo aspecto y rellenamos con negro al tamano objetivo.
    filters.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v${i}]`
    );
  });
  const concatInputs = ordered.map((_, i) => `[v${i}]`).join("");
  const filterComplex =
    filters.join(";") + `;${concatInputs}concat=n=${ordered.length}:v=1:a=0[outv]`;

  const finalRel = "final.mp4";
  const finalAbs = absPathFor(projectId, finalRel);

  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    finalAbs,
  ];

  const res = spawnSync("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"],
    cwd: projectDir(projectId),
  });

  if (res.status !== 0) {
    const stderr = res.stderr ? res.stderr.toString().slice(-600) : "";
    return { ok: false, reason: `ffmpeg fallo: ${stderr}` };
  }

  return { ok: true, finalPath: finalRel };
}
