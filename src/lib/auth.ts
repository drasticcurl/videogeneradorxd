/**
 * Login simple y seguro a nivel app (una contraseña compartida + cookie de sesión firmada).
 *
 * - Edge-safe: usa SOLO Web Crypto (crypto.subtle) + btoa/atob, así sirve en el middleware
 *   (edge) y en los route handlers (node).
 * - La cookie guarda un token { exp } firmado con HMAC-SHA256 usando APP_AUTH_SECRET.
 * - La contraseña se compara via HMAC (longitud fija) para no filtrar info por timing.
 *
 * Config por env:
 *   APP_PASSWORD     contraseña de acceso
 *   APP_AUTH_SECRET  secreto largo y aleatorio para firmar la sesión
 * Si falta cualquiera de las dos, la auth queda DESACTIVADA (útil en local/dev/mock).
 */

export const AUTH_COOKIE = "augc_session";
const DEFAULT_TTL_SEC = 60 * 60 * 24 * 7; // 7 días

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(b64: string): Uint8Array {
  const norm = b64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 ? "=".repeat(4 - (norm.length % 4)) : "";
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function strToB64url(s: string): string {
  return bytesToB64url(enc.encode(s));
}
function b64urlToStr(s: string): string {
  return dec.decode(b64urlToBytes(s));
}

async function hmacB64url(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return bytesToB64url(new Uint8Array(sig));
}

/** Comparación en tiempo constante de dos strings de igual longitud (HMACs). */
function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** ¿Está la auth configurada? (si no, la app queda abierta: local/dev). */
export function authConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD && process.env.APP_AUTH_SECRET);
}

/** Crea un token de sesión firmado (payload.sig en base64url). */
export async function createSession(ttlSec = DEFAULT_TTL_SEC): Promise<string> {
  const secret = process.env.APP_AUTH_SECRET as string;
  const payload = strToB64url(JSON.stringify({ exp: Date.now() + ttlSec * 1000 }));
  const sig = await hmacB64url(secret, payload);
  return `${payload}.${sig}`;
}

/** Verifica firma + expiración del token de sesión. */
export async function verifySession(token?: string): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.APP_AUTH_SECRET;
  if (!secret) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacB64url(secret, payload);
  if (!timingEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(b64urlToStr(payload)) as { exp?: number };
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

/** Compara la contraseña ingresada con APP_PASSWORD (via HMAC, sin filtrar por timing). */
export async function passwordOk(input: string): Promise<boolean> {
  const expected = process.env.APP_PASSWORD;
  const secret = process.env.APP_AUTH_SECRET;
  if (!expected || !secret) return false;
  const a = await hmacB64url(secret, "pw:" + input);
  const b = await hmacB64url(secret, "pw:" + expected);
  return timingEqual(a, b);
}
