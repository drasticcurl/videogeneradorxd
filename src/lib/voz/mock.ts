/**
 * Proveedor de voz MOCK (D16): el default, no gasta y no necesita key. Deja probar todo
 * el circuito (lista, favoritas, prueba, conversion, cancelar, versiones) sin red.
 * Contrato de tasks/cambio-de-voz/02-DISENO.md §6.3.
 *
 * La "conversion" sube el tono un 25 % SIN cambiar la duracion: asi el E2E puede
 * comprobar que lo convertido cambio (audio distinto) y que la sincronia no se movio
 * (mismas muestras). Verificado en §1: la salida dura 2,6 ms menos que la entrada, y
 * eso es justo lo que la normalizacion de audio.ts absorbe.
 */
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runFfmpegAsync } from "../ffmpeg";
import type { VozResumen } from "../types";
import {
  ErrorDeVoz,
  VOICE_ID_RE,
  type ConvertirInput,
  type ConvertirResultado,
  type ListaDeVoces,
  type PaginaDeVoces,
  type VozProvider,
} from "./tipos";

const voz = (id: string, nombre: string, etiquetas: Record<string, string>, descripcion: string): VozResumen => ({
  id,
  nombre,
  categoria: "premade",
  etiquetas,
  descripcion,
  previewUrl: null,
  esPropia: false,
});

const VOCES: VozResumen[] = [
  voz("mock-grave", "Grave (mock)", { acento: "rioplatense", genero: "masculino", edad: "adulto" }, "Voz de prueba grave."),
  voz("mock-aguda", "Aguda (mock)", { acento: "neutro", genero: "femenino", edad: "joven" }, "Voz de prueba aguda."),
  voz("mock-neutra", "Neutra (mock)", { acento: "neutro", genero: "femenino", edad: "adulto" }, "Voz de prueba neutra."),
  voz("mock-radio", "Radio (mock)", { acento: "mexicano", genero: "masculino", edad: "mayor" }, "Voz de prueba de locutor."),
];

/** VOICE_MOCK_DELAY_MS: solo para verificacion (deja tiempo para probar el 409 y cancelar). */
function demoraMs(): number {
  const n = Number(process.env.VOICE_MOCK_DELAY_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function esperar(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => {
      const e = new Error("Cancelado");
      e.name = "AbortError";
      return e;
    };
    if (signal?.aborted) return reject(abortError());
    if (ms <= 0) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function crearProveedorMock(): VozProvider {
  return {
    nombre: "mock",

    async listar(lista: ListaDeVoces, opts?: { q?: string; cursor?: string | null }): Promise<PaginaDeVoces> {
      const base = lista === "mias" ? VOCES.slice(0, 2) : VOCES;
      const q = opts?.q?.trim().toLowerCase();
      return { voces: q ? base.filter((v) => v.nombre.toLowerCase().includes(q)) : base, siguiente: null };
    },

    async porIds(ids: string[]): Promise<VozResumen[]> {
      return VOCES.filter((v) => ids.includes(v.id));
    },

    async convertir(input: ConvertirInput): Promise<ConvertirResultado> {
      // Mismo contrato que ElevenLabs: una voz que no existe falla igual, asi el E2E
      // cubre el camino de error sin gastar.
      if (!VOICE_ID_RE.test(input.voiceId)) {
        throw new ErrorDeVoz("ElevenLabs rechazó el pedido: id de voz inválido", "validacion");
      }
      if (!VOCES.some((v) => v.id === input.voiceId)) {
        throw new ErrorDeVoz("Esa voz ya no existe en tu cuenta de ElevenLabs.", "voz_inexistente", 404);
      }

      await esperar(demoraMs(), input.signal);

      const id = randomUUID();
      const entrada = path.join(os.tmpdir(), `voz-mock-${id}-in.wav`);
      const salida = path.join(os.tmpdir(), `voz-mock-${id}-out.wav`);
      try {
        await fsp.writeFile(entrada, input.wav);
        const r = await runFfmpegAsync(
          [
            "-y",
            "-i",
            entrada,
            "-af",
            "asetrate=44100*1.25,aresample=44100,atempo=0.8",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            salida,
          ],
          { signal: input.signal },
        );
        if (r.code !== 0) {
          throw new ErrorDeVoz(`ffmpeg falló en la conversión mock: ${r.stderr.slice(-300)}`, "otro");
        }
        return { bytes: new Uint8Array(await fsp.readFile(salida)), extension: "wav", modelo: "mock" };
      } finally {
        await fsp.rm(entrada, { force: true });
        await fsp.rm(salida, { force: true });
      }
    },

    async creditos() {
      return null;
    },
  };
}
