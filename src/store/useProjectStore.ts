"use client";
/**
 * Estado global del cliente (Zustand): brief, plan interpretado, estimacion,
 * proyecto actual y jobs en vivo. Llamadas al backend centralizadas aca.
 */
import { create } from "zustand";
import type { ProjectPlan } from "@/lib/schema";
import type { JobRecord, Manifest, ProjectRecord } from "@/lib/types";

export interface CostEstimate {
  imageCount: number;
  videoCount: number;
  realClipCount: number;
  videoSeconds: number;
  estimatedUsd: number;
  breakdown: { imagesUsd: number; videosUsd: number };
  providerMode: string;
  note: string;
}

export interface AppConfig {
  providerMode: string;
  models: Record<string, string>;
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

  project: ProjectRecord | null;
  jobs: JobRecord[];
  manifest: Manifest | null;

  setBrief: (b: string) => void;
  loadConfig: () => Promise<void>;
  parseBrief: () => Promise<void>;
  setPlan: (p: ProjectPlan) => void;
  setEstimate: (e: CostEstimate | null) => void;
  reset: () => void;

  loadProject: (id: string) => Promise<void>;
  refreshJobs: (id: string) => Promise<void>;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data && (data.error as string)) || `Error ${res.status} en ${url}`;
    throw new Error(msg);
  }
  return data as T;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  config: null,
  brief: "",
  plan: null,
  estimate: null,
  parsing: false,
  error: null,

  project: null,
  jobs: [],
  manifest: null,

  setBrief: (b) => set({ brief: b }),

  loadConfig: async () => {
    try {
      const cfg = await jsonFetch<AppConfig>("/api/config");
      set({ config: cfg });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  parseBrief: async () => {
    const { brief } = get();
    set({ parsing: true, error: null });
    try {
      const data = await jsonFetch<{ plan: ProjectPlan; estimate: CostEstimate }>(
        "/api/parse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief }),
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
    });
  },

  refreshJobs: async (id) => {
    const data = await jsonFetch<{
      projectStatus: ProjectRecord["status"];
      jobs: JobRecord[];
      manifest: Manifest;
    }>(`/api/projects/${id}/jobs`);
    const current = get().project;
    set({
      jobs: data.jobs,
      manifest: data.manifest,
      project: current ? { ...current, status: data.projectStatus } : current,
    });
  },
}));
