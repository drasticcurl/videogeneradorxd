"use client";
/**
 * REVISION DE CLIPS (fase videos).
 *
 * Recorre TODOS los clips del lote en orden (proyecto por proyecto, por "orden" del
 * plan) y te deja aprobar / rechazar / regenerar de a uno, con el diálogo al costado
 * para chequear el lip-sync.
 *
 * Sirve para los dos casos:
 *  - Si generaste con aprobación manual, los clips llegan en "aprobar" y el botón
 *    verde los aprueba (y desbloquea lo que dependa).
 *  - Si generaste con auto-aprobación (default), ya están aprobados: igual los podés
 *    ver en orden y regenerar los que no te gustaron.
 *
 * Atajos: → siguiente · ← anterior · A aprobar · R rechazar y regenerar.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { BatchSnapshot, BatchTimelineItem } from "@/lib/batch";
import { StatusBadge } from "@/components/StatusBadge";

const POLL_MS = 3000;

interface DeckItem extends BatchTimelineItem {
  projectId: string;
  projectName: string;
}

export function VideoDeck() {
  const searchParams = useSearchParams();
  const idsParam = searchParams.get("ids") ?? "";
  const ids = useMemo(
    () =>
      idsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [idsParam]
  );

  const [snap, setSnap] = useState<BatchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  /** true una vez que posicionamos el cursor en el primer clip por aprobar */
  const positioned = useRef(false);
  const lockRef = useRef(false);

  const load = useCallback(async () => {
    if (ids.length === 0) return;
    try {
      const res = await fetch(`/api/batch?ids=${ids.join(",")}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo leer el lote");
      setSnap(data as BatchSnapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ids]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Todos los clips del lote, en orden de proyecto y de guion.
  const items: DeckItem[] = useMemo(() => {
    const out: DeckItem[] = [];
    for (const p of snap?.projects ?? []) {
      for (const t of p.timeline) {
        out.push({ ...t, projectId: p.id, projectName: p.name });
      }
    }
    return out;
  }, [snap]);

  const awaiting = items.filter((i) => i.status === "awaiting_approval");

  // La primera vez, arrancamos en el primer clip que espera aprobacion.
  useEffect(() => {
    if (positioned.current || items.length === 0) return;
    positioned.current = true;
    const idx = items.findIndex((i) => i.status === "awaiting_approval");
    if (idx >= 0) setCursor(idx);
  }, [items]);

  const current = items[Math.min(cursor, Math.max(0, items.length - 1))] ?? null;

  const go = useCallback(
    (delta: number) => {
      setCursor((c) => Math.min(Math.max(0, c + delta), Math.max(0, items.length - 1)));
    },
    [items.length]
  );

  /** POST simple sobre el job actual (aprobar / regenerar / desaprobar). */
  const act = useCallback(
    async (
      kind: "approve" | "retry" | "unapprove",
      opts?: { advance?: boolean }
    ) => {
      if (!current?.videoJobId || lockRef.current) return;
      lockRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/jobs/${current.videoJobId}/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: kind === "approve" ? JSON.stringify({}) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "La acción falló");
        if (opts?.advance) go(1);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        lockRef.current = false;
        setBusy(false);
        void load();
      }
    },
    [current, go, load]
  );

  /** Aprueba de una todos los clips que esperan aprobacion en el lote. */
  const approveAll = useCallback(async () => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: "approve-videos" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo aprobar");
      if (data.batch) setSnap(data.batch as BatchSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [ids, load]);

  // Atajos de teclado.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.repeat) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "a" || e.key === "A") {
        void act("approve", { advance: true });
      } else if (e.key === "r" || e.key === "R") {
        void act("retry", { advance: true });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, act]);

  if (ids.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        Falta el lote.{" "}
        <Link href="/batch" className="text-accent hover:underline">
          Armá un tablero
        </Link>{" "}
        y volvé.
      </p>
    );
  }

  const backHref = `/batch?ids=${ids.join(",")}`;
  const totals = snap?.totals.videos;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">
            Revisar clips{" "}
            <span className="text-slate-500">
              ({items.length > 0 ? cursor + 1 : 0}/{items.length})
            </span>
          </h1>
          <p className="text-xs text-slate-500">
            {totals
              ? `${totals.done} aprobados · ${totals.awaiting} esperando aprobación · ${
                  totals.generating - totals.stuck
                } generando · ${totals.pending} en fila`
              : "Cargando…"}
            {" · "}
            <span className="text-slate-400">
              → siguiente · ← anterior · A aprobar · R rechazar
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {awaiting.length > 0 && (
            <button
              onClick={() => void approveAll()}
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              title="Aprueba todos los clips que están esperando"
            >
              ✓ Aprobar todos ({awaiting.length})
            </button>
          )}
          <Link
            href={backHref}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            ← Tablero
          </Link>
        </div>
      </div>

      {error && (
        <p className="rounded bg-red-500/10 p-2 text-sm text-red-300">{error}</p>
      )}

      {/* Tira de navegacion: todos los clips, el actual resaltado. */}
      {items.length > 0 && (
        <div className="flex gap-0.5 overflow-x-auto pb-1">
          {items.map((it, i) => (
            <button
              key={`${it.projectId}:${it.clipId}`}
              onClick={() => setCursor(i)}
              title={`${it.projectName} · ${it.label} · ${it.status}`}
              className={`h-7 w-7 shrink-0 rounded text-[10px] ${
                i === cursor
                  ? "bg-accent text-white"
                  : it.status === "done"
                  ? "bg-emerald-500/20 text-emerald-300"
                  : it.status === "awaiting_approval"
                  ? "bg-indigo-500/20 text-indigo-300"
                  : it.status === "failed"
                  ? "bg-red-500/20 text-red-300"
                  : it.status === "generating"
                  ? "bg-amber-500/20 text-amber-300"
                  : "bg-slate-800 text-slate-500"
              }`}
            >
              {it.orden}
            </button>
          ))}
        </div>
      )}

      {!current ? (
        <div className="rounded-xl border border-slate-800 bg-panel p-8 text-center text-sm text-slate-400">
          Todavía no hay clips. Volvé al tablero y arrancá la generación de videos.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* ------------------------------ video ------------------------------ */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">
                {current.projectName}
              </span>
              <code className="text-slate-400">{current.label}</code>
              <StatusBadge status={current.status} />
              <span className="text-slate-500">{current.duracionSeg}s</span>
              {current.etiqueta === "FILMAR_REAL" && (
                <span className="text-fuchsia-300">a filmar</span>
              )}
            </div>

            {current.videoUrl ? (
              <video
                key={current.videoUrl}
                src={current.videoUrl}
                controls
                autoPlay
                playsInline
                className="w-full max-w-sm rounded-lg border border-slate-800 bg-black"
              />
            ) : current.imageUrl ? (
              <div className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={current.imageUrl}
                  src={current.imageUrl}
                  alt=""
                  className="w-full max-w-sm rounded-lg border border-slate-800 opacity-60"
                />
                <p className="text-xs text-slate-500">
                  {current.status === "generating"
                    ? "Generando este clip… (se actualiza solo)"
                    : "Todavía no se generó. Este es el frame inicial."}
                </p>
              </div>
            ) : (
              <p className="text-xs text-slate-500">Sin archivo todavía.</p>
            )}

            {current.error && (
              <p className="rounded bg-amber-500/10 p-2 text-xs text-amber-300">
                {current.error}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => go(-1)}
                disabled={cursor === 0}
                className="rounded-lg border border-slate-600 px-3 py-2.5 text-sm hover:bg-slate-800 disabled:opacity-40"
              >
                ← Anterior
              </button>

              {current.status === "awaiting_approval" && (
                <button
                  onClick={() => void act("approve", { advance: true })}
                  disabled={busy}
                  className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                  title="Aprueba este clip y pasa al siguiente · A"
                >
                  ✓ Aprobar
                </button>
              )}
              {current.status === "done" && (
                <>
                  <span className="rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300">
                    ✓ Aprobado
                  </span>
                  <button
                    onClick={() => void act("unapprove")}
                    disabled={busy}
                    className="rounded-lg border border-slate-600 px-3 py-2.5 text-sm hover:bg-slate-800 disabled:opacity-50"
                    title="Lo saca de aprobado y lo deja para volver a decidir (no regenera nada)"
                  >
                    ↩ Desaprobar
                  </button>
                </>
              )}
              {current.videoJobId && (
                <button
                  onClick={() => void act("retry", { advance: false })}
                  disabled={busy}
                  className="rounded-lg bg-red-600/90 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                  title="Vuelve a generar este clip con el mismo prompt · R"
                >
                  ✕ Rechazar y regenerar
                </button>
              )}
              <button
                onClick={() => go(1)}
                disabled={cursor >= items.length - 1}
                className="rounded-lg border border-slate-600 px-3 py-2.5 text-sm hover:bg-slate-800 disabled:opacity-40"
              >
                Siguiente →
              </button>
            </div>
          </div>

          {/* --------------------- guion + editor del clip --------------------- */}
          <ClipPanel
            item={current}
            busy={busy}
            resolutions={snap?.resolutions ?? ["720p", "1080p"]}
            onSaved={() => void load()}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------ panel del guion + editor del clip ------------------ */

/**
 * Guion del clip y editor completo: diálogo, prompt visual, duración, resolución y
 * el override del prompt final. "Guardar" persiste en el PLAN sin regenerar (el
 * export de ffmpeg lee del plan); "Guardar y regenerar" además reencola el clip.
 */
function ClipPanel({
  item,
  busy,
  resolutions,
  onSaved,
}: {
  item: DeckItem;
  busy: boolean;
  resolutions: string[];
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"guion" | "editar">("guion");
  const [dialogo, setDialogo] = useState(item.dialogo);
  const [videoPrompt, setVideoPrompt] = useState(item.videoPrompt);
  const [finalPrompt, setFinalPrompt] = useState(item.finalPrompt);
  const [duracion, setDuracion] = useState(item.duracionSeg);
  const [resolucion, setResolucion] = useState(item.resolucion);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const clipRef = useRef(`${item.projectId}:${item.clipId}`);

  // Al cambiar de clip recargamos los campos (el poll no pisa lo que estás escribiendo).
  useEffect(() => {
    const key = `${item.projectId}:${item.clipId}`;
    if (clipRef.current !== key) {
      clipRef.current = key;
      setDialogo(item.dialogo);
      setVideoPrompt(item.videoPrompt);
      setFinalPrompt(item.finalPrompt);
      setDuracion(item.duracionSeg);
      setResolucion(item.resolucion);
      setTab("guion");
      setSaved(false);
      setSaveError(null);
    }
  }, [item]);

  const dirty =
    dialogo !== item.dialogo ||
    videoPrompt.trim() !== item.videoPrompt.trim() ||
    finalPrompt.trim() !== item.finalPrompt.trim() ||
    duracion !== item.duracionSeg ||
    resolucion !== item.resolucion;

  async function save(regenerate: boolean) {
    if (!item.videoJobId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/jobs/${item.videoJobId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: videoPrompt.trim(),
          dialogue: dialogo,
          durationSec: duracion,
          resolution: resolucion,
          finalPrompt, // "" borra el override y vuelve al armado automatico
          regenerate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo guardar");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="h-fit space-y-3 rounded-xl border border-slate-800 bg-panel p-3">
      <div className="flex gap-1 rounded-lg border border-slate-800 bg-ink p-1 text-xs">
        <button
          onClick={() => setTab("guion")}
          className={`flex-1 rounded-md px-3 py-1.5 ${
            tab === "guion" ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
          }`}
        >
          Guión
        </button>
        <button
          onClick={() => setTab("editar")}
          className={`flex-1 rounded-md px-3 py-1.5 ${
            tab === "editar"
              ? "bg-accent text-white"
              : "text-slate-300 hover:bg-slate-800"
          }`}
        >
          ✎ Editar{dirty ? " ·" : ""}
        </button>
      </div>

      {tab === "guion" ? (
        <div className="space-y-3">
          <div>
            <p className="text-[11px] text-slate-500">
              Diálogo · clip #{item.orden} · {item.duracionSeg}s · {item.resolucion}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-100">
              {item.dialogo ? `“${item.dialogo}”` : (
                <span className="text-slate-500">(sin diálogo · b-roll mudo)</span>
              )}
            </p>
          </div>
          <details className="rounded-lg border border-slate-800 bg-ink p-2.5">
            <summary className="cursor-pointer text-[11px] text-slate-500">
              Prompt visual
            </summary>
            <p className="code mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">
              {item.videoPrompt}
            </p>
          </details>
          {item.finalPrompt && (
            <details className="rounded-lg border border-amber-800/60 bg-amber-500/5 p-2.5">
              <summary className="cursor-pointer text-[11px] text-amber-300">
                Prompt FINAL manual (override activo)
              </summary>
              <p className="code mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">
                {item.finalPrompt}
              </p>
            </details>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block text-[11px] text-slate-500">
            Diálogo (es-AR, no se traduce)
            <textarea
              value={dialogo}
              onChange={(e) => setDialogo(e.target.value)}
              className="mt-1 h-24 w-full resize-y rounded border border-slate-700 bg-ink p-2 text-xs leading-relaxed text-slate-100 focus:border-accent focus:outline-none"
            />
          </label>

          <label className="block text-[11px] text-slate-500">
            Prompt visual (inglés)
            <textarea
              value={videoPrompt}
              onChange={(e) => setVideoPrompt(e.target.value)}
              spellCheck={false}
              className="code mt-1 h-28 w-full resize-y rounded border border-slate-700 bg-ink p-2 text-[11px] leading-relaxed text-slate-200 focus:border-accent focus:outline-none"
            />
          </label>

          <div className="flex gap-2">
            <label className="flex-1 text-[11px] text-slate-500">
              Duración
              <select
                value={duracion}
                onChange={(e) => setDuracion(Number(e.target.value))}
                className="mt-1 w-full rounded border border-slate-700 bg-ink px-2 py-1.5 text-xs text-slate-200 focus:border-accent focus:outline-none"
              >
                {[4, 6, 8].map((d) => (
                  <option key={d} value={d}>
                    {d}s
                  </option>
                ))}
              </select>
            </label>
            <label className="flex-1 text-[11px] text-slate-500">
              Resolución
              <select
                value={resolucion}
                onChange={(e) => setResolucion(e.target.value)}
                className="mt-1 w-full rounded border border-slate-700 bg-ink px-2 py-1.5 text-xs text-slate-200 focus:border-accent focus:outline-none"
              >
                {resolutions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <details className="rounded-lg border border-slate-800 bg-ink p-2.5">
            <summary className="cursor-pointer text-[11px] text-slate-500">
              Prompt FINAL manual (avanzado)
            </summary>
            <p className="mt-1 text-[10px] text-slate-500">
              Si escribís algo acá se manda TAL CUAL a Veo y se ignora el armado
              automático (estilo UGC + lip-sync + acento argentino). Vacío = automático.
            </p>
            <textarea
              value={finalPrompt}
              onChange={(e) => setFinalPrompt(e.target.value)}
              spellCheck={false}
              placeholder="(vacío = se arma solo)"
              className="code mt-1 h-24 w-full resize-y rounded border border-slate-700 bg-panel p-2 text-[11px] leading-relaxed text-slate-200 focus:border-accent focus:outline-none"
            />
          </details>

          {saveError && (
            <p className="rounded bg-red-500/10 p-2 text-[11px] text-red-300">
              {saveError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void save(false)}
              disabled={saving || busy || !dirty || !item.videoJobId}
              className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
              title="Guarda en el plan sin regenerar el clip"
            >
              {saving ? "Guardando…" : saved ? "✓ Guardado" : "💾 Guardar"}
            </button>
            <button
              onClick={() => void save(true)}
              disabled={saving || busy || !item.videoJobId}
              className="rounded-lg bg-red-600/90 px-3 py-2 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
              title="Guarda los cambios y vuelve a generar este clip con Veo"
            >
              ↻ Guardar y regenerar
            </button>
          </div>
          <p className="text-[10px] text-slate-500">
            Regenerar consume cuota de Veo. El clip vuelve a la cola y respeta el
            ritmo de 4 por minuto.
          </p>
        </div>
      )}
    </aside>
  );
}
