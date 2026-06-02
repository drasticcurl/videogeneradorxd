"use client";
/**
 * Pantalla "Pipeline": estado en vivo con DOS vistas:
 *   - Storyboard: frames ordenados (imagenes + clips en orden).
 *   - Flujo: grafo agentico por etapas.
 * Cada imagen/video pide APROBACION. Incluye mini-log y controles pausar/reanudar/cancelar.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { ProjectTabs } from "@/components/ProjectTabs";
import { JobCard } from "@/components/JobCard";
import { FlowGraph } from "@/components/FlowGraph";
import { LogPanel } from "@/components/LogPanel";
import { StatusBadge } from "@/components/StatusBadge";
import type { JobRecord } from "@/lib/types";

type View = "storyboard" | "flow";

export default function PipelinePage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const {
    project,
    jobs,
    logs,
    config,
    defaultResolution,
    loadProject,
    loadConfig,
    refreshJobs,
    approveJob,
    regenerateJob,
    changePromptJob,
    control,
    setClipResolution,
    extendJob,
  } = useProjectStore();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("storyboard");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadConfig();
    loadProject(projectId).catch((e) =>
      setLoadError(e instanceof Error ? e.message : String(e))
    );
    pollRef.current = setInterval(() => {
      refreshJobs(projectId).catch(() => {});
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleGenerateAll() {
    await fetch(`/api/projects/${projectId}/generate`, { method: "POST" });
    await refreshJobs(projectId);
  }

  async function approveBatch() {
    await fetch(`/api/projects/${projectId}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await refreshJobs(projectId);
  }

  const imageModoById = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.assets.forEach((a) =>
      a.images.forEach((img) => m.set(img.id, img.modo))
    );
    return m;
  }, [project]);

  const ordenByClip = useMemo(() => {
    const m = new Map<string, number>();
    project?.plan.clips.forEach((c) => m.set(c.id, c.orden));
    return m;
  }, [project]);

  // Prompt actual por job.refId (image.prompt o clip.video_prompt) para precargar al editar.
  const promptByRef = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.assets.forEach((a) =>
      a.images.forEach((img) => m.set(img.id, img.prompt))
    );
    project?.plan.clips.forEach((c) => m.set(c.id, c.video_prompt));
    return m;
  }, [project]);

  // Dialogo actual por clip.id (para precargar y editar lo que dice la persona).
  const dialogueByRef = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.clips.forEach((c) => m.set(c.id, c.dialogo ?? ""));
    return m;
  }, [project]);

  // Duracion actual por clip.id (para precargar el selector 4/6/8).
  const durationByRef = useMemo(() => {
    const m = new Map<string, number>();
    project?.plan.clips.forEach((c) => m.set(c.id, c.duracion_seg));
    return m;
  }, [project]);

  const imageModels = config?.catalog.image ?? [];
  const videoModels = config?.catalog.video ?? [];
  const projectImageModel = project?.models.image ?? "";
  const projectVideoModel = project?.models.video ?? "";

  const resByClip = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.clips.forEach((c) =>
      m.set(c.id, c.resolucion ?? project.defaultResolution ?? defaultResolution)
    );
    return m;
  }, [project, defaultResolution]);

  const resolutionOptions = config?.resolutions ?? ["720p", "1080p"];

  const groups = useMemo(() => {
    const t2i: JobRecord[] = [];
    const i2i: JobRecord[] = [];
    const vids: JobRecord[] = [];
    for (const j of jobs) {
      if (j.type === "video") vids.push(j);
      else if (imageModoById.get(j.refId) === "image2image") i2i.push(j);
      else t2i.push(j);
    }
    vids.sort(
      (a, b) => (ordenByClip.get(a.refId) ?? 0) - (ordenByClip.get(b.refId) ?? 0)
    );
    return { t2i, i2i, vids };
  }, [jobs, imageModoById, ordenByClip]);

  const progress = useMemo(() => {
    if (jobs.length === 0) return { done: 0, total: 0, pct: 0, awaiting: 0 };
    const done = jobs.filter((j) => j.status === "done").length;
    const awaiting = jobs.filter((j) => j.status === "awaiting_approval").length;
    return { done, total: jobs.length, pct: Math.round((done / jobs.length) * 100), awaiting };
  }, [jobs]);

  const handlers = {
    onApprove: (id: string, index?: number) => void approveJob(id, index),
    onRegenerate: (id: string) => void regenerateJob(id),
    onChangePrompt: (
      id: string,
      payload: {
        prompt?: string;
        dialogue?: string;
        durationSec?: number;
        resolution?: string;
        model?: string;
        regenerate?: boolean;
      }
    ) => void changePromptJob(id, payload),
    onExtend: (id: string) => void extendJob(id),
  };

  // Datos para precargar prompt + selector de modelo en cada tarjeta.
  const imageMeta = {
    promptByRef,
    dialogueByRef,
    durationByRef,
    modelOptions: imageModels,
    projectModel: projectImageModel,
  };
  const videoMeta = {
    promptByRef,
    dialogueByRef,
    durationByRef,
    modelOptions: videoModels,
    projectModel: projectVideoModel,
  };

  // Props extra para videos (selector de resolucion por clip).
  const videoExtra = {
    resByClip,
    resolutionOptions,
    onChangeResolution: (clipId: string, r: string) =>
      void setClipResolution(clipId, r),
  };

  if (loadError) {
    return <p className="rounded bg-red-500/10 p-3 text-red-300">{loadError}</p>;
  }

  return (
    <div className="space-y-5">
      <ProjectTabs projectId={projectId} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{project?.name ?? "Pipeline"}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-400">
            {project && <StatusBadge status={project.status} />}
            <span>
              {progress.done}/{progress.total} aprobados ({progress.pct}%)
            </span>
            {progress.awaiting > 0 && (
              <span className="rounded bg-indigo-500/20 px-2 py-0.5 text-xs text-indigo-300">
                {progress.awaiting} esperando tu aprobacion
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {progress.awaiting > 0 && (
            <button
              onClick={() => void approveBatch()}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
              title="Aprueba todo el lote que esta esperando y deja que se genere el proximo"
            >
              ✓ Aprobar lote ({progress.awaiting})
            </button>
          )}
          <button
            onClick={() => void control("pause")}
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
          >
            ⏸ Pausar
          </button>
          <button
            onClick={() => void control("resume")}
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
          >
            ▶ Reanudar
          </button>
          <button
            onClick={() => void control("cancel")}
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
          >
            ⏹ Cancelar
          </button>
          <button
            onClick={() => void handleGenerateAll()}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Reintentar pendientes
          </button>
        </div>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${progress.pct}%` }}
        />
      </div>

      {/* Toggle de vista */}
      <div className="flex gap-1 rounded-lg border border-slate-800 bg-panel p-1 text-sm">
        <button
          onClick={() => setView("storyboard")}
          className={`rounded-md px-4 py-1.5 ${
            view === "storyboard" ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
          }`}
        >
          🎬 Storyboard
        </button>
        <button
          onClick={() => setView("flow")}
          className={`rounded-md px-4 py-1.5 ${
            view === "flow" ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
          }`}
        >
          🔀 Flujo agentico
        </button>
      </div>

      {view === "flow" && (
        <FlowGraph
          stages={[
            { title: "Imagenes base", jobs: groups.t2i },
            { title: "Imagenes derivadas", jobs: groups.i2i },
            { title: "Videos", jobs: groups.vids },
          ]}
        />
      )}

      {/* Cuerpo */}
      {view === "storyboard" ? (
        <div className="space-y-5">
          <Group title="Imagenes base (text2image)" jobs={groups.t2i} projectId={projectId} handlers={handlers} meta={imageMeta} />
          <Group title="Imagenes derivadas (image2image · misma identidad)" jobs={groups.i2i} projectId={projectId} handlers={handlers} meta={imageMeta} />
          <Filmstrip title="Clips en orden" jobs={groups.vids} projectId={projectId} handlers={handlers} meta={videoMeta} videoExtra={videoExtra} />
        </div>
      ) : (
        <div className="space-y-5">
          <Group title="1 · Imagenes base" jobs={groups.t2i} projectId={projectId} handlers={handlers} meta={imageMeta} />
          <Group title="2 · Imagenes derivadas" jobs={groups.i2i} projectId={projectId} handlers={handlers} meta={imageMeta} />
          <Group title="3 · Videos" jobs={groups.vids} projectId={projectId} handlers={handlers} meta={videoMeta} videoExtra={videoExtra} />
        </div>
      )}

      <LogPanel logs={logs} />
    </div>
  );
}

