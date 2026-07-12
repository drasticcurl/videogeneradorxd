/**
 * GET /api/models
 *   -> { catalog: { llm[], image[], video[] }, source: "vertex" | "catalog", error? }
 *
 * Lista los modelos disponibles en Vertex AI (Model Garden de Google) y los devuelve
 * categorizados para los selectores de la UI. Si el modo no es vertex, el proyecto no
 * esta configurado, o la API falla, cae al catalogo estatico curado (MODEL_CATALOG).
 *
 * Cachea el resultado en memoria (TTL) para no pegarle a Vertex en cada carga de pagina.
 * `?refresh=1` fuerza re-consulta.
 */
import { config, MODEL_CATALOG } from "@/lib/config";
import { listGoogleModels, type ModelCatalog } from "@/lib/providers/vertex/models";
import { ok, serverError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 60 * 60 * 1000; // 1 hora

interface ModelsResponse {
  catalog: ModelCatalog;
  source: "vertex" | "catalog";
  error?: string;
}

let cache: { ts: number; data: ModelsResponse } | null = null;

/**
 * Catalogo BLOQUEADO: exponemos UNICAMENTE los modelos curados de MODEL_CATALOG,
 * ignorando cualquier otro modelo que Vertex liste. Solo se conserva el listado
 * dinamico para poder marcar la fuente como "vertex" cuando el proyecto responde.
 */
function mergeCatalog(_dynamic: ModelCatalog): ModelCatalog {
  const out: ModelCatalog = { llm: [], image: [], video: [] };
  for (const k of ["llm", "image", "video"] as const) {
    out[k] = MODEL_CATALOG[k].map((o) => ({ id: o.id, label: o.label }));
  }
  return out;
}

export async function GET(req: Request) {
  try {
    const refresh = new URL(req.url).searchParams.get("refresh");

    if (!refresh && cache && Date.now() - cache.ts < TTL_MS) {
      return ok(cache.data);
    }

    // Sin Vertex (modo mock o sin proyecto): catalogo estatico.
    if (config.providerMode !== "vertex" || !config.google.project) {
      const data: ModelsResponse = { catalog: MODEL_CATALOG, source: "catalog" };
      cache = { ts: Date.now(), data };
      return ok(data);
    }

    try {
      const dynamic = await listGoogleModels();
      const data: ModelsResponse = {
        catalog: mergeCatalog(dynamic),
        source: "vertex",
      };
      cache = { ts: Date.now(), data };
      return ok(data);
    } catch (err) {
      // Fallback resiliente: el catalogo curado siempre funciona.
      const data: ModelsResponse = {
        catalog: MODEL_CATALOG,
        source: "catalog",
        error: err instanceof Error ? err.message : String(err),
      };
      return ok(data);
    }
  } catch (err) {
    return serverError(err);
  }
}
