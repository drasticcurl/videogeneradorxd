"use client";
/**
 * REVISION DE IMAGENES DE A UNA ("tipo tinder").
 *
 * Toma la cola de imagenes que estan esperando aprobacion en TODO el lote
 * (?ids=a,b,c) y te las muestra una por una:
 *
 *  - Si el proyecto genera varias variantes, las ves juntas y elegís cual aprobar.
 *    Rechazar rechaza TODAS (regenera la imagen completa).
 *  - Si la imagen es image2image, arriba aparecen las imagenes de referencia
 *    (la foto subida o la imagen previa) para comparar la cara.
 *  - A la derecha, el guion: todos los dialogos de los clips que usan esta imagen,
 *    con una pestaña para editarlos (se guardan en el plan).
 *
 * Atajos: → aprobar · ← rechazar y regenerar · S saltar · Z deshacer · 1-4 variante.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { BatchReviewItem, BatchSnapshot } from "@/lib/batch";

const POLL_MS = 2000;

export function ReviewDeck() {
  const searchParams = useSearchParams();
  const idsParam = searchParams.get("ids") ?? "";
  const focusId = searchParams.get("focus");

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
  /**
   * Candado SINCRONICO. El state de React se actualiza async, asi que con un click
   * + una tecla (o key repeat) se podian disparar dos acciones sobre el mismo job
   * (y rechazar dos veces = generar dos veces). Con el ref cortamos en seco.
   */
  const lockRef = useRef(false);
  /** jobs ya resueltos localmente (para pasar de card sin esperar el poll) */
  const [resolved, setResolved] = useState<string[]>([]);
  /** jobs salteados: se ven al final */
  const [skipped, setSkipped] = useState<string[]>([]);
  /** ultima aprobacion, para poder deshacerla */
  const [lastApproved, setLastApproved] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [tab, setTab] = useState<"guion" | "editar">("guion");

  const load = useCallback(async () => {
    if (ids.length === 0) return;
    try {
      const res = await fetch(`/api/batch?ids=${ids.join(",")}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo leer el lote");
      setSnap(data as BatchSnapshot);
      // Limpiamos los "resueltos" que el backend ya confirmo que salieron de la cola.
      const stillThere = new Set(
        (data as BatchSnapshot).review.map((r) => r.jobId)
      );
      setResolved((prev) => prev.filter((id) => stillThere.has(id)));
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

  /* --------------------------- cola y card actual --------------------------- */

  const queue = useMemo(() => {
    const review = snap?.review ?? [];
    const pendientes = review.filter((r) => !resolved.includes(r.jobId));
    // Si venís de un card puntual del tablero, ese proyecto va primero.
    if (focusId) {
      return [
        ...pendientes.filter((r) => r.projectId === focusId),
        ...pendientes.filter((r) => r.projectId !== focusId),
      ];
    }
    return pendientes;
  }, [snap, resolved, focusId]);

  const current = useMemo(
    () => queue.find((r) => !skipped.includes(r.jobId)) ?? null,
    [queue, skipped]
  );
  const skippedPending = queue.filter((r) => skipped.includes(r.jobId)).length;

  // Al cambiar de imagen: variante 1 seleccionada y volvemos a la pestaña del guion.
  const currentJobId = current?.jobId ?? null;
  useEffect(() => {
    setSelectedIndex(current?.variants[0]?.index ?? null);
    setTab("guion");
  }, [currentJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------- acciones ------------------------------- */

  const resolve = useCallback((jobId: string) => {
    setResolved((prev) => (prev.includes(jobId) ? prev : [...prev, jobId]));
    setSkipped((prev) => prev.filter((id) => id !== jobId));
  }, []);

  const approve = useCallback(async () => {
    if (!current || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    const jobId = current.jobId;
    try {
      const res = await fetch(`/api/jobs/${jobId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: selectedIndex ?? undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo aprobar");
      resolve(jobId);
      setLastApproved(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [current, selectedIndex, resolve, load]);

  const reject = useCallback(async () => {
    if (!current || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    const jobId = current.jobId;
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "No se pudo regenerar");
      }
      resolve(jobId);
      setLastApproved(null); // no hay nada que deshacer: ya se esta regenerando
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [current, resolve, load]);

  const undo = useCallback(async () => {
    if (!lastApproved || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${lastApproved}/unapprove`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo deshacer");
      setResolved((prev) => prev.filter((id) => id !== lastApproved));
      setLastApproved(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [lastApproved, load]);

  const skip = useCallback(() => {
    if (!current) return;
    setSkipped((prev) => [...prev, current.jobId]);
  }, [current]);

  /**
   * Reintenta las imagenes rotas del lote: las que fallaron y las que quedaron
   * colgadas en "generando" sin estar corriendo (si no, la cola no sigue sola).
   */
  const retryBroken = useCallback(async () => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: "retry-images" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo reintentar");
      if (data.batch) setSnap(data.batch as BatchSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [ids, load]);

  /* ------------------------------- teclado ------------------------------- */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      // No secuestramos las teclas mientras escribís.
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.repeat) return; // sin auto-repeat: una tecla = una decision
      if (e.key === "ArrowRight") {
        e.preventDefault();
        void approve();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        void reject();
      } else if (e.key === "s" || e.key === "S") {
        skip();
      } else if (e.key === "z" || e.key === "Z") {
        void undo();
      } else if (/^[1-4]$/.test(e.key)) {
        const idx = Number(e.key);
        if (current?.variants.some((v) => v.index === idx)) setSelectedIndex(idx);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve, reject, skip, undo, current]);

  /* ------------------------------- render ------------------------------- */

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

  const totals = snap?.totals.images;
  const stuck = totals?.stuck ?? 0;
  // "generando" real = las que estan corriendo de verdad (sin las colgadas).
  const generating = (totals?.generating ?? 0) - stuck;
  const pending = totals?.pending ?? 0;
  const broken = (totals?.failed ?? 0) + stuck;
  const backHref = `/batch?ids=${ids.join(",")}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">
            Revisar imágenes{" "}
            <span className="text-slate-500">
              ({queue.length - skippedPending} en cola
              {skippedPending > 0 ? `, ${skippedPending} salteadas` : ""})
            </span>
          </h1>
          <p className="text-xs text-slate-500">
            {totals
              ? `${totals.done}/${totals.total} aprobadas · ${generating} generando · ${pending} pendientes`
              : "Cargando…"}
            {" · "}
            <span className="text-slate-400">
              → aprobar · ← rechazar · S saltar · Z deshacer
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {broken > 0 && (
            <button
              onClick={() => void retryBroken()}
              disabled={busy}
              className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
              title="Reencola las imagenes falladas y las colgadas en 'generando'"
            >
              ↻ Reintentar {broken} rotas
            </button>
          )}
          {lastApproved && (
            <button
              onClick={() => void undo()}
              disabled={busy}
              className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
              title="Vuelve la última aprobada a la cola (no regenera nada)"
            >
              ↩ Deshacer
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

      {!current ? (
        <EmptyState
          generating={generating}
          pending={pending}
          broken={broken}
          busy={busy}
          onRetryBroken={() => void retryBroken()}
          skippedPending={skippedPending}
          onUnskip={() => setSkipped([])}
          backHref={backHref}
          allDone={Boolean(totals && totals.total > 0 && totals.done === totals.total)}
        />
      ) : (
        <ReviewCard
          item={current}
          selectedIndex={selectedIndex}
          onSelectIndex={setSelectedIndex}
          tab={tab}
          onTab={setTab}
          busy={busy}
          onApprove={() => void approve()}
          onReject={() => void reject()}
          onSkip={skip}
          onSaved={() => void load()}
          onRegenerated={(jobId) => {
            resolve(jobId);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ empty state ------------------------------ */

function EmptyState({
  generating,
  pending,
  broken,
  busy,
  onRetryBroken,
  skippedPending,
  onUnskip,
  backHref,
  allDone,
}: {
  generating: number;
  pending: number;
  broken: number;
  busy: boolean;
  onRetryBroken: () => void;
  skippedPending: number;
  onUnskip: () => void;
  backHref: string;
  allDone: boolean;
}) {
  if (skippedPending > 0) {
    return (
      <div className="space-y-3 rounded-xl border border-slate-800 bg-panel p-8 text-center">
        <p className="text-sm text-slate-300">
          Ya revisaste todo lo que había. Quedan {skippedPending} salteadas.
        </p>
        <button
          onClick={onUnskip}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          Volver a verlas
        </button>
      </div>
    );
  }
  // Nada esperando revision + nada corriendo + hay roto => la cola quedo trabada.
  if (broken > 0 && generating === 0) {
    return (
      <div className="space-y-3 rounded-xl border border-amber-800/60 bg-amber-500/5 p-8 text-center">
        <p className="text-sm text-slate-300">
          La cola se trabó: hay <b>{broken}</b> imágenes con error o colgadas en
          “generando”, y ninguna corriendo.
        </p>
        <button
          onClick={onRetryBroken}
          disabled={busy}
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
        >
          {busy ? "Reintentando…" : `↻ Reintentar las ${broken} rotas`}
        </button>
        <p className="text-xs text-slate-500">
          Se les da presupuesto de reintentos nuevo y la cola arranca de vuelta.
        </p>
      </div>
    );
  }
  if (allDone) {
    return (
      <div className="space-y-3 rounded-xl border border-emerald-800/60 bg-emerald-500/5 p-8 text-center">
        <p className="text-lg font-semibold text-emerald-300">
          ✓ Todas las imágenes aprobadas
        </p>
        <p className="text-sm text-slate-400">
          Volvé al tablero y largá la generación de videos.
        </p>
        <Link
          href={backHref}
          className="inline-block rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white hover:bg-fuchsia-500"
        >
          Ir al tablero →
        </Link>
      </div>
    );
  }
  if (generating > 0 || pending > 0) {
    return (
      <div className="space-y-2 rounded-xl border border-slate-800 bg-panel p-8 text-center">
        <p className="text-sm text-slate-300">
          <span className="animate-pulse">⏳</span> Generando… {generating} en curso,{" "}
          {pending} en fila.
        </p>
        <p className="text-xs text-slate-500">
          La próxima imagen aparece acá sola cuando termina. Dejá esta pantalla
          abierta.
        </p>
        {broken > 0 && (
          <button
            onClick={onRetryBroken}
            disabled={busy}
            className="rounded-lg border border-amber-700 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
          >
            ↻ Reintentar {broken} rotas
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-panel p-8 text-center">
      <p className="text-sm text-slate-300">No hay imágenes esperando revisión.</p>
      <Link
        href={backHref}
        className="inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
      >
        Ir al tablero →
      </Link>
    </div>
  );
}

/* ------------------------------- la card ------------------------------- */

function ReviewCard({
  item,
  selectedIndex,
  onSelectIndex,
  tab,
  onTab,
  busy,
  onApprove,
  onReject,
  onSkip,
  onSaved,
  onRegenerated,
}: {
  item: BatchReviewItem;
  selectedIndex: number | null;
  onSelectIndex: (i: number) => void;
  tab: "guion" | "editar";
  onTab: (t: "guion" | "editar") => void;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onSkip: () => void;
  onSaved: () => void;
  onRegenerated: (jobId: string) => void;
}) {
  const multi = item.variants.length > 1;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* ---------------------------- imagenes ---------------------------- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-slate-800 px-2 py-1 text-slate-300">
            {item.projectName}
          </span>
          <code className="text-slate-400">{item.imageId}</code>
          <span
            className={`rounded px-2 py-0.5 ${
              item.modo === "image2image"
                ? "bg-sky-500/20 text-sky-300"
                : "bg-slate-700 text-slate-300"
            }`}
          >
            {item.modo}
          </span>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-400">
            {item.assetTipo}
          </span>
          {item.attempts > 1 && (
            <span className="text-amber-300">intento {item.attempts}</span>
          )}
        </div>

        {/* Referencias: para image2image mostramos de donde sale la identidad. */}
        {item.refs.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-slate-800 bg-panel p-3">
            <p className="text-[11px] text-slate-500">
              Viene de {item.refs.length === 1 ? "esta referencia" : "estas referencias"}{" "}
              (tiene que ser la misma cara):
            </p>
            <div className="flex flex-wrap gap-2">
              {item.refs.map((r) => (
                <div key={r.id} className="w-24 shrink-0 space-y-1">
                  {r.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={r.url}
                      src={r.url}
                      alt={r.label}
                      className="aspect-[9/16] w-full rounded border border-slate-700 object-cover"
                    />
                  ) : (
                    <div className="flex aspect-[9/16] w-full items-center justify-center rounded border border-dashed border-slate-700 text-[10px] text-slate-500">
                      sin archivo
                    </div>
                  )}
                  <p className="truncate text-[10px] text-slate-500" title={r.label}>
                    {r.kind === "reference" ? "📷 " : "🖼 "}
                    {r.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Variantes generadas. Con 1 sola ocupa todo el ancho. */}
        <div
          className={`grid gap-3 ${multi ? "grid-cols-2" : "grid-cols-1 sm:max-w-sm"}`}
        >
          {item.variants.map((v) => {
            const active = selectedIndex === v.index;
            return (
              <button
                key={v.url}
                onClick={() => onSelectIndex(v.index)}
                className={`relative overflow-hidden rounded-lg border-2 transition ${
                  active
                    ? "border-emerald-500 ring-2 ring-emerald-500/30"
                    : "border-slate-800 hover:border-slate-600"
                }`}
                title={multi ? `Elegir variante ${v.index} (tecla ${v.index})` : ""}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={v.url}
                  src={v.url}
                  alt={`variante ${v.index}`}
                  className="aspect-[9/16] w-full bg-ink object-cover"
                />
                {multi && (
                  <span
                    className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      active
                        ? "bg-emerald-500 text-white"
                        : "bg-black/60 text-slate-200"
                    }`}
                  >
                    v{v.index} {active ? "· elegida" : ""}
                  </span>
                )}
              </button>
            );
          })}
          {item.variants.length === 0 && (
            <p className="rounded bg-amber-500/10 p-3 text-xs text-amber-300">
              No hay archivo generado para mostrar. Rechazá para volver a generarla.
            </p>
          )}
        </div>

        {item.error && (
          <p className="rounded bg-amber-500/10 p-2 text-xs text-amber-300">
            {item.error}
          </p>
        )}

        {/* --------------------------- botonera --------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onReject}
            disabled={busy}
            className="rounded-lg bg-red-600/90 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            title="Rechaza (todas las variantes) y vuelve a generar la imagen · ←"
          >
            ✕ Rechazar y regenerar
          </button>
          <button
            onClick={onApprove}
            disabled={busy || item.variants.length === 0}
            className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            title="Aprueba la variante elegida y sigue con la próxima · →"
          >
            ✓ Aprobar{multi && selectedIndex ? ` v${selectedIndex}` : ""}
          </button>
          <button
            onClick={onSkip}
            disabled={busy}
            className="rounded-lg border border-slate-600 px-3 py-2.5 text-sm hover:bg-slate-800 disabled:opacity-50"
            title="Dejarla para el final · S"
          >
            ⏭ Saltar
          </button>
        </div>
      </div>

      {/* ----------------------------- guion ----------------------------- */}
      <ScriptPanel
        item={item}
        tab={tab}
        onTab={onTab}
        busy={busy}
        onSaved={onSaved}
        onRegenerated={onRegenerated}
      />
    </div>
  );
}

/* --------------------------- panel del guion --------------------------- */

function ScriptPanel({
  item,
  tab,
  onTab,
  busy,
  onSaved,
  onRegenerated,
}: {
  item: BatchReviewItem;
  tab: "guion" | "editar";
  onTab: (t: "guion" | "editar") => void;
  busy: boolean;
  onSaved: () => void;
  onRegenerated: (jobId: string) => void;
}) {
  const [prompt, setPrompt] = useState(item.prompt);
  const [dialogues, setDialogues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const jobIdRef = useRef(item.jobId);

  // Al cambiar de imagen, recargamos los campos editables (sin pisar lo que escribís
  // mientras estás en la misma card: el poll no toca este estado).
  useEffect(() => {
    if (jobIdRef.current !== item.jobId) {
      jobIdRef.current = item.jobId;
      setPrompt(item.prompt);
      setDialogues({});
      setSaved(false);
      setSaveError(null);
    }
  }, [item.jobId, item.prompt]);

  const dialogueOf = (clipId: string, original: string) =>
    dialogues[clipId] !== undefined ? dialogues[clipId] : original;

  const promptDirty = prompt.trim() !== item.prompt.trim();
  const dialoguesDirty = item.clips.some(
    (c) => dialogueOf(c.clipId, c.dialogo) !== c.dialogo
  );
  const dirty = promptDirty || dialoguesDirty;

  /** Guarda diálogos (en el job de video de cada clip) y el prompt de la imagen. */
  async function save(regenerate: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      for (const c of item.clips) {
        const value = dialogueOf(c.clipId, c.dialogo);
        if (value === c.dialogo) continue;
        if (!c.hasJob) continue; // FILMAR_REAL: no tiene job de video
        const res = await fetch(`/api/jobs/${c.videoJobId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dialogue: value, regenerate: false }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            data.error ?? `No se pudo guardar el diálogo de "${c.clipId}"`
          );
        }
      }

      if (promptDirty || regenerate) {
        const res = await fetch(`/api/jobs/${item.jobId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompt.trim(), regenerate }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "No se pudo guardar el prompt");
        }
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      if (regenerate) onRegenerated(item.jobId);
      else onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="flex h-fit flex-col gap-3 rounded-xl border border-slate-800 bg-panel p-3">
      <div className="flex gap-1 rounded-lg border border-slate-800 bg-ink p-1 text-xs">
        <button
          onClick={() => onTab("guion")}
          className={`flex-1 rounded-md px-3 py-1.5 ${
            tab === "guion" ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
          }`}
        >
          Guión ({item.clips.length})
        </button>
        <button
          onClick={() => onTab("editar")}
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
        <div className="space-y-2">
          {item.clips.length === 0 ? (
            <p className="text-xs text-slate-500">
              Ningún clip usa esta imagen todavía.
            </p>
          ) : (
            item.clips.map((c) => (
              <div
                key={c.clipId}
                className="space-y-1 rounded-lg border border-slate-800 bg-ink p-2.5"
              >
                <div className="flex items-center justify-between text-[10px] text-slate-500">
                  <span>
                    #{c.orden} · {c.clipId}
                  </span>
                  <span>
                    {c.duracionSeg}s
                    {c.etiqueta === "FILMAR_REAL" ? " · a filmar" : ""}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
                  {c.dialogo ? `“${c.dialogo}”` : (
                    <span className="text-slate-500">(sin diálogo · b-roll mudo)</span>
                  )}
                </p>
              </div>
            ))
          )}
          <details className="rounded-lg border border-slate-800 bg-ink p-2.5">
            <summary className="cursor-pointer text-[11px] text-slate-500">
              Prompt visual de la imagen
            </summary>
            <p className="code mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">
              {item.prompt}
            </p>
          </details>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block text-[11px] text-slate-500">
            Prompt visual (inglés)
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              spellCheck={false}
              className="code mt-1 h-28 w-full resize-y rounded border border-slate-700 bg-ink p-2 text-[11px] leading-relaxed text-slate-200 focus:border-accent focus:outline-none"
            />
          </label>

          {item.clips.map((c) => (
            <label key={c.clipId} className="block text-[11px] text-slate-500">
              Diálogo #{c.orden} · {c.clipId} ({c.duracionSeg}s)
              {!c.hasJob && (
                <span className="ml-1 text-fuchsia-300">
                  · clip a filmar, no editable acá
                </span>
              )}
              <textarea
                value={dialogueOf(c.clipId, c.dialogo)}
                onChange={(e) =>
                  setDialogues((prev) => ({ ...prev, [c.clipId]: e.target.value }))
                }
                readOnly={!c.hasJob}
                className="mt-1 h-20 w-full resize-y rounded border border-slate-700 bg-ink p-2 text-xs leading-relaxed text-slate-200 focus:border-accent focus:outline-none read-only:opacity-60"
              />
            </label>
          ))}

          {saveError && (
            <p className="rounded bg-red-500/10 p-2 text-[11px] text-red-300">
              {saveError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void save(false)}
              disabled={saving || busy || !dirty}
              className="rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
              title="Guarda en el plan sin volver a generar (el export de ffmpeg lee del plan)"
            >
              {saving ? "Guardando…" : saved ? "✓ Guardado" : "💾 Guardar"}
            </button>
            <button
              onClick={() => void save(true)}
              disabled={saving || busy}
              className="rounded-lg border border-slate-600 px-3 py-2 text-xs hover:bg-slate-800 disabled:opacity-50"
              title="Guarda y vuelve a generar la imagen con el prompt nuevo"
            >
              ↻ Guardar y regenerar
            </button>
          </div>
          <p className="text-[10px] text-slate-500">
            Los diálogos se guardan en el plan (no regeneran nada: los videos todavía
            no se generaron). El prompt visual sí afecta la imagen.
          </p>
        </div>
      )}
    </aside>
  );
}
