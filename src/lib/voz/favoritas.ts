/**
 * Voces favoritas, POR USUARIO, en su propio archivo: `<DATA_DIR>/voces-favoritas.json`
 * (D14 de tasks/cambio-de-voz/02-DISENO.md §6.4).
 *
 * No van en la base de proyectos: son preferencias de una persona, no datos de un proyecto, y
 * meterlas ahi obliga a tocar db.ts, del que depende toda la app.
 *
 * Mismo patron que db.ts (escritura atomica tmp + rename, singleton por globalThis) con
 * una diferencia a proposito: si el JSON esta roto, se arranca vacio pero el archivo
 * roto se RENOMBRA a `.roto-<ts>` antes de la primera escritura. db.ts no lo hace, y ahi
 * un JSON roto termina pisado por uno vacio: las favoritas de todos, perdidas.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { AjustesDeVoz, VozFavorita } from "../types";
import { ErrorDeVoz, VOICE_ID_RE } from "./tipos";

type Proveedor = "mock" | "elevenlabs";

interface ArchivoFavoritas {
  version: 1;
  porUsuario: Record<string, VozFavorita[]>;
}

const MAX_POR_USUARIO = 50;

function archivo(): string {
  return path.join(config.storage.dataDir, "voces-favoritas.json");
}

interface Estado {
  datos: ArchivoFavoritas;
  /** El archivo en disco no se pudo leer: hay que apartarlo antes de escribir. */
  roto: boolean;
}

function cargar(): Estado {
  const f = archivo();
  try {
    if (!fs.existsSync(f)) return { datos: { version: 1, porUsuario: {} }, roto: false };
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<ArchivoFavoritas>;
    if (!j || typeof j !== "object" || typeof j.porUsuario !== "object" || j.porUsuario === null) {
      throw new Error("forma inesperada");
    }
    return { datos: { version: 1, porUsuario: j.porUsuario }, roto: false };
  } catch (err) {
    console.error("[voz/favoritas] voces-favoritas.json roto, arrancando vacio (se aparta al escribir):", err);
    return { datos: { version: 1, porUsuario: {} }, roto: true };
  }
}

const globalForFav = globalThis as unknown as { __augcVozFavoritas?: Estado };
function estado(): Estado {
  return globalForFav.__augcVozFavoritas ?? (globalForFav.__augcVozFavoritas = cargar());
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

function validarAjustes(a: AjustesDeVoz | null | undefined): AjustesDeVoz | null {
  if (a == null) return null;
  const nums = [a.estabilidad, a.similitud, a.estilo];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) || typeof a.realceHablante !== "boolean") {
    throw new ErrorDeVoz("Los ajustes de la voz tienen que estar entre 0 y 1.", "validacion");
  }
  return { estabilidad: a.estabilidad, similitud: a.similitud, estilo: a.estilo, realceHablante: a.realceHablante };
}

export function favoritasDe(usuario: string, proveedor: Proveedor): VozFavorita[] {
  return (estado().datos.porUsuario[usuario] ?? []).filter((f) => f.proveedor === proveedor);
}

/** Upsert por voiceId; devuelve la lista del usuario (de ese proveedor). */
export function guardarFavorita(
  usuario: string,
  proveedor: Proveedor,
  f: { voiceId: string; alias?: string; ajustes?: AjustesDeVoz | null },
): VozFavorita[] {
  if (!VOICE_ID_RE.test(f.voiceId ?? "")) {
    throw new ErrorDeVoz("El id de la voz no es válido.", "validacion");
  }
  const alias = (f.alias ?? f.voiceId).trim();
  if (alias.length < 1 || alias.length > 60) {
    throw new ErrorDeVoz("El alias tiene que tener entre 1 y 60 caracteres.", "validacion");
  }
  const ajustes = validarAjustes(f.ajustes);

  const e = estado();
  const todas = e.datos.porUsuario[usuario] ?? [];
  const i = todas.findIndex((x) => x.proveedor === proveedor && x.voiceId === f.voiceId);
  if (i >= 0) {
    // Upsert: un alias o ajustes que no vinieron no borran los que ya estaban.
    todas[i] = {
      ...todas[i],
      alias: f.alias !== undefined ? alias : todas[i].alias,
      ajustes: f.ajustes !== undefined ? ajustes : todas[i].ajustes,
    };
  } else {
    if (todas.filter((x) => x.proveedor === proveedor).length >= MAX_POR_USUARIO) {
      throw new ErrorDeVoz(`Llegaste al máximo de ${MAX_POR_USUARIO} favoritas. Sacá alguna para agregar otra.`, "validacion");
    }
    todas.push({ voiceId: f.voiceId, proveedor, alias, ajustes, agregadaEn: new Date().toISOString() });
  }
  e.datos.porUsuario[usuario] = todas;
  guardar(e);
  return favoritasDe(usuario, proveedor);
}

export function quitarFavorita(usuario: string, proveedor: Proveedor, voiceId: string): VozFavorita[] {
  const e = estado();
  const todas = e.datos.porUsuario[usuario] ?? [];
  const quedan = todas.filter((x) => !(x.proveedor === proveedor && x.voiceId === voiceId));
  if (quedan.length !== todas.length) {
    e.datos.porUsuario[usuario] = quedan;
    guardar(e);
  }
  return favoritasDe(usuario, proveedor);
}
