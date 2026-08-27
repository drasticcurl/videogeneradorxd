/**
 * Auth de la app — password-gate por usuario.
 *
 * Es el mismo mecanismo que ya corre en produccion en el panel de tracking
 * (`dashboard-admin/lib/auth.ts`), adaptado a multiples usuarios. No se
 * reinventa nada: cookie firmada con HMAC, comparacion timing-safe y rate limit
 * por IP.
 *
 * POR QUE HACE FALTA: la app llama a Veo y a Nano Banana, que son de pago. Sin
 * gate, cualquiera que descubra el hostname puede quemar cuota facturable, y
 * ademas leer y borrar todos los proyectos generados. Antes de este modulo la
 * app no tenia ningun control de acceso porque estaba pensada para correr en
 * localhost.
 *
 * Modelo de seguridad:
 *  - Un usuario por var `PASSWORD_<NOMBRE>` (ver `authUsers()` en config.ts).
 *  - Cookie `gen_session` = `<usuario>.<ts>.<hmac>`, con HMAC-SHA256 sobre
 *    `<usuario>.<ts>` usando `AUTH_SECRET` como clave. La cookie NO contiene la
 *    password y no se puede forjar sin conocer el secret.
 *  - El secret es una var aparte y NO la password del usuario: con varios
 *    usuarios, firmar con la password propia haria que rotar una invalide solo
 *    esa sesion y obliga a probar N claves para verificar una cookie.
 *  - Verificacion timing-safe del HMAC y de la password → no se puede
 *    bruteforcear caracter por caracter midiendo tiempos.
 *  - Rate limit por IP: 5 intentos cada 15 min.
 *  - Cookie `httpOnly`, `sameSite=lax`, `secure` en prod, `path=/`.
 *
 * Falla CERRADO: si falta `AUTH_SECRET` o no hay ninguna `PASSWORD_*`, todos los
 * checks devuelven false y no entra nadie. Nunca "se abre porque no hay config".
 *
 * Este modulo es server-only (importa `node:crypto`): NO se importa desde
 * `middleware.ts`, que corre en Edge y tiene su propia copia del verify con Web
 * Crypto.
 */

import crypto from "node:crypto";
import { config, authUsers } from "./config";

// ─── Constantes publicas ───────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = "gen_session";

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const CLOCK_SKEW_MS = 60_000;

/** TTL de la sesion en segundos, derivado de `AUTH_SESSION_HOURS`. */
export function sessionTtlSeconds(): number {
  return Math.round(config.auth.sessionHours * 3600);
}

// ─── Warnings de configuracion (una sola vez por proceso) ──────────────────

let warnedNoSecret = false;
let warnedNoUsers = false;

function getSecret(): string | null {
  const secret = config.auth.secret;
  if (!secret) {
    if (!warnedNoSecret) {
      console.warn(
        "[auth] AUTH_SECRET no configurado — la app queda cerrada para todos.",
      );
      warnedNoSecret = true;
    }
    return null;
  }
  return secret;
}

function getUsers(): Map<string, string> | null {
  const users = authUsers();
  if (users.size === 0) {
    if (!warnedNoUsers) {
      console.warn(
        "[auth] no hay ninguna PASSWORD_<NOMBRE> configurada — no puede entrar nadie.",
      );
      warnedNoUsers = true;
    }
    return null;
  }
  return users;
}

/** `true` solo si hay secret Y al menos un usuario. Todo lo demas cierra. */
export function isConfigured(): boolean {
  return getSecret() !== null && getUsers() !== null;
}

/** Nombres de usuario habilitados, ordenados. Solo para mostrar en la UI. */
export function listUsers(): string[] {
  return [...(getUsers()?.keys() ?? [])].sort();
}

// ─── Token HMAC ────────────────────────────────────────────────────────────

function hmac(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/** Compara dos strings hex en tiempo constante. */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ab.length === 0 || ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Firma la cookie de sesion para un usuario.
 * Devuelve `null` si falta config: el login tiene que fallar cerrado.
 */
export function signSessionToken(
  user: string,
  nowMs: number = Date.now(),
): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const name = user.toLowerCase();
  // El usuario va en el payload, asi que no puede contener el separador.
  if (!/^[a-z0-9_-]+$/.test(name)) return null;
  const ts = String(nowMs);
  return `${name}.${ts}.${hmac(secret, `${name}.${ts}`)}`;
}

/**
 * Verifica firma y expiracion. Devuelve el usuario si el token es valido, o
 * `null` si no lo es.
 */
