/**
 * Stitch OPCIONAL con ffmpeg: une los clips en orden en un unico mp4 dentro de la
 * carpeta del proyecto, llamado `<nombre del proyecto>.mp4`. Si ffmpeg no esta
 * instalado, se salta este paso.
 *
 * Normalizamos cada entrada (escala + pad al formato 9:16) y concatenamos VIDEO + AUDIO.
 * Para que la concatenacion no falle si algun clip no tiene pista de audio (b-roll mudo,
 * placeholder, etc.), a esos clips les agregamos una pista de SILENCIO de su misma duracion.
 * Asi el video unido conserva el audio de los clips que lo tienen.
 *
 * ─── COSTO ───────────────────────────────────────────────────────────────────
 *
 * Medido en la VPS (4 cores EPYC): con `-preset slow` tarda ~1 segundo de reloj por
 * cada segundo de video de salida. 8 clips de 8s = 64s de video -> 61s de encodeo,
 * saturando los 4 cores (load 6.4). Los funnels que comparten la maquina NO se vieron
 * afectados: p50 de 5-6ms antes y durante.
 *
 * Lo que SI importa: esto es `spawnSync`, o sea que bloquea el event loop de este
 * proceso mientras encodea. Un VSL de 95 clips son ~13 minutos con la app entera
 * congelada, y el request se va a comer el timeout del proxy. Para esos casos hay que
 * pasarlo a async con estado en la DB, como los jobs de la cola.
 */
import {
  spawnSync,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { projectsDb, jobsDb } from "./db";
import {
  buildManifest,
  absPathFor,
  finalVideoRelPath,
  projectDir,
} from "./storage";
import { hasFfmpeg } from "./providers/placeholder";

export interface StitchResult {
  ok: boolean;
  finalPath?: string; // relativo: "<nombre del proyecto>.mp4"
  skipped?: boolean;
  reason?: string;
}

/**
 * Dimensiones del lienzo de salida 9:16 segun la resolucion objetivo.
 * IMPORTANTE: usamos resolucion REAL de video (no los placeholders de 360x640),
 * para que el video unido NO pierda calidad al unir clips 720p/1080p.
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

/* ─────────────────── limite de cores para ffmpeg ─────────────────── */

/**
 * Cuantos cores puede usar ffmpeg. Default: TODOS MENOS UNO.
 *
 * En la VPS son 4, asi que quedan 3 para encodear y 1 libre. Se puede fijar a mano con
 * FFMPEG_CORES. El default es relativo y no un 3 escrito, para que en una maquina de 8
 * cores use 7 en vez de seguir clavado en 3.
 */
function coresParaFfmpeg(): number {
  const total = os.cpus().length || 1;
  const pedido = Number(process.env.FFMPEG_CORES);
  if (Number.isFinite(pedido) && pedido >= 1) {
    return Math.min(Math.floor(pedido), total);
  }
  return Math.max(1, total - 1);
}

let tasksetChecked = false;
let tasksetOk = false;

/** taskset existe en Linux (util-linux). En macOS NO hay equivalente. */
function hasTaskset(): boolean {
  if (tasksetChecked) return tasksetOk;
  tasksetChecked = true;
  try {
    tasksetOk = spawnSync("taskset", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    tasksetOk = false;
  }
  return tasksetOk;
}

/**
 * Corre ffmpeg limitado a N cores, dejando el resto libre para los otros procesos de
 * la maquina (en esta VPS, los funnels que sirven trafico real).
 *
 * Se usa `taskset` (afinidad de CPU) y no `-threads`. Medido en la VPS con un stitch de
 * 8 clips de 8s, mirando el uso de cada core:
 *
 *   sin limite                              4 cores al 89%    50s
 *   -threads 3 -filter_complex_threads 3    4 cores al ~63%   67s
 *   taskset -c 0-2                          3 al ~92%, uno al 8%   60s
 *
 * O sea que `-threads` baja el consumo total pero REPARTE el trabajo en los 4 cores
 * igual: no libera ninguno, que era el objetivo. taskset lo confina de verdad (load
 * exactamente 3.00) y encima termina antes que limitando hilos, porque ffmpeg conserva
 * su paralelismo interno y solo se le acota donde puede correr.
 *
 * En macOS no hay taskset, asi que ahi cae a `-threads` como aproximacion. No es
 * grave: la maquina de desarrollo no comparte con nada que importe.
 */
export function runFfmpeg(
  args: string[],
  opts?: { cwd?: string }
): SpawnSyncReturns<Buffer> {
  const n = coresParaFfmpeg();
  const total = os.cpus().length || 1;
  /*
    `encoding: "buffer"` fija el overload de spawnSync que devuelve Buffer. Sin eso el
    tipo sale `string | Buffer` y los callers, que hacen res.stderr.toString(), quedan
    con una union innecesaria. Y sin `as const` en el stdio, porque spawnSync lo pide
    mutable.
  */
  const comun: SpawnSyncOptionsWithBufferEncoding = {
    stdio: ["ignore", "ignore", "pipe"],
    cwd: opts?.cwd,
    encoding: "buffer",
  };

  if (n >= total) {
    return spawnSync("ffmpeg", args, comun);
  }
  if (hasTaskset()) {
    return spawnSync("taskset", ["-c", `0-${n - 1}`, "ffmpeg", ...args], comun);
  }
  /*
    Fallback sin taskset. `-threads` y `-filter_complex_threads` tienen que ir ANTES
    del primer -i para alcanzar a los decoders y al grafo de filtros; el encoder toma
    el `-threads` que ya va junto a libx264 mas abajo.
  */
  return spawnSync(
    "ffmpeg",
    ["-threads", String(n), "-filter_complex_threads", String(n), ...args],
    comun
  );
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
        "ffmpeg no esta instalado. Instalalo para unir los clips en un solo video (paso opcional).",
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

  const finalRel = finalVideoRelPath(project);
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

  const res = runFfmpeg(args, { cwd: projectDir(projectId) });

  if (res.status !== 0) {
    const stderr = res.stderr ? res.stderr.toString().slice(-600) : "";
    return { ok: false, reason: `ffmpeg fallo: ${stderr}` };
  }

  return { ok: true, finalPath: finalRel };
}
