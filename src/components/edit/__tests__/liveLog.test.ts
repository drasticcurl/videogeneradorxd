/**
 * Task 3.2 — Visual live log for the user.
 *
 * These tests pin the *additive* behavior that lets the user see exactly which
 * step/substep is active even while the percentage stays at 25%, and that a
 * failed state surfaces {paso, subpaso, motivo} plus a recommended action. The
 * sandbox test environment has no DOM renderer, so — like editComponents.test.ts
 * — they exercise the pure helpers the EditProgress component renders from
 * (parsing, dedupe keyed on the meaningful tuple, line formatting, correlation
 * surfacing, and the recommended-action mapping).
 *
 * Everything here is tolerant: when the backend does not emit subpaso/estado/
 * correlation (the current reality — that arrives in tasks 3.4/3.5), the helpers
 * degrade cleanly to the legacy behavior, so the Task 2 baselines are untouched.
 *
 * Requirements: 2.2, 2.7, 3.8
 */

import { describe, it, expect } from "vitest";
import {
  appendProgressLog,
  formatCorrelationSuffix,
  formatProgressLogLine,
  parseProgressResponse,
  recommendedActionForError,
  type ProgressLogEntry,
} from "../editUiData";

const logEntry = (over: Partial<ProgressLogEntry> = {}): ProgressLogEntry => ({
  time: "15:04:05",
  porcentaje: 25,
  pasoActual: "UNIR",
  mensaje: "",
  status: "running",
  ...over,
});

describe("live log — substep changes at a constant percentage", () => {
  it("appends distinct log lines when only the substep changes at 25%", () => {
    // Three distinct substeps that all report percentage 25 — the exact opaque
    // boundary from the bug: UNIR-done → detection-started → pause-reached.
    const a = logEntry({ subpaso: "Clips unidos", status: "running" });
    const b = logEntry({ subpaso: "Detectando silencios", status: "running" });
    const c = logEntry({
      subpaso: "Esperando edición de silencios",
      status: "awaiting_silences",
      estado: "esperando_edicion_silencios",
    });

    let log: ProgressLogEntry[] = [];
    log = appendProgressLog(log, a);
    log = appendProgressLog(log, b);
    log = appendProgressLog(log, c);

    // All three retained even though the percentage never changed.
    expect(log).toHaveLength(3);
    expect(log.every((e) => e.porcentaje === 25)).toBe(true);

    // And they render as visibly distinct lines.
    const lines = log.map(formatProgressLogLine);
    expect(new Set(lines).size).toBe(3);
    expect(lines[0]).toContain("Clips unidos");
    expect(lines[1]).toContain("Detectando silencios");
    expect(lines[2]).toContain("Esperando edición de silencios");
  });

  it("still dedupes truly identical states (substep unchanged)", () => {
    const a = logEntry({ subpaso: "Detectando silencios", time: "15:04:05" });
    const dupe = logEntry({ subpaso: "Detectando silencios", time: "15:04:07" });
    expect(appendProgressLog([a], dupe)).toHaveLength(1);
    expect(appendProgressLog([a], dupe)[0]).toBe(a);
  });

  it("appends a new line when only the estado changes at the same %/substep", () => {
    const a = logEntry({ subpaso: "Detectando silencios", estado: "en_ejecucion" });
    const b = logEntry({ subpaso: "Detectando silencios", estado: "esperando_edicion_silencios" });
    expect(appendProgressLog([a], b)).toHaveLength(2);
  });

  it("formats substep next to the step and stays legacy-compatible without it", () => {
    expect(formatProgressLogLine(logEntry({ subpaso: "Detectando silencios", mensaje: "Analizando audio" }))).toBe(
      "[15:04:05] 25% UNIR › Detectando silencios — Analizando audio · running",
    );
    // No substep/correlation → identical to the legacy line.
    expect(formatProgressLogLine(logEntry({ mensaje: "Uniendo y normalizando clips a 9:16" }))).toBe(
      "[15:04:05] 25% UNIR — Uniendo y normalizando clips a 9:16 · running",
    );
  });
});

