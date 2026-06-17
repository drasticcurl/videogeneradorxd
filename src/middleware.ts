/**
 * Middleware de autenticación: si la auth está configurada (APP_PASSWORD + APP_AUTH_SECRET),
 * bloquea TODAS las rutas y APIs salvo que haya una sesión válida.
 *  - páginas sin sesión -> redirect a /login
 *  - APIs sin sesión    -> 401 JSON
 * Si la auth NO está configurada, deja pasar todo (local/dev/mock).
 */
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, authConfigured, verifySession } from "@/lib/auth";

// Rutas accesibles sin sesión (login + sus endpoints).
const PUBLIC = ["/login", "/api/auth/login", "/api/auth/logout"];

export async function middleware(req: NextRequest) {
  if (!authConfigured()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (await verifySession(token)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "No autorizado. Iniciá sesión." }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Protege todo menos assets estáticos de Next y el favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