interface GroupHandlers {
  onApprove: (id: string, index?: number) => void;
  onRegenerate: (id: string) => void;
  onChangePrompt: (
    id: string,
    payload: {
      prompt?: string;
      dialogue?: string;
      durationSec?: number;
      resolution?: string;
      model?: string;
      regenerate?: boolean;
    }
  ) => void;
  onExtend: (id: string) => void;
}

interface JobMeta {
  promptByRef: Map<string, string>;
  dialogueByRef: Map<string, string>;
  durationByRef: Map<string, number>;
  modelOptions: { id: string; label: string }[];
  projectModel: string;
}

interface VideoExtra {
  resByClip: Map<string, string>;
  resolutionOptions: string[];
  onChangeResolution: (clipId: string, r: string) => void;
}

function Group({
  title,
  jobs,
  projectId,
  handlers,
  meta,
  videoExtra,
}: {
  title: string;
  jobs: JobRecord[];
  projectId: string;
  handlers: GroupHandlers;
  meta: JobMeta;
  videoExtra?: VideoExtra;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        {title} <span className="text-slate-600">({jobs.length})</span>
      </h2>
      {jobs.length === 0 ? (
        <p className="text-xs text-slate-600">— sin items —</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {jobs.map((j) => (
            <JobCard
              key={j.id}
              job={j}
              projectId={projectId}
              currentPrompt={meta.promptByRef.get(j.refId) ?? ""}
              currentDialogue={meta.dialogueByRef.get(j.refId) ?? ""}
              currentDuration={meta.durationByRef.get(j.refId)}
              modelOptions={meta.modelOptions}
              projectModel={meta.projectModel}
              {...handlers}
              resolution={videoExtra?.resByClip.get(j.refId)}
              resolutionOptions={videoExtra?.resolutionOptions}
              onChangeResolution={videoExtra?.onChangeResolution}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Filmstrip({
  title,
  jobs,
  projectId,
  handlers,
  meta,
  videoExtra,
}: {
  title: string;
  jobs: JobRecord[];
  projectId: string;
  handlers: GroupHandlers;
  meta: JobMeta;
  videoExtra?: VideoExtra;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        {title} <span className="text-slate-600">({jobs.length})</span>
      </h2>
      {jobs.length === 0 ? (
        <p className="text-xs text-slate-600">— sin items —</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {jobs.map((j, i) => (
            <div key={j.id} className="flex items-center gap-3">
              {i > 0 && <span className="text-slate-600">→</span>}
              <div className="w-56 shrink-0">
                <JobCard
                  job={j}
                  projectId={projectId}
                  currentPrompt={meta.promptByRef.get(j.refId) ?? ""}
                  currentDialogue={meta.dialogueByRef.get(j.refId) ?? ""}
                  currentDuration={meta.durationByRef.get(j.refId)}
                  modelOptions={meta.modelOptions}
                  projectModel={meta.projectModel}
                  {...handlers}
                  resolution={videoExtra?.resByClip.get(j.refId)}
                  resolutionOptions={videoExtra?.resolutionOptions}
                  onChangeResolution={videoExtra?.onChangeResolution}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
