/**
 * Listado DINAMICO de modelos disponibles en Vertex AI (Model Garden de Google).
 *
 * Usa el endpoint REST publishers.models.list:
 *   GET https://{LOCATION}-aiplatform.googleapis.com/v1beta1/publishers/google/models
 *
 * Devuelve los modelos publicos de Google (Gemini / Veo / Imagen-Nano Banana) y los
 * categoriza en llm | image | video por patron de nombre. Auth por ADC (authHeaders()).
 */
import { authHeaders } from "./auth";
import { config, type ModelOption } from "../../config";

export type ModelKind = "llm" | "image" | "video";
export interface ModelCatalog {
  llm: ModelOption[];
  image: ModelOption[];
  video: ModelOption[];
}

function aiplatformHost(location: string): string {
  return location === "global"
    ? "aiplatform.googleapis.com"
    : `${location}-aiplatform.googleapis.com`;
}

/** Clasifica un id de modelo en un tipo, o null si no nos interesa para la UI. */
function categorize(modelId: string): ModelKind | null {
  const s = modelId.toLowerCase();
  // Descartamos modelos que no usamos (embeddings, tts, live, vision deprecado, etc.)
  if (/(embedding|tts|live|guard|aqa|gemini-pro-vision|gemma)/.test(s)) return null;
  if (/veo/.test(s)) return "video";
  if (/(imagen|image)/.test(s)) return "image"; // gemini-*-image (Nano Banana) e imagen-*
  if (/gemini/.test(s)) return "llm";
  return null;
}

/**
 * Consulta Model Garden y devuelve el catalogo categorizado. Pagina hasta 6 veces.
 * Lanza si la API falla (el caller decide el fallback al catalogo estatico).
 */
export async function listGoogleModels(
  location: string = config.google.location
): Promise<ModelCatalog> {
  const headers = await authHeaders();
  const base = `https://${aiplatformHost(location)}/v1beta1/publishers/google/models`;

  const seen = new Set<string>();
  const cat: ModelCatalog = { llm: [], image: [], video: [] };
  let pageToken: string | undefined;

  for (let page = 0; page < 6; page++) {
    const url = new URL(base);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `publishers.models.list ${res.status}: ${text.slice(0, 300)}`
      );
    }
    const data = (await res.json()) as {
      publisherModels?: { name?: string }[];
      nextPageToken?: string;
    };

    for (const m of data.publisherModels ?? []) {
      const id = (m.name ?? "").split("/").pop() ?? "";
      if (!id || seen.has(id)) continue;
      const kind = categorize(id);
      if (!kind) continue;
      seen.add(id);
      cat[kind].push({ id, label: id });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  for (const k of ["llm", "image", "video"] as const) {
    cat[k].sort((a, b) => a.id.localeCompare(b.id));
  }
  return cat;
}
