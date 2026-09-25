/**
 * Cliente de ElevenLabs para el cambio de voz: listar voces, resolver favoritas,
 * convertir (Voice Changer, speech-to-speech) y leer creditos. Contrato de
 * tasks/cambio-de-voz/02-DISENO.md §6.2.
 *
 * Sin SDK (D15): fetch + FormData + Blob nativos. Son cuatro endpoints y un SDK es una
 * dependencia mas que viaja al build standalone.
 *
 * Este es el UNICO archivo de src/ que escribe el header xi-api-key (chequeo A2). La key
 * entra por parametro: aca no se leen variables de entorno. Ningun mensaje de error copia headers
 * ni la key: esos mensajes terminan en VersionDeVoz.error, en el log del proyecto y en
 * la pantalla.
 */
import { createHash } from "node:crypto";
import { config } from "../config";
import { parseRetryAfter } from "../providers/types";
import type { AjustesDeVoz, CreditosDeVoz, VozResumen } from "../types";
import {
  ErrorDeVoz,
  VOICE_ID_RE,
  type CodigoErrorDeVoz,
  type ConvertirInput,
  type ConvertirResultado,
  type ListaDeVoces,
  type PaginaDeVoces,
  type VozProvider,
} from "./tipos";

/** Mensajes de §14. Los de "validacion" y "otro" se arman con el message de ElevenLabs. */
const MENSAJES: Partial<Record<CodigoErrorDeVoz, string>> = {
  key_invalida: "ElevenLabs rechazó la API key. Revisá ELEVENLABS_API_KEY en el server.",
  sin_permiso:
    "La API key de ElevenLabs no tiene permiso para esto. Creala con Speech to Speech y Voices (lectura).",
  sin_creditos: "No quedan créditos en ElevenLabs. Cargá créditos o esperá a que se renueve el plan.",
  voz_inexistente: "Esa voz ya no existe en tu cuenta de ElevenLabs.",
  limite: "ElevenLabs está saturado. Probá de nuevo en unos minutos.",
  red: "No se pudo hablar con ElevenLabs (red o tiempo de espera).",
  timeout: "No se pudo hablar con ElevenLabs (red o tiempo de espera).",
};

const CACHE_MS = 60_000;
/** Timeout de los GET (listar, creditos). El de convertir sale de la config: tarda minutos. */
const TIMEOUT_LECTURA_MS = 20_000;

/*
  Cache en memoria compartido entre instancias (index.ts crea un proveedor por key). La
  clave lleva un HASH de la key y nunca la key en claro: un Map con la key como clave
  termina en un heap dump o en un console.log de depuracion.
*/
const globalForCache = globalThis as unknown as {
  __augcVozCache?: Map<string, { vence: number; valor: unknown }>;
};
const cache: Map<string, { vence: number; valor: unknown }> =
  globalForCache.__augcVozCache ?? (globalForCache.__augcVozCache = new Map());

