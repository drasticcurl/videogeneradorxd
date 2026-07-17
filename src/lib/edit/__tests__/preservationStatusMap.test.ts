/**
 * Task 2.3 (Property 2: Preservation) — statusMap and control-mapping baseline.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8**
 *
 * Observation-first baseline (design §"Glossary / statusMap", §"Correctness
 * Properties / Property 2"). These pin the CURRENT estado→status mapping and
 * status→control mapping that the additive, observation-only instrumentation of
 * Task 3 MUST NOT change:
 *
 *  - `mapEditorEstado("esperando_edicion_silencios")` === `awaiting_silences`
 *    (the paused silence-edit state maps to the actionable status that mounts
 *    the timeline).
 *  - An unknown estado maps to `failed` with `{paso:"STATUS_MAPPING"}` (no
 *    silent hang — every estado is actionable).
 *  - `controlForStatus` yields the correct control for every reachable status.
 *
 * EXPECTED OUTCOME on UNFIXED code: PASS.
 */

import { describe, it, expect } from "vitest";
import { mapEditorEstado } from "../statusMap";
import { controlForStatus, type EditControl } from "@/components/edit/editUiData";
import type { EditJobStatus } from "../types";

describe("Task 2.3 — statusMap / control baseline", () => {
  it("esperando_edicion_silencios maps to awaiting_silences (no error)", () => {
    const result = mapEditorEstado("esperando_edicion_silencios");
    expect(result.status).toBe("awaiting_silences");
    expect(result.error).toBeNull();
  });

  it("maps every known estado to its normalized status", () => {
    const expected: Record<string, EditJobStatus> = {
      en_cola: "queued",
      en_ejecucion: "running",
      esperando_edicion_silencios: "awaiting_silences",
      esperando_revision: "awaiting_subtitles",
      esperando_edicion_final: "awaiting_final_render",
      completado: "completed",
      fallido: "failed",
    };
    for (const [estado, status] of Object.entries(expected)) {
      const result = mapEditorEstado(estado);
      expect(result.status).toBe(status);
      expect(result.error).toBeNull();
    }
  });

  it("an unknown estado maps to failed {paso:'STATUS_MAPPING'}", () => {
    const result = mapEditorEstado("estado_que_no_existe");
    expect(result.status).toBe("failed");
    expect(result.error).not.toBeNull();
    expect(result.error!.paso).toBe("STATUS_MAPPING");
    expect(result.error!.motivo).toContain("estado_que_no_existe");
  });

  it("controlForStatus yields the correct control for every reachable status", () => {
    const expected: Record<EditJobStatus, EditControl> = {
      queued: "progress",
      uploading: "progress",
      running: "progress",
      awaiting_silences: "silence",
      awaiting_subtitles: "subtitle",
      awaiting_final_render: "final",
      completed: "download",
      failed: "error",
    };
    for (const [status, control] of Object.entries(expected)) {
      expect(controlForStatus(status)).toBe(control);
    }
  });
});
