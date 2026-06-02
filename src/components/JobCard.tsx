"use client";
/**
 * Tarjeta de job con flujo de aprobacion:
 *  - awaiting_approval (imagen): muestra las variantes candidatas, elegís una y Aprobás.
 *  - awaiting_approval (video): muestra el video y Aprobás.
 *  - Acciones: Aprobar / Regenerar / Editar.
 *    Al "Editar" se PRECARGA el prompt actual (el que se usó para generar), el diálogo,
 *    la duración y la resolución, y se muestra un selector de modelo. Desde el editor
 *    podés:
 *      · "Guardar sin regenerar": solo persiste los cambios (texto/tiempo/diálogo) para
 *        poder revisarlos y controlarlos ANTES de generar en batch (no consume cuota).
 *      · "Guardar y regenerar": guarda y vuelve a generar ese item puntual.
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
  /** dialogo actual del clip (solo videos) para precargar al editar */
  currentDialogue?: string;
  /** duracion actual del clip en segundos (solo videos) */
  currentDuration?: number;
  /** opciones de modelo para el selector (catalogo de imagen o de video segun el tipo) */
  modelOptions: ModelOption[];
  /** modelo del proyecto para este tipo (default si no hay override) */
  projectModel: string;
  onApprove: (jobId: string, index?: number) => void;
  onRegenerate: (jobId: string) => void;
  onChangePrompt: (
    jobId: string,
    payload: {
      prompt?: string;
      dialogue?: string;
      durationSec?: number;
      resolution?: string;
      model?: string;
      regenerate?: boolean;
    }
  ) => void;
  /** Solo videos: extender el video +7s. */
  onExtend?: (jobId: string) => void;
  /** Solo videos: resolucion actual del clip y callback para cambiarla. */
  resolution?: string;
  resolutionOptions?: string[];
  onChangeResolution?: (jobRefId: string, resolution: string) => void;
}

function fileUrl(projectId: string, rel: string) {
  return `/api/files/${projectId}/${rel}`;
}

const DURATION_OPTIONS = [4, 6, 8];

