/**
 * Stitch OPCIONAL con ffmpeg: une los clips en orden en un unico final.mp4 dentro
 * de la carpeta del proyecto. Si ffmpeg no esta instalado, se salta este paso.
 *
 * Normalizamos cada entrada (escala + pad al formato 9:16) y concatenamos VIDEO + AUDIO.
 * Para que la concatenacion no falle si algun clip no tiene pista de audio (b-roll mudo,
 * placeholder, etc.), a esos clips les agregamos una pista de SILENCIO de su misma duracion.
 * Asi el final.mp4 conserva el audio de los clips que lo tienen.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { projectsDb, jobsDb } from "./db";
import { buildManifest, absPathFor, projectDir } from "./storage";
import { hasFfmpeg } from "./providers/placeholder";

export interface StitchResult {
  ok: boolean;
  finalPath?: string; // relativo: "final.mp4"
  skipped?: boolean;
  reason?: string;
}

/**
 * Dimensiones del lienzo de salida 9:16 segun la resolucion objetivo.
 * IMPORTANTE: usamos resolucion REAL de video (no los placeholders de 360x640),
 * para que el final.mp4 NO pierda calidad al unir clips 720p/1080p.
 */
function canvasForResolution(resolution?: string): { w: number; h: number } {
  switch ((resolution ?? "720p").toLowerCase()) {
    case "1080p":
      return { w: 1080, h: 1920 };
    case "720p":
    default:
      return { w: 720, h: 1280 };
  }
}

/** ¿hay ffprobe disponible? (viene con ffmpeg normalmente). */
function hasFfprobe(): boolean {
  try {
    return spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Devuelve si el archivo tiene al menos una pista de audio. */
function probeHasAudio(absFile: string): boolean {
  try {
    const res = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        absFile,
      ],
      { encoding: "utf8" }
    );
    return res.status === 0 && Boolean(res.stdout && res.stdout.trim().length > 0);
  } catch {
    return false;
  }
}

/** Duracion del archivo en segundos (fallback a 8s si falla). */
function probeDuration(absFile: string, fallback = 8): number {
  try {
    const res = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        absFile,
      ],
      { encoding: "utf8" }
    );
    const d = parseFloat((res.stdout ?? "").trim());
    return Number.isFinite(d) && d > 0 ? d : fallback;
  } catch {
    return fallback;
  }
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

  // Resolucion objetivo = la MAS ALTA entre los clips (asi no perdemos calidad).
  const anyHd = ordered.some(
    (c) => (c.resolucion ?? project.defaultResolution ?? "720p").toLowerCase() === "1080p"
  );
  const { w, h } = canvasForResolution(anyHd ? "1080p" : "720p");
  const ffprobeOk = hasFfprobe();

  // Inputs reales (uno por clip). Detectamos audio/duracion por clip.
  const inputs: string[] = [];
  const clipMeta = ordered.map((clip, i) => {
    const abs = absPathFor(projectId, clip.file!);
    inputs.push("-i", abs);
    // Si no hay ffprobe, asumimos que tiene audio (los videos de Veo lo tienen).
    const hasAudio = ffprobeOk ? probeHasAudio(abs) : true;
    const duration = ffprobeOk
      ? probeDuration(abs, clip.duracion_seg || 8)
      : clip.duracion_seg || 8;
    return { videoIndex: i, hasAudio, duration, silenceIndex: -1 };
  });

  // Para clips sin audio, agregamos un input de silencio (anullsrc) de su duracion.
  let nextInput = ordered.length;
  for (const m of clipMeta) {
    if (!m.hasAudio) {
      inputs.push(
        "-f",
        "lavfi",
        "-t",
        String(Math.max(0.1, m.duration)),
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000"
      );
      m.silenceIndex = nextInput;
      nextInput += 1;
    }
  }

  // Filtros: video normalizado + audio (real o silencio) por clip.
  const filters: string[] = [];
  clipMeta.forEach((m, i) => {
    filters.push(
      `[${m.videoIndex}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`
    );
    const aSrc = m.hasAudio ? `${m.videoIndex}:a` : `${m.silenceIndex}:a`;
    filters.push(
      `[${aSrc}]aresample=48000,asetpts=N/SR/TB,aformat=channel_layouts=stereo[a${i}]`
    );
  });

  const concatPairs = clipMeta.map((_, i) => `[v${i}][a${i}]`).join("");
  const filterComplex =
    filters.join(";") +
    `;${concatPairs}concat=n=${clipMeta.length}:v=1:a=1[outv][outa]`;

  const finalRel = "final.mp4";
  const finalAbs = absPathFor(projectId, finalRel);

  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    // Calidad alta: CRF bajo + preset slow. Conserva la nitidez del 720p/1080p.
    "-crf",
    "18",
    "-preset",
    "slow",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-shortest",
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
