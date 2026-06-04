/**
 * Transcripcion LOCAL con Whisper (openai-whisper), gratis y sin API.
 *
 * Corre el binario `whisper` como SUBPROCESO async (no bloquea el event loop) sobre
 * el archivo subido (video o audio). Whisper usa ffmpeg internamente para extraer el
 * audio, asi que acepta .mp4/.mov/.mkv/.webm/.mp3/.wav/.m4a/etc. directamente.
 *
 * Por defecto: idioma SIEMPRE español, modelo `small`, tarea `transcribe`.
 * Todo es configurable por env (ver src/lib/config.ts -> config.whisper).
 *
 * Salida: un archivo .txt por clip dentro de TRANSCRIBE_DIR/<timestamp>_<nombre>/.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { slugify } from "./storage";

export interface TranscribeResult {
  /** Texto transcripto (trim). */
  text: string;
  /** Modelo usado (ej. "small"). */
  model: string;
  /** Idioma usado (ej. "Spanish"). */
  language: string;
  /** Path absoluto del .txt persistido. */
  txtPath: string;
  /** Carpeta de trabajo de esta transcripcion. */
  outDir: string;
  /** Cuanto tardo, en ms. */
  durationMs: number;
}

let whisperChecked = false;
let whisperAvailable = false;

/**
 * ¿Esta el binario de Whisper disponible en el PATH? Chequeo barato (no importa
 * torch ni carga el modelo): usa `which`/`where`. Se cachea por proceso.
 */
export function hasWhisper(): boolean {
  if (whisperChecked) return whisperAvailable;
  whisperChecked = true;

  const bin = config.whisper.bin;
  // Si es un path absoluto, alcanza con ver si existe.
  if (path.isAbsolute(bin)) {
    whisperAvailable = fs.existsSync(bin);
    return whisperAvailable;
  }
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(locator, [bin], { stdio: "ignore" });
    whisperAvailable = res.status === 0;
  } catch {
    whisperAvailable = false;
  }
  return whisperAvailable;
}

/** Extension segura (lowercase, solo alfanumerica) a partir del nombre original. */
function safeExt(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext && ext.length <= 6 ? ext : ".mp4";
}

/** Nombre base seguro (sin extension) para los archivos de salida. */
function safeStem(originalName: string): string {
  const base = path.basename(originalName, path.extname(originalName));
  return slugify(base) || "clip";
}

/** Corre `whisper` y resuelve cuando termina OK; rechaza con mensaje claro si falla. */
function runWhisper(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";
    const capture = (d: Buffer) => {
      stderr += d.toString();
      // No dejamos crecer el buffer indefinidamente (progreso de whisper es verboso).
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `No se encontro el comando "${bin}". Instala Whisper local: ` +
              `pip install -U openai-whisper (y necesitas ffmpeg en el PATH). ` +
              `Si usas otro binario, configura WHISPER_BIN en .env.local.`
          )
        );
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Whisper termino con error (codigo ${code}).\n${stderr.slice(-1000)}`
          )
        );
    });
  });
}

/**
 * Transcribe un archivo (bytes en memoria) y devuelve el texto.
 * Guarda el media en una carpeta temporal de trabajo, corre whisper con salida .txt,
 * lee el resultado y borra el media (best-effort) para no llenar el disco.
 */
export async function transcribeFile(
  originalName: string,
  bytes: Uint8Array
): Promise<TranscribeResult> {
  const started = Date.now();
  const { bin, model, language, task, extraArgs, outputDir } = config.whisper;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = safeStem(originalName);
  const ext = safeExt(originalName);

  // Carpeta unica por transcripcion (evita colisiones de nombre).
  const outDir = path.join(outputDir, `${stamp}_${stem}`);
  await fsp.mkdir(outDir, { recursive: true });

  const mediaPath = path.join(outDir, `${stem}${ext}`);
  await fsp.writeFile(mediaPath, bytes);

  const args = [
    mediaPath,
    "--model",
    model,
    "--language",
    language,
    "--task",
    task,
    "--output_format",
    "txt",
    "--output_dir",
    outDir,
    "--verbose",
    "False",
    ...extraArgs,
  ];

  try {
    await runWhisper(bin, args);
  } catch (err) {
    // Si fallo, dejamos el media en disco para poder depurar.
    throw err;
  }

  // Whisper nombra el .txt con el stem del input.
  const txtPath = path.join(outDir, `${stem}.txt`);
  let text: string;
  try {
    text = (await fsp.readFile(txtPath, "utf8")).trim();
  } catch {
    throw new Error(
      "Whisper termino pero no se encontro el .txt de salida. Revisa el log del servidor."
    );
  }

  // Borramos el media para no duplicar archivos pesados (el .txt queda persistido).
  try {
    await fsp.unlink(mediaPath);
  } catch {
    /* best-effort */
  }

  return {
    text,
    model,
    language,
    txtPath,
    outDir,
    durationMs: Date.now() - started,
  };
}
