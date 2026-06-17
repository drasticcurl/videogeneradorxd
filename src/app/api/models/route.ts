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

/** Junta el catalogo dinamico con el curado: los curados van primero (con su label lindo). */
function mergeCatalog(dynamic: ModelCatalog): ModelCatalog {
  const out: ModelCatalog = { llm: [], image: [], video: [] };
  for (const k of ["llm", "image", "video"] as const) {
    const curatedIds = MODEL_CATALOG[k].map((o) => o.id);
    const labelById = new Map<string, string>();
    for (const o of dynamic[k]) labelById.set(o.id, o.label);
    for (const o of MODEL_CATALOG[k]) labelById.set(o.id, o.label); // label curado pisa al id pelado

    const dynIds = dynamic[k].map((o) => o.id);
    const curated = curatedIds.filter(
      (id) => labelById.has(id) // siempre true, pero deja los curados primero
    );
    const others = dynIds
      .filter((id) => !curatedIds.includes(id))
      .sort((a, b) => a.localeCompare(b));

    out[k] = [...curated, ...others].map((id) => ({
      id,
      label: labelById.get(id) ?? id,
    }));
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
