"use client";
/**
 * SubtitleReview — subtitle-review surface for the awaiting_subtitles pause.
 *
 * Fetches the proposed subtitle groups, renders one editable text field per
 * group (group + per-word timings are read-only), and POSTs text-only groups
 * preserving the group count. On editor 202 it calls onResumed().
 *
 * Requirements: 2.2, 2.4
 */
import { useCallback, useEffect, useState } from "react";
import {
  allGroupsNonEmpty,
  apiErrorMessage,
  buildSubtitlesPayload,
  parseSubtitulosResponse,
  type SubtitlesView,
} from "./editUiData";

interface SubtitleReviewProps {
  editJobId: string;
  onResumed: () => void;
}

export function SubtitleReview({ editJobId, onResumed }: SubtitleReviewProps) {
  const [view, setView] = useState<SubtitlesView | null>(null);
  const [texts, setTexts] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/edit/${editJobId}/subtitles`);
        const data = await res.json();
        if (!res.ok) throw new Error(apiErrorMessage(data, res.status));
        if (!active) return;
        const normalized: SubtitlesView = data.status === "awaiting_subtitles"
          ? (data as SubtitlesView)
          : parseSubtitulosResponse(data);
        setView(normalized);
        setTexts(normalized.groups.map((g) => g.texto));
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "Error");
      }
    })();
    return () => {
      active = false;
    };
  }, [editJobId]);

  const hasEmpty = !allGroupsNonEmpty(texts);
  const canSubmit = view?.editable !== false && !hasEmpty && texts.length > 0 && !submitting;

  const updateText = useCallback((i: number, value: string) => {
    setTexts((prev) => prev.map((t, idx) => (idx === i ? value : t)));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setApiError(null);
    try {
      const res = await fetch(`/api/edit/${editJobId}/subtitles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSubtitlesPayload(texts)),
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
  }, [canSubmit, editJobId, texts, onResumed]);

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
        Revisar subtítulos
      </h3>

      <div className="space-y-2">
        {(view?.groups ?? []).map((g, i) => (
          <div key={i} className="space-y-1">
            <div className="text-[11px] text-slate-500">
              {g.inicioS.toFixed(2)}s → {g.finS.toFixed(2)}s
            </div>
            <input
              type="text"
              value={texts[i] ?? ""}
              onChange={(e) => updateText(i, e.target.value)}
              className="w-full rounded bg-slate-800 px-2 py-1 text-xs text-slate-200"
              aria-label={`grupo-${i}`}
            />
          </div>
        ))}
      </div>

      {hasEmpty && <div className="text-xs text-amber-300">Ningún grupo puede quedar vacío.</div>}

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
        {submitting ? "Confirmando..." : "Confirmar subtítulos"}
      </button>
    </div>
  );
}
