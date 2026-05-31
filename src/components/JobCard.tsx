"use client";
/**
 * Tarjeta de job con flujo de aprobacion:
 *  - awaiting_approval (imagen): muestra las variantes candidatas, elegís una y Aprobás.
 *  - awaiting_approval (video): muestra el video y Aprobás.
 *  - Acciones: Aprobar / Regenerar / Cambiar prompt.
 *    Al "Cambiar prompt" se PRECARGA el prompt actual (el que se usó para generar)
 *    y se muestra un selector de modelo para regenerar ese item puntual.
 */
import { useState } from "react";
import { StatusBadge } from "./StatusBadge";
import type { JobRecord } from "@/lib/types";

interface ModelOption {
  id: string;
  label: string;
}

interface Props {
  job: JobRecord;
  projectId: string;
  /** prompt actual del item (image.prompt o clip.video_prompt) para precargar al editar */
  currentPrompt: string;
  /** opciones de modelo para el selector (catalogo de imagen o de video segun el tipo) */
  modelOptions: ModelOption[];
  /** modelo del proyecto para este tipo (default si no hay override) */
  projectModel: string;
  onApprove: (jobId: string, index?: number) => void;
  onRegenerate: (jobId: string) => void;
  onChangePrompt: (jobId: string, prompt: string, model?: string) => void;
  /** Solo videos: resolucion actual del clip y callback para cambiarla. */
  resolution?: string;
  resolutionOptions?: string[];
  onChangeResolution?: (jobRefId: string, resolution: string) => void;
}

function fileUrl(projectId: string, rel: string) {
  return `/api/files/${projectId}/${rel}`;
}

export function JobCard({
  job,
  projectId,
  currentPrompt,
  modelOptions,
  projectModel,
  onApprove,
  onRegenerate,
  onChangePrompt,
  resolution,
  resolutionOptions,
  onChangeResolution,
}: Props) {
  const [selected, setSelected] = useState<number | null>(job.selectedIndex);
  const [editing, setEditing] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [modelChoice, setModelChoice] = useState("");

  const isImage = job.type === "image";
  const awaiting = job.status === "awaiting_approval";
  const approvedUrl = job.outputPath ? fileUrl(projectId, job.outputPath) : null;
  const chosen = selected ?? job.selectedIndex ?? job.candidates[0]?.index ?? null;

  // El modelo efectivo de este job: override > modelo usado > modelo del proyecto.
  const effectiveModel = job.modelOverride || job.model || projectModel;

  function openEditor() {
    // PRECARGAMOS el prompt actual y el modelo efectivo, asi el usuario ve lo que se uso.
    setPromptText(currentPrompt ?? "");
    setModelChoice(effectiveModel);
    setEditing(true);
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-100">{job.label}</div>
          <div className="text-xs text-slate-500">
            {isImage ? "imagen" : "video"}
            {effectiveModel ? ` · ${effectiveModel}` : ""}
            {job.attempts > 0 && ` · intento ${job.attempts}/${job.maxAttempts}`}
            {job.locked && " · 🔒"}
          </div>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {/* Preview / candidatos */}
      <div className="overflow-hidden rounded-md bg-ink">
        {awaiting && isImage && job.candidates.length > 0 ? (
          <div
            className={`grid gap-1 p-1 ${
              job.candidates.length > 1 ? "grid-cols-2" : "grid-cols-1"
            }`}
          >
            {job.candidates.map((c) => (
              <button
                key={c.index}
                onClick={() => setSelected(c.index)}
                className={`relative overflow-hidden rounded ${
                  chosen === c.index ? "ring-2 ring-emerald-400" : "ring-1 ring-slate-700"
                }`}
                title={`Variante ${c.index}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={fileUrl(projectId, c.file)}
                  alt={`v${c.index}`}
                  className="aspect-[9/16] w-full object-cover"
                />
                {chosen === c.index && (
                  <span className="absolute bottom-1 right-1 rounded bg-emerald-500 px-1 text-[10px] font-bold text-white">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex aspect-[9/16] max-h-56 items-center justify-center">
            {approvedUrl ? (
              isImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={approvedUrl} alt={job.label} className="h-full w-full object-contain" />
              ) : (
                <video src={approvedUrl} controls className="h-full w-full object-contain" />
              )
            ) : job.status === "generating" ? (
              <span className="text-xs text-amber-300">generando…</span>
            ) : job.status === "failed" ? (
              <span className="px-2 text-center text-xs text-red-300">error</span>
            ) : (
              <span className="text-xs text-slate-600">en cola…</span>
            )}
          </div>
        )}
      </div>

      {job.error && (
        <p className="line-clamp-3 rounded bg-red-500/10 p-1.5 text-[11px] text-red-300">
          {job.error}
        </p>
      )}

      {/* Editor de prompt (precargado) + selector de modelo */}
      {editing && (
        <div className="space-y-2 rounded-md border border-slate-700 bg-ink/60 p-2">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wide text-slate-400">
              Prompt actual ({isImage ? "imagen" : "video"})
            </label>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="Prompt…"
              className="code h-32 w-full resize-y rounded border border-slate-600 bg-ink p-2 text-[11px] leading-relaxed focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] uppercase tracking-wide text-slate-400">
              Modelo para regenerar
            </label>
            <select
              value={modelChoice}
              onChange={(e) => setModelChoice(e.target.value)}
              className="rounded border border-slate-600 bg-ink px-2 py-1 text-xs focus:border-accent focus:outline-none"
            >
              {modelOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
              {!modelOptions.some((o) => o.id === modelChoice) && modelChoice && (
                <option value={modelChoice}>{modelChoice}</option>
              )}
            </select>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => {
                if (promptText.trim()) onChangePrompt(job.id, promptText.trim(), modelChoice);
                setEditing(false);
              }}
              className="rounded bg-accent px-2 py-1 text-xs text-white"
            >
              Guardar y regenerar
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* Selector de resolucion (solo videos) */}
      {!isImage && onChangeResolution && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400">Resolucion:</span>
          <select
            value={resolution ?? "720p"}
            disabled={job.status === "generating"}
            onChange={(e) => onChangeResolution(job.refId, e.target.value)}
            className="rounded border border-slate-600 bg-ink px-2 py-1 text-xs focus:border-accent focus:outline-none disabled:opacity-40"
          >
            {(resolutionOptions ?? ["720p", "1080p"]).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Acciones */}
      {!editing && (
        <div className="flex flex-wrap gap-1">
          {awaiting && (
            <button
              onClick={() => onApprove(job.id, isImage ? chosen ?? undefined : undefined)}
              className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500"
            >
              ✓ Aprobar
            </button>
          )}
          <button
            onClick={() => onRegenerate(job.id)}
            disabled={job.status === "generating"}
            className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            ↻ Regenerar
          </button>
          <button
            onClick={openEditor}
            disabled={job.status === "generating"}
            className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            ✎ Cambiar prompt
          </button>
        </div>
      )}
    </div>
  );
}
