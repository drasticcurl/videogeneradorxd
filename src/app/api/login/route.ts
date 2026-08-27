/**
 * POST /api/login   — valida usuario + password y setea la cookie de sesion.
 * DELETE /api/login — cierra la sesion.
 *
 * Es una de las dos rutas que el middleware deja pasar sin cookie (la otra es la
 * pagina `/login`). Si estuviera detras del guard no se podria entrar nunca.
 *
 * La password viaja SOLO en el body de un POST. Nunca en la query string: eso
 * quedaria escrito en el log de acceso de Caddy y en el historial del browser.
 */
import { cookies } from "next/headers";
import { headers } from "next/headers";

import {
  SESSION_COOKIE_NAME,
  checkLoginRateLimit,
  clearSessionCookieOptions,
  getClientIp,
  isConfigured,
  resetLoginRateLimit,
  sessionCookieOptions,
  signSessionToken,
  verifyCredentials,
} from "@/lib/auth";
import { ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Sin AUTH_SECRET o sin ningun usuario, el login rechaza todo. Es a proposito:
  // una app de generacion facturable no puede quedar abierta porque falto una var.
  if (!isConfigured()) {
    return ok(
      { ok: false, error: "La app no tiene el login configurado en el server." },
      { status: 503 },
    );
  }

  const ip = getClientIp(headers());
  const limite = checkLoginRateLimit(ip);
  if (!limite.allowed) {
    return ok(
      {
        ok: false,
        error: `Demasiados intentos. Probá de nuevo en ${limite.retryAfterSeconds}s.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limite.retryAfterSeconds) },
      },
    );
  }

  let usuario: unknown;
  let password: unknown;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    usuario = body?.usuario;
    password = body?.password;
  } catch {
    return ok({ ok: false, error: "Body invalido." }, { status: 400 });
  }

  const nombre = verifyCredentials(
    typeof usuario === "string" ? usuario : undefined,
    typeof password === "string" ? password : undefined,
  );

  // El mensaje es el mismo para usuario inexistente y password incorrecta: no
  // tiene sentido confirmarle a nadie que "ivan" es un usuario valido.
  if (!nombre) {
    return ok(
      { ok: false, error: "Usuario o password incorrectos." },
      { status: 401 },
    );
  }

  const token = signSessionToken(nombre);
  if (!token) {
    return ok(
      { ok: false, error: "No se pudo firmar la sesion en el server." },
      { status: 500 },
    );
  }

  resetLoginRateLimit(ip);
  cookies().set(SESSION_COOKIE_NAME, token, sessionCookieOptions());

  return ok({ ok: true, usuario: nombre });
}

export async function DELETE() {
  cookies().set(SESSION_COOKIE_NAME, "", clearSessionCookieOptions());
  return ok({ ok: true });
}
