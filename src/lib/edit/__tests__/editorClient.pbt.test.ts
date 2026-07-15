/**
 * Property-based test: Editor Isolation (Property 7).
 *
 * **Validates: Requirements 9.1, 9.2**
 *
 * Property 7: The client targets localhost sidecar URL (no external/public URL, no token).
 * - The client always uses the configured localhost base URL.
 * - Never attaches Authorization or auth-related headers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { createEditorClient } from "../editorClient";
import type { EditorProcesarRequest } from "../types";

describe("Property 7: Editor isolation — localhost sidecar only, no auth", () => {
  /**
   * Property: Every request the client makes targets the configured localhost
   * base URL and never includes Authorization, Cookie, or X-Auth-* headers.
   */
  it("procesar always targets configured base URL with no auth headers", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Arbitrary valid EditorProcesarRequest
        fc.record({
          orden_clips: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
          musica_id: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          ajustes: fc.constant({} as Record<string, unknown>),
        }),
        // Arbitrary localhost base URL (always loopback)
        fc.constantFrom(
          "http://127.0.0.1:8000",
          "http://127.0.0.1:9000",
          "http://localhost:8000",
          "http://localhost:3456",
        ),
        async (req: EditorProcesarRequest, baseUrl: string) => {
          const capturedRequests: { url: string; headers: HeadersInit | undefined; method?: string }[] = [];

          const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            capturedRequests.push({
              url: typeof input === "string" ? input : input.toString(),
              headers: init?.headers,
              method: init?.method,
            });
            return new Response(
              JSON.stringify({ job_id: "test-job-1", estado: "PROCESANDO" }),
              { status: 202, headers: { "Content-Type": "application/json" } },
            );
          });

          const client = createEditorClient({
            baseUrl,
            fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
            retry: { maxAttempts: 1 },
          });

          // Property: baseUrl matches what we configured
          expect(client.baseUrl).toBe(baseUrl);

          await client.procesar(req);

          // Verify all requests went to the expected base URL
          for (const captured of capturedRequests) {
            expect(captured.url).toMatch(new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

            // Verify NO auth-related headers
            const headers = captured.headers as Record<string, string> | undefined;
            if (headers) {
              const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
              expect(headerKeys).not.toContain("authorization");
              expect(headerKeys).not.toContain("cookie");
              expect(headerKeys.filter((k) => k.startsWith("x-auth"))).toHaveLength(0);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("progreso always targets configured base URL with no auth headers", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Arbitrary editor job IDs
        fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !s.includes("/") && !s.includes("\\")),
        fc.constantFrom(
          "http://127.0.0.1:8000",
          "http://localhost:8000",
        ),
        async (jobId: string, baseUrl: string) => {
          const capturedRequests: { url: string; headers: HeadersInit | undefined }[] = [];

          const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            capturedRequests.push({
              url: typeof input === "string" ? input : input.toString(),
              headers: init?.headers,
            });
            return new Response(
              JSON.stringify({ porcentaje: 50, pasoActual: "UNIR", mensaje: "Working", error: null }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          });

          const client = createEditorClient({
            baseUrl,
            fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
            retry: { maxAttempts: 1 },
          });

          await client.progreso(jobId);

          for (const captured of capturedRequests) {
            // Targets localhost base URL
            expect(captured.url).toMatch(new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
            // Includes the job ID in the path
            expect(captured.url).toContain(`/progreso/${encodeURIComponent(jobId)}`);

            // No auth headers
            const headers = captured.headers as Record<string, string> | undefined;
            if (headers) {
              const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
              expect(headerKeys).not.toContain("authorization");
              expect(headerKeys).not.toContain("cookie");
              expect(headerKeys.filter((k) => k.startsWith("x-auth"))).toHaveLength(0);
            }
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