export function verifySessionToken(
  token: string | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!token || typeof token !== "string") return null;
  const secret = getSecret();
  if (!secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [name, ts, sig] = parts;
  if (!name || !ts || !sig) return null;
  if (!/^[a-z0-9_-]+$/.test(name)) return null;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return null;

  // Expiracion, y tampoco se aceptan timestamps del futuro.
  if (nowMs - tsNum > sessionTtlSeconds() * 1000) return null;
  if (tsNum - nowMs > CLOCK_SKEW_MS) return null;

  if (!safeEqualHex(sig, hmac(secret, `${name}.${ts}`))) return null;

  // Un usuario que se saco del .env deja de entrar aunque su cookie siga firmada
  // y sin vencer. Es lo que permite revocar el acceso de alguien sin esperar el
  // TTL ni rotar el secret (que echaria a todos).
  const users = getUsers();
  if (!users || !users.has(name)) return null;

  return name;
}

// ─── Verificacion de password ──────────────────────────────────────────────

/**
 * Valida usuario + password. Devuelve el nombre normalizado, o `null`.
 *
 * El costo es el mismo exista o no el usuario: si no existe, se compara contra
 * un valor dummy del mismo largo. Sin eso, el tiempo de respuesta delata que
 * `PASSWORD_IVAN` existe y `PASSWORD_PEPE` no.
 */
export function verifyCredentials(
  user: string | undefined,
  password: string | undefined,
): string | null {
  const users = getUsers();
  if (!users) return null;
  if (typeof user !== "string" || typeof password !== "string") return null;
  if (user.length === 0 || password.length === 0) return null;

  const name = user.trim().toLowerCase();
  const expected = users.get(name);

  if (expected === undefined) {
    // Trabajo equivalente para no filtrar por timing si el usuario existe.
    const dummy = Buffer.alloc(Math.max(1, password.length), 0);
    crypto.timingSafeEqual(dummy, dummy);
    return null;
  }

  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return null;
  }
  return crypto.timingSafeEqual(a, b) ? name : null;
}

// ─── Cookie helpers ────────────────────────────────────────────────────────

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionTtlSeconds(),
  };
}

export function clearSessionCookieOptions(): CookieOptions {
  return { ...sessionCookieOptions(), maxAge: 0 };
}

// ─── IP del visitante ──────────────────────────────────────────────────────
//
// Topologia: visitante → Cloudflare (proxy) → Caddy → Node. Cloudflare y Caddy
// APENDEAN a `x-forwarded-for`, asi que el PRIMER token es texto libre que puede
// escribir el atacante y el ultimo es el que agrego el proxy de confianza. Usar
// el primero permitiria evadir el rate limit mandando un XFF distinto por
// intento.
//
// Orden de confianza:
//   1. `cf-connecting-ip` — Cloudflare lo sobreescribe siempre.
//   2. `x-real-ip` — lo setea Caddy con `header_up X-Real-IP {client_ip}`.
//   3. ultimo token de `x-forwarded-for`.
//   4. "unknown" — dev local sin proxy.

type HeaderLike = { get(name: string): string | null };

export function getClientIp(headers: HeaderLike): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;

  const parts = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.at(-1) ?? "unknown";
}

// ─── Rate limit (in-memory, por IP) ────────────────────────────────────────
//
// El balde vive en la memoria del proceso. La app corre en UNA sola instancia de
// PM2 (la cola de jobs es in-memory y no se puede balancear), asi que todos los
// intentos caen en el mismo balde. Si algun dia se corren N instancias, el
// limite efectivo se multiplica por N y hay que mover esto a Redis.

interface Bucket {
  count: number;
  firstTs: number;
}

const globalForRateLimit = globalThis as unknown as {
  __genLoginRateLimit?: Map<string, Bucket>;
};

function getBuckets(): Map<string, Bucket> {
  if (!globalForRateLimit.__genLoginRateLimit) {
    globalForRateLimit.__genLoginRateLimit = new Map();
  }
  return globalForRateLimit.__genLoginRateLimit;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function checkLoginRateLimit(
  ip: string,
  nowMs: number = Date.now(),
): RateLimitResult {
  const buckets = getBuckets();
  const b = buckets.get(ip);

  // GC oportunista para que el Map no crezca sin techo.
  if (buckets.size > 1024) {
    const firstKey = buckets.keys().next().value;
    if (firstKey !== undefined) buckets.delete(firstKey);
  }

  if (!b || nowMs - b.firstTs > RATE_LIMIT_WINDOW_MS) {
    buckets.set(ip, { count: 1, firstTs: nowMs });
    return { allowed: true };
  }

  if (b.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil(
      (b.firstTs + RATE_LIMIT_WINDOW_MS - nowMs) / 1000,
    );
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  b.count += 1;
  return { allowed: true };
}

/** Resetea el contador de un IP tras un login exitoso. */
export function resetLoginRateLimit(ip: string): void {
  getBuckets().delete(ip);
}

// ─── API alto nivel ────────────────────────────────────────────────────────

/**
 * Usuario logueado, o `null`. Acepta cualquier objeto con
 * `cookies.get(name)?.value` (NextRequest, `cookies()` de next/headers).
 */
export function currentUser(cookies: {
  get: (name: string) => { value: string } | undefined;
}): string | null {
  const c = cookies.get(SESSION_COOKIE_NAME);
  if (!c) return null;
  return verifySessionToken(c.value);
}
