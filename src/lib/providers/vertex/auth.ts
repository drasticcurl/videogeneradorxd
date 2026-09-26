/**
 * Autenticacion contra Vertex AI, POR CUENTA (ver `vertexCuentaFor` en cuentaVertex.ts).
 *
 *  - Cuenta propia de un usuario: la que cargo desde la app, o el JSON de
 *    `GOOGLE_APPLICATION_CREDENTIALS_<NOMBRE>` (una service account, o el
 *    `application_default_credentials.json` de su gcloud).
 *  - Cuenta compartida: Application Default Credentials (ADC). En local,
 *    `gcloud auth application-default login`; en el server, `GOOGLE_APPLICATION_CREDENTIALS`.
 *
 * Toda llamada a modelos sale del BACKEND (route handlers y la cola), nunca del cliente.
 */
import { GoogleAuth } from "google-auth-library";
import { config, vertexBaseUrl, type CuentaVertex } from "../../config";
import type { PruebaCuentaVertex } from "../../types";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Un GoogleAuth por archivo de credenciales ("" = ADC), reutilizado: cada uno cachea
 * su token internamente. La clave es el path y no el usuario, asi dos usuarios que
 * apuntan al mismo JSON comparten token en vez de pedir uno cada uno.
 */
const globalForAuth = globalThis as unknown as {
  __augcAuthPorCredenciales?: Map<string, GoogleAuth>;
};
const auths: Map<string, GoogleAuth> =
  globalForAuth.__augcAuthPorCredenciales ??
  (globalForAuth.__augcAuthPorCredenciales = new Map());

function authDe(cuenta: CuentaVertex): GoogleAuth {
  let auth = auths.get(cuenta.credenciales);
  if (!auth) {
    auth = cuenta.credenciales
      ? new GoogleAuth({ keyFilename: cuenta.credenciales, scopes: [SCOPE] })
      : new GoogleAuth({ scopes: [SCOPE] });
    auths.set(cuenta.credenciales, auth);
  }
  return auth;
}

/** Devuelve un access token valido para la cuenta. */
export async function getAccessToken(cuenta: CuentaVertex): Promise<string> {
  try {
    const client = await authDe(cuenta).getClient();
    const token = await client.getAccessToken();
    if (!token || !token.token) {
      throw new Error("token vacio");
    }
    return token.token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (cuenta.origen === "app") {
      throw new Error(
        `No se pudo usar la cuenta de Vertex que cargó ${cuenta.usuario} (${msg}). ` +
          `Probala o volvé a cargarla desde tu nombre, arriba a la derecha.`
      );
    }
    if (cuenta.credenciales) {
      throw new Error(
        `No se pudieron usar las credenciales de Vertex de ${cuenta.usuario} ` +
          `(GOOGLE_APPLICATION_CREDENTIALS_${cuenta.usuario?.toUpperCase()}=` +
          `${cuenta.credenciales}): ${msg}`
      );
    }
    throw new Error(
      `No se pudieron obtener credenciales ADC de Google Cloud (${msg}). ` +
        `Corré 'gcloud auth application-default login' o usá PROVIDER_MODE=mock.`
    );
  }
}

