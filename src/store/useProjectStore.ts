"use client";
/**
 * Estado global del cliente (Zustand): config/modelos, brief, plan, estimacion,
 * proyecto actual, jobs y logs en vivo. Llamadas al backend centralizadas aca.
 */
import { create } from "zustand";
import type { ProjectPlan } from "@/lib/schema";
import type {
  JobRecord,
  LogEntry,
  Manifest,
  ProjectModels,
  ProjectRecord,
} from "@/lib/types";

export interface CostEstimate {
  imageCount: number;
  baseImages: number;
  imageVariants: number;
  videoCount: number;
  realClipCount: number;
  videoSeconds: number;
  estimatedUsd: number;
  breakdown: { imagesUsd: number; videosUsd: number };
  providerMode: string;
  note: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

/**
 * Avatar/foto de referencia que el usuario sube ANTES de generar (VSL).
 * Se guarda en memoria del cliente (dataUrl para preview) hasta que se crea el
 * proyecto; ahi se suben los bytes al backend (/references) y se mapean por id.
 */
export interface ReferenceDraft {
  /** id estable interno para React keys (no cambia aunque edites el id de la foto) */
  uid: string;
  id: string;
  label: string;
  fileName: string;
  mimeType: string;
  /** data URL (base64) para previsualizar y para reconstruir el blob al subir */
  dataUrl: string;
}

export interface AppConfig {
  providerMode: string;
  catalog: { llm: ModelOption[]; image: ModelOption[]; video: ModelOption[] };
  defaults: ProjectModels;
  defaultImageVariants: number;
  resolutions: string[];
  defaultResolution: string;
  location: string;
  project: string | null;
  outputDir: string;
  dataDir: string;
  ffmpeg: boolean;
}

interface ProjectState {
  config: AppConfig | null;
  brief: string;
  plan: ProjectPlan | null;
  estimate: CostEstimate | null;
  parsing: boolean;
  error: string | null;

  selectedModels: ProjectModels;
  imageVariants: number;
  defaultResolution: string;

  /** avatares/fotos de referencia subidos por el usuario (VSL), aun en el cliente */
  references: ReferenceDraft[];

  project: ProjectRecord | null;
  jobs: JobRecord[];
  manifest: Manifest | null;
  logs: LogEntry[];

  setBrief: (b: string) => void;
  setModel: (kind: keyof ProjectModels, id: string) => void;
  setImageVariants: (n: number) => void;
  setDefaultResolution: (r: string) => void;

  // avatares de referencia (VSL)
  addReferenceFile: (file: File) => Promise<void>;
  updateReference: (
    uid: string,
    patch: Partial<Pick<ReferenceDraft, "id" | "label">>
  ) => void;
  removeReference: (uid: string) => void;
  uploadReferences: (projectId: string) => Promise<void>;

  loadConfig: () => Promise<void>;
  parseBrief: () => Promise<void>;
  setPlanFromJson: (raw: unknown) => void;
  setPlan: (p: ProjectPlan) => void;
  setEstimate: (e: CostEstimate | null) => void;
  reset: () => void;

  loadProject: (id: string) => Promise<void>;
  refreshJobs: (id: string) => Promise<void>;

  // acciones de pipeline
  approveJob: (jobId: string, index?: number) => Promise<void>;
  regenerateJob: (jobId: string) => Promise<void>;
  regenerateMany: (jobIds: string[]) => Promise<void>;
  changePromptJob: (
    jobId: string,
    payload: {
      prompt?: string;
      dialogue?: string;
      durationSec?: number;
      resolution?: string;
      model?: string;
      regenerate?: boolean;
    }
  ) => Promise<void>;
  control: (action: "pause" | "resume" | "cancel") => Promise<void>;
  setClipResolution: (clipId: string, resolution: string) => Promise<void>;
  extendJob: (jobId: string) => Promise<void>;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.error as string)) || `Error ${res.status} en ${url}`;
    throw new Error(msg);
  }
  return data as T;
}

/** Slug simple del lado del cliente (debe coincidir con storage.slugify del backend). */
function clientSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "avatar"
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(meta)?.[1] ?? "image/png";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

const FALLBACK_MODELS: ProjectModels = {
  llm: "gemini-2.5-flash",
  image: "gemini-2.5-flash-image",
  video: "veo-3.1-generate-001",
};

