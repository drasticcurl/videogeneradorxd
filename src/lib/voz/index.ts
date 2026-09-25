/**
 * Factory del proveedor de voz, por usuario. Se elige por `VOICE_PROVIDER` (config.voz)
 * y NO por PROVIDER_MODE: el de Vertex se autentica con ADC y este con API key (D11).
 *
 * La corrida (corrida.ts) NO importa este archivo: recibe el proveedor por parametro,
 * armado por la ruta, que es la que sabe que usuario pidio (§3 del diseño).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { config, elevenLabsKeyFor } from "../config";
import { hasFfmpeg } from "../providers/placeholder";
import { crearProveedorElevenLabs } from "./elevenlabs";
import { crearProveedorMock } from "./mock";
import { ErrorDeVoz, type VozProvider } from "./tipos";

const MSJ_NO_CONFIGURADO =
  "El cambio de voz no está configurado: falta ELEVENLABS_API_KEY en el server.";
const MSJ_SIN_FFMPEG = "Falta ffmpeg o ffprobe en el server.";

/*
  Un proveedor por key, cacheado por el HASH de la key (nunca la key en claro como clave:
  termina en un heap dump). Singleton en globalThis para sobrevivir al HMR.
*/
const globalForVoz = globalThis as unknown as {
  __augcVozProveedores?: { mock: VozProvider | null; porKey: Map<string, VozProvider> };
};
const estado =
  globalForVoz.__augcVozProveedores ??
  (globalForVoz.__augcVozProveedores = { mock: null, porKey: new Map() });

/** Lanza ErrorDeVoz("no_configurado") si VOICE_PROVIDER=elevenlabs y el usuario no tiene key. */
export function getVozProvider(usuario: string): VozProvider {
  if (config.voz.proveedor === "mock") {
    return estado.mock ?? (estado.mock = crearProveedorMock());
  }
  const key = elevenLabsKeyFor(usuario);
  if (!key) throw new ErrorDeVoz(MSJ_NO_CONFIGURADO, "no_configurado");
  const h = createHash("sha256").update(key).digest("hex").slice(0, 16);
  let p = estado.porKey.get(h);
  if (!p) {
    p = crearProveedorElevenLabs(key);
    estado.porKey.set(h, p);
  }
  return p;
}

let ffprobeChequeado: boolean | null = null;
function hayFfprobe(): boolean {
  if (ffprobeChequeado !== null) return ffprobeChequeado;
  try {
    ffprobeChequeado = spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    ffprobeChequeado = false;
  }
  return ffprobeChequeado;
}

export function vozDisponible(usuario: string): { disponible: boolean; motivo: string | null } {
  if (!hasFfmpeg() || !hayFfprobe()) return { disponible: false, motivo: MSJ_SIN_FFMPEG };
  if (config.voz.proveedor === "elevenlabs" && !elevenLabsKeyFor(usuario)) {
    return { disponible: false, motivo: MSJ_NO_CONFIGURADO };
  }
  return { disponible: true, motivo: null };
}
