"use client";
/**
 * FinalRenderTrigger — final-render surface for the awaiting_final_render pause.
 *
 * Fetches the final-render payload, optionally previews the cut video, lets the
 * user add up to 2 extra "hook" texts, and POSTs {extraTexts, motor:"remotion"}
 * to trigger the render. On editor 202 it calls onResumed().
 *
 * Requirements: 3.2, 3.4, 8.4
 */
import { useCallback, useEffect, useState } from "react";
import type { EditorTextoExtra } from "@/lib/edit/editorClient";
import {
  apiErrorMessage,
  buildRenderPayload,
  parseRenderResponse,
  type FinalRenderView,
} from "./editUiData";

interface FinalRenderTriggerProps {
  editJobId: string;
  onResumed: () => void;
}

const MAX_EXTRA_TEXTS = 2;

function defaultExtra(): EditorTextoExtra {
  return {
    texto: "",
    inicio_s: 0,
    fin_s: 2,
    estilo: {
      fuente: "Arial",
      tamano: 72,
      color: "#FFFFFF",
      color_borde: "#000000",
      grosor_borde: 5,
      negrita: true,
      pos_vertical_pct: 20,
      pos_horizontal_pct: 50,
    },
  };
}

export function FinalRenderTrigger({ editJobId, onResumed }: FinalRenderTriggerProps) {
  const [view, setView] = useState<FinalRenderView | null>(null);
  const [extraTexts, setExtraTexts] = useState<EditorTextoExtra[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/edit/${editJobId}/render`);
        const data = await res.json();
        if (!res.ok) throw new Error(apiErrorMessage(data, res.status));
        if (!active) return;
        const normalized: FinalRenderView = data.status === "awaiting_final_render"
          ? (data as FinalRenderView)
          : parseRenderResponse(editJobId, data);
        setView(normalized);
        setExtraTexts(normalized.extraTexts.slice(0, MAX_EXTRA_TEXTS));
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "Error");
      }
    })();
    return () => {
      active = false;
    };
  }, [editJobId]);

  const canAdd = extraTexts.length < MAX_EXTRA_TEXTS;
  const canSubmit = view?.editable !== false && extraTexts.length <= MAX_EXTRA_TEXTS && !submitting;

  const addExtra = useCallback(() => {
    setExtraTexts((prev) => (prev.length < MAX_EXTRA_TEXTS ? [...prev, defaultExtra()] : prev));
  }, []);

  const removeExtra = useCallback((i: number) => {
    setExtraTexts((prev) => prev.filter((_, idx) => idx !== i));
  }, []);

  const updateExtraText = useCallback((i: number, texto: string) => {
    setExtraTexts((prev) => prev.map((t, idx) => (idx === i ? { ...t, texto } : t)));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setApiError(null);
    try {
      const res = await fetch(`/api/edit/${editJobId}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRenderPayload(extraTexts)),
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
  }, [canSubmit, editJobId, extraTexts, onResumed]);

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
        Render final
      </h3>

      {view?.previewUrl ? (
        <video src={view.previewUrl} controls className="w-full rounded-md bg-black" />
      ) : (
        <div className="text-xs text-slate-500">Vista previa no disponible</div>
      )}

      <div className="space-y-2">
        <label className="text-xs text-slate-400 font-medium">Textos extra (máx. 2)</label>
        {extraTexts.map((t, i) => (
          <div key={i} className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="text"
              value={t.texto}
              onChange={(e) => updateExtraText(i, e.target.value)}
              className="flex-1 rounded bg-slate-800 px-2 py-1"
              aria-label={`extra-${i}`}
            />
            <button
              onClick={() => removeExtra(i)}
              className="rounded px-2 py-1 text-red-300 hover:bg-red-500/10"
            >
              Quitar
            </button>
          </div>
        ))}
        <button
          onClick={addExtra}
          disabled={!canAdd}
          className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        >
          Añadir texto
        </button>
      </div>

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
        {submitting ? "Iniciando render..." : "Iniciar render final"}
      </button>
    </div>
  );
}
