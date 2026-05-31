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
    loadProject,
    refreshJobs,
    approveJob,
    regenerateJob,
    changePromptJob,
    control,
  } = useProjectStore();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("storyboard");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
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
    onChangePrompt: (id: string, p: string) => void changePromptJob(id, p),
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
          <Group title="Imagenes base (text2image)" jobs={groups.t2i} projectId={projectId} handlers={handlers} />
          <Group title="Imagenes derivadas (image2image · misma identidad)" jobs={groups.i2i} projectId={projectId} handlers={handlers} />
          <Filmstrip title="Clips en orden" jobs={groups.vids} projectId={projectId} handlers={handlers} />
        </div>
      ) : (
        <div className="space-y-5">
          <Group title="1 · Imagenes base" jobs={groups.t2i} projectId={projectId} handlers={handlers} />
          <Group title="2 · Imagenes derivadas" jobs={groups.i2i} projectId={projectId} handlers={handlers} />
          <Group title="3 · Videos" jobs={groups.vids} projectId={projectId} handlers={handlers} />
        </div>
      )}

      <LogPanel logs={logs} />
    </div>
  );
}

interface GroupHandlers {
  onApprove: (id: string, index?: number) => void;
  onRegenerate: (id: string) => void;
  onChangePrompt: (id: string, p: string) => void;
}

function Group({
  title,
  jobs,
  projectId,
  handlers,
}: {
  title: string;
  jobs: JobRecord[];
  projectId: string;
  handlers: GroupHandlers;
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
            <JobCard key={j.id} job={j} projectId={projectId} {...handlers} />
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
}: {
  title: string;
  jobs: JobRecord[];
  projectId: string;
  handlers: GroupHandlers;
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
                <JobCard job={j} projectId={projectId} {...handlers} />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
