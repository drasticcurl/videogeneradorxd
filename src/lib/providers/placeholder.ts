/**
 * Generadores de placeholders para el MOCK provider (sin credenciales).
 * - makePngPlaceholder: PNG real (gradiente derivado del prompt) -> se previsualiza bien.
 * - makeMp4Placeholder: intenta ffmpeg (clip de color real y reproducible); si no hay ffmpeg,
 *   devuelve un MP4 minimo embebido como fallback.
 */
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/* --------------------------- util hash/color --------------------------- */

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function colorFromSeed(seed: number): [number, number, number] {
  const r = (seed & 0xff);
  const g = (seed >> 8) & 0xff;
  const b = (seed >> 16) & 0xff;
  // Subimos luminancia para que se vea decente.
  return [
    Math.min(255, 60 + (r % 180)),
    Math.min(255, 60 + (g % 180)),
    Math.min(255, 60 + (b % 180)),
  ];
}

export function dimsForAspect(aspect = "9:16"): { w: number; h: number } {
  switch (aspect) {
    case "16:9":
      return { w: 640, h: 360 };
    case "1:1":
      return { w: 512, h: 512 };
    case "4:3":
      return { w: 640, h: 480 };
    case "3:4":
      return { w: 480, h: 640 };
    case "9:16":
    default:
      return { w: 360, h: 640 };
  }
}

/* ------------------------------ PNG encoder ----------------------------- */

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Genera un PNG RGB con gradiente diagonal derivado del seed (prompt). */
export function makePngPlaceholder(seedText: string, aspect = "9:16"): Uint8Array {
  const { w, h } = dimsForAspect(aspect);
  const seed = hashString(seedText);
  const c1 = colorFromSeed(seed);
  const c2 = colorFromSeed(seed ^ 0x9e3779b9);

  // scanlines: cada fila = filterByte(0) + w*3 bytes RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  let off = 0;
  for (let y = 0; y < h; y++) {
    raw[off++] = 0; // filtro None
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2; // 0..1 diagonal
      raw[off++] = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      raw[off++] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      raw[off++] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    }
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------ MP4 placeholder ------------------------- */

let ffmpegChecked = false;
let ffmpegAvailable = false;

export function hasFfmpeg(): boolean {
  if (ffmpegChecked) return ffmpegAvailable;
  ffmpegChecked = true;
  try {
    const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    ffmpegAvailable = res.status === 0;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/**
 * MP4 minimo embebido (base64) como fallback cuando no hay ffmpeg.
 * Es un clip negro muy corto y valido; sirve para que el archivo exista y, en la
 * mayoria de los navegadores, se pueda al menos cargar metadata.
 */
const MINIMAL_MP4_BASE64 =
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAr1tZGF0AAAC" +
  "rgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzA5NSBiYWVlNDAw" +
  "IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMiAtIGh0" +
  "dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEg" +
  "AAAAAAAAAAEAAAAA";

/**
 * Genera un MP4 placeholder. Si ffmpeg esta disponible, crea un clip de color
 * solido real con la duracion pedida (mejor preview). Si no, devuelve el MP4 minimo.
 */
export function makeMp4Placeholder(
  seedText: string,
  durationSec: number,
  aspect = "9:16"
): Uint8Array {
  if (hasFfmpeg()) {
    const { w, h } = dimsForAspect(aspect);
    const seed = hashString(seedText);
    const [r, g, b] = colorFromSeed(seed);
    const hex = `0x${[r, g, b]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;
    const tmp = path.join(
      os.tmpdir(),
      `augc_mock_${seed.toString(16)}_${Date.now()}.mp4`
    );
    const dur = Math.max(1, Math.min(60, Math.round(durationSec)));
    const res = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=c=${hex}:s=${w}x${h}:d=${dur}:r=24`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=220:duration=${dur}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        tmp,
      ],
      { stdio: "ignore" }
    );
    if (res.status === 0 && fs.existsSync(tmp)) {
      const bytes = fs.readFileSync(tmp);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return bytes;
    }
    // si fallo, caemos al fallback
  }
  return Buffer.from(MINIMAL_MP4_BASE64, "base64");
}
