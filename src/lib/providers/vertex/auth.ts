/**
 * Autenticacion con Application Default Credentials (ADC) via google-auth-library.
 *
 * NO usamos API keys ni service account en el codigo. En local, el usuario corre:
 *   gcloud auth application-default login
 * y GoogleAuth toma esas credenciales automaticamente.
 *
 * Toda llamada a modelos sale del BACKEND (route handlers), nunca del cliente.
 */
import { GoogleAuth } from "google-auth-library";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

// Reutilizamos la instancia (cachea el token internamente).
const globalForAuth = globalThis as unknown as { __augcAuth?: GoogleAuth };
const auth: GoogleAuth =
  globalForAuth.__augcAuth ??
  (globalForAuth.__augcAuth = new GoogleAuth({ scopes: [SCOPE] }));

/** Devuelve un access token valido obtenido desde ADC. */
export async function getAccessToken(): Promise<string> {
  try {
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (!token || !token.token) {
      throw new Error("token vacio");
    }
    return token.token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `No se pudieron obtener credenciales ADC de Google Cloud (${msg}). ` +
        `Corré 'gcloud auth application-default login' o usá PROVIDER_MODE=mock.`
    );
  }
}

/** Headers comunes (Authorization + JSON) para llamadas REST a Vertex AI. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}
