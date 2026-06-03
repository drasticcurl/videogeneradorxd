"use client";
/**
 * Pantalla "Pipeline": estado en vivo con TRES vistas:
 *   - Storyboard: frames ordenados (imagenes + clips en orden).
 *   - Revisar / Arreglar: vista liviana para marcar clips malos y regenerarlos.
 *   - Flujo: grafo agentico por etapas.
 * Incluye mini-log y controles pausar/reanudar/cancelar.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { ProjectTabs } from "@/components/ProjectTabs";
import { JobCard } from "@/components/JobCard";
import { FlowGraph } from "@/components/FlowGraph";
import { LogPanel } from "@/components/LogPanel";
import { StatusBadge } from "@/components/StatusBadge";
import type { JobRecord } from "@/lib/types";

type View = "storyboard" | "flow" | "fix";

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
    regenerateMany,
  } = useProjectStore();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [manualView, setManualView] = useState<View | null>(null);
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

  // Vista efectiva: si el usuario eligio una, se respeta; si no, con muchos clips
  // arrancamos en la vista liviana "fix" (no monta 95 <video> -> no lagea la PC).
  const view: View = manualView ?? (groups.vids.length > 24 ? "fix" : "storyboard");

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
      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-panel p-1 text-sm">
        <button
          onClick={() => setManualView("storyboard")}
          className={`rounded-md px-4 py-1.5 ${
            view === "storyboard" ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
          }`}
        >
          🎬 Storyboard
        </button>
        <button
          onClick={() => setManualView("fix")}
          className={`rounded-md px-4 py-1.5 ${
            view === "fix" ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
          }`}
          title="Vista liviana (sin cargar todos los videos): marcá los que están mal y regeneralos"
        >
          🔧 Revisar / Arreglar
        </button>
        <button
          onClick={() => setManualView("flow")}
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
      {view === "fix" ? (
        <FixView
          jobs={groups.vids}
          projectId={projectId}
          ordenByClip={ordenByClip}
          dialogueByRef={dialogueByRef}
          onRegenerateMany={(ids) => void regenerateMany(ids)}
          onRegenerate={(id) => void regenerateJob(id)}
        />
      ) : view === "storyboard" ? (
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


/* ----------------------- Vista "Revisar / Arreglar" ---------------------- */
/**
 * Vista LIVIANA: lista compacta de clips (NO carga todos los <video> -> no lagea).
 * Marcás los que estan mal (o pegás sus numeros) y "Revisar seleccionados" abre un
 * storyboard SOLO con esos, mostrando: imagen de entrada + prompt EXACTO + JSON entero.
 * El video de cada fila se carga ON-DEMAND al tocar "Ver".
 */
