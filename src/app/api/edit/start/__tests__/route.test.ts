/**
 * Integration tests for POST /api/edit/start route.
 *
 * Mocks the editor client and storage adapter to test the route logic
 * in isolation. Asserts:
 *   - 202 + persisted EditJob for "final" and "clips" sources.
 *   - orden_clips ordering forwarded exactly.
 *   - Failure paths: bad music format, editor 400, upload failure.
 *
 * Requirements: 1.1, 1.7, 2.5, 2.6, 11.1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POST } from "../route";
import { __setDeps, __resetDeps } from "../_deps";
import type { StartRouteDeps } from "../_deps";
import type { EditJob, EditorProcesarRequest } from "@/lib/edit/types";
import { EditorPermanentError } from "@/lib/edit/retry";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function jsonRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/edit/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<StartRouteDeps>) {
  const storedJobs = new Map<string, EditJob>();

  const editJobStore = {
    createEditJob: vi.fn(async (job: EditJob) => {
      storedJobs.set(job.id, { ...job });
      return job;
    }),
    getEditJob: vi.fn((id: string) => storedJobs.get(id)),
    updateEditJob: vi.fn(async (id: string, patch: Partial<EditJob>) => {
      const existing = storedJobs.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      storedJobs.set(id, updated);
      return updated;
    }),
    listEditJobs: vi.fn((_projectId: string) => {
      return [...storedJobs.values()];
    }),
  };

  const putInputKeys: string[] = [];
  const mockAdapter = {
    putInput: vi.fn(async (_editJobId: string, relKey: string, _data: Uint8Array) => {
      const key = `edit-io/test/inputs/${relKey}`;
      putInputKeys.push(key);
      return key;
    }),
    toEditorInputReference: vi.fn(async (_editJobId: string, storedKey: string) => storedKey.split("/inputs/")[1]),
    getOutputStream: vi.fn(),
    persistOutput: vi.fn(),
    signedGetUrl: vi.fn(),
  };

  const mockClient = {
    baseUrl: "http://127.0.0.1:8000",
    procesar: vi.fn(async (_request: EditorProcesarRequest) => ({
      job_id: "editor-job-123",
      estado: "en_cola",
    })),
    progreso: vi.fn(),
  };

  const mockBrollBank = {
    getClipPath: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    upload: vi.fn(),
    resolve: vi.fn(),
    validateUpload: vi.fn(() => null),
  };

  const deps: StartRouteDeps = {
    editJobStore,
    createClient: () => mockClient as any,
    getStorageAdapter: () => mockAdapter as any,
    getBrollBank: () => mockBrollBank as any,
    startMonitor: vi.fn(),
    ...overrides,
  };

  return { deps, editJobStore, mockAdapter, mockClient, mockBrollBank, storedJobs, putInputKeys };
}

// ---------------------------------------------------------------------------
// Mock filesystem reads — resolveSource uses fs.existsSync and the jobs db
// ---------------------------------------------------------------------------

// We need to mock resolveSource and friends since they depend on the filesystem.
// We'll mock the entire resolveInputs module.
vi.mock("@/lib/edit/resolveInputs", () => ({
  resolveSource: vi.fn((_projectId: string, source: any) => {
    if (source.type === "final") {
      return {
        inputs: [
          { id: source.artifactKey, absPath: `/tmp/test/${source.artifactKey}`, isBroll: false },
        ],
      };
    }
    // clips source
    const inputs = source.clipIds.map((id: string) => ({
      id,
      absPath: `/tmp/test/clips/${id}.mp4`,
      isBroll: false,
    }));
    return { inputs };
  }),
  resolveDefaultSource: vi.fn((_projectId: string) => ({
    inputs: [
      { id: "clip-1", absPath: "/tmp/test/clips/clip-1.mp4", isBroll: false },
      { id: "clip-2", absPath: "/tmp/test/clips/clip-2.mp4", isBroll: false },
    ],
  })),
  mergeOrdering: vi.fn(async (_generatedInputs: any, ordering: any, _bank: any) => {
    // Sort by index and return
    const sorted = [...ordering].sort((a: any, b: any) => a.index - b.index);
    const ordenClips = sorted.map((e: any) => ({
      id: e.clipId,
      absPath: `/tmp/test/clips/${e.clipId}.mp4`,
      isBroll: e.isBroll,
    }));
    return { ordenClips };
  }),
  buildDefaultOrdering: vi.fn((inputs: any) =>
    inputs.map((inp: any, i: number) => ({ index: i, clipId: inp.id, isBroll: false }))
  ),
}));

// Mock fs/promises readFile to return fake data
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async () => Buffer.from("fake-video-data")),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    access: vi.fn(async () => {}),
  },
  readFile: vi.fn(async () => Buffer.from("fake-video-data")),
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  access: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/edit/start", () => {
  beforeEach(() => {
    __resetDeps();
  });

  afterEach(() => {
    __resetDeps();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path: clips source → 202
  // -------------------------------------------------------------------------

  it("returns 202 with editJobId for clips source", async () => {
    const { deps, editJobStore, mockClient, storedJobs } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "clips", clipIds: ["clip-1", "clip-2"] },
        options: { silenceCut: true, subtitles: true },
      })
    );

    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json.editJobId).toBeDefined();
    expect(typeof json.editJobId).toBe("string");

    // Verify job was created and updated to running
    expect(editJobStore.createEditJob).toHaveBeenCalledTimes(1);
    expect(mockClient.procesar).toHaveBeenCalledTimes(1);

    // FastAPI receives the generator namespace plus relative filenames only.
    const procesarCall = mockClient.procesar.mock.calls[0][0];
    expect(procesarCall.edit_job_id).toBe(json.editJobId);
    expect(procesarCall.orden_clips).toEqual([
      "clip-0001-clip-1.mp4",
      "clip-0002-clip-2.mp4",
    ]);

    // Job should be in running state
    const stored = storedJobs.get(json.editJobId);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("running");
    expect(stored!.editorJobId).toBe("editor-job-123");
  });

  // -------------------------------------------------------------------------
  // Happy path: final source → 202
  // -------------------------------------------------------------------------

  it("returns 202 with editJobId for final source", async () => {
    const { deps, mockClient } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "final", artifactKey: "final.mp4" },
        options: { silenceCut: false, subtitles: true },
      })
    );

    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json.editJobId).toBeDefined();
    expect(mockClient.procesar).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Default source (no source provided) → uses resolveDefaultSource
  // -------------------------------------------------------------------------

  it("uses default source (clips) when no source is specified", async () => {
    const { deps, mockClient } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        options: { silenceCut: true, subtitles: false },
      })
    );

    expect(response.status).toBe(202);
    const json = await response.json();
    expect(json.editJobId).toBeDefined();
    expect(mockClient.procesar).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Ordering forwarded exactly (Req 1.7)
  // -------------------------------------------------------------------------

  it("forwards orden_clips in the exact user-specified order", async () => {
    const { deps, mockClient, putInputKeys } = createMockDeps();
    __setDeps(deps);

    const ordering = [
      { index: 0, clipId: "clip-b", isBroll: false },
      { index: 1, clipId: "clip-a", isBroll: false },
      { index: 2, clipId: "clip-c", isBroll: false },
    ];

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "clips", clipIds: ["clip-a", "clip-b", "clip-c"] },
        options: { silenceCut: true, subtitles: true, ordering },
      })
    );

    expect(response.status).toBe(202);

    // The procesar call should have orden_clips matching the upload order
    const procesarCall = mockClient.procesar.mock.calls[0][0];
    expect(procesarCall.orden_clips).toEqual([
      "clip-0001-clip-b.mp4",
      "clip-0002-clip-a.mp4",
      "clip-0003-clip-c.mp4",
    ]);
    expect(procesarCall.orden_clips.every((key: string) => !key.startsWith("edit-io/"))).toBe(true);
  });

  it("assigns deterministic unique names when input basenames collide", async () => {
    const { deps, mockClient, mockAdapter } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "clips", clipIds: ["same", "same"] },
        options: { silenceCut: true, subtitles: true },
      })
    );

    expect(response.status).toBe(202);
    expect(mockAdapter.putInput.mock.calls.map((call: any[]) => call[1])).toEqual([
      "clip-0001-same.mp4",
      "clip-0002-same.mp4",
    ]);
    expect(mockClient.procesar.mock.calls[0][0].orden_clips).toEqual([
      "clip-0001-same.mp4",
      "clip-0002-same.mp4",
    ]);
  });

  // -------------------------------------------------------------------------
  // Failure: bad music format → 400 (Req 2.5)
  // -------------------------------------------------------------------------

  it("rejects unsupported music format with 400", async () => {
    const { deps, mockClient } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "clips", clipIds: ["clip-1"] },
        options: { silenceCut: true, subtitles: false },
        music: {
          data: Buffer.from("fake").toString("base64"),
          mimeType: "video/mp4", // not a supported audio type
          fileName: "track.mp4",
        },
      })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("Unsupported music format");
    // Editor should NOT have been called
    expect(mockClient.procesar).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Failure: editor 400 → failed job (Req 2.6)
  // -------------------------------------------------------------------------

  it("sets job to failed and returns 400 when editor rejects with 400", async () => {
    const { deps, mockClient, storedJobs } = createMockDeps();

    // Make editor reject with a permanent error
    mockClient.procesar.mockRejectedValueOnce(
      new EditorPermanentError("Invalid ajustes: silencios.umbral_db", 400, "campos_invalidos: silencios.umbral_db")
    );

    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "clips", clipIds: ["clip-1"] },
        options: { silenceCut: true, subtitles: true },
      })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Editor rejected the request");
    expect(json.details).toContain("silencios.umbral_db");
    expect(json.editJobId).toBeDefined();

    // Job should be failed
    const stored = storedJobs.get(json.editJobId);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("failed");
    expect(stored!.error).toBeDefined();
    expect(stored!.error!.paso).toBe("PROCESAR");
    // Options should be retained on the job
    expect(stored!.options).toEqual({ silenceCut: true, subtitles: true });
  });

  // -------------------------------------------------------------------------
  // Failure: upload failure → 500 (Req 11.1)
  // -------------------------------------------------------------------------

  it("sets job to failed and returns 500 when input upload fails", async () => {
    const { deps, mockClient, storedJobs, mockAdapter } = createMockDeps();

    // Make the adapter's putInput fail on the second call
    mockAdapter.putInput
      .mockResolvedValueOnce("edit-io/test/clip-1.mp4")
      .mockRejectedValueOnce(new Error("Disk full"));

    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "clips", clipIds: ["clip-1", "clip-2"] },
        options: { silenceCut: true, subtitles: false },
      })
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toContain("Input upload failed");
    expect(json.error).toContain("Disk full");
    expect(json.editJobId).toBeDefined();

    // Editor should NOT have been called
    expect(mockClient.procesar).not.toHaveBeenCalled();

    // Job should be failed
    const stored = storedJobs.get(json.editJobId);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("failed");
    expect(stored!.error!.paso).toBe("UPLOAD");
  });

  // -------------------------------------------------------------------------
  // Validation: missing projectId → 400
  // -------------------------------------------------------------------------

  it("returns 400 for missing projectId", async () => {
    const { deps } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        options: { silenceCut: true, subtitles: false },
      })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("projectId");
  });

  // -------------------------------------------------------------------------
  // Validation: missing options → 400
  // -------------------------------------------------------------------------

  it("returns 400 for missing options", async () => {
    const { deps } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
      })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("options");
  });

  // -------------------------------------------------------------------------
  // Validation: invalid JSON → 400
  // -------------------------------------------------------------------------

  it("returns 400 for invalid JSON body", async () => {
    const { deps } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      new Request("http://localhost/api/edit/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      })
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("Invalid JSON");
  });

  // -------------------------------------------------------------------------
  // Happy path with music → music key forwarded to editor
  // -------------------------------------------------------------------------

  it("accepts M4A when the browser reports a common or generic MIME", async () => {
    const { deps, mockClient } = createMockDeps();
    __setDeps(deps);

    for (const mimeType of [
      "audio/mp4",
      "audio/m4a",
      "audio/x-m4a",
      "application/x-m4a",
      "application/octet-stream",
      "",
    ]) {
      const response = await POST(
        jsonRequest({
          projectId: "proj-1",
          source: { type: "clips", clipIds: ["clip-1"] },
          options: { silenceCut: true, subtitles: false },
          music: {
            data: Buffer.from("fake-m4a").toString("base64"),
            mimeType,
            fileName: "song.m4a",
          },
        })
      );
      expect(response.status).toBe(202);
    }
    expect(mockClient.procesar).toHaveBeenCalledTimes(6);
  });

  it("marks the job failed with UPLOAD when the music write fails", async () => {
    const { deps, mockAdapter, mockClient, storedJobs } = createMockDeps();
    mockAdapter.putInput
      .mockResolvedValueOnce("edit-io/test/inputs/clip.mp4")
      .mockRejectedValueOnce(new Error("music disk full"));
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "clips", clipIds: ["clip-1"] },
        options: { silenceCut: true, subtitles: false },
        music: {
          data: Buffer.from("fake-audio").toString("base64"),
          mimeType: "audio/mpeg",
          fileName: "song.mp3",
        },
      })
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain("Music upload failed");
    expect(mockClient.procesar).not.toHaveBeenCalled();
    expect(storedJobs.get(body.editJobId)?.status).toBe("failed");
    expect(storedJobs.get(body.editJobId)?.error?.paso).toBe("UPLOAD");
  });

  it("uploads music and includes musica_id in procesar request", async () => {
    const { deps, mockClient, mockAdapter } = createMockDeps();
    __setDeps(deps);

    const response = await POST(
      jsonRequest({
        projectId: "proj-1",
        source: { type: "clips", clipIds: ["clip-1"] },
        options: { silenceCut: true, subtitles: false, musicTrackId: "track-1" },
        music: {
          data: Buffer.from("fake-audio").toString("base64"),
          mimeType: "audio/mpeg",
          fileName: "song.mp3",
        },
      })
    );

    expect(response.status).toBe(202);

    // Verify music was uploaded (adapter.putInput called for music too)
    const putInputCalls = mockAdapter.putInput.mock.calls;
    // At least one call should be for the music file
    const musicCall = putInputCalls.find((c: any[]) => c[1] === "music-song.mp3");
    expect(musicCall).toBeDefined();

    // Verify musica_id is in the procesar request
    const procesarCall = mockClient.procesar.mock.calls[0][0];
    expect(procesarCall.musica_id).toBe("music-song.mp3");
    expect(procesarCall.musica_id).not.toContain("edit-io/");
  });
});
