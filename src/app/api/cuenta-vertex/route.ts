/**
 * La cuenta de Vertex del usuario logueado (src/lib/cuentaVertex.ts).
 *
 *   GET    → { estado }
 *   POST   { llave, proyecto? } → prueba la cuenta sin gastar y, si anda, la guarda.
 *                                  { estado, prueba }. Si no anda NO se guarda nada.
 *   POST   { probar: true }     → prueba la cuenta que usa hoy. { estado, prueba }
 *   DELETE → saca la cargada desde la app. { estado }
 *
 * El usuario sale SIEMPRE de la cookie, nunca del body: cada uno ve y cambia SOLO la
 * suya. Es identidad (auth.ts) y no un chequeo de dueño: no hay proyecto de por medio.
 *
 * Ninguna respuesta trae la llave ni el path donde quedo: lo que se sube no vuelve a salir.
 */
import { cookies } from "next/headers";

import { currentUser } from "@/lib/auth";
import {
  cargarCuenta,
  ErrorDeCuenta,
  estadoCuentaVertex,
  probarCuentaActual,
  quitarCuenta,
} from "@/lib/cuentaVertex";
import { badRequest, ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noAutenticado = () => ok({ error: "No autenticado. Volvé a entrar." }, { status: 401 });

/** Tope del body: una llave pesa ~2,4 KB. Esto corta antes de parsear cualquier otra cosa. */
const MAX_BODY = 100_000;

export async function GET() {
  const usuario = currentUser(cookies());
  if (!usuario) return noAutenticado();
  return ok({ estado: estadoCuentaVertex(usuario) });
}

export async function POST(req: Request) {
  const usuario = currentUser(cookies());
  if (!usuario) return noAutenticado();
  try {
    const texto = await req.text();
    if (texto.length > MAX_BODY) {
      return ok({ error: "El archivo es demasiado grande para ser una llave." }, { status: 413 });
    }
    let body: { llave?: unknown; proyecto?: unknown; probar?: unknown };
    try {
      body = JSON.parse(texto) as typeof body;
    } catch {
      return badRequest("El pedido no es un JSON.");
    }

    if (body.probar === true) {
      const prueba = await probarCuentaActual(usuario);
      return ok({ estado: estadoCuentaVertex(usuario), prueba });
    }

    if (typeof body.llave !== "string" || body.llave.length === 0) {
      return badRequest("Elegí el archivo JSON de tu cuenta.");
    }
    const proyecto = typeof body.proyecto === "string" ? body.proyecto : "";
    return ok(await cargarCuenta(usuario, body.llave, proyecto));
  } catch (err) {
    if (err instanceof ErrorDeCuenta) return badRequest(err.message);
    return serverError(err);
  }
}

export async function DELETE() {
  const usuario = currentUser(cookies());
  if (!usuario) return noAutenticado();
  try {
    return ok({ estado: quitarCuenta(usuario) });
  } catch (err) {
    return serverError(err);
  }
}
