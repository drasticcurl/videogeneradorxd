"use client";
/**
 * Pantalla "Resultado": timeline ordenada por clip, textos en pantalla sugeridos,
 * subida manual para clips FILMAR_REAL, stitch opcional (final.mp4) y la ruta local
 * de la carpeta de salida.
 */
import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "@/store/useProjectStore";
import { ProjectTabs } from "@/components/ProjectTabs";
import { StatusBadge } from "@/components/StatusBadge";
import { EditPanel } from "@/components/edit/EditPanel";
import { EditOutputList } from "@/components/edit/EditOutputList";
import type { ManifestClip } from "@/lib/types";

export default function ResultPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const { project, manifest, config, loadProject, loadConfig, refreshJobs } =
    useProjectStore();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
    loadProject(projectId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleUpload(clipId: string, file: File) {
    setBusy(clipId);
    try {
      const fd = new FormData();
      fd.append("clipId", clipId);
      fd.append("file", file);
      await fetch(`/api/projects/${projectId}/upload`, {
        method: "POST",
        body: fd,
      });
      await refreshJobs(projectId);
      await loadProject(projectId);
    } finally {
      setBusy(null);
    }
  }

  const outputPath = project
    ? `${config?.outputDir ?? "./output"}/${project.id}`
    : "";

  return (
    <div className="space-y-5">
      <ProjectTabs projectId={projectId} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{project?.name ?? "Resultado"}</h1>
          {project && (
            <div className="mt-1">
              <StatusBadge status={project.status} />
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <a
            href={`/api/projects/${projectId}/download`}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            ⬇ Descargar proyecto (ZIP)
          </a>
        </div>
      </div>

      {/* Descarga / salida */}
      <div className="rounded-lg border border-slate-700 bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-slate-200">
              Descargar proyecto + unir local
            </div>
            <code className="text-xs text-slate-400">{outputPath}</code>
          </div>
          <div className="flex gap-2">
            <a
              href={`/api/projects/${projectId}/download`}
              className="rounded-md border border-emerald-600/60 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/10"
            >
              ⬇ Descargar ZIP
            </a>
            <a
              href={`/api/files/${projectId}/manifest.json`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800"
            >
              Ver manifest.json
            </a>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          El ZIP trae las imágenes (<code>images/</code>), los clips (<code>clips/</code>,
          incluidas las extensiones <code>__extK</code>), el <code>manifest.json</code> y un{" "}
          <code>stitch.sh</code>/<code>stitch.bat</code>. El video final se arma en tu PC con
          ffmpeg (corré <code>stitch.sh</code> o <code>stitch.bat</code>) — así la nube solo
          genera y no gasta poder uniendo video.
        </p>
      </div>

      {/* Editor integration */}
      <EditPanel
        projectId={projectId}
        clipIds={manifest?.clips.filter(c => c.status === "done" && c.file).map(c => c.id) ?? []}
        hasFinal={false}
      />

      <EditOutputList projectId={projectId} />

      {/* Timeline de clips */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Timeline ({manifest?.clips.length ?? 0} clips)
        </h2>
        <div className="space-y-3">
          {manifest?.clips.map((clip) => (
            <ClipRow
              key={clip.id}
              clip={clip}
              projectId={projectId}
              busy={busy === clip.id}
              onUpload={handleUpload}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function ClipRow({
  clip,
  projectId,
  busy,
  onUpload,
}: {
  clip: ManifestClip;
  projectId: string;
  busy: boolean;
  onUpload: (clipId: string, file: File) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const fileUrl = clip.file ? `/api/files/${projectId}/${clip.file}` : null;
  const isReal = clip.etiqueta === "FILMAR_REAL";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-panel p-3 sm:flex-row">
      {/* preview */}
      <div className="flex aspect-[9/16] w-32 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink">
        {fileUrl ? (
          <video src={fileUrl} controls className="h-full w-full object-contain" />
        ) : (
          <span className="px-2 text-center text-[11px] text-slate-600">
            {isReal ? "subí tu clip" : "sin generar"}
          </span>
        )}
      </div>

      {/* info */}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="rounded bg-slate-700 px-2 py-0.5 text-xs font-mono text-slate-200">
            {String(clip.orden).padStart(2, "0")}
          </span>
          <span className="font-medium text-slate-100">{clip.id}</span>
          <span
            className={`rounded px-2 py-0.5 text-[11px] ${
              isReal
                ? "bg-fuchsia-500/20 text-fuchsia-300"
                : "bg-sky-500/20 text-sky-300"
            }`}
          >
            {clip.etiqueta}
          </span>
          <StatusBadge status={clip.status} />
          <span className="text-xs text-slate-500">{clip.duracion_seg}s</span>
        </div>

        {clip.dialogo && (
          <p className="text-sm text-slate-200">
            <span className="text-slate-500">diálogo:</span> “{clip.dialogo}”
          </p>
        )}
        {clip.on_screen_text && (
          <p className="text-xs text-slate-400">
            <span className="text-slate-500">texto en pantalla:</span>{" "}
            {clip.on_screen_text}
          </p>
        )}
        {clip.file && (
          <code className="block text-[11px] text-slate-500">{clip.file}</code>
        )}

        {isReal && (
          <div className="pt-1">
            <input
              ref={fileInput}
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(clip.id, f);
              }}
            />
            <button
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="rounded-md border border-fuchsia-600/60 px-3 py-1.5 text-xs text-fuchsia-200 hover:bg-fuchsia-500/10 disabled:opacity-40"
            >
              {busy ? "Subiendo…" : clip.file ? "Reemplazar archivo" : "Subir archivo filmado"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
