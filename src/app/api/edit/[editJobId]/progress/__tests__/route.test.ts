import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";
import { __resetDeps, __setDeps } from "../_deps";
import type { EditJob } from "@/lib/edit/types";

function job(): EditJob {
  return {
    id: "edit-1",
    projectId: "project-1",
    source: { type: "clips", clipIds: ["clip-1"] },
    options: { silenceCut: true, subtitles: true },
    status: "running",
    editorJobId: "editor-1",
    progress: { porcentaje: 80, pasoActual: "MUSICA", mensaje: "", error: null },
    outputKey: null,
    error: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

afterEach(() => __resetDeps());

describe("GET edit progress completion", () => {
  it("persists final.mp4 and records outputKey before marking completed", async () => {
    let stored = job();
    const updateEditJob = vi.fn(async (_id: string, patch: Partial<EditJob>) => {
      stored = { ...stored, ...patch };
      return stored;
    });
    const persistOutput = vi.fn(async () => "edit-output/edit-1/final.mp4");
    __setDeps({
      editJobStore: {
        getEditJob: () => stored,
        updateEditJob,
        createEditJob: vi.fn(),
        listEditJobs: vi.fn(),
      },
      createClient: () => ({
        baseUrl: "http://127.0.0.1:8000",
        procesar: vi.fn(),
        progreso: vi.fn(async () => ({
          estado: "completado",
          porcentaje: 100,
          paso_actual: "MUSICA",
          mensaje: "Listo",
          error: null,
        })),
      } as any),
      getStorageAdapter: () => ({
        putInput: vi.fn(),
        toEditorInputReference: vi.fn(),
        getOutputStream: vi.fn(),
        persistOutput,
        signedGetUrl: vi.fn(),
      }),
    });

    const response = await GET(new Request("http://localhost"), {
      params: { editJobId: "edit-1" },
    });

    expect(response.status).toBe(200);
    expect(persistOutput).toHaveBeenCalledWith("edit-1", "final.mp4");
    expect(stored.status).toBe("completed");
    expect(stored.outputKey).toBe("edit-output/edit-1/final.mp4");
  });

  it("marks the job failed when completed output is not retrievable", async () => {
    let stored = job();
    __setDeps({
      editJobStore: {
        getEditJob: () => stored,
        updateEditJob: vi.fn(async (_id: string, patch: Partial<EditJob>) => {
          stored = { ...stored, ...patch };
          return stored;
        }),
        createEditJob: vi.fn(),
        listEditJobs: vi.fn(),
      },
      createClient: () => ({
        baseUrl: "http://127.0.0.1:8000",
        procesar: vi.fn(),
        progreso: vi.fn(async () => ({ estado: "completado", porcentaje: 100 })),
      } as any),
      getStorageAdapter: () => ({
        putInput: vi.fn(),
        toEditorInputReference: vi.fn(),
        getOutputStream: vi.fn(),
        persistOutput: vi.fn(async () => undefined),
        signedGetUrl: vi.fn(),
      }),
    });

    await GET(new Request("http://localhost"), {
      params: { editJobId: "edit-1" },
    });

    expect(stored.status).toBe("failed");
    expect(stored.outputKey).toBeNull();
    expect(stored.error?.paso).toBe("OUTPUT");
  });
});