export function JobCard({
  job,
  projectId,
  currentPrompt,
  currentDialogue,
  currentDuration,
  modelOptions,
  projectModel,
  onApprove,
  onRegenerate,
  onChangePrompt,
  onExtend,
  resolution,
  resolutionOptions,
  onChangeResolution,
}: Props) {
  const [selected, setSelected] = useState<number | null>(job.selectedIndex);
  const [editing, setEditing] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [dialogueText, setDialogueText] = useState("");
  const [durationChoice, setDurationChoice] = useState<number>(8);
  const [resChoice, setResChoice] = useState<string>("720p");
  const [modelChoice, setModelChoice] = useState("");

  const isImage = job.type === "image";
  const awaiting = job.status === "awaiting_approval";
  // Cache-busting: la URL cambia cuando el job se actualiza (regenera/aprueba), asi el
  // navegador NO muestra el video/imagen viejo cacheado (el archivo va al mismo path).
  const ver = encodeURIComponent(job.updatedAt ?? "");
  const withVer = (u: string) => `${u}?v=${ver}`;
  const approvedUrl = job.outputPath
    ? withVer(fileUrl(projectId, job.outputPath))
    : null;
  const chosen = selected ?? job.selectedIndex ?? job.candidates[0]?.index ?? null;

  // El modelo efectivo de este job: override > modelo usado > modelo del proyecto.
  const effectiveModel = job.modelOverride || job.model || projectModel;

  function openEditor() {
    // PRECARGAMOS prompt + dialogo + duracion + resolucion + modelo efectivo.
    setPromptText(currentPrompt ?? "");
    setDialogueText(currentDialogue ?? "");
    setDurationChoice(currentDuration ?? 8);
    setResChoice(resolution ?? "720p");
    setModelChoice(effectiveModel);
    setEditing(true);
  }

  // Guarda los cambios del editor. Si regenerate=false SOLO persiste (no genera),
  // util para ajustar texto/tiempo/dialogo antes de generar en batch.
  function submitEdits(regenerate: boolean) {
    const payload = isImage
      ? { prompt: promptText.trim(), model: modelChoice, regenerate }
      : {
          prompt: promptText.trim(),
          dialogue: dialogueText,
          durationSec: durationChoice,
          resolution: resChoice,
          model: modelChoice,
          regenerate,
        };
    if (payload.prompt) onChangePrompt(job.id, payload);
    setEditing(false);
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
                  src={withVer(fileUrl(projectId, c.file))}
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
                <img
                  key={approvedUrl}
                  src={approvedUrl}
                  alt={job.label}
                  className="h-full w-full object-contain"
                />
              ) : (
                <video
                  key={approvedUrl}
                  src={approvedUrl}
                  controls
                  className="h-full w-full object-contain"
                />
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

      {/* Editor de prompt en MODAL grande: se ve TODO el prompt completo. */}
      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setEditing(false)}
        >
          <div
            className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-xl border border-slate-700 bg-panel p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-100">
                Editar · <span className="text-slate-400">{job.label}</span>
              </h3>
              <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                {isImage ? "imagen" : "video"}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-400">
                {isImage
                  ? "Prompt de la imagen (editá lo que quieras)"
                  : "Prompt visual del video (cámara, acción, escena)"}
              </label>
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                placeholder="Prompt…"
                spellCheck={false}
                className="code min-h-[240px] w-full resize-y whitespace-pre-wrap break-words rounded-lg border border-slate-600 bg-ink p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
              />
              <span className="text-[11px] text-slate-500">
                {promptText.length} caracteres
              </span>
            </div>

            {/* Solo videos: el DIALOGO que dice la persona (lo que se escucha). */}
            {!isImage && (
              <div className="flex flex-col gap-1">
                <label className="text-xs uppercase tracking-wide text-slate-400">
                  Diálogo (lo que dice la persona · es-AR)
                </label>
                <textarea
                  value={dialogueText}
                  onChange={(e) => setDialogueText(e.target.value)}
                  placeholder="Texto hablado… (vacío = b-roll mudo)"
                  spellCheck={false}
                  className="min-h-[120px] w-full resize-y whitespace-pre-wrap break-words rounded-lg border border-slate-600 bg-ink p-3 text-sm leading-relaxed focus:border-accent focus:outline-none"
                />
                <span className="text-[11px] text-slate-500">
                  {dialogueText.length} caracteres
                </span>
              </div>
            )}

            {/* Solo videos: duracion (4/6/8) + resolucion, campo por campo. */}
            {!isImage && (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs uppercase tracking-wide text-slate-400">
                    Duración (segundos)
                  </label>
                  <select
                    value={durationChoice}
                    onChange={(e) => setDurationChoice(Number(e.target.value))}
                    className="rounded-lg border border-slate-600 bg-ink px-3 py-2 text-sm focus:border-accent focus:outline-none"
                  >
                    {DURATION_OPTIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}s
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs uppercase tracking-wide text-slate-400">
                    Resolución
                  </label>
                  <select
                    value={resChoice}
                    onChange={(e) => setResChoice(e.target.value)}
                    className="rounded-lg border border-slate-600 bg-ink px-3 py-2 text-sm focus:border-accent focus:outline-none"
                  >
                    {(resolutionOptions ?? ["720p", "1080p"]).map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-400">
                Modelo para regenerar
              </label>
              <select
                value={modelChoice}
                onChange={(e) => setModelChoice(e.target.value)}
                className="rounded-lg border border-slate-600 bg-ink px-3 py-2 text-sm focus:border-accent focus:outline-none"
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

            <div className="flex flex-col gap-2 pt-1">
              <p className="text-[11px] leading-relaxed text-slate-500">
                «Guardar sin regenerar» actualiza el texto, el tiempo y el diálogo
                (audio) sin volver a generar — útil para revisarlos y controlarlos
                antes de generar en batch. No consume cuota.
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  onClick={() => setEditing(false)}
                  className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => submitEdits(false)}
                  className="rounded-lg border border-emerald-600/60 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/10"
                >
                  💾 Guardar sin regenerar
                </button>
                <button
                  onClick={() => submitEdits(true)}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  ↻ Guardar y regenerar
                </button>
              </div>
            </div>
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
            title="Vuelve a generar este item. Sirve tambien para destrabar uno colgado en 'generando'."
            className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
          >
            ↻ Regenerar
          </button>
          <button
            onClick={openEditor}
            disabled={job.status === "generating"}
            title="Editá prompt, diálogo, tiempo y resolución. Podés guardar sin regenerar para controlarlo antes del batch."
            className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            ✎ Editar
          </button>
          {!isImage && onExtend && job.outputPath && (
            <button
              onClick={() => onExtend(job.id)}
              disabled={job.status === "generating"}
              title="Genera 7s más de continuación y los une al final del video"
              className="rounded-md border border-sky-600/60 px-2 py-1 text-xs text-sky-200 hover:bg-sky-500/10 disabled:opacity-40"
            >
              ⏩ Extender +7s
            </button>
          )}
        </div>
      )}
    </div>
  );
}
