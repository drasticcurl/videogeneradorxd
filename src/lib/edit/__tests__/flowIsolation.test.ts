/**
 * Task 2.2 (Property 2: Preservation) — the silence/edit flow and the separate
 * "+7 seconds" clip-extension flow stay decoupled in BOTH directions.
 *
 * **Validates: Requirements 3.4, 3.7**
 *
 * Observation-first baseline (design §"Preservation Requirements / Flow
 * isolation"). The diagnostic-first instrumentation of Task 3 threads a
 * correlation tuple through the edit flow only; these assertions pin that the
 * two flows share **no triggers, states, or wiring**:
 *
 *  - The edit flow (`src/lib/edit/*`, silence/subtitle/final-render pauses)
 *    never references the +7s extension flow (`extendVideoJob`,
 *    `EXTEND_DURATION`, the `/extend` route trigger).
 *  - The +7s extension flow (`src/lib/jobs/pipeline/edit.ts`) never references
 *    the edit-flow vocabulary (edit job store, estado→status mapping,
 *    reconciler, `awaiting_silences` / `esperando_edicion_silencios`).
 *  - The +7s duration constant is a self-contained value unrelated to any edit
 *    status, and the normalized edit-status domain has no "extend" trigger.
 *
 * EXPECTED OUTCOME on UNFIXED code: PASS.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { EXTEND_DURATION } from "@/lib/config";
import { mapEditorEstado } from "../statusMap";
import { controlForStatus } from "@/components/edit/editUiData";

const REPO_ROOT = process.cwd();
const EDIT_FLOW_DIR = path.join(REPO_ROOT, "src", "lib", "edit");
const EXTEND_FLOW_FILE = path.join(REPO_ROOT, "src", "lib", "jobs", "pipeline", "edit.ts");

// Tokens that belong exclusively to the +7s extension flow.
const EXTEND_FLOW_TOKENS = ["extendVideoJob", "EXTEND_DURATION", "VideoExtendInput"];

// Tokens that belong exclusively to the silence/edit flow.
const EDIT_FLOW_TOKENS = [
  "editJobStore",
  "mapEditorEstado",
  "reconcileEditJob",
  "awaiting_silences",
  "esperando_edicion_silencios",
  "EditJobStatus",
];

function readEditFlowSources(): { file: string; text: string }[] {
  return readdirSync(EDIT_FLOW_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))
    .map((name) => ({
      file: name,
      text: readFileSync(path.join(EDIT_FLOW_DIR, name), "utf8"),
    }));
}

describe("Flow isolation — edit flow vs +7s extension flow", () => {
  it("no edit-flow module references the +7s extension flow", () => {
    const sources = readEditFlowSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const { file, text } of sources) {
      for (const token of EXTEND_FLOW_TOKENS) {
        expect(
          text.includes(token),
          `edit-flow module ${file} unexpectedly references +7s token "${token}"`,
        ).toBe(false);
      }
    }
  });

  it("the +7s extension flow never references the edit-flow vocabulary", () => {
    const text = readFileSync(EXTEND_FLOW_FILE, "utf8");
    for (const token of EDIT_FLOW_TOKENS) {
      expect(
        text.includes(token),
        `+7s flow (edit.ts) unexpectedly references edit-flow token "${token}"`,
      ).toBe(false);
    }
  });

  it("the +7s duration is a self-contained constant (7s), independent of edit statuses", () => {
    expect(EXTEND_DURATION).toBe(7);
  });

  it("no reachable edit status maps to an 'extend'/+7s control or trigger", () => {
    const estados = [
      "en_cola",
      "en_ejecucion",
      "esperando_edicion_silencios",
      "esperando_revision",
      "esperando_edicion_final",
      "completado",
      "fallido",
    ];
    for (const estado of estados) {
      const { status } = mapEditorEstado(estado);
      const control = controlForStatus(status);
      expect(["silence", "subtitle", "final", "download", "error", "progress"]).toContain(control);
      // The edit-flow control vocabulary has no extension trigger.
      expect(control).not.toContain("extend");
    }
  });
});
