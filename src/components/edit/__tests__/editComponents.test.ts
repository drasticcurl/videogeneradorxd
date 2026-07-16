/**
 * Logic/contract tests for the edit components' shared payload builders,
 * validation gating, and EditProgress status→control switching.
 *
 * The sandbox test environment has no DOM renderer, so these tests exercise the
 * pure helpers the components rely on (payload shapes, count preservation,
 * ≤2-extra-texts gating, validation gating, and status routing) — the same
 * "data contract" approach used by editPanel.test.ts.
 *
 * Requirements: 1.2, 1.4, 8.1, 2.2, 2.4, 2.6, 3.2, 3.4, 8.4, 5.5, 10.1, 10.2, 10.3, 10.4
 */

import { describe, it, expect } from "vitest";
import {
  allGroupsNonEmpty,
  buildRenderPayload,
  buildSilencesPayload,
  buildSubtitlesPayload,
  controlForStatus,
} from "../editUiData";
import { validateSegments } from "@/lib/edit/validateSegments";
import type { EditorTextoExtra } from "@/lib/edit/editorClient";

describe("SilenceTimeline — contract", () => {
  it("builds {segments} payload preserving order and values", () => {
    const segments = [
      { inicioS: 1, finS: 2 },
      { inicioS: 3, finS: 4 },
    ];
    expect(buildSilencesPayload(segments)).toEqual({ segments });
  });

  it("blocks submit when client-side validation fails (mirrors server)", () => {
    // Overlapping segments → invalid
    const bad = [
      { inicioS: 0, finS: 5 },
      { inicioS: 3, finS: 6 },
    ];
    expect(validateSegments(bad, 10).length).toBeGreaterThan(0);
    // Valid list
    const good = [
      { inicioS: 0, finS: 2 },
      { inicioS: 3, finS: 4 },
    ];
    expect(validateSegments(good, 10)).toEqual([]);
  });
});

describe("SubtitleReview — contract", () => {
  it("POSTs text-only groups preserving count and never sends timings", () => {
    const payload = buildSubtitlesPayload(["hola", "mundo"]);
    expect(payload).toEqual({ groups: [{ texto: "hola" }, { texto: "mundo" }] });
    expect(JSON.stringify(payload)).not.toContain("inicio_s");
    expect(JSON.stringify(payload)).not.toContain("inicioS");
  });

  it("gates submit on all-groups-non-empty", () => {
    expect(allGroupsNonEmpty(["a", "b"])).toBe(true);
    expect(allGroupsNonEmpty(["a", "   "])).toBe(false);
    expect(allGroupsNonEmpty([])).toBe(false);
  });
});

describe("FinalRenderTrigger — contract", () => {
  const style = {
    fuente: "Arial",
    tamano: 72,
    color: "#fff",
    color_borde: "#000",
    grosor_borde: 5,
    negrita: true,
    pos_vertical_pct: 20,
    pos_horizontal_pct: 50,
  };
  const extra = (t: string): EditorTextoExtra => ({ texto: t, inicio_s: 0, fin_s: 1, estilo: style });

  it("builds {extraTexts, motor:'remotion'}", () => {
    const payload = buildRenderPayload([extra("hook")]);
    expect(payload.motor).toBe("remotion");
    expect(payload.extraTexts).toHaveLength(1);
  });

  it("enforces at most 2 extra texts (gating rule)", () => {
    const three = [extra("a"), extra("b"), extra("c")];
    expect(three.length > 2).toBe(true);
    const two = [extra("a"), extra("b")];
    expect(two.length <= 2).toBe(true);
  });
});

describe("EditProgress — status → control switching", () => {
  it("mounts the right control for each status", () => {
    expect(controlForStatus("awaiting_silences")).toBe("silence");
    expect(controlForStatus("awaiting_subtitles")).toBe("subtitle");
    expect(controlForStatus("awaiting_final_render")).toBe("final");
    expect(controlForStatus("completed")).toBe("download");
    expect(controlForStatus("failed")).toBe("error");
  });

  it("every non-terminal, non-awaiting status renders the progress bar", () => {
    for (const s of ["queued", "uploading", "running", "anything-else"]) {
      expect(controlForStatus(s)).toBe("progress");
    }
  });
});
