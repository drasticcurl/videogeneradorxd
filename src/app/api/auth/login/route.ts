/**
 * POST /api/auth/login  { password }  -> setea la cookie de sesión si la pass es correcta.
 */
import { cookies } from "next/headers";
import {
  AUTH_COOKIE,
  authConfigured,
  createSession,
  passwordOk,
} from "@/lib/auth";
import { ok, badRequest, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!authConfigured()) {
      return ok({ ok: true, note: "auth deshabilitada" });
    }
    const body = (await req.json().catch(() => ({}))) as { password?: string };
    const password = String(body.password ?? "");
    if (!password || !(await passwordOk(password))) {
      // pequeño delay para frenar fuerza bruta.
      await new Promise((r) => setTimeout(r, 600));
      return badRequest("Contraseña incorrecta");
    }
    const token = await createSession();
    cookies().set(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return ok({ ok: true });
  } catch (err) {
    return serverError(err);
  }
}
