/**
 * EditorClient — typed HTTP client for the generator ↔ editor sidecar.
 *
 * Talks to the editor's FastAPI endpoints over localhost (no auth, no OIDC token).
 * Wraps calls with retry/backoff for transient errors.
 *
 * Requirements: 1, 5, 9, 11
 */

import { getEditorBaseUrl } from "./config";
import { withRetry, EditorTransientError, EditorPermanentError } from "./retry";
import type { EditorProcesarRequest, EditorProgress } from "./types";
import type { RetryOptions } from "./retry";

// ---------------------------------------------------------------------------
// Response shapes from the editor
// ---------------------------------------------------------------------------

/** Shape returned by POST /procesar (HTTP 202). */
export interface ProcesarResponse {
  job_id: string;
  estado: string;
}

// ---------------------------------------------------------------------------
// Editor pause read/confirm contracts (verbatim, snake_case)
//
// These mirror the editor's FastAPI response models exactly. They are returned
// verbatim by the getX methods and consumed by the BFF normalization helpers.
// ---------------------------------------------------------------------------

/** A detected/edited silence cut segment (editor form). */
export interface EditorTramo {
  inicio_s: number;
  fin_s: number;
}

/** A proposed subtitle group with group + per-word timings (editor form). */
export interface EditorGrupo {
  texto: string;
  inicio_s: number;
  fin_s: number;
  palabras:
    | { texto: string; inicio_s: number | null; fin_s: number | null }[]
    | null;
}

/** An optional overlaid "hook" text on the final render (editor form). */
export interface EditorTextoExtra {
  texto: string;
  inicio_s: number;
  fin_s: number;
  estilo: {
    fuente: string;
    tamano: number;
    color: string;
    color_borde: string;
    grosor_borde: number;
    negrita: boolean;
    pos_vertical_pct: number;
    pos_horizontal_pct: number;
  };
}

/** GET /silencios/{id} response. */
export interface EditorSilenciosResponse {
  job_id: string;
  estado: string;
  editable: boolean;
  video_url: string | null;
  video_nombre: string | null;
  duracion_s: number;
  fps: number;
  ancho: number;
  alto: number;
  tramos: EditorTramo[];
}

/** GET /subtitulos/{id} response. */
export interface EditorSubtitulosResponse {
  job_id: string;
  estado: string;
  editable: boolean;
  grupos: EditorGrupo[];
}

/** GET /render/{id} response. */
export interface EditorRenderResponse {
  job_id: string;
  estado: string;
  editable: boolean;
  motor_preferido: string;
  grupos: EditorGrupo[];
  video_url: string | null;
  video_nombre: string | null;
  fps: number;
  ancho: number;
  alto: number;
  duracion_s: number | null;
  textos_extra: EditorTextoExtra[];
}

/** POST /render/{id} confirmation body. */
export interface EditorRenderConfirmBody {
  textos_extra: EditorTextoExtra[];
  motor?: "remotion";
}

// ---------------------------------------------------------------------------
// Network-error classification helpers
// ---------------------------------------------------------------------------

/** Node.js error codes that indicate a transient network issue. */
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "EPIPE",
  "EAI_AGAIN",
]);

function isTransientNetworkError(err: unknown): boolean {
  // AbortError = fetch timeout (check first — DOMException also has a legacy `code` prop)
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  // Node.js network error codes
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;
  }
  if (err instanceof TypeError && /fetch|network/i.test(err.message))
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// EditorClient
// ---------------------------------------------------------------------------

