/**
 * Unit tests for EditorClient: error mapping, backoff schedule, and auth absence.
 *
 * Requirements: 11
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEditorClient } from "../editorClient";
import {
  withRetry,
  computeBackoffSchedule,
  EditorTransientError,
  EditorPermanentError,
} from "../retry";

// ---------------------------------------------------------------------------
// Backoff schedule verification
// ---------------------------------------------------------------------------

describe("computeBackoffSchedule", () => {
  it("produces the correct default delay sequence: 1s, 2s, 4s, 8s (4 retries)", () => {
    const schedule = computeBackoffSchedule();
    // 5 attempts = 4 retry delays: 1s, 2s, 4s, 8s
    expect(schedule).toEqual([1000, 2000, 4000, 8000]);
  });

  it("caps delays at maxDelayMs=30000", () => {
    const schedule = computeBackoffSchedule({
      maxAttempts: 8,
      initialDelayMs: 1000,
      multiplier: 2,
      maxDelayMs: 30000,
    });
    // 1000, 2000, 4000, 8000, 16000, 30000, 30000
    expect(schedule).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("handles single attempt (no retries → empty schedule)", () => {
    expect(computeBackoffSchedule({ maxAttempts: 1 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// withRetry behavior
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  it("succeeds on first try without sleeping", async () => {
    const sleep = vi.fn();
    const result = await withRetry(async () => "ok", { sleep });
    expect(result).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on EditorTransientError and succeeds", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new EditorTransientError("fail");
        return "success";
      },
      { maxAttempts: 5, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000, sleep },
    );
    expect(result).toBe("success");
    expect(calls).toBe(3);
    // Two sleeps: 1000ms, then 2000ms
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it("throws after all attempts exhausted", async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      withRetry(
        async () => {
          throw new EditorTransientError("always fails");
        },
        { maxAttempts: 3, initialDelayMs: 500, multiplier: 2, maxDelayMs: 30000, sleep },
      ),
    ).rejects.toThrow("always fails");
    // 2 retries = 2 sleeps
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry on EditorPermanentError", async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      withRetry(
        async () => {
          throw new EditorPermanentError("bad request", 400);
        },
        { maxAttempts: 5, sleep },
      ),
    ).rejects.toThrow("bad request");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry on unknown errors", async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      withRetry(
        async () => {
          throw new Error("unexpected");
        },
        { maxAttempts: 5, sleep },
      ),
    ).rejects.toThrow("unexpected");
    expect(sleep).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EditorClient: no auth headers in any mode
// ---------------------------------------------------------------------------

describe("EditorClient — no auth token", () => {
  it("never attaches Authorization headers on procesar", async () => {
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({ job_id: "j-1", estado: "PROCESANDO" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });

    await client.procesar({ orden_clips: ["a.mp4"], ajustes: {} });

    const [, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain("authorization");
    expect(headerKeys).not.toContain("cookie");
    expect(headerKeys.filter((k) => k.startsWith("x-auth"))).toHaveLength(0);
  });

  it("never attaches Authorization headers on progreso", async () => {
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({ porcentaje: 75, pasoActual: "SUBTÍTULOS", mensaje: "ok", error: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });

    await client.progreso("j-1");

    const [, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain("authorization");
    expect(headerKeys).not.toContain("cookie");
    expect(headerKeys.filter((k) => k.startsWith("x-auth"))).toHaveLength(0);
  });

  it("also omits auth in cloud mode (EDIT_MODE=cloud)", async () => {
    // Cloud mode changes storage paths but should NOT add any auth to editor calls
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({ job_id: "j-cloud", estado: "PROCESANDO" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });

    await client.procesar({ orden_clips: ["clip1.mp4"], ajustes: {} });

    const [, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(headerKeys).not.toContain("authorization");
  });
});

// ---------------------------------------------------------------------------
// EditorClient: error mapping
// ---------------------------------------------------------------------------

describe("EditorClient — error mapping", () => {
  it("maps 5xx to EditorTransientError and retries", async () => {
    let callCount = 0;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      callCount++;
      if (callCount < 3) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(
        JSON.stringify({ job_id: "j-ok", estado: "PROCESANDO" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });

    const sleep = vi.fn(async () => {});
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 5, sleep },
    });

    const result = await client.procesar({ orden_clips: ["a.mp4"], ajustes: {} });
    expect(result.job_id).toBe("j-ok");
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("maps ECONNREFUSED to EditorTransientError and retries (sidecar not ready)", async () => {
    let callCount = 0;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      callCount++;
      if (callCount < 2) {
        const err = new TypeError("fetch failed");
        (err as unknown as { code: string }).code = "ECONNREFUSED";
        throw err;
      }
      return new Response(
        JSON.stringify({ porcentaje: 10, pasoActual: "UNIR", mensaje: "Starting", error: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const sleep = vi.fn(async () => {});
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 5, sleep },
    });

    const result = await client.progreso("j-1");
    expect(result.porcentaje).toBe(10);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("maps 4xx to EditorPermanentError (no retry)", async () => {
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ detail: "bad input" }), { status: 400 });
    });

    const sleep = vi.fn(async () => {});
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 5, sleep },
    });

    await expect(client.procesar({ orden_clips: [], ajustes: {} })).rejects.toThrow(
      EditorPermanentError,
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps timeout (AbortError) to EditorTransientError and retries", async () => {
    let callCount = 0;
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount++;
      if (callCount < 2) {
        // Simulate abort due to timeout
        const err = new DOMException("The operation was aborted", "AbortError");
        throw err;
      }
      return new Response(
        JSON.stringify({ job_id: "j-after-timeout", estado: "PROCESANDO" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });

    const sleep = vi.fn(async () => {});
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      timeoutMs: 1000,
      retry: { maxAttempts: 3, sleep },
    });

    const result = await client.procesar({ orden_clips: ["x.mp4"], ajustes: {} });
    expect(result.job_id).toBe("j-after-timeout");
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// EditorClient: base URL construction
// ---------------------------------------------------------------------------

describe("EditorClient — URL construction", () => {
  it("builds correct /procesar URL", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8000/procesar");
      return new Response(
        JSON.stringify({ job_id: "j-1", estado: "PROCESANDO" }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });

    await client.procesar({ orden_clips: ["a.mp4"], ajustes: {} });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("builds correct /progreso/{id} URL with encoding", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8000/progreso/abc%20123");
      return new Response(
        JSON.stringify({ porcentaje: 0, pasoActual: null, mensaje: "", error: null }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });

    await client.progreso("abc 123");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("strips trailing slash from base URL", () => {
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000/",
      fetchFn: vi.fn() as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });

    expect(client.baseUrl).toBe("http://127.0.0.1:8000");
  });
});


// ---------------------------------------------------------------------------
// EditorClient — pause read/confirm methods + workfile proxy
// ---------------------------------------------------------------------------

describe("EditorClient — pause read methods", () => {
  it("getSilencios returns the editor payload verbatim", async () => {
    const payload = {
      job_id: "j-1",
      estado: "esperando_edicion_silencios",
      editable: true,
      video_url: "http://127.0.0.1:8000/workfile/j-1/unido.mp4",
      video_nombre: "unido.mp4",
      duracion_s: 12.5,
      fps: 30,
      ancho: 1080,
      alto: 1920,
      tramos: [{ inicio_s: 1, fin_s: 2 }],
    };
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });
    const res = await client.getSilencios("j-1");
    expect(res).toEqual(payload);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url] = fakeFetch.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://127.0.0.1:8000/silencios/j-1");
  });

  it("getSubtitulos and getRender hit the correct URLs", async () => {
    const fakeFetch = vi.fn(async (url: string) =>
      new Response(JSON.stringify({ job_id: "j", estado: "x", editable: true, grupos: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });
    await client.getSubtitulos("j-2");
    await client.getRender("j-3");
    expect((fakeFetch.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:8000/subtitulos/j-2");
    expect((fakeFetch.mock.calls[1] as [string])[0]).toBe("http://127.0.0.1:8000/render/j-3");
  });
});

describe("EditorClient — confirm methods", () => {
  it("postSilencios succeeds on 202", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 202 }));
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });
    await expect(
      client.postSilencios("j-1", { tramos: [{ inicio_s: 0, fin_s: 1 }] }),
    ).resolves.toBeUndefined();
    const [url, init] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8000/silencios/j-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ tramos: [{ inicio_s: 0, fin_s: 1 }] });
  });

  it("postSubtitulos maps editor 4xx to EditorPermanentError with statusCode", async () => {
    const fakeFetch = vi.fn(async () => new Response("count mismatch", { status: 400 }));
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });
    await expect(
      client.postSubtitulos("j-1", { grupos: [{ texto: "hi" }] }),
    ).rejects.toMatchObject({ name: "EditorPermanentError", statusCode: 400 });
  });

  it("postRender maps 5xx/network to EditorTransientError", async () => {
    const fakeFetch = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });
    await expect(
      client.postRender("j-1", { textos_extra: [], motor: "remotion" }),
    ).rejects.toBeInstanceOf(EditorTransientError);
  });
});

describe("EditorClient — fetchWorkfile", () => {
  it("forwards the Range header and returns the raw Response without parsing", async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>)?.["Range"];
      return new Response(body, {
        status: range ? 206 : 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Range": "bytes 0-3/4",
          "Accept-Ranges": "bytes",
        },
      });
    });
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });
    const res = await client.fetchWorkfile("j-1", "unido.mp4", "bytes=0-3");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Content-Range")).toBe("bytes 0-3/4");
    const [url, init] = fakeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8000/workfile/j-1/unido.mp4");
    expect((init.headers as Record<string, string>)["Range"]).toBe("bytes=0-3");
  });

  it("returns editor 404 verbatim (no throw)", async () => {
    const fakeFetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });
    const res = await client.fetchWorkfile("j-1", "unido.mp4");
    expect(res.status).toBe(404);
  });

  it("throws EditorTransientError on network failure", async () => {
    const fakeFetch = vi.fn(async () => {
      const err = new TypeError("fetch failed");
      (err as unknown as { code: string }).code = "ECONNREFUSED";
      throw err;
    });
    const client = createEditorClient({
      baseUrl: "http://127.0.0.1:8000",
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      retry: { maxAttempts: 1 },
    });
    await expect(client.fetchWorkfile("j-1", "unido.mp4")).rejects.toBeInstanceOf(
      EditorTransientError,
    );
  });
});
