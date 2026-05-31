"use client";
/**
 * Pantalla "Pipeline": estado en vivo de los jobs (imagen -> imagen -> video),
 * con previews, reintentar/regenerar y barra de progreso. Hace polling cada 2s.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { ProjectTabs } from "@/components/ProjectTabs";
import { JobCard } from "@/components/JobCard";
import { StatusBadge } from "@/components/StatusBadge";
import type { JobRecord } from "@/lib/types";

export default function PipelinePage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const { project, jobs, loadProject, refreshJobs } = useProjectStore();
  const [loadError, setLoadError] = useState<string | null>(null);
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

  async function handleRetry(jobId: string) {
    await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
    await refreshJobs(projectId);
  }

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

  const groups = useMemo(() => {
    const t2i: JobRecord[] = [];
    const i2i: JobRecord[] = [];
    const vids: JobRecord[] = [];
    for (const j of jobs) {
      if (j.type === "video") vids.push(j);
      else if (imageModoById.get(j.refId) === "image2image") i2i.push(j);
      else t2i.push(j);
    }
    vids.sort((a, b) => a.label.localeCompare(b.label));
    return { t2i, i2i, vids };
  }, [jobs, imageModoById]);

  const progress = useMemo(() => {
    if (jobs.length === 0) return { done: 0, total: 0, pct: 0 };
    const done = jobs.filter((j) => j.status === "done").length;
    return { done, total: jobs.length, pct: Math.round((done / jobs.length) * 100) };
  }, [jobs]);

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
              {progress.done}/{progress.total} jobs listos ({progress.pct}%)
            </span>
          </div>
        </div>
        <button
          onClick={() => void handleGenerateAll()}
          className="rounded-lg border border-slate-600 px-4 py-2 text-sm hover:bg-slate-800"
        >
          Reanudar / reintentar pendientes
        </button>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${progress.pct}%` }}
        />
      </div>

      <Group
        title="1 · Imagenes base (text2image)"
        jobs={groups.t2i}
        projectId={projectId}
        onRetry={handleRetry}
      />
      <Group
        title="2 · Imagenes derivadas (image2image · misma identidad)"
        jobs={groups.i2i}
        projectId={projectId}
        onRetry={handleRetry}
      />
      <Group
        title="3 · Videos (Veo · imagen → video)"
        jobs={groups.vids}
        projectId={projectId}
        onRetry={handleRetry}
      />
    </div>
  );
}

function Group({
  title,
  jobs,
  projectId,
  onRetry,
}: {
  title: string;
  jobs: JobRecord[];
  projectId: string;
  onRetry: (id: string) => void;
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
            <JobCard key={j.id} job={j} projectId={projectId} onRetry={onRetry} />
          ))}
        </div>
      )}
    </section>
  );
}