/** Headers comunes (Authorization + JSON) para llamadas REST a Vertex AI. */
export async function authHeaders(
  cuenta: CuentaVertex
): Promise<Record<string, string>> {
  const token = await getAccessToken(cuenta);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/* ─────────────────────────── probar una cuenta ─────────────────────────── */

/**
 * Prueba una cuenta SIN GASTAR: pide un token y hace un `countTokens` (gratis) contra su
 * proyecto, con el modelo de chat por default. Si pasa, la cuenta puede generar: la
 * llave es valida, la Vertex AI API esta habilitada, el proyecto tiene facturacion y la
 * identidad tiene permiso. Esas cuatro son justamente las que fallan al armar una
 * cuenta nueva, y sin esta prueba aparecian recien en el primer job, en rojo.
 *
 * `llave` es para probar un JSON ANTES de guardarlo (todavia no tiene path). Sin
 * `llave`, se prueba la cuenta tal cual la usaria un job.
 */
export async function probarCuenta(
  cuenta: CuentaVertex,
  llave?: object
): Promise<PruebaCuentaVertex> {
  const proyecto = cuenta.proyecto;
  let token: string;
  try {
    if (llave) {
      const auth = new GoogleAuth({ credentials: llave, scopes: [SCOPE] });
      const t = await (await auth.getClient()).getAccessToken();
      if (!t?.token) throw new Error("token vacio");
      token = t.token;
    } else {
      token = await getAccessToken(cuenta);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      motivo: /invalid_grant|invalid_client|unauthorized_client|DECODER|PEM|private key/i.test(msg)
        ? "Google rechazó la llave: puede que la hayan borrado o que sea de un login que " +
          `expiró. Generá una nueva. (${msg})`
        : `No se pudo sacar un token con esa llave: ${msg}`,
      ayuda: {
        texto: "Cuentas de servicio del proyecto",
        url: consola("iam-admin/serviceaccounts", proyecto),
      },
    };
  }

  let res: Response;
  try {
    res = await fetch(`${vertexBaseUrl(cuenta)}/${config.models.llm}:countTokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "prueba" }] }] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, motivo: `No se pudo hablar con Google (${msg}). Probá de nuevo.`, ayuda: null };
  }
  if (res.ok) return { ok: true };
  return traducirError(res.status, await res.text(), proyecto);
}

/** Link a una pagina de la consola de Google Cloud, ya parada en el proyecto. */
function consola(pagina: string, proyecto: string): string {
  const q = proyecto ? `?project=${encodeURIComponent(proyecto)}` : "";
  return `https://console.cloud.google.com/${pagina}${q}`;
}

/**
 * Pasa el error de Google a lo que hay que hacer. Mira el `reason` de ErrorInfo y, por
 * las dudas, el texto: Google no siempre manda el `reason`.
 */
function traducirError(status: number, cuerpo: string, proyecto: string): PruebaCuentaVertex {
  let mensaje = cuerpo.slice(0, 300);
  let razon = "";
  try {
    const j = JSON.parse(cuerpo) as {
      error?: { message?: string; details?: Array<{ reason?: string }> };
    };
    mensaje = j.error?.message ?? mensaje;
    razon = j.error?.details?.find((d) => d.reason)?.reason ?? "";
  } catch {
    /* no era JSON: queda el texto crudo */
  }
  const texto = `${razon} ${mensaje}`;

  if (/BILLING_DISABLED|billing/i.test(texto)) {
    return {
      ok: false,
      motivo: `El proyecto ${proyecto} no tiene la facturación activa.`,
      ayuda: { texto: "Activar la facturación", url: consola("billing/linkedaccount", proyecto) },
    };
  }
  if (/SERVICE_DISABLED|has not been used|is disabled|API not enabled/i.test(texto)) {
    return {
      ok: false,
      motivo: `Falta habilitar la Vertex AI API en el proyecto ${proyecto}.`,
      ayuda: {
        texto: "Habilitar la Vertex AI API",
        url: consola("apis/library/aiplatform.googleapis.com", proyecto),
      },
    };
  }
  if (/CONSUMER_INVALID|not found|does not exist/i.test(texto) && !/model/i.test(texto)) {
    return {
      ok: false,
      motivo:
        `No existe el proyecto "${proyecto}", o la cuenta no lo puede ver. Revisá que sea el ` +
        "ID del proyecto y no el nombre.",
      ayuda: { texto: "Ver mis proyectos", url: "https://console.cloud.google.com/projectselector2/home/dashboard" },
    };
  }
  if (status === 403) {
    return {
      ok: false,
      motivo:
        `La cuenta no tiene permiso para usar Vertex en ${proyecto}. Dale el rol ` +
        `"Usuario de Vertex AI". (${mensaje.slice(0, 200)})`,
      ayuda: { texto: "Permisos del proyecto (IAM)", url: consola("iam-admin/iam", proyecto) },
    };
  }
  if (status === 429) {
    return {
      ok: false,
      motivo: "Google contestó que la cuota está agotada (429). Esperá un minuto y probá de nuevo.",
      ayuda: { texto: "Cuotas del proyecto", url: consola("iam-admin/quotas", proyecto) },
    };
  }
  return { ok: false, motivo: `Google contestó ${status}: ${mensaje.slice(0, 300)}`, ayuda: null };
}