function hashDe(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

async function conCache<T>(clave: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(clave);
  if (hit && hit.vence > Date.now()) return hit.valor as T;
  const valor = await fn();
  cache.set(clave, { vence: Date.now() + CACHE_MS, valor });
  // Poda simple: el cache vive lo que el proceso y no tiene que crecer sin tope.
  if (cache.size > 200) {
    for (const [k, v] of cache) if (v.vence <= Date.now()) cache.delete(k);
  }
  return valor;
}

interface VozCruda {
  voice_id?: string;
  name?: string;
  category?: string | null;
  labels?: Record<string, string> | null;
  description?: string | null;
  preview_url?: string | null;
  is_owner?: boolean;
}

function normalizar(v: VozCruda): VozResumen {
  const preview = typeof v.preview_url === "string" ? v.preview_url : "";
  return {
    id: String(v.voice_id ?? ""),
    nombre: String(v.name ?? v.voice_id ?? ""),
    categoria: v.category ?? null,
    etiquetas: v.labels ?? {},
    descripcion: v.description ?? null,
    // Solo https: la UI lo pone en un <audio src>, y un javascript: o http: no tiene que entrar.
    previewUrl: preview.startsWith("https://") ? preview : null,
    esPropia: Boolean(v.is_owner),
  };
}

function ajustesAElevenLabs(a: AjustesDeVoz) {
  return {
    stability: a.estabilidad,
    similarity_boost: a.similitud,
    style: a.estilo,
    use_speaker_boost: a.realceHablante,
  };
}

/**
 * Traduce una respuesta de error a ErrorDeVoz con la tabla de §6.2. `detail` puede venir
 * como objeto `{ status, message }` o como string: se manejan los dos.
 */
async function errorDesdeRespuesta(res: Response): Promise<ErrorDeVoz> {
  let detailStatus = "";
  let detailMessage = "";
  try {
    const j = (await res.json()) as { detail?: unknown };
    const d = j?.detail;
    if (typeof d === "string") {
      detailMessage = d;
    } else if (d && typeof d === "object") {
      const o = d as { status?: unknown; message?: unknown };
      detailStatus = typeof o.status === "string" ? o.status : "";
      detailMessage = typeof o.message === "string" ? o.message : "";
    }
  } catch {
    // Cuerpo no-JSON (un 502 de un proxy, por ejemplo): queda solo el status.
  }
  const s = res.status;
  const msg = detailMessage.slice(0, 300);

  if (s === 401) {
    if (detailStatus === "quota_exceeded") return new ErrorDeVoz(MENSAJES.sin_creditos!, "sin_creditos", s);
    if (detailStatus === "missing_permissions") return new ErrorDeVoz(MENSAJES.sin_permiso!, "sin_permiso", s);
    return new ErrorDeVoz(MENSAJES.key_invalida!, "key_invalida", s);
  }
  if (s === 400 || s === 422) {
    return new ErrorDeVoz(`ElevenLabs rechazó el pedido: ${msg || `HTTP ${s}`}`, "validacion", s);
  }
  if (s === 404) return new ErrorDeVoz(MENSAJES.voz_inexistente!, "voz_inexistente", s);
  if (s === 429) {
    return new ErrorDeVoz(MENSAJES.limite!, "limite", s, parseRetryAfter(res.headers.get("retry-after")));
  }
  if (s >= 500) return new ErrorDeVoz(MENSAJES.limite!, "limite", s);
  /*
    Lo que la tabla no cubre cae en "otro" con el mensaje de ElevenLabs. El caso real que
    midio T00 es un 403 "output_format_not_allowed" (wav_44100 fuera del plan): anotado
    como P-07 en §17, no se decide aca.
  */
  return new ErrorDeVoz(`ElevenLabs respondió ${s}${msg ? `: ${msg}` : ""}`, "otro", s);
}

export function crearProveedorElevenLabs(key: string): VozProvider {
  const { baseUrl, modelo, formatoSalida, timeoutMs } = config.voz.elevenlabs;
  const h = hashDe(key);

  /**
   * fetch con timeout propio combinado A MANO con el signal de la corrida. No se usa
   * el combinador nativo de signals (AbortSignal con "any"): requiere Node >= 20.3 y `engines` dice >= 18.18.
   */
  async function pedir(
    path: string,
    init: RequestInit & { timeout: number; signal?: AbortSignal },
  ): Promise<Response> {
    const ctrl = new AbortController();
    let porTimeout = false;
    const timer = setTimeout(() => {
      porTimeout = true;
      ctrl.abort();
    }, init.timeout);
    const externo = init.signal;
    const onAbort = () => ctrl.abort();
    if (externo?.aborted) ctrl.abort();
    else externo?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(baseUrl + path, {
        method: init.method,
        body: init.body,
        headers: { ...(init.headers as Record<string, string> | undefined), "xi-api-key": key },
        signal: ctrl.signal,
      });
      if (!res.ok) throw await errorDesdeRespuesta(res);
      return res;
    } catch (err) {
      if (err instanceof ErrorDeVoz) throw err;
      if (ctrl.signal.aborted) {
        if (porTimeout) throw new ErrorDeVoz(MENSAJES.timeout!, "timeout");
        // Abort de afuera (cancelar): se propaga como AbortError, no es un error de red.
        const e = new Error("Cancelado");
        e.name = "AbortError";
        throw e;
      }
      // Error de red: el mensaje de fetch puede traer la URL, pero nunca los headers.
      throw new ErrorDeVoz(MENSAJES.red!, "red");
    } finally {
      clearTimeout(timer);
      externo?.removeEventListener("abort", onAbort);
    }
  }

  async function voces(params: URLSearchParams): Promise<{ voces: VozResumen[]; siguiente: string | null }> {
    const res = await pedir(`/v2/voices?${params.toString()}`, { method: "GET", timeout: TIMEOUT_LECTURA_MS });
    const j = (await res.json()) as { voices?: VozCruda[]; has_more?: boolean; next_page_token?: string | null };
    return {
      voces: (j.voices ?? []).map(normalizar).filter((v) => v.id),
      siguiente: j.has_more && j.next_page_token ? j.next_page_token : null,
    };
  }

  return {
    nombre: "elevenlabs",

    listar(lista: ListaDeVoces, opts?: { q?: string; cursor?: string | null }): Promise<PaginaDeVoces> {
      const p = new URLSearchParams();
      if (lista === "mias") {
        // non-default = todo lo de la cuenta que no es predeterminado: clonadas,
        // diseñadas, profesionales y las agregadas desde la Voice Library (R2.1).
        p.set("voice_type", "non-default");
        p.set("page_size", "100");
        p.set("sort", "created_at_unix");
        p.set("sort_direction", "desc");
      } else {
        p.set("voice_type", "default");
        p.set("page_size", "100");
        p.set("sort", "name");
        p.set("sort_direction", "asc");
      }
      const q = opts?.q?.trim();
      if (q) p.set("search", q);
      if (opts?.cursor) p.set("next_page_token", opts.cursor);
      return conCache(`${h}|listar|${p.toString()}`, () => voces(p));
    },

    async porIds(ids: string[]): Promise<VozResumen[]> {
      const validos = ids.filter((id) => VOICE_ID_RE.test(id)).slice(0, 100);
      if (validos.length === 0) return [];
      const p = new URLSearchParams();
      for (const id of validos) p.append("voice_ids", id);
      p.set("page_size", "100");
      const r = await conCache(`${h}|porIds|${validos.slice().sort().join(",")}`, () => voces(p));
      return r.voces;
    },

    async convertir(input: ConvertirInput): Promise<ConvertirResultado> {
      // Otra vez aca, aunque la ruta ya lo valide: la ruta puede cambiar, y este es el
      // archivo que arma la URL con la key del server (D13).
      if (!VOICE_ID_RE.test(input.voiceId)) {
        throw new ErrorDeVoz("ElevenLabs rechazó el pedido: id de voz inválido", "validacion");
      }
      const fd = new FormData();
      fd.append("audio", new Blob([Buffer.from(input.wav)], { type: "audio/wav" }), "tramo.wav");
      fd.append("model_id", modelo);
      fd.append("remove_background_noise", input.quitarRuido ? "true" : "false");
      if (input.ajustes) fd.append("voice_settings", JSON.stringify(ajustesAElevenLabs(input.ajustes)));

      const res = await pedir(
        `/v1/speech-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${encodeURIComponent(formatoSalida)}`,
        { method: "POST", body: fd, timeout: timeoutMs, signal: input.signal },
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, extension: formatoSalida.startsWith("wav_") ? "wav" : "mp3", modelo };
    },

    async creditos(): Promise<CreditosDeVoz | null> {
      // Best-effort: una key sin user_read (como la que midio T00) no tiene que romper nada.
      try {
        return await conCache(`${h}|creditos`, async () => {
          const res = await pedir("/v1/user/subscription", { method: "GET", timeout: TIMEOUT_LECTURA_MS });
          const j = (await res.json()) as {
            character_count?: number;
            character_limit?: number;
            next_character_count_reset_unix?: number | null;
            tier?: string | null;
          };
          return {
            usados: Number(j.character_count ?? 0),
            limite: Number(j.character_limit ?? 0),
            seRenuevaEn: j.next_character_count_reset_unix
              ? new Date(j.next_character_count_reset_unix * 1000).toISOString()
              : null,
            plan: j.tier ?? null,
          };
        });
      } catch {
        return null;
      }
    },
  };
}
