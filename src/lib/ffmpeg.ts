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
 * Medido en la VPS (4 cores EPYC) sobre un proyecto REAL de 6 clips, 40.1s de video,
 * con los 3 cores que deja el limite y el preset actual: ~32s, o sea 0.8s de reloj por
 * segundo de video. Con el `-preset slow` de antes eran 52s.
 *
 * Los funnels que comparten la maquina NO se ven afectados ni sin el limite de cores:
 * p50 de 4-6ms antes, durante y despues, con ffmpeg al 89% en los 4 cores.
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

/**
 * Preset de x264. Cuanto mas lento, mejor compresion para la misma calidad.
 *
 * Default `medium`, que es el propio default de x264. Antes estaba en `slow` y eso
 * costaba mucho por casi nada. Medido sobre un proyecto real de 6 clips (40.1s de
 * video), con 3 cores y fps nativo:
 *
 *   slow    51.9s   13.5 MB    (lo de antes)
 *   medium  31.9s   13.9 MB    SSIM 0.996 contra slow
 *   fast    26.4s   14.1 MB    SSIM 0.996
 *   faster  19.0s   13.7 MB    SSIM 0.9956
 *
 * O sea: `medium` termina 39% antes, pesa 3% mas y la diferencia de imagen es de
 * 0.4% de SSIM, que a ojo no existe. Y estos videos despues los re-encodea Meta o
 * TikTok igual, asi que afinar el ultimo 0.4% en el archivo intermedio no cambia nada
 * de lo que ve el usuario final.
 *
 * `FFMPEG_PRESET` lo cambia sin tocar codigo (ej. `faster` para bajar a ~19s).
 */
function presetX264(): string {
  const permitidos = [
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
  ];
  const pedido = (process.env.FFMPEG_PRESET ?? "").trim();
  return permitidos.includes(pedido) ? pedido : "medium";
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

/**
 * Frames por segundo del archivo, o null si no se puede leer.
 *
 * `r_frame_rate` viene como fraccion ("24/1", "30000/1001"), asi que se divide.
 */
function probeFps(absFile: string): number | null {
  try {
    const res = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate",
        "-of",
        "csv=p=0",
        absFile,
      ],
      { encoding: "utf8" }
    );
    const crudo = (res.stdout ?? "").trim();
    const [num, den] = crudo.split("/").map(Number);
    if (!Number.isFinite(num)) return null;
    const fps = den && Number.isFinite(den) ? num / den : num;
    return fps > 0 && fps <= 120 ? fps : null;
  } catch {
    return null;
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

  /**
   * FPS de salida: el MAS ALTO de los clips, no un 30 fijo.
   *
   * Los clips de Veo vienen a 24. Forzar 30 duplicaba 1 de cada 4 frames (24 -> 30 es
   * 1.25x) y eso cuesta sin devolver nada: medido sobre un proyecto real de 6 clips,
   * 12% mas de tiempo de encodeo (6.9s de 58s) y 1203 frames en vez de 962, para un
   * archivo del MISMO peso. Los frames repetidos ademas pueden meter judder en el
   * movimiento, porque la duplicacion es despareja.
   *
   * Se toma el maximo y no el minimo para no tirar frames si algun dia se mezclan
   * clips de distinto framerate. Si ffprobe no esta, queda el 30 de antes.
   */
  const fpsDetectados = ffprobeOk
    ? ordered
        .map((c) => probeFps(absPathFor(projectId, c.file!)))
        .filter((f): f is number => f !== null)
    : [];
  const fpsSalida =
    fpsDetectados.length > 0 ? Math.round(Math.max(...fpsDetectados)) : 30;

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
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fpsSalida},format=yuv420p[v${i}]`
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
    // CRF 18 conserva la nitidez del 720p/1080p. El preset sale de presetX264(),
    // que documenta por que ya no es `slow`.
    "-crf",
    "18",
    "-preset",
    presetX264(),
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
