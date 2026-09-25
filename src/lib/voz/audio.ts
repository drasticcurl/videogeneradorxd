/**
 * El motor de audio del cambio de voz: los 7 pasos de ffmpeg de
 * tasks/cambio-de-voz/02-DISENO.md §9, verificados con ffmpeg real en §1.
 *
 * Dos garantias que sostienen todo el modulo:
 *   - D5: cada pieza de la pista nueva tiene EXACTAMENTE las muestras de su tramo
 *     original. Todos los cortes son por muestra a 48 kHz, y el fin de una pieza es la
 *     misma muestra que el inicio de la siguiente. Sin esto, 20 ms de error por tramo se
 *     acumulan y el final del video queda corrido de la boca.
 *   - D1: el video no se toca (-c:v copy, md5 identico). Solo la prueba re-encodea.
 *
 * Todo va por runFfmpegAsync (limite de cores, no bloquea el event loop) y recibe el
 * signal de la corrida, asi cancelar mata el ffmpeg en curso.
 */
import { execFile, execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { runFfmpegAsync } from "../ffmpeg";
import { hasFfmpeg } from "../providers/placeholder";

export const SR = 48000;

/** Segundos → muestra a 48 kHz. Todas las fronteras pasan por aca. */
export const muestra = (seg: number): number => Math.round(seg * SR);

let ffprobeOk: boolean | null = null;
/** ffmpeg y ffprobe presentes. El chequeo de ffprobe es un -version de milisegundos. */
export function hayFfmpegYFfprobe(): boolean {
  if (!hasFfmpeg()) return false;
  if (ffprobeOk === null) {
    try {
      execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
      ffprobeOk = true;
    } catch {
      ffprobeOk = false;
    }
  }
  return ffprobeOk;
}

/** Muestras del primer stream de audio (duration_ts de un WAV = muestras exactas). */
export function muestrasDe(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts", "-of", "csv=p=0", file],
      { encoding: "utf8" },
      (err, stdout) => {
        const n = Number(String(stdout ?? "").trim().split(/\s+/)[0]);
        if (err || !Number.isFinite(n)) reject(new Error(`ffmpeg falló en medir el audio: ${String(err?.message ?? stdout).slice(-300)}`));
        else resolve(n);
      },
    );
  });
}

async function ff(paso: string, args: string[], signal?: AbortSignal): Promise<void> {
  const r = await runFfmpegAsync(args, { signal });
  if (r.code !== 0) throw new Error(`ffmpeg falló en ${paso}: ${r.stderr.slice(-300)}`);
}

/** Paso 1 — audio completo del unido, PCM 48 kHz estereo. Devuelve N_total. */
export async function extraerCompleto(unidoAbs: string, out: string, signal?: AbortSignal): Promise<number> {
  await ff("extraer el audio", ["-y", "-i", unidoAbs, "-vn", "-ac", "2", "-ar", String(SR), "-c:a", "pcm_s16le", out], signal);
  return muestrasDe(out);
}

/** Paso 2 — el tramo para el proveedor: WAV mono 44,1 kHz s16 (el formato que acepta el STS). */
export async function cortarTramo(completo: string, a: number, b: number, out: string, signal?: AbortSignal): Promise<void> {
  await ff(
    "cortar el tramo",
    [
      "-y",
      "-i",
      completo,
      "-af",
      `atrim=start_sample=${a}:end_sample=${b},asetpts=N/SR/TB`,
      "-ac",
      "1",
      "-ar",
      "44100",
      "-c:a",
      "pcm_s16le",
      out,
    ],
    signal,
  );
}

/** La salida del proveedor dura mas de un 5 % distinto que el tramo (D5). */
export class DuracionInesperada extends Error {
  constructor() {
    super("duración fuera del 5 %");
    this.name = "DuracionInesperada";
  }
}

/**
 * Paso 3 — normalizar la salida del proveedor a EXACTAMENTE n muestras 48 kHz estereo.
 *
 * Primero se mide la salida (ya decodificada y con el offset aplicado) y despues se
 * normaliza con el comando de §9. El ajuste depende de la diferencia:
 *   |Δ| <= 50 ms        nada: apad + atrim absorben
 *   50 ms < |Δ| <= 5 %  atempo, que corrige la duracion conservando el tono
 *   |Δ| > 5 %           falla: no es un redondeo, es otra performance
 * T00 midio con ElevenLabs real Δ de 15 a 22 ms en 20, 60 y 270 s.
 */
