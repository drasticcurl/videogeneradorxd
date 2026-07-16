/**
 * Unit tests for validateSegments and the pause-view normalization helpers.
 *
 * Requirements: 8.1, 8.2, 4.3
 */

import { describe, it, expect } from "vitest";
import { validateSegments } from "../validateSegments";
import {
  parseSilencesResponse,
  parseSubtitulosResponse,
  parseRenderResponse,
} from "@/components/edit/editUiData";
import type {
  EditorSilenciosResponse,
  EditorSubtitulosResponse,
  EditorRenderResponse,
} from "../editorClient";

describe("validateSegments", () => {
  it("accepts a valid sorted, non-overlapping, in-bounds list", () => {
    const errs = validateSegments(
      [
        { inicioS: 0, finS: 2 },
        { inicioS: 3, finS: 4 },
        { inicioS: 4, finS: 5 },
      ],
      10,
    );
    expect(errs).toEqual([]);
  });

  it("accepts an empty list", () => {
    expect(validateSegments([], 10)).toEqual([]);
  });

  it("rejects inicioS >= finS", () => {
    const errs = validateSegments([{ inicioS: 5, finS: 5 }], 10);
    expect(errs.some((e) => e.index === 0 && /inicioS < finS/.test(e.reason))).toBe(true);
  });

  it("rejects negative inicioS", () => {
    const errs = validateSegments([{ inicioS: -1, finS: 2 }], 10);
    expect(errs.some((e) => e.index === 0)).toBe(true);
  });

  it("rejects finS beyond duration", () => {
    const errs = validateSegments([{ inicioS: 0, finS: 11 }], 10);
    expect(errs.some((e) => e.reason === "exceeds duration")).toBe(true);
  });

  it("rejects overlapping / unsorted segments", () => {
    const errs = validateSegments(
      [
        { inicioS: 0, finS: 5 },
        { inicioS: 3, finS: 6 },
      ],
      10,
    );
    expect(errs.some((e) => e.index === 1 && /overlaps/.test(e.reason))).toBe(true);
  });

  it("rejects non-finite bounds", () => {
    const errs = validateSegments(
      [{ inicioS: Number.NaN, finS: Number.POSITIVE_INFINITY }],
      10,
    );
    expect(errs.some((e) => /non-numeric/.test(e.reason))).toBe(true);
  });
});

describe("pause-view normalization", () => {
  it("parseSilencesResponse rewrites video_url to a BFF previewUrl and camelCases", () => {
    const editor: EditorSilenciosResponse = {
      job_id: "j",
      estado: "esperando_edicion_silencios",
      editable: true,
      video_url: "http://127.0.0.1:8000/workfile/j/unido.mp4",
      video_nombre: "unido.mp4",
      duracion_s: 12,
      fps: 30,
      ancho: 1080,
      alto: 1920,
      tramos: [{ inicio_s: 1, fin_s: 2 }],
    };
    const view = parseSilencesResponse("edit-1", editor);
    expect(view.previewUrl).toBe("/api/edit/edit-1/preview/unido.mp4");
    expect(view.durationS).toBe(12);
    expect(view.width).toBe(1080);
    expect(view.height).toBe(1920);
    expect(view.segments).toEqual([{ inicioS: 1, finS: 2 }]);
    // No editor-internal URL leaks through.
    expect(JSON.stringify(view)).not.toContain("127.0.0.1");
  });

  it("parseSilencesResponse yields null previewUrl when video_nombre missing", () => {
    const editor = {
      job_id: "j",
      estado: "x",
      editable: false,
      video_url: null,
      video_nombre: null,
      duracion_s: 0,
      fps: 0,
      ancho: 0,
      alto: 0,
      tramos: [],
    } as EditorSilenciosResponse;
    expect(parseSilencesResponse("edit-1", editor).previewUrl).toBeNull();
  });

  it("parseSubtitulosResponse maps groups with camelCase timings", () => {
    const editor: EditorSubtitulosResponse = {
      job_id: "j",
      estado: "esperando_revision",
      editable: true,
      grupos: [{ texto: "hola", inicio_s: 0, fin_s: 1, palabras: null }],
    };
    const view = parseSubtitulosResponse(editor);
    expect(view.groups).toEqual([{ texto: "hola", inicioS: 0, finS: 1 }]);
  });

  it("parseRenderResponse rewrites cortado.mp4 preview and keeps extraTexts", () => {
    const editor: EditorRenderResponse = {
      job_id: "j",
      estado: "esperando_edicion_final",
      editable: true,
      motor_preferido: "remotion",
      grupos: [{ texto: "line", inicio_s: 0, fin_s: 1, palabras: null }],
      video_url: "http://127.0.0.1:8000/workfile/j/cortado.mp4",
      video_nombre: "cortado.mp4",
      fps: 30,
      ancho: 1080,
      alto: 1920,
      duracion_s: null,
      textos_extra: [],
    };
    const view = parseRenderResponse("edit-9", editor);
    expect(view.previewUrl).toBe("/api/edit/edit-9/preview/cortado.mp4");
    expect(view.durationS).toBeNull();
    expect(view.groups).toEqual([{ texto: "line", inicioS: 0, finS: 1 }]);
  });
});
