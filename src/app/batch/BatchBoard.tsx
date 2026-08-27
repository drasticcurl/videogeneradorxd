"use client";
/**
 * TABLERO DEL LOTE (bento grid).
 *
 * Muestra todos los proyectos del lote (los ids viajan en la URL: ?ids=a,b,c) con
 * su progreso, y desde aca se maneja el flujo en DOS FASES:
 *
 *   1) "Comenzar generación de imágenes": encola todos en fase imagenes con
 *      aprobacion manual. Los videos NO se generan todavia.
 *   2) Revisás las imagenes de a una en /batch/review (aprobar / rechazar).
 *   3) Cuando estan todas aprobadas: "Comenzar generación de videos". Ahi cada card
 *      muestra la linea de tiempo completa del video.
 *
 * La concurrencia de la cola es GLOBAL (PIPELINE_CONCURRENCY), asi que tener 5
 * proyectos activos genera el mismo rate de requests que tener 1.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { BatchCounts, BatchProject, BatchSnapshot } from "@/lib/batch";
import { StatusBadge } from "@/components/StatusBadge";
import { ClipTimeline } from "./ClipTimeline";

interface ProjectOption {
  id: string;
  name: string;
  status: string;
  clipCount: number;
  imageCount: number;
  createdAt: string;
}

const POLL_MS = 2500;

export function BatchBoard() {
  const router = useRouter();
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
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<ProjectOption[]>([]);
  // Default OFF: cada clip espera tu aprobacion y lo revisás en /batch/videos,
  // donde además podés editar el prompt y el diálogo antes de regenerarlo.
  const [autoApproveVideos, setAutoApproveVideos] = useState(false);

  const load = useCallback(async () => {
    if (ids.length === 0) {
      setSnap(null);
      return;
    }
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

  // Lista de proyectos para el selector "agregar al tablero".
  const loadOptions = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setOptions(data.projects ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (pickerOpen || ids.length === 0) void loadOptions();
  }, [pickerOpen, ids.length, loadOptions]);

  function setIds(next: string[]) {
    const unique = Array.from(new Set(next.filter(Boolean)));
    router.replace(unique.length > 0 ? `/batch?ids=${unique.join(",")}` : "/batch");
  }

  async function action(
    kind:
      | "start-images"
      | "start-videos"
      | "pause"
      | "resume"
      | "retry-images"
      | "retry-videos"
      | "approve-videos",
    targetIds: string[] = ids
  ) {
    if (targetIds.length === 0) return;
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: targetIds,
          action: kind,
          autoApproveVideos,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "La accion fallo");
      if (data.batch) setSnap(data.batch as BatchSnapshot);
      if (kind === "approve-videos") {
        const n = Number(data.requeued ?? 0);
        setNote(n > 0 ? `✓ Aprobé ${n} clips.` : "No había clips esperando aprobación.");
        setTimeout(() => setNote(null), 5000);
      }
      if (kind === "retry-images" || kind === "retry-videos") {
        const n = Number(data.requeued ?? 0);
        setNote(
          n > 0
            ? `↻ Reencolé ${n} ${kind === "retry-images" ? "imágenes" : "clips"}. Ya están generándose de nuevo.`
            : "No había nada roto para reintentar."
        );
        setTimeout(() => setNote(null), 5000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      void load();
    }
  }

  const projects = snap?.projects ?? [];
  const totals = snap?.totals;
  const awaiting = totals?.images.awaiting ?? 0;
  const imagesStarted = (totals?.images.total ?? 0) > 0;
  const imagesLeft =
    (totals?.images.pending ?? 0) + (totals?.images.generating ?? 0) + awaiting;
  const allImagesReady =
    projects.length > 0 && projects.every((p) => p.imagesReady);
  const anyVideoStage = projects.some((p) => p.stage === "videos");
  // Proyectos que todavia NO pasaron a fase videos. Se usa para las dos acciones:
  //  - start-videos: solo los que faltan (no re-largar los que ya estan corriendo).
  //  - start-images: NUNCA tocar uno que ya esta en fase videos (lo frenaria).
  const videoCandidates = projects
    .filter((p) => p.stage !== "videos")
    .map((p) => p.id);
  const imageTargets = snap ? videoCandidates : ids;

  // Roto = fallado + colgado en "generating" sin estar corriendo de verdad.
  const brokenImages = (totals?.images.failed ?? 0) + (totals?.images.stuck ?? 0);
  const brokenVideos = (totals?.videos.failed ?? 0) + (totals?.videos.stuck ?? 0);
  const brokenImageIds = projects
    .filter((p) => p.images.failed + p.images.stuck > 0)
    .map((p) => p.id);
  const brokenVideoIds = projects
    .filter((p) => p.videos.failed + p.videos.stuck > 0)
    .map((p) => p.id);

  const videosAwaiting = totals?.videos.awaiting ?? 0;
  // Clips que ya tienen archivo (o esperan aprobacion): hay algo para mirar.
  const clipsWithFile = (totals?.videos.done ?? 0) + videosAwaiting;
  const videoRate = snap?.videoRate ?? { max: 4, windowMs: 60000 };
  // Se pueden largar videos si hay al menos una imagen aprobada y clips por hacer.
  const canStartVideos =
    videoCandidates.length > 0 &&
    (totals?.images.done ?? 0) > 0 &&
    (totals?.videos.total ?? 0) > (totals?.videos.done ?? 0);

  /* ------------------------------ sin lote ------------------------------ */
  if (ids.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-bold">Tablero de lote</h1>
          <p className="text-sm text-slate-400">
            Elegí los proyectos que querés manejar juntos: generás las imágenes de
            todos, las revisás de a una, y recién después largás los videos.
          </p>
        </div>
        <ProjectPicker
          options={options}
          selected={[]}
          onConfirm={(sel) => setIds(sel)}
          onCancel={() => router.push("/")}
          confirmLabel="Armar tablero"
        />
      </div>
    );
  }

  /* ------------------------------ tablero ------------------------------ */
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            Tablero de lote{" "}
            <span className="text-slate-500">({projects.length} proyectos)</span>
          </h1>
          <p className="text-sm text-slate-400">
            {!imagesStarted ? (
              <>
                Todavía no arrancó nada. Dale a{" "}
                <b>Comenzar generación de imágenes</b> y revisá de a una.
              </>
            ) : allImagesReady && !anyVideoStage ? (
              <>
                ✓ Todas las imágenes aprobadas. Ya podés largar los videos.
              </>
            ) : (
              <>
                Imágenes: {totals?.images.done ?? 0}/{totals?.images.total ?? 0}{" "}
                aprobadas ·{" "}
                {(totals?.images.generating ?? 0) - (totals?.images.stuck ?? 0)}{" "}
                generando · {awaiting} esperando tu ojo
                {brokenImages > 0 && (
                  <span className="text-amber-300"> · {brokenImages} rotas</span>
                )}
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {awaiting > 0 && (
            <Link
              href={`/batch/review?ids=${ids.join(",")}`}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              🃏 Revisar imágenes ({awaiting})
            </Link>
          )}
          {clipsWithFile > 0 && (
            <Link
              href={`/batch/videos?ids=${ids.join(",")}`}
              className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                videosAwaiting > 0
                  ? "bg-indigo-600 text-white hover:bg-indigo-500"
                  : "border border-slate-700 text-slate-300 hover:bg-slate-800"
              }`}
              title="Ver los clips uno por uno, con el diálogo al lado, y aprobar o regenerar"
            >
              🎞 Revisar clips
              {videosAwaiting > 0 ? ` (${videosAwaiting} por aprobar)` : ""}
            </Link>
          )}
          {videosAwaiting > 0 && (
            <button
              onClick={() => void action("approve-videos")}
              disabled={busy !== null}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              title="Aprueba de una todos los clips que están esperando"
            >
              {busy === "approve-videos"
                ? "Aprobando…"
                : `✓ Aprobar todos los clips (${videosAwaiting})`}
            </button>
          )}
          {brokenImages > 0 && (
            <button
              onClick={() => void action("retry-images", brokenImageIds)}
              disabled={busy !== null}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
              title="Reencola las imagenes que fallaron y las que quedaron colgadas en 'generando' (se les da presupuesto de reintentos nuevo)"
            >
              {busy === "retry-images"
                ? "Reintentando…"
                : `↻ Reintentar imágenes con error (${brokenImages})`}
            </button>
          )}
          {brokenVideos > 0 && (
            <button
              onClick={() => void action("retry-videos", brokenVideoIds)}
              disabled={busy !== null}
              className="rounded-lg border border-amber-700 px-3 py-2 text-sm text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
              title="Reencola los clips que fallaron o quedaron colgados"
            >
              {busy === "retry-videos"
                ? "Reintentando…"
                : `↻ Reintentar videos (${brokenVideos})`}
            </button>
          )}
          {(imagesLeft > 0 || !imagesStarted) && imageTargets.length > 0 ? (
            <button
              onClick={() => void action("start-images", imageTargets)}
              disabled={busy !== null}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              title="Encola todos los proyectos en fase imagenes (los videos quedan frenados)"
            >
              {busy === "start-images"
                ? "Arrancando…"
                : imagesStarted
                ? "▶ Seguir con las imágenes"
                : "▶ Comenzar generación de imágenes"}
            </button>
          ) : null}
          {canStartVideos && (
            <button
              onClick={() => {
                // Si todavia hay imagenes sin aprobar, esos clips no se van a generar
                // (dependen de su imagen): avisamos antes de largar.
                if (!allImagesReady) {
                  const ok = window.confirm(
                    `Todavía hay imágenes sin aprobar. Los clips de esas imágenes no se van a generar hasta que las apruebes.\n\n` +
                      `¿Largo los videos de las que ya están aprobadas?`
                  );
                  if (!ok) return;
                }
                void action("start-videos", videoCandidates);
              }}
              disabled={busy !== null}
              className="rounded-lg bg-fuchsia-600 px-4 py-2 text-sm font-semibold text-white hover:bg-fuchsia-500 disabled:opacity-50"
              title={`Libera los clips: se generan con Veo de a ${videoRate.max} cada ${Math.round(
                videoRate.windowMs / 1000
              )}s`}
            >
              {busy === "start-videos" ? "Arrancando…" : "🎬 Comenzar generación de videos"}
            </button>
          )}
          <button
            onClick={() => void action("pause")}
            disabled={busy !== null}
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            ⏸ Pausar
          </button>
          <button
            onClick={() => void action("resume")}
            disabled={busy !== null}
            className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
          >
            ▶ Reanudar
          </button>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            ＋ Proyectos
          </button>
        </div>
      </div>

      {/* Nota de fase videos: hoy los clips se aprueban solos (la revision de video
          de a uno viene despues). El check deja elegirlo antes de arrancar. */}
      {canStartVideos && (
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-panel px-3 py-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={autoApproveVideos}
            onChange={(e) => setAutoApproveVideos(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          <span>
            Aprobar los videos solos al terminar. <b>Apagado</b> (recomendado): cada
            clip queda esperándote en <b>🎞 Revisar clips</b>, donde lo ves con el
            diálogo al lado y podés editarle el prompt antes de regenerarlo. Tildalo
            solo si querés dejarlo correr de largo sin revisar nada.
            <span className="mt-0.5 block text-[11px] text-slate-500">
              Ritmo de Veo: <b>{videoRate.max} clips cada{" "}
              {Math.round(videoRate.windowMs / 1000)}s</b> (ventana deslizante). Si
              uno falla por cuota o red, vuelve solo a la cola y se reintenta más
              tarde. Se ajusta con <code>PIPELINE_VIDEO_RATE_MAX</code> y{" "}
              <code>PIPELINE_VIDEO_RATE_WINDOW_MS</code>.
            </span>
          </span>
        </label>
      )}

      {error && (
        <p className="rounded bg-red-500/10 p-2 text-sm text-red-300">{error}</p>
      )}

      {note && (
        <p className="rounded bg-emerald-500/10 p-2 text-sm text-emerald-300">
          {note}
        </p>
      )}

      {(totals?.images.stuck ?? 0) > 0 && (
        <p className="rounded bg-amber-500/10 p-2 text-xs text-amber-300">
          Hay {totals?.images.stuck} imágenes colgadas en “generando” que en realidad
          no están corriendo (pasa cuando se reinicia el server). Dale a{" "}
          <b>Reintentar imágenes con error</b> y salen solas.
        </p>
      )}

      {snap && snap.missingIds.length > 0 && (
        <p className="rounded bg-amber-500/10 p-2 text-xs text-amber-300">
          Estos proyectos ya no existen (los borraste):{" "}
          <code>{snap.missingIds.join(", ")}</code>{" "}
          <button
            onClick={() => setIds(ids.filter((id) => !snap.missingIds.includes(id)))}
            className="underline hover:text-amber-200"
          >
            quitarlos del tablero
          </button>
        </p>
      )}

      {pickerOpen && (
        <ProjectPicker
          options={options}
          selected={ids}
          onConfirm={(sel) => {
            setIds(sel);
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
          confirmLabel="Actualizar tablero"
        />
      )}

      {/* Bento: la primera card ocupa el doble de ancho, el resto entra en la grilla. */}
      <div className="grid auto-rows-min gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p, i) => (
          <ProjectCard
            key={p.id}
            project={p}
            wide={i % 5 === 0}
            ids={ids}
            busy={busy !== null}
            onStartImages={() => void action("start-images", [p.id])}
            onRetryImages={() => void action("retry-images", [p.id])}
            onRetryVideos={() => void action("retry-videos", [p.id])}
            onRemove={() => setIds(ids.filter((id) => id !== p.id))}
          />
        ))}
      </div>

      {projects.length === 0 && !error && (
        <p className="text-sm text-slate-500">Cargando proyectos del lote…</p>
      )}
    </div>
  );
}

/* -------------------------------- card -------------------------------- */

function ProjectCard({
  project: p,
  wide,
  ids,
  busy,
  onStartImages,
  onRetryImages,
  onRetryVideos,
  onRemove,
}: {
  project: BatchProject;
  wide: boolean;
  ids: string[];
  busy: boolean;
  onStartImages: () => void;
  onRetryImages: () => void;
  onRetryVideos: () => void;
  onRemove: () => void;
}) {
  const totalSeconds = p.timeline.reduce((a, c) => a + c.duracionSeg, 0);
  return (
    <article
      className={`relative flex flex-col gap-3 overflow-hidden rounded-xl border border-slate-800 bg-panel p-4 ${
        wide ? "lg:col-span-2" : ""
      }`}
    >
      {/* Miniatura de fondo: la ultima imagen aprobada. */}
      {p.thumbUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={p.thumbUrl}
          src={p.thumbUrl}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-10"
        />
      )}

      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{p.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={p.status} />
            {p.stage && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  p.stage === "images"
                    ? "bg-sky-500/20 text-sky-300"
                    : "bg-fuchsia-500/20 text-fuchsia-300"
                }`}
              >
                fase {p.stage === "images" ? "imágenes" : "videos"}
              </span>
            )}
            {p.imageVariants > 1 && (
              <span className="rounded-full bg-slate-700 px-2 py-0.5 text-[10px] text-slate-300">
                {p.imageVariants} variantes
              </span>
            )}
          </div>
        </div>
        <button
          onClick={onRemove}
          title="Quitar del tablero (no borra el proyecto)"
          className="shrink-0 rounded px-1.5 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
        >
          ✕
        </button>
      </div>

      <div className="relative space-y-2">
        <Progress label="Imágenes" counts={p.images} tone="emerald" />
        {p.videos.total > 0 &&
          (p.stage === "videos" ||
            p.videos.done > 0 ||
            p.videos.awaiting > 0) && (
            <Progress label="Videos" counts={p.videos} tone="fuchsia" />
          )}
      </div>

      {p.timeline.length > 0 && (
        <div className="relative">
          <ClipTimeline items={p.timeline} totalSeconds={totalSeconds} />
        </div>
      )}

      <div className="relative mt-auto flex flex-wrap items-center gap-2 text-xs">
        {p.images.awaiting > 0 && (
          <Link
            href={`/batch/review?ids=${ids.join(",")}&focus=${p.id}`}
            className="rounded-md bg-indigo-600 px-2.5 py-1.5 font-medium text-white hover:bg-indigo-500"
          >
            🃏 Revisar ({p.images.awaiting})
          </Link>
        )}
        {p.images.total === 0 && (
          <button
            onClick={onStartImages}
            disabled={busy}
            className="rounded-md bg-emerald-600 px-2.5 py-1.5 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            ▶ Arrancar imágenes
          </button>
        )}
        {p.images.failed + p.images.stuck > 0 && (
          <button
            onClick={onRetryImages}
            disabled={busy}
            className="rounded-md bg-amber-600 px-2.5 py-1.5 font-medium text-white hover:bg-amber-500 disabled:opacity-50"
            title="Reencola las imagenes falladas y las colgadas de ESTE proyecto"
          >
            ↻ Reintentar {p.images.failed + p.images.stuck}{" "}
            {p.images.stuck > 0 && p.images.failed === 0 ? "colgadas" : "con error"}
          </button>
        )}
        {p.videos.failed + p.videos.stuck > 0 && (
          <button
            onClick={onRetryVideos}
            disabled={busy}
            className="rounded-md border border-amber-700 px-2.5 py-1.5 text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
            title="Reencola los clips fallados y los colgados de ESTE proyecto"
          >
            ↻ Reintentar {p.videos.failed + p.videos.stuck} clips
          </button>
        )}
        <Link
          href={`/project/${p.id}/pipeline`}
          className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-300 hover:bg-slate-800"
        >
          Pipeline →
        </Link>
        {p.videos.done + p.videos.awaiting > 0 && (
          <Link
            href={`/batch/videos?ids=${p.id}`}
            className={`rounded-md px-2.5 py-1.5 font-medium ${
              p.videos.awaiting > 0
                ? "bg-indigo-600 text-white hover:bg-indigo-500"
                : "border border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
          >
            🎞 Clips
            {p.videos.awaiting > 0 ? ` (${p.videos.awaiting})` : ""}
          </Link>
        )}
        {p.videos.done > 0 && (
          <Link
            href={`/project/${p.id}/result`}
            className="rounded-md border border-slate-700 px-2.5 py-1.5 text-slate-300 hover:bg-slate-800"
          >
            Resultado →
          </Link>
        )}
      </div>
    </article>
  );
}

function Progress({
  label,
  counts,
  tone,
}: {
  label: string;
  counts: BatchCounts;
  tone: "emerald" | "fuchsia";
}) {
  const pct =
    counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;
  const bar = tone === "emerald" ? "bg-emerald-500" : "bg-fuchsia-500";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>
          {label} · {counts.done}/{counts.total}
        </span>
        <span className="flex gap-1.5">
          {counts.generating - counts.stuck > 0 && (
            <span className="text-amber-300">
              {counts.generating - counts.stuck} generando
            </span>
          )}
          {counts.stuck > 0 && (
            <span className="text-orange-400" title="Colgadas: no están corriendo de verdad">
              {counts.stuck} colgadas
            </span>
          )}
          {counts.awaiting > 0 && (
            <span className="text-indigo-300">{counts.awaiting} aprobar</span>
          )}
          {counts.failed > 0 && (
            <span className="text-red-300">{counts.failed} error</span>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------- picker ------------------------------- */

function ProjectPicker({
  options,
  selected,
  onConfirm,
  onCancel,
  confirmLabel,
}: {
  options: ProjectOption[];
  selected: string[];
  onConfirm: (ids: string[]) => void;
  onCancel: () => void;
  confirmLabel: string;
}) {
  const [sel, setSel] = useState<string[]>(selected);
  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-panel p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Proyectos del tablero</h3>
        <span className="text-xs text-slate-500">{sel.length} elegidos</span>
      </div>
      {options.length === 0 ? (
        <p className="text-xs text-slate-500">
          No hay proyectos todavía. Importá una carpeta de PlanJSON desde{" "}
          <Link href="/" className="text-accent hover:underline">
            Nuevo proyecto
          </Link>
          .
        </p>
      ) : (
        <div className="max-h-64 divide-y divide-slate-800 overflow-y-auto rounded-md border border-slate-700">
          {options.map((o) => {
            const checked = sel.includes(o.id);
            return (
              <label
                key={o.id}
                className="flex cursor-pointer items-center gap-3 px-3 py-2 text-xs hover:bg-slate-800/50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    setSel((prev) =>
                      e.target.checked
                        ? [...prev, o.id]
                        : prev.filter((id) => id !== o.id)
                    )
                  }
                  className="h-4 w-4 accent-accent"
                />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="shrink-0 text-slate-500">
                  {o.imageCount} img · {o.clipCount} clips
                </span>
              </label>
            );
          })}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => onConfirm(sel)}
          disabled={sel.length === 0}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {confirmLabel}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
