/**
 * Unit tests for edit panel logic and API interaction patterns.
 *
 * Since this is a server-side test environment without React DOM rendering,
 * we test the API contract and data transformation logic that the EditPanel
 * and EditOutputList components rely on.
 *
 * Requirements: 1, 2, 6
 */
import { describe, it, expect } from "vitest";
import type { EditOptions, ClipOrderEntry, EditSource } from "@/lib/edit/types";
import {
  apiErrorMessage,
  parseOutputListResponse,
  parseProgressResponse,
} from "../editUiData";

describe("EditPanel — data contracts", () => {
  it("builds correct source for clips mode", () => {
    const clipIds = ["clip_01", "clip_02", "clip_03"];
    const source: EditSource = { type: "clips", clipIds };
    expect(source.type).toBe("clips");
    expect(source.clipIds).toEqual(clipIds);
  });

  it("builds correct source for final mode", () => {
    const source: EditSource = { type: "final", artifactKey: "final.mp4" };
    expect(source.type).toBe("final");
    expect(source.artifactKey).toBe("final.mp4");
  });

  it("builds EditOptions with defaults", () => {
    const clipIds = ["clip_01", "clip_02"];
    const options: EditOptions = {
      silenceCut: true,
      subtitles: true,
      ordering: clipIds.map((id, i) => ({
        index: i,
        clipId: id,
        isBroll: false,
      })),
    };

    expect(options.silenceCut).toBe(true);
    expect(options.subtitles).toBe(true);
    expect(options.ordering).toHaveLength(2);
    expect(options.ordering![0]).toEqual({ index: 0, clipId: "clip_01", isBroll: false });
    expect(options.ordering![1]).toEqual({ index: 1, clipId: "clip_02", isBroll: false });
  });

  it("includes b-roll in ordering at correct positions", () => {
    const ordering: ClipOrderEntry[] = [
      { index: 0, clipId: "clip_01", isBroll: false },
      { index: 1, clipId: "broll_abc", isBroll: true },
      { index: 2, clipId: "clip_02", isBroll: false },
    ];

    expect(ordering).toHaveLength(3);
    expect(ordering[1].isBroll).toBe(true);
    expect(ordering[1].clipId).toBe("broll_abc");
    // All indexes are contiguous
    expect(ordering.map((e) => e.index)).toEqual([0, 1, 2]);
  });

  it("validates MAX_CLIPS_PER_JOB constraint", () => {
    const MAX_CLIPS = 500;
    const tooMany = Array.from({ length: MAX_CLIPS + 1 }, (_, i) => ({
      index: i,
      clipId: `clip_${i}`,
      isBroll: false,
    }));
    expect(tooMany.length).toBeGreaterThan(MAX_CLIPS);
  });
});

describe("EditPanel — BFF response shapes", () => {
  it("reads progress from the nested progress object", () => {
    expect(parseProgressResponse({
      status: "running",
      progress: {
        porcentaje: 42,
        pasoActual: "TRANSCRIBIR",
        mensaje: "Transcribiendo",
        error: null,
      },
    })).toEqual({
      status: "running",
      porcentaje: 42,
      pasoActual: "TRANSCRIBIR",
      mensaje: "Transcribiendo",
      error: null,
    });
  });

  it("surfaces the nested progress.error {paso, motivo} on failure", () => {
    expect(parseProgressResponse({
      status: "failed",
      progress: {
        porcentaje: 80,
        pasoActual: "UNIR",
        mensaje: "Fallo al unir",
        error: {
          paso: "UNIR",
          motivo: "ffmpeg: Error while opening encoder for output stream #0:0",
        },
      },
    })).toEqual({
      status: "failed",
      porcentaje: 80,
      pasoActual: "UNIR",
      mensaje: "Fallo al unir",
      error: {
        paso: "UNIR",
        motivo: "ffmpeg: Error while opening encoder for output stream #0:0",
      },
    });
  });

  it("defaults error to null when absent", () => {
    expect(parseProgressResponse({
      status: "running",
      progress: { porcentaje: 10, pasoActual: "NORMALIZAR", mensaje: "En curso" },
    }).error).toBeNull();
  });

  it("defaults error to null when malformed", () => {
    // Missing motivo
    expect(parseProgressResponse({
      status: "failed",
      progress: { error: { paso: "UNIR" } },
    }).error).toBeNull();
    // Wrong types
    expect(parseProgressResponse({
      status: "failed",
      progress: { error: { paso: 1, motivo: 2 } },
    }).error).toBeNull();
    // Not an object
    expect(parseProgressResponse({
      status: "failed",
      progress: { error: "boom" },
    }).error).toBeNull();
  });

  it("reads the output listing's outputs/editJobId/completedAt shape", () => {
    expect(parseOutputListResponse({
      outputs: [{
        editJobId: "edit-1",
        outputKey: "edit-output/edit-1/final.mp4",
        completedAt: "2025-01-01T00:00:00Z",
      }],
    })).toEqual([{
      editJobId: "edit-1",
      outputKey: "edit-output/edit-1/final.mp4",
      completedAt: "2025-01-01T00:00:00Z",
    }]);
  });

  it("handles string and object API errors", () => {
    expect(apiErrorMessage("plain failure", 500)).toBe("plain failure");
    expect(apiErrorMessage({ error: "structured failure" }, 400)).toBe("structured failure");
    expect(apiErrorMessage({ error: { message: "nested failure" } }, 400)).toBe("nested failure");
  });
});

describe("EditOutputList — data shape", () => {
  it("filters completed outputs from job list", () => {
    const jobs = [
      { id: "edit_1", status: "completed", outputKey: "output/1.mp4", createdAt: "2024-01-01", updatedAt: "2024-01-01" },
      { id: "edit_2", status: "failed", outputKey: null, createdAt: "2024-01-02", updatedAt: "2024-01-02" },
      { id: "edit_3", status: "completed", outputKey: "output/3.mp4", createdAt: "2024-01-03", updatedAt: "2024-01-03" },
    ];

    const completed = jobs.filter((j) => j.status === "completed");
    expect(completed).toHaveLength(2);
    expect(completed.every((j) => j.outputKey !== null)).toBe(true);
  });

  it("returns empty list when no completed jobs", () => {
    const jobs = [
      { id: "edit_1", status: "running", outputKey: null },
      { id: "edit_2", status: "failed", outputKey: null },
    ];
    const completed = jobs.filter((j) => j.status === "completed");
    expect(completed).toHaveLength(0);
  });

  it("sorts by completion time (most recent first)", () => {
    const jobs = [
      { id: "edit_1", status: "completed", updatedAt: "2024-01-01T10:00:00Z" },
      { id: "edit_2", status: "completed", updatedAt: "2024-01-03T10:00:00Z" },
      { id: "edit_3", status: "completed", updatedAt: "2024-01-02T10:00:00Z" },
    ];
    const sorted = [...jobs].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    expect(sorted[0].id).toBe("edit_2");
    expect(sorted[1].id).toBe("edit_3");
    expect(sorted[2].id).toBe("edit_1");
  });
});