export async function normalizarSalida(
  entrada: string,
  n: number,
  out: string,
  opts: { offsetMs: number; trabajo: string; signal?: AbortSignal },
): Promise<void> {
  const offset = opts.offsetMs > 0 ? `atrim=start=${opts.offsetMs / 1000},asetpts=N/SR/TB,` : "";

  const medida = path.join(opts.trabajo, `${path.basename(out, ".wav")}_medida.wav`);
  await ff(
    "medir la salida",
    ["-y", "-i", entrada, "-af", `${offset}aresample=${SR}`, "-ac", "2", "-c:a", "pcm_s16le", medida],
    opts.signal,
  );
  const m = await muestrasDe(medida);
  await fsp.rm(medida, { force: true });

  const durSalida = m / SR;
  const durTramo = n / SR;
  const delta = Math.abs(durSalida - durTramo);
  if (delta > durTramo * 0.05) throw new DuracionInesperada();
  const ajuste = delta > 0.05 ? `atempo=${(durSalida / durTramo).toFixed(6)},` : "";

  await ff(
    "normalizar la salida",
    [
      "-y",
      "-i",
      entrada,
      "-af",
      `${offset}aresample=${SR},${ajuste}apad=whole_len=${n},atrim=end_sample=${n}`,
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      out,
    ],
    opts.signal,
  );
}

/** Paso 4 — una pieza que se conserva, cortada del completo por muestra. b null = hasta el final. */
export async function piezaConservada(
  completo: string,
  a: number,
  b: number | null,
  out: string,
  signal?: AbortSignal,
): Promise<void> {
  const fin = b === null ? "" : `:end_sample=${b}`;
  await ff(
    "conservar el audio original",
    ["-y", "-i", completo, "-af", `atrim=start_sample=${a}${fin},asetpts=N/SR/TB`, "-c:a", "pcm_s16le", out],
    signal,
  );
}

/**
 * Paso 5 — concatenar las piezas (copia, sin re-encodear) y verificar que la pista
 * nueva tenga EXACTAMENTE las muestras esperadas. Si no, falla: no se "corrige" con un
 * pad al final, porque eso esconderia una pieza corrida (D5).
 */
export async function concatenar(
  piezas: string[],
  out: string,
  esperadas: number,
  trabajo: string,
  signal?: AbortSignal,
): Promise<void> {
  const lista = path.join(trabajo, "lista.txt");
  await fsp.writeFile(lista, piezas.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
  await ff("concatenar", ["-y", "-f", "concat", "-safe", "0", "-i", lista, "-c", "copy", out], signal);
  const n = await muestrasDe(out);
  if (n !== esperadas) {
    throw new Error(`ffmpeg falló en concatenar: la pista nueva tiene ${n} muestras y la original ${esperadas}`);
  }
}

/** Paso 6 — la version completa: el MISMO video (copia) con la pista nueva. */
export async function remux(unidoAbs: string, nuevo: string, out: string, signal?: AbortSignal): Promise<void> {
  await ff(
    "armar el video",
    [
      "-y",
      "-i",
      unidoAbs,
      "-i",
      nuevo,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      out,
    ],
    signal,
  );
}

/**
 * Paso 7 — la prueba: la ventana del video con la pista nueva. Aca SI se re-encodea:
 * `-ss` con `-c:v copy` corta en el keyframe anterior y el audio quedaria corrido. Son
 * ~20 s, tarda pocos segundos.
 */
export async function recortePrueba(
  unidoAbs: string,
  nuevo: string,
  inicioSeg: number,
  durSeg: number,
  out: string,
  signal?: AbortSignal,
): Promise<void> {
  await ff(
    "armar la prueba",
    [
      "-y",
      "-ss",
      String(inicioSeg),
      "-t",
      String(durSeg),
      "-i",
      unidoAbs,
      "-i",
      nuevo,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      out,
    ],
    signal,
  );
}