function FixView({
  jobs,
  projectId,
  ordenByClip,
  dialogueByRef,
  onRegenerateMany,
  onRegenerate,
}: {
  jobs: JobRecord[];
  projectId: string;
  ordenByClip: Map<string, number>;
  dialogueByRef: Map<string, string>;
  onRegenerateMany: (jobIds: string[]) => void;
  onRegenerate: (jobId: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [numbersText, setNumbersText] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const rows = useMemo(
    () =>
      [...jobs].sort(
        (a, b) => (ordenByClip.get(a.refId) ?? 0) - (ordenByClip.get(b.refId) ?? 0)
      ),
    [jobs, ordenByClip]
  );

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  function selectByNumbers() {
    const nums = new Set(
      numbersText
        .split(/[^0-9]+/)
        .filter(Boolean)
        .map((n) => Number(n))
    );
    if (nums.size === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const j of rows) {
        const o = ordenByClip.get(j.refId);
        if (o != null && nums.has(o)) next.add(j.id);
      }
      return next;
    });
  }

  const sel = selected.size;
  const selectedJobs = rows.filter((j) => selected.has(j.id));

  // Storyboard de revision: solo los seleccionados, con prompt + imagen input + JSON.
  if (reviewing && selectedJobs.length > 0) {
    return (
      <ReviewStoryboard
        jobs={selectedJobs}
        projectId={projectId}
        ordenByClip={ordenByClip}
        onRegenerate={onRegenerate}
        onRegenerateAll={(ids) => onRegenerateMany(ids)}
        onClose={() => setReviewing(false)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-800 bg-panel p-3">
        <div className="min-w-[220px] flex-1">
          <label className="mb-1 block text-xs text-slate-400">
            Pegá los números de los clips malos (ej: 12, 45, 78)
          </label>
          <div className="flex gap-2">
            <input
              value={numbersText}
              onChange={(e) => setNumbersText(e.target.value)}
              placeholder="12, 45, 78…"
              className="flex-1 rounded border border-slate-700 bg-ink px-2 py-1.5 text-sm focus:border-accent focus:outline-none"
            />
            <button
              onClick={selectByNumbers}
              className="rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
            >
              Marcar
            </button>
          </div>
        </div>
        <button
          onClick={() =>
            setSelected(
              new Set(rows.filter((j) => j.status === "failed").map((j) => j.id))
            )
          }
          className="rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Marcar fallidos
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          Limpiar
        </button>
        <button
          onClick={() => setReviewing(true)}
          disabled={sel === 0}
          className="ml-auto rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          🔍 Revisar seleccionados ({sel})
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="w-10 px-2 py-2"></th>
              <th className="w-12 px-2 py-2">#</th>
              <th className="px-2 py-2">Clip</th>
              <th className="w-28 px-2 py-2">Estado</th>
              <th className="px-2 py-2">Diálogo</th>
              <th className="w-24 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => (
              <FixRow
                key={j.id}
                job={j}
                orden={ordenByClip.get(j.refId) ?? 0}
                dialogo={dialogueByRef.get(j.refId) ?? ""}
                selected={selected.has(j.id)}
                expanded={expanded.has(j.id)}
                projectId={projectId}
                onToggleSel={() => setSelected((s) => toggle(s, j.id))}
                onToggleExp={() => setExpanded((s) => toggle(s, j.id))}
                onRegenerate={() => onRegenerate(j.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Tip: tocá <b>Ver</b> para cargar solo ese video (los demás no se cargan, por eso no
        lagea). Marcá los malos y <b>Revisar seleccionados</b> abre un storyboard solo con esos
        (con el prompt exacto + imagen de entrada + JSON) para revisarlos y regenerarlos.
      </p>
    </div>
  );
}

function statusPill(status: JobRecord["status"]): { txt: string; cls: string } {
  switch (status) {
    case "done":
      return { txt: "aprobado", cls: "bg-emerald-500/15 text-emerald-300" };
    case "generating":
      return { txt: "generando…", cls: "bg-indigo-500/15 text-indigo-300" };
    case "awaiting_approval":
      return { txt: "esperando", cls: "bg-amber-500/15 text-amber-300" };
    case "failed":
      return { txt: "falló", cls: "bg-red-500/15 text-red-300" };
    case "pending":
      return { txt: "en cola", cls: "bg-slate-500/15 text-slate-300" };
    default:
      return { txt: status, cls: "bg-slate-500/15 text-slate-300" };
  }
}

function FixRow({
  job,
  orden,
  dialogo,
  selected,
  expanded,
  projectId,
  onToggleSel,
  onToggleExp,
  onRegenerate,
}: {
  job: JobRecord;
  orden: number;
  dialogo: string;
  selected: boolean;
  expanded: boolean;
  projectId: string;
  onToggleSel: () => void;
  onToggleExp: () => void;
  onRegenerate: () => void;
}) {
  const pill = statusPill(job.status);
  const ver = encodeURIComponent(job.updatedAt ?? "");
  const videoUrl = job.outputPath
    ? `/api/files/${projectId}/${job.outputPath}?v=${ver}`
    : null;
  return (
    <>
      <tr className={`border-t border-slate-800 ${selected ? "bg-emerald-500/5" : ""}`}>
        <td className="px-2 py-2 align-top">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSel}
            className="h-4 w-4"
          />
        </td>
        <td className="px-2 py-2 align-top font-mono text-slate-400">{orden}</td>
        <td className="px-2 py-2 align-top">
          <div className="font-medium text-slate-200">{job.label}</div>
          {job.error && <div className="text-[11px] text-red-300">{job.error}</div>}
        </td>
        <td className="px-2 py-2 align-top">
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${pill.cls}`}>{pill.txt}</span>
        </td>
        <td className="px-2 py-2 align-top text-xs text-slate-400">{dialogo}</td>
        <td className="px-2 py-2 align-top">
          <div className="flex gap-1">
            <button
              onClick={onToggleExp}
              className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-800"
            >
              {expanded ? "Ocultar" : "Ver"}
            </button>
            <button
              onClick={onRegenerate}
              title="Regenerar solo este clip"
              className="rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-800"
            >
              ↻
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-ink/40">
          <td></td>
          <td colSpan={5} className="px-2 pb-3">
            {videoUrl ? (
              <video
                key={videoUrl}
                src={videoUrl}
                controls
                preload="none"
                className="max-h-[60vh] w-auto rounded border border-slate-700"
              />
            ) : (
              <span className="text-xs text-slate-500">
                {job.status === "generating" ? "generando…" : "(sin video todavía)"}
              </span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/* --------------------- Storyboard de revisión (focalizado) --------------------- */

interface PreviewData {
  type: "image" | "video";
  label: string;
  status: JobRecord["status"];
  model?: string;
  durationSec?: number;
  resolution?: string;
  modo?: string;
  executedPrompt: string;
  json: unknown;
  updatedAt?: string;
  outputPath?: string | null;
  inputImage?: { id: string; file: string | null; status: string; json: unknown };
  refs?: { id: string; kind: string; file: string | null }[];
}

function ReviewStoryboard({
  jobs,
  projectId,
  ordenByClip,
  onRegenerate,
  onRegenerateAll,
  onClose,
}: {
  jobs: JobRecord[];
  projectId: string;
  ordenByClip: Map<string, number>;
  onRegenerate: (id: string) => void;
  onRegenerateAll: (ids: string[]) => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-panel p-3">
        <button
          onClick={onClose}
          className="rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800"
        >
          ← Volver a la lista
        </button>
        <span className="text-sm text-slate-400">{jobs.length} clip(s) para revisar</span>
        <button
          onClick={() => onRegenerateAll(jobs.map((j) => j.id))}
          className="ml-auto rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500"
        >
          ↻ Regenerar todos ({jobs.length})
        </button>
      </div>
      <div className="space-y-4">
        {jobs.map((j) => (
          <ReviewCard
            key={j.id}
            job={j}
            projectId={projectId}
            orden={ordenByClip.get(j.refId) ?? 0}
            onRegenerate={() => onRegenerate(j.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ReviewCard({
  job,
  projectId,
  orden,
  onRegenerate,
}: {
  job: JobRecord;
  projectId: string;
  orden: number;
  onRegenerate: () => void;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    fetch(`/api/jobs/${job.id}/preview`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setData(d as PreviewData);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [job.id, job.updatedAt]);

  const ver = encodeURIComponent(job.updatedAt ?? "");
  const fileUrl = (p: string) => `/api/files/${projectId}/${p}?v=${ver}`;
  const inputImg = data?.inputImage?.file ?? null;
  const outUrl = job.outputPath ? fileUrl(job.outputPath) : null;
  const pill = statusPill(job.status);

  function copyPrompt() {
    if (data?.executedPrompt) {
      navigator.clipboard?.writeText(data.executedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-slate-400">#{orden}</span>
        <span className="font-semibold text-slate-100">{job.label}</span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${pill.cls}`}>{pill.txt}</span>
        {data?.model && <span className="text-[11px] text-slate-500">{data.model}</span>}
        {data?.type === "video" && data?.durationSec && (
          <span className="text-[11px] text-slate-500">{data.durationSec}s · {data.resolution}</span>
        )}
        <button
          onClick={onRegenerate}
          className="ml-auto rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          ↻ Regenerar este
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Izquierda: imagen de entrada + resultado actual */}
        <div className="space-y-2">
          <div>
            <div className="mb-1 text-[11px] uppercase text-slate-500">
              Imagen de entrada (input)
            </div>
            {inputImg ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={fileUrl(inputImg)}
                alt="input"
                className="max-h-72 rounded border border-slate-700"
              />
            ) : data?.refs && data.refs.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {data.refs.map((r) =>
                  r.file ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={r.id}
                      src={fileUrl(r.file)}
                      alt={r.id}
                      className="max-h-48 rounded border border-slate-700"
                    />
                  ) : (
                    <span key={r.id} className="text-xs text-slate-500">
                      {r.id} (sin archivo)
                    </span>
                  )
                )}
              </div>
            ) : (
              <span className="text-xs text-slate-500">(sin imagen de entrada)</span>
            )}
          </div>
          <div>
            <div className="mb-1 text-[11px] uppercase text-slate-500">Resultado actual</div>
            {outUrl ? (
              showVideo ? (
                <video
                  key={outUrl}
                  src={outUrl}
                  controls
                  preload="none"
                  className="max-h-72 rounded border border-slate-700"
                />
              ) : (
                <button
                  onClick={() => setShowVideo(true)}
                  className="rounded-md border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
                >
                  ▶ Ver resultado actual
                </button>
              )
            ) : (
              <span className="text-xs text-slate-500">
                {job.status === "generating" ? "generando…" : "(sin resultado)"}
              </span>
            )}
          </div>
        </div>

        {/* Derecha: prompt exacto + JSON */}
        <div className="space-y-2">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11px] uppercase text-slate-500">
              Prompt que se ejecuta
              <button
                onClick={copyPrompt}
                className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] normal-case hover:bg-slate-800"
              >
                {copied ? "✓ copiado" : "copiar"}
              </button>
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border border-slate-700 bg-ink p-2 text-[11px] text-slate-200">
              {data ? data.executedPrompt : "cargando…"}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-[11px] uppercase text-slate-500">
              JSON del {data?.type === "video" ? "clip" : "imagen"}
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border border-slate-700 bg-ink p-2 text-[11px] text-slate-400">
              {data ? JSON.stringify(data.json, null, 2) : "cargando…"}
            </pre>
          </div>
          {data?.inputImage?.json != null && (
            <div>
              <div className="mb-1 text-[11px] uppercase text-slate-500">
                JSON de la imagen de entrada
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-slate-700 bg-ink p-2 text-[11px] text-slate-400">
                {JSON.stringify(data.inputImage.json, null, 2)}
              </pre>
            </div>
          )}
          {err && <p className="text-xs text-red-300">{err}</p>}
        </div>
      </div>
    </section>
  );
}
