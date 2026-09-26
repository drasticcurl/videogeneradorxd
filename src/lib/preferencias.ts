/**
 * Preferencias POR USUARIO, en su propio archivo: `<DATA_DIR>/preferencias.json`. Se
 * cambian desde el header (el nombre → "Configuración" → "Aprobación").
 *
 * Hoy es una sola: cuantos clips de video se generan sin aprobar antes de frenar, en los
 * proyectos con aprobacion manual. Antes era UN numero para todos
 * (`PIPELINE_APPROVAL_BATCH_VIDEOS`, 5), que sigue siendo el default de quien no eligio
 * el suyo. Cada clip de Veo cuesta plata: el lote es cuanto se puede gastar sin mirar, y
 * eso lo decide cada uno para SUS proyectos.
 *
 * Mismo patron que voz/favoritas.ts: escritura atomica (tmp + rename), singleton por
 * globalThis, y un JSON roto se aparta a `.roto-<ts>` en vez de pisarse.
 */
import fs from "node:fs";
import path from "node:path";

import { config } from "./config";
import type { JobType, PreferenciasDeUsuario } from "./types";

/** Tope del lote elegible. Mas que esto ya es "sin limite", que es 0. */
export const LOTE_VIDEOS_MAX = 50;

interface Guardadas {
  loteVideos?: number;
}

interface ArchivoPreferencias {
  version: 1;
  porUsuario: Record<string, Guardadas>;
}

/** Un error que la ruta devuelve tal cual al usuario (400). */
export class ErrorDePreferencias extends Error {}

function archivo(): string {
  return path.join(config.storage.dataDir, "preferencias.json");
}

interface Estado {
  datos: ArchivoPreferencias;
  /** El archivo en disco no se pudo leer: hay que apartarlo antes de escribir. */
  roto: boolean;
}

function cargar(): Estado {
  const f = archivo();
  try {
    if (!fs.existsSync(f)) return { datos: { version: 1, porUsuario: {} }, roto: false };
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<ArchivoPreferencias>;
    if (!j || typeof j !== "object" || typeof j.porUsuario !== "object" || j.porUsuario === null) {
      throw new Error("forma inesperada");
    }
    return { datos: { version: 1, porUsuario: j.porUsuario }, roto: false };
  } catch (err) {
    console.error("[preferencias] preferencias.json roto, arrancando vacio (se aparta al escribir):", err);
    return { datos: { version: 1, porUsuario: {} }, roto: true };
  }
}

const globalForPrefs = globalThis as unknown as { __augcPreferencias?: Estado };
function estado(): Estado {
  return globalForPrefs.__augcPreferencias ?? (globalForPrefs.__augcPreferencias = cargar());
}

function guardar(e: Estado): void {
  const f = archivo();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (e.roto) {
    if (fs.existsSync(f)) fs.renameSync(f, `${f}.roto-${Date.now()}`);
    e.roto = false;
  }
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(e.datos, null, 2), "utf8");
  fs.renameSync(tmp, f);
}

export function preferenciasDe(usuario: string): PreferenciasDeUsuario {
  const propio = estado().datos.porUsuario[usuario]?.loteVideos;
  const loteVideosDefault = config.pipeline.approvalBatchVideos;
  return {
    loteVideos: propio ?? loteVideosDefault,
    loteVideosDefault,
    loteVideosPropio: propio !== undefined,
  };
}

/** `loteVideos: null` vuelve al default (borra el propio). */
export function guardarPreferencias(
  usuario: string,
  cambios: { loteVideos: number | null },
): PreferenciasDeUsuario {
  const v = cambios.loteVideos;
  if (v !== null && (!Number.isInteger(v) || v < 0 || v > LOTE_VIDEOS_MAX)) {
    throw new ErrorDePreferencias(`Tiene que ser un número entero entre 0 y ${LOTE_VIDEOS_MAX}.`);
  }
  const e = estado();
  const actuales: Guardadas = { ...(e.datos.porUsuario[usuario] ?? {}) };
  if (v === null) delete actuales.loteVideos;
  else actuales.loteVideos = v;
  if (Object.keys(actuales).length > 0) e.datos.porUsuario[usuario] = actuales;
  else delete e.datos.porUsuario[usuario];
  guardar(e);
  return preferenciasDe(usuario);
}

/**
 * El lote que usa la COLA para un job: cuantos del mismo tipo puede haber sin aprobar en
 * su proyecto antes de frenar. Sale del DUEÑO del proyecto (la cola corre sin sesion).
 * 0 = sin limite.
 *
 * Solo los videos son por usuario. Las imagenes siguen con el global
 * (`PIPELINE_APPROVAL_BATCH_IMAGES`, 0): se generan todas y se revisan en bloque.
 */
export function loteDeAprobacion(usuario: string | null, tipo: JobType): number {
  if (tipo === "image") return config.pipeline.approvalBatchImages;
  const propio = usuario ? estado().datos.porUsuario[usuario]?.loteVideos : undefined;
  return propio ?? config.pipeline.approvalBatchVideos;
}
