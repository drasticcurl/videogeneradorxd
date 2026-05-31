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

  project: ProjectRecord | null;
  jobs: JobRecord[];
  manifest: Manifest | null;
  logs: LogEntry[];

  setBrief: (b: string) => void;
  setModel: (kind: keyof ProjectModels, id: string) => void;
  setImageVariants: (n: number) => void;
  setDefaultResolution: (r: string) => void;
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
  changePromptJob: (jobId: string, prompt: string, model?: string) => Promise<void>;
  control: (action: "pause" | "resume" | "cancel") => Promise<void>;
  setClipResolution: (clipId: string, resolution: string) => Promise<void>;
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

  project: null,
  jobs: [],
  manifest: null,
  logs: [],

  setBrief: (b) => set({ brief: b }),
  setModel: (kind, id) =>
    set((s) => ({ selectedModels: { ...s.selectedModels, [kind]: id } })),
  setImageVariants: (n) => set({ imageVariants: Math.min(4, Math.max(1, n)) }),
  setDefaultResolution: (r) => set({ defaultResolution: r }),

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
    const { brief, selectedModels, imageVariants } = get();
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

  changePromptJob: async (jobId, prompt, model) => {
    await fetch(`/api/jobs/${jobId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, model }),
    });
    const id = get().project?.id;
    if (id) await get().refreshJobs(id);
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
}));
