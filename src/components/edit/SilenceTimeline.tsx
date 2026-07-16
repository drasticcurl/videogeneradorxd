"use client";
/**
 * SilenceTimeline — silence-editing surface for the awaiting_silences pause.
 *
 * Fetches the silence pause payload, renders the joined-video preview and the
 * detected cut segments, lets the user add/remove/edit cut ranges, mirrors the
 * server-side validateSegments invariant client-side, and POSTs the edited
 * segments. On editor 202 it calls onResumed() to re-arm the poll loop.
 *
 * Requirements: 1.2, 1.4, 8.1
 */
import { useCallback, useEffect, useState } from "react";
import { validateSegments, type SilenceSegment } from "@/lib/edit/validateSegments";
import {
  apiErrorMessage,
  buildSilencesPayload,
  parseSilencesResponse,
  type SilencesView,
} from "./editUiData";

interface SilenceTimelineProps {
  editJobId: string;
  onResumed: () => void;
}

export function SilenceTimeline({ editJobId, onResumed }: SilenceTimelineProps) {
  const [view, setView] = useState<SilencesView | null>(null);
  const [segments, setSegments] = useState<SilenceSegment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/edit/${editJobId}/silences`);
        const data = await res.json();
        if (!res.ok) throw new Error(apiErrorMessage(data, res.status));
        if (!active) return;
        // The GET route already returns a normalized view, but re-normalizing a
        // raw editor payload is harmless; prefer the normalized shape.
        const normalized: SilencesView = data.status === "awaiting_silences"
          ? (data as SilencesView)
          : parseSilencesResponse(editJobId, data);
        setView(normalized);
        setSegments(normalized.segments);
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "Error");
      }
    })();
    return () => {
      active = false;
    };
  }, [editJobId]);

  const durationS = view?.durationS ?? 0;
  const errors = validateSegments(segments, durationS);
  const canSubmit = view?.editable !== false && errors.length === 0 && !submitting;

  const updateSegment = useCallback((i: number, patch: Partial<SilenceSegment>) => {
    setSegments((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }, []);

  const addSegment = useCallback(() => {
    setSegments((prev) => [...prev, { inicioS: 0, finS: Math.min(1, durationS || 1) }]);
  }, [durationS]);

  const removeSegment = useCallback((i: number) => {
    setSegments((prev) => prev.filter((_, idx) => idx !== i));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setApiError(null);
    try {
      const res = await fetch(`/api/edit/${editJobId}/silences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSilencesPayload(segments)),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        onResumed();
        return;
      }
      throw new Error(apiErrorMessage(data, res.status));
    } catch (e) {
      setApiError(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, editJobId, segments, onResumed]);

  if (loadError) {
    return (
      <div className="rounded-md bg-red-500/10 border border-red-600/40 px-3 py-2 text-xs text-red-300">
        {loadError}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-indigo-600/40 bg-panel p-4 space-y-4">
      <h3 className="text-sm font-semibold text-indigo-300 uppercase tracking-wide">
        Editar silencios
      </h3>

      {view?.previewUrl ? (
        <video src={view.previewUrl} controls className="w-full rounded-md bg-black" />
      ) : (
        <div className="text-xs text-slate-500">Vista previa no disponible</div>
      )}

      <div className="space-y-2">
        {segments.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs text-slate-300">
            <span className="text-slate-500">#{i + 1}</span>
            <input
              type="number"
              step="0.01"
              value={s.inicioS}
              onChange={(e) => updateSegment(i, { inicioS: Number(e.target.value) })}
              className="w-20 rounded bg-slate-800 px-2 py-1"
              aria-label={`inicio-${i}`}
            />
            <span>→</span>
            <input
              type="number"
              step="0.01"
              value={s.finS}
              onChange={(e) => updateSegment(i, { finS: Number(e.target.value) })}
              className="w-20 rounded bg-slate-800 px-2 py-1"
              aria-label={`fin-${i}`}
            />
            <button
              onClick={() => removeSegment(i)}
              className="rounded px-2 py-1 text-red-300 hover:bg-red-500/10"
            >
              Quitar
            </button>
          </div>
        ))}
        <button
          onClick={addSegment}
          className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
        >
          Añadir corte
        </button>
      </div>

      {errors.length > 0 && (
        <div className="text-xs text-amber-300">
          {errors.length} segmento(s) inválido(s): {errors.map((e) => `#${e.index + 1} ${e.reason}`).join("; ")}
        </div>
      )}

      {apiError && (
        <div className="rounded-md bg-red-500/10 border border-red-600/40 px-3 py-2 text-xs text-red-300">
          {apiError}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
      >
        {submitting ? "Confirmando..." : "Confirmar cortes"}
      </button>
    </div>
  );
}
