/**
 * Middleware — guard de auth + headers de seguridad.
 *
 * Es la primera linea: sin cookie valida, ningun request llega a una pagina ni a
 * una route handler. Importa porque la app gasta plata real (Veo y Nano Banana
 * son de pago) y porque `/api/files/*` sirve todo lo generado.
 *
 * POR QUE ESTE ARCHIVO REIMPLEMENTA EL VERIFY en vez de importar `lib/auth.ts`:
 * el middleware de Next 14 corre en Edge, y `lib/auth.ts` usa `node:crypto`
 * (`createHmac`, `timingSafeEqual`) y ademas importa `lib/config.ts`, que usa
 * `node:path`. Ninguno de los dos existe en Edge. Es el MISMO formato de token
 * (`usuario.ts.sig`, HMAC-SHA256 con AUTH_SECRET) y el mismo TTL; solo cambia la
 * primitiva (Web Crypto). Es el mismo arreglo que ya usa el panel de tracking.
 *
 * Lo que este archivo NO puede chequear: que el usuario siga existiendo en el
 * .env. Eso necesita enumerar `PASSWORD_*`, y el acceso dinamico a `process.env`
 * no es confiable en Edge. Lo verifica `lib/auth.ts` en el server, que es donde
 * la revocacion tiene que valer.
 */

import { NextResponse, type NextRequest } from "next/server";

const COOKIE_NAME = "gen_session";
const CLOCK_SKEW_MS = 60_000;
const DEFAULT_SESSION_HOURS = 72;

/** Mismo default y misma var que `config.auth.sessionHours`. */
function sessionTtlMs(): number {
  const n = Number(process.env.AUTH_SESSION_HOURS ?? "");
  const hours = Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_HOURS;
  return hours * 3600 * 1000;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(mac), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

// Web Crypto no expone timingSafeEqual: comparar en tiempo constante a mano es lo
// mejor disponible en Edge. La verificacion definitiva (node:crypto) la hace
// lib/auth.ts en el server.
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;

  // Falla cerrado: sin secret no se puede verificar nada, asi que no entra nadie.
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [name, ts, sig] = parts;
  if (!name || !ts || !sig) return false;
  if (!/^[a-z0-9_-]+$/.test(name)) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return false;

  const now = Date.now();
  if (now - tsNum > sessionTtlMs()) return false;
  if (tsNum - now > CLOCK_SKEW_MS) return false;

  return safeEqualHex(sig, await hmacSha256Hex(secret, `${name}.${ts}`));
}

/**
 * La URL del login, en el dominio POR EL QUE ENTRO el visitante.
 *
 * NO se usa `new URL('/login', req.url)`. En el build standalone detras de Caddy,
 * Next arma `req.url` con la direccion donde escucha el proceso, no con el Host
 * que pidio el browser: el redirect saldria a `http://127.0.0.1:3006/login` y
 * sacaria al usuario de la app cada vez que se le vence la sesion. Es el mismo
 * bug que ya se documento en el panel y en el middleware de los funnels.
 *
 * El orden es a proposito:
 *  1. `NEXT_PUBLIC_SITE_URL` — el valor canonico. Es el unico que no depende de
 *     headers que puede escribir el cliente.
 *  2. `x-forwarded-host` + `x-forwarded-proto` — lo que manda Caddy. Solo se usa
 *     si no hay (1).
 *  3. `req.nextUrl` — dev local sin proxy, donde el host si es el real.
 */
export function urlDeLogin(req: NextRequest): URL {
  const canonica = process.env.NEXT_PUBLIC_SITE_URL;
  if (canonica) {
    try {
      return new URL("/login", canonica);
    } catch {
      // Una env var mal escrita no puede dejar la app sin redirect.
    }
  }

  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto =
      req.headers.get("x-forwarded-proto") ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https");
    try {
      return new URL("/login", `${proto}://${host}`);
    } catch {
      // idem
    }
  }

  const local = req.nextUrl.clone();
  local.pathname = "/login";
  local.search = "";
  return local;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // `/login` y `/api/login` son las unicas rutas abiertas: son las que permiten
  // conseguir la cookie. Si estuvieran detras del guard, no se podria entrar
  // nunca.
  const esPublica = pathname === "/login" || pathname === "/api/login";
  const autenticado = esPublica || (await isAuthenticated(req));

  let res: NextResponse;
  if (autenticado) {
    res = NextResponse.next();
  } else if (pathname.startsWith("/api/")) {
    // A una llamada de la API se le contesta 401, no un redirect: el `fetch` de
    // la UI seguiria el 307 y parsearia el HTML del login como si fuera JSON,
    // con lo que el error real quedaria tapado por un "Unexpected token <".
    res = NextResponse.json(
      { ok: false, error: "No autenticado. Volvé a entrar." },
      { status: 401 },
    );
  } else {
    res = NextResponse.redirect(urlDeLogin(req));
  }

  // Herramienta interna en un subdominio publico: nada cacheable, nada indexable.
  res.headers.set("Cache-Control", "no-store, must-revalidate");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  return res;
}

export const config = {
  // Se excluyen solo los assets del build y el favicon. `_next/static` tiene que
  // quedar afuera o la pantalla de login sale sin CSS: el HTML lo sirve el login
  // (que si pasa), pero los assets se piden sin haber conseguido la cookie
  // todavia y el middleware los redirigiria a `/login`.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
