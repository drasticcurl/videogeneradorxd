/**
 * POST   /api/voces/favoritas            { voiceId, alias?, ajustes? }  -> { favoritas }
 * DELETE /api/voces/favoritas?voiceId=<id>                              -> { favoritas }
 *
 * Favoritas POR USUARIO (R3.4), en su propio archivo (D14). El usuario sale de la
 * cookie: si saliera del body, cualquiera editaria las favoritas de otro.
 */
import { config } from "@/lib/config";
import { ok, serverError } from "@/lib/http";
import { sessionUser } from "@/lib/ownership";
import type { AjustesDeVoz } from "@/lib/types";
import { guardarFavorita, quitarFavorita } from "@/lib/voz/favoritas";
import { ErrorDeVoz } from "@/lib/voz/tipos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noAutenticado = () => ok({ error: "No autenticado. Volvé a entrar." }, { status: 401 });

export async function POST(req: Request) {
  try {
    const usuario = sessionUser();
    if (!usuario) return noAutenticado();
    const body = (await req.json().catch(() => null)) as
      | { voiceId?: unknown; alias?: unknown; ajustes?: unknown }
      | null;
    if (!body || typeof body.voiceId !== "string") return ok({ error: "Falta voiceId." }, { status: 400 });
    if (body.alias !== undefined && typeof body.alias !== "string") return ok({ error: "El alias tiene que ser texto." }, { status: 400 });
    try {
      const favoritas = guardarFavorita(usuario, config.voz.proveedor, {
        voiceId: body.voiceId,
        alias: body.alias as string | undefined,
        ajustes: body.ajustes as AjustesDeVoz | null | undefined,
      });
      return ok({ favoritas });
    } catch (err) {
      if (err instanceof ErrorDeVoz && err.codigo === "validacion") {
        return ok({ error: err.message, codigo: err.codigo }, { status: 400 });
      }
      throw err;
    }
  } catch (err) {
    return serverError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const usuario = sessionUser();
    if (!usuario) return noAutenticado();
    const voiceId = new URL(req.url).searchParams.get("voiceId") ?? "";
    if (!voiceId) return ok({ error: "Falta voiceId." }, { status: 400 });
    return ok({ favoritas: quitarFavorita(usuario, config.voz.proveedor, voiceId) });
  } catch (err) {
    return serverError(err);
  }
}