describe("live log — failed state surfaces {paso, subpaso, motivo} + action", () => {
  it("parses a failure carrying the substep and yields a recommended action", () => {
    const view = parseProgressResponse({
      status: "failed",
      progress: {
        porcentaje: 25,
        pasoActual: "UNIR",
        subpaso: "Normalizando clip 2/3",
        mensaje: "Fallo al normalizar",
        error: {
          paso: "UNIR",
          subpaso: "Normalizando clip 2/3",
          motivo: "ffmpeg: timeout",
        },
      },
    });

    expect(view.error).toEqual({
      paso: "UNIR",
      subpaso: "Normalizando clip 2/3",
      motivo: "ffmpeg: timeout",
    });
    expect(view.subpaso).toBe("Normalizando clip 2/3");

    const action = recommendedActionForError(view.error);
    expect(action.length).toBeGreaterThan(0);
    expect(action.toLowerCase()).toContain("ffmpeg");
  });

  it("gives a targeted action for the lost-editor-job (category C) failure", () => {
    expect(recommendedActionForError({ paso: "EDITOR_STATE_LOST", motivo: "404" }))
      .toContain("editor");
    expect(recommendedActionForError({ paso: "STATUS_MAPPING", motivo: "unknown" }))
      .toContain("estado");
    expect(recommendedActionForError(null)).toBe("");
  });

  it("keeps a failure legacy-compatible when no substep is present", () => {
    const view = parseProgressResponse({
      status: "failed",
      progress: {
        porcentaje: 80,
        pasoActual: "UNIR",
        mensaje: "Fallo al unir",
        error: { paso: "UNIR", motivo: "boom" },
      },
    });
    // No `subpaso` key added → identical to the pre-3.2 shape.
    expect(view.error).toEqual({ paso: "UNIR", motivo: "boom" });
  });
});

describe("live log — correlation identifiers appear when provided", () => {
  it("parses correlation from top-level and nested progress fields", () => {
    const view = parseProgressResponse({
      status: "running",
      editJobId: "edit-1",
      version: "v0.9124 mango xD",
      progress: {
        porcentaje: 25,
        pasoActual: "CORTAR_SILENCIOS",
        subpaso: "Detectando silencios",
        mensaje: "Analizando",
        estado: "en_ejecucion",
        editorJobId: "job-9",
        revision: "editor-abc123",
      },
    });

    expect(view.correlation).toEqual({
      version: "v0.9124 mango xD",
      revision: "editor-abc123",
      editJobId: "edit-1",
      editorJobId: "job-9",
    });
    expect(view.estado).toBe("en_ejecucion");
  });

  it("renders correlation as a compact suffix on the log line", () => {
    const line = formatProgressLogLine(
      logEntry({
        subpaso: "Detectando silencios",
        correlation: { revision: "editor-abc123", editorJobId: "job-9" },
      }),
    );
    expect(line).toContain("rev=editor-abc123");
    expect(line).toContain("editor=job-9");
  });

  it("omits correlation entirely when none is present (legacy line)", () => {
    expect(formatCorrelationSuffix(undefined)).toBe("");
    expect(formatCorrelationSuffix({})).toBe("");
    const view = parseProgressResponse({
      status: "running",
      progress: { porcentaje: 10, pasoActual: "NORMALIZAR", mensaje: "En curso" },
    });
    expect(view.correlation).toBeUndefined();
  });

  it("never carries video content through the parsed view", () => {
    const view = parseProgressResponse({
      status: "running",
      progress: {
        porcentaje: 25,
        pasoActual: "UNIR",
        mensaje: "Uniendo",
        // Fields like these must never be surfaced by the parser.
        video_url: "http://loopback/internal/video.mp4",
        video_bytes: "AAAA",
      },
    });
    expect(JSON.stringify(view)).not.toContain("video");
    expect(JSON.stringify(view)).not.toContain("loopback");
  });
});