export interface EditorClientOptions {
  /** Override the base URL (defaults to config value). */
  baseUrl?: string;
  /** Request timeout in ms. Default: 60_000 (60s). */
  timeoutMs?: number;
  /** Retry options. */
  retry?: RetryOptions;
  /** Custom fetch implementation (for testing). */
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Creates an EditorClient instance that talks to the editor sidecar.
 * No auth headers are ever attached — the editor is internal-only over localhost.
 */
export function createEditorClient(options?: EditorClientOptions) {
  const baseUrl = (options?.baseUrl ?? getEditorBaseUrl()).replace(/\/$/, "");
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const retryOpts: RetryOptions = options?.retry ?? {};
  const fetchImpl = options?.fetchFn ?? globalThis.fetch;

  /**
   * Low-level fetch wrapper that classifies errors as transient/permanent.
   */
  async function editorFetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const method = init?.method ?? "GET";
    console.log(`[EditorClient] fetching ${method} ${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...(init?.headers ?? {}),
          "Content-Type": "application/json",
        },
      });

      if (response.status >= 500) {
        const bodyText = await response.text().catch(() => "");
        console.log(`[EditorClient] server error ${response.status} ${bodyText}`);
        throw new EditorTransientError(
          `Editor returned ${response.status}: ${bodyText}`,
        );
      }

      if (response.status >= 400) {
        const bodyText = await response.text().catch(() => "");
        throw new EditorPermanentError(
          `Editor returned ${response.status}: ${bodyText}`,
          response.status,
          bodyText,
        );
      }

      console.log(`[EditorClient] response ${response.status}`);
      return response;
    } catch (err: unknown) {
      if (err instanceof EditorTransientError) throw err;
      if (err instanceof EditorPermanentError) throw err;
      if (isTransientNetworkError(err)) {
        const netErr = err as Error & { code?: string; cause?: unknown };
        console.log("[EditorClient] network error", {
          message: netErr.message,
          code: netErr.code,
          cause: netErr.cause,
        });
        throw new EditorTransientError(
          `Network error calling editor: ${(err as Error).message ?? err}`,
          err,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * POST /procesar — submits a new edit job to the editor.
   * Expects HTTP 202 with { job_id, estado }.
   */
  async function procesar(req: EditorProcesarRequest): Promise<ProcesarResponse> {
    return withRetry(async () => {
      const res = await editorFetch("/procesar", {
        method: "POST",
        body: JSON.stringify(req),
      });

      if (res.status !== 202) {
        throw new EditorPermanentError(
          `Expected 202 from /procesar, got ${res.status}`,
          res.status,
        );
      }

      const data = (await res.json()) as ProcesarResponse;

      if (!data.job_id || typeof data.job_id !== "string") {
        throw new EditorPermanentError(
          "Invalid /procesar response: missing job_id",
          res.status,
          data,
        );
      }

      return data;
    }, retryOpts);
  }

  /**
   * GET /progreso/{id} — fetches progress for the given editor job.
   * Returns the EditorProgress shape.
   */
  async function progreso(editorJobId: string): Promise<EditorProgress> {
    return withRetry(async () => {
      const res = await editorFetch(`/progreso/${encodeURIComponent(editorJobId)}`, {
        method: "GET",
      });

      const data = (await res.json()) as EditorProgress;
      return data;
    }, retryOpts);
  }

  // -------------------------------------------------------------------------
  // Pause read methods — GET the editor's read-only pause payload verbatim
  // -------------------------------------------------------------------------

  async function getJson<T>(path: string): Promise<T> {
    return withRetry(async () => {
      const res = await editorFetch(path, { method: "GET" });
      return (await res.json()) as T;
    }, retryOpts);
  }

  /** GET /silencios/{id} — detected silence segments + preview metadata. */
  async function getSilencios(
    editorJobId: string,
  ): Promise<EditorSilenciosResponse> {
    return getJson<EditorSilenciosResponse>(
      `/silencios/${encodeURIComponent(editorJobId)}`,
    );
  }

  /** GET /subtitulos/{id} — proposed subtitle groups. */
  async function getSubtitulos(
    editorJobId: string,
  ): Promise<EditorSubtitulosResponse> {
    return getJson<EditorSubtitulosResponse>(
      `/subtitulos/${encodeURIComponent(editorJobId)}`,
    );
  }

  /** GET /render/{id} — final groups, preview, and existing extra texts. */
  async function getRender(editorJobId: string): Promise<EditorRenderResponse> {
    return getJson<EditorRenderResponse>(
      `/render/${encodeURIComponent(editorJobId)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Confirmation methods — POST the user's edit; the editor returns 202.
  // Non-2xx is surfaced via EditorPermanentError (4xx) / EditorTransientError
  // (5xx/network) by editorFetch so callers can branch on statusCode.
  // -------------------------------------------------------------------------

  async function postConfirm(path: string, body: unknown): Promise<void> {
    return withRetry(async () => {
      const res = await editorFetch(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res.status !== 202) {
        throw new EditorPermanentError(
          `Expected 202 from ${path}, got ${res.status}`,
          res.status,
        );
      }
    }, retryOpts);
  }

  /** POST /silencios/{id} — forward edited cut segments. */
  async function postSilencios(
    editorJobId: string,
    body: { tramos: EditorTramo[] },
  ): Promise<void> {
    return postConfirm(`/silencios/${encodeURIComponent(editorJobId)}`, body);
  }

  /** POST /subtitulos/{id} — forward edited text-only groups. */
  async function postSubtitulos(
    editorJobId: string,
    body: { grupos: { texto: string }[] },
  ): Promise<void> {
    return postConfirm(`/subtitulos/${encodeURIComponent(editorJobId)}`, body);
  }

  /** POST /render/{id} — trigger the final render with optional extra texts. */
  async function postRender(
    editorJobId: string,
    body: EditorRenderConfirmBody,
  ): Promise<void> {
    return postConfirm(`/render/${encodeURIComponent(editorJobId)}`, body);
  }

  // -------------------------------------------------------------------------
  // Workfile proxy — raw fetch, no JSON parsing, forwards Range for streaming
  // -------------------------------------------------------------------------

  /**
   * GET /workfile/{id}/{name} — raw fetch of an intermediate video for preview.
   *
   * Performs no JSON parsing and no error classification: it forwards the
   * `Range` request header (if provided) and returns the editor `Response`
   * verbatim (status 200/206/404 and headers intact) so the BFF preview route
   * can stream it. Transient network failures throw EditorTransientError.
   */
  async function fetchWorkfile(
    editorJobId: string,
    name: string,
    range?: string,
  ): Promise<Response> {
    const url = `${baseUrl}/workfile/${encodeURIComponent(editorJobId)}/${encodeURIComponent(name)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {};
    if (range) headers["Range"] = range;
    try {
      return await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        headers,
      });
    } catch (err: unknown) {
      if (isTransientNetworkError(err)) {
        throw new EditorTransientError(
          `Network error fetching workfile: ${(err as Error).message ?? err}`,
          err,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** The base URL this client targets (for assertions/tests). */
    baseUrl,
    procesar,
    progreso,
    getSilencios,
    getSubtitulos,
    getRender,
    postSilencios,
    postSubtitulos,
    postRender,
    fetchWorkfile,
  };
}

/** Type of the client returned by createEditorClient. */
export type EditorClient = ReturnType<typeof createEditorClient>;
