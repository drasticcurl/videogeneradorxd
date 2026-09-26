/**
 * Las preferencias del usuario logueado (src/lib/preferencias.ts).
 *
 *   GET → { preferencias }
 *   PUT { loteVideos: number | null } → { preferencias }. null vuelve al default.
 *
 * El usuario sale SIEMPRE de la cookie, nunca del body: cada uno cambia solo las suyas,
 * y afectan solo a SUS proyectos. Es identidad (auth.ts), no un chequeo de dueño.
 */
import { cookies } from "next/headers";

import { currentUser } from "@/lib/auth";
import { badRequest, ok, serverError } from "@/lib/http";
import { ErrorDePreferencias, guardarPreferencias, preferenciasDe } from "@/lib/preferencias";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noAutenticado = () => ok({ error: "No autenticado. Volvé a entrar." }, { status: 401 });

export async function GET() {
  const usuario = currentUser(cookies());
  if (!usuario) return noAutenticado();
  return ok({ preferencias: preferenciasDe(usuario) });
}

export async function PUT(req: Request) {
  const usuario = currentUser(cookies());
  if (!usuario) return noAutenticado();
  try {
    const body = (await req.json().catch(() => null)) as { loteVideos?: unknown } | null;
    if (!body || !("loteVideos" in body)) return badRequest("Falta loteVideos.");
    const v = body.loteVideos;
    if (v !== null && typeof v !== "number") return badRequest("loteVideos tiene que ser un número o null.");
    return ok({ preferencias: guardarPreferencias(usuario, { loteVideos: v }) });
  } catch (err) {
    if (err instanceof ErrorDePreferencias) return badRequest(err.message);
    return serverError(err);
  }
}
