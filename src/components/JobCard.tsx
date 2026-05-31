"use client";
/**
 * Tarjeta de job con flujo de aprobacion:
 *  - awaiting_approval (imagen): muestra las variantes candidatas, elegís una y Aprobás.
 *  - awaiting_approval (video): muestra el video y Aprobás.
 *  - Acciones: Aprobar / Regenerar / Cambiar prompt (editás el prompt y regenera).
 */
import { useState } from "react";
import { StatusBadge } from "./StatusBadge";
import type { JobRecord } from "@/lib/types";

interface Props {
  job: JobRecord;
  projectId: string;
  onApprove: (jobId: string, index?: number) => void;
  onRegenerate: (jobId: string) => void;
  onChangePrompt: (jobId: string, prompt: string) => void;
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

  const isImage = job.type === "image";
  const awaiting = job.status === "awaiting_approval";
  const approvedUrl = job.outputPath ? fileUrl(projectId, job.outputPath) : null;
  const chosen = selected ?? job.selectedIndex ?? job.candidates[0]?.index ?? null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-panel p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-100">{job.label}</div>
          <div className="text-xs text-slate-500">
            {isImage ? "imagen" : "video"}
            {job.model ? ` · ${job.model}` : ""}
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

      {/* Editor de prompt */}
      {editing && (
        <div className="space-y-1">
          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            placeholder="Nuevo prompt…"
            className="h-20 w-full resize-y rounded border border-slate-600 bg-ink p-2 text-xs"
          />
          <div className="flex gap-1">
            <button
              onClick={() => {
                if (promptText.trim()) onChangePrompt(job.id, promptText.trim());
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
            onClick={() => {
              setPromptText("");
              setEditing(true);
            }}
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
