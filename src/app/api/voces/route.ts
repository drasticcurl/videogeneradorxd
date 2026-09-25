/**
 * GET /api/voces?lista=favoritas|mias|predeterminadas&q=&cursor=
 *
 * Las voces para el selector de "Cambiar voz" (§11 de tasks/cambio-de-voz/02-DISENO.md).
 * Exige sesion: las favoritas y la key son por usuario, y el usuario sale de la cookie.
 */
import { config } from "@/lib/config";
import { ok, serverError } from "@/lib/http";
import { sessionUser } from "@/lib/ownership";
import type { CreditosDeVoz, RespuestaVoces, VozEnLista, VozFavorita } from "@/lib/types";
import { favoritasDe } from "@/lib/voz/favoritas";
import { getVozProvider } from "@/lib/voz/index";
import { ErrorDeVoz, type VozProvider } from "@/lib/voz/tipos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LISTAS = ["favoritas", "mias", "predeterminadas"] as const;
type Lista = (typeof LISTAS)[number];

async function creditosDe(p: VozProvider): Promise<CreditosDeVoz | null> {
  // Best-effort: una key sin user_read no rompe la lista.
  try {
    return await p.creditos();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const usuario = sessionUser();
    if (!usuario) return ok({ error: "No autenticado. Volvé a entrar." }, { status: 401 });

    const sp = new URL(req.url).searchParams;
    const lista = sp.get("lista") as Lista | null;
    if (!lista || !LISTAS.includes(lista)) {
      return ok({ error: "La lista tiene que ser favoritas, mias o predeterminadas." }, { status: 400 });
    }
    const q = (sp.get("q") ?? "").slice(0, 100);
    const cursor = sp.get("cursor");
    if (cursor && cursor.length > 500) return ok({ error: "Cursor inválido." }, { status: 400 });

    try {
      const proveedor = getVozProvider(usuario);
      const favs = favoritasDe(usuario, proveedor.nombre);
      const porId = new Map<string, VozFavorita>(favs.map((f) => [f.voiceId, f]));

      let voces: VozEnLista[];
      let siguiente: string | null = null;
      if (lista === "favoritas") {
        const resueltas = await proveedor.porIds(favs.map((f) => f.voiceId));
        const existe = new Map(resueltas.map((v) => [v.id, v]));
        voces = favs.map((f): VozEnLista => {
          const v = existe.get(f.voiceId);
          if (v) return { ...v, favorita: f, disponible: true };
          // R3.5: la favorita sigue en la lista, marcada, para poder borrarla.
          return {
            id: f.voiceId,
            nombre: f.alias,
            categoria: null,
            etiquetas: {},
            descripcion: "Ya no está en tu cuenta de ElevenLabs",
            previewUrl: null,
            esPropia: false,
            favorita: f,
            disponible: false,
          };
        });
      } else {
        const pagina = await proveedor.listar(lista, { q, cursor });
        voces = pagina.voces.map((v) => ({ ...v, favorita: porId.get(v.id) ?? null, disponible: true }));
        siguiente = pagina.siguiente;
      }

      const respuesta: RespuestaVoces = {
        proveedor: config.voz.proveedor,
        voces,
        siguiente,
        creditos: await creditosDe(proveedor),
      };
      return ok(respuesta);
    } catch (err) {
      if (err instanceof ErrorDeVoz) {
        const status = err.codigo === "no_configurado" ? 503 : err.codigo === "validacion" ? 400 : 502;
        return ok({ error: err.message, codigo: err.codigo }, { status });
      }
      throw err;
    }
  } catch (err) {
    return serverError(err);
  }
}