export const useProjectStore = create<ProjectState>((set, get) => ({
  config: null,
  brief: "",
  plan: null,
  estimate: null,
  parsing: false,
  error: null,

  selectedModels: { ...FALLBACK_MODELS },
  imageVariants: 1,
  defaultResolution: "720p",

  references: [],

  project: null,
  jobs: [],
  manifest: null,
  logs: [],

  setBrief: (b) => set({ brief: b }),
  setModel: (kind, id) =>
    set((s) => ({ selectedModels: { ...s.selectedModels, [kind]: id } })),
  setImageVariants: (n) => set({ imageVariants: Math.min(4, Math.max(1, n)) }),
  setDefaultResolution: (r) => set({ defaultResolution: r }),

  addReferenceFile: async (file) => {
    const dataUrl = await readFileAsDataUrl(file);
    set((s) => {
      const base = clientSlug(file.name.replace(/\.[^.]+$/, ""));
      // aseguramos id unico entre los drafts existentes
      let id = base;
      let n = 2;
      while (s.references.some((r) => r.id === id)) id = `${base}_${n++}`;
      const uid =
        (globalThis.crypto?.randomUUID?.() as string | undefined) ??
        `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const draft: ReferenceDraft = {
        uid,
        id,
        label: file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name,
        mimeType: file.type || "image/png",
        dataUrl,
      };
      return { references: [...s.references, draft] };
    });
  },

  updateReference: (uid, patch) =>
    set((s) => ({
      references: s.references.map((r) =>
        r.uid === uid
          ? {
              ...r,
              ...patch,
              id: patch.id !== undefined ? clientSlug(patch.id) : r.id,
            }
          : r
      ),
    })),

  removeReference: (uid) =>
    set((s) => ({ references: s.references.filter((r) => r.uid !== uid) })),

  uploadReferences: async (projectId) => {
    const { references } = get();
    for (const ref of references) {
      const form = new FormData();
      form.append("referenceId", ref.id);
      if (ref.label) form.append("label", ref.label);
      form.append("file", dataUrlToBlob(ref.dataUrl), ref.fileName || `${ref.id}.png`);
      const res = await fetch(`/api/projects/${projectId}/references`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data && (data.error as string)) ||
            `No se pudo subir el avatar de referencia "${ref.id}"`
        );
      }
    }
  },

  loadConfig: async () => {
    try {
      const cfg = await jsonFetch<AppConfig>("/api/config");
      set({
        config: cfg,
        selectedModels: { ...cfg.defaults },
        imageVariants: cfg.defaultImageVariants,
        defaultResolution: cfg.defaultResolution,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  parseBrief: async () => {
    const { brief, selectedModels, imageVariants, references } = get();
    set({ parsing: true, error: null });
    try {
      const data = await jsonFetch<{ plan: ProjectPlan; estimate: CostEstimate }>(
        "/api/parse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brief,
            model: selectedModels.llm,
            imageVariants,
            references: references.map((r) => ({ id: r.id, label: r.label })),
          }),
        }
      );
      set({ plan: data.plan, estimate: data.estimate, parsing: false });
    } catch (err) {
      set({
        parsing: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setPlanFromJson: (raw) => {
    try {
      const plan = typeof raw === "string" ? JSON.parse(raw) : raw;
      set({ plan: plan as ProjectPlan, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "JSON invalido" });
    }
  },

  setPlan: (p) => set({ plan: p }),
  setEstimate: (e) => set({ estimate: e }),

  reset: () =>
    set({
      brief: "",
      plan: null,
      estimate: null,
      error: null,
      references: [],
      project: null,
      jobs: [],
      manifest: null,
      logs: [],
    }),

  loadProject: async (id) => {
    const data = await jsonFetch<{
      project: ProjectRecord;
      jobs: JobRecord[];
      manifest: Manifest;
      estimate: CostEstimate;
    }>(`/api/projects/${id}`);
    set({
      project: data.project,
      jobs: data.jobs,
      manifest: data.manifest,
      estimate: data.estimate,
      plan: data.project.plan,
      selectedModels: data.project.models,
      imageVariants: data.project.imageVariants,
      defaultResolution: data.project.defaultResolution ?? "720p",
    });
  },

  refreshJobs: async (id) => {
    const data = await jsonFetch<{
      projectStatus: ProjectRecord["status"];
      jobs: JobRecord[];
      manifest: Manifest;
      logs: LogEntry[];
    }>(`/api/projects/${id}/jobs`);
    const current = get().project;
    set({
      jobs: data.jobs,
      manifest: data.manifest,
      logs: data.logs ?? [],
      project: current ? { ...current, status: data.projectStatus } : current,
    });
  },

  approveJob: async (jobId, index) => {
    await fetch(`/api/jobs/${jobId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    });
    const id = get().project?.id;
    if (id) await get().refreshJobs(id);
  },

  regenerateJob: async (jobId) => {
    await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    const id = get().project?.id;
    if (id) await get().refreshJobs(id);
  },

  regenerateMany: async (jobIds) => {
    const id = get().project?.id;
    if (!id || jobIds.length === 0) return;
    await fetch(`/api/projects/${id}/regenerate-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobIds }),
    });
    await get().refreshJobs(id);
  },

  changePromptJob: async (jobId, payload) => {
    await fetch(`/api/jobs/${jobId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const id = get().project?.id;
    // loadProject refresca tambien el plan, para que los valores editados
    // (prompt/dialogo/tiempo) queden persistidos en la UI aunque no se regenere.
    if (id) await get().loadProject(id);
  },

  control: async (action) => {
    const id = get().project?.id;
    if (!id) return;
    await fetch(`/api/projects/${id}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await get().refreshJobs(id);
  },

  setClipResolution: async (clipId, resolution) => {
    const { project, plan } = get();
    if (!project || !plan) return;
    // Actualizamos la resolucion del clip en el plan y persistimos via PUT.
    const newPlan: ProjectPlan = {
      ...plan,
      clips: plan.clips.map((c) =>
        c.id === clipId ? { ...c, resolucion: resolution as "720p" | "1080p" } : c
      ),
    };
    set({ plan: newPlan });
    await fetch(`/api/projects/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: newPlan }),
    });
    await get().loadProject(project.id);
  },

  extendJob: async (jobId) => {
    await fetch(`/api/jobs/${jobId}/extend`, { method: "POST" });
    const id = get().project?.id;
    if (id) await get().refreshJobs(id);
  },
}));
