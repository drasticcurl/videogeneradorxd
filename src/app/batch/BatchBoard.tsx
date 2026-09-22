"use client";
/**
 * TABLERO DEL LOTE.
 *
 * Muestra todos los proyectos del lote (los ids viajan en la URL: ?ids=a,b,c) con
 * su progreso, y desde aca se maneja el flujo en DOS FASES:
 *
 *   1) "Comenzar imágenes": encola todos en fase imagenes con aprobacion manual.
 *      Los videos NO se generan todavia.
 *   2) Revisás las imagenes de a una en /batch/review (aprobar / rechazar).
 *   3) Cuando estan todas aprobadas: "Comenzar videos". Ahi cada card muestra la
 *      linea de tiempo completa del video.
 *
 * La concurrencia de la cola es GLOBAL (PIPELINE_CONCURRENCY), asi que tener 5
 * proyectos activos genera el mismo rate de requests que tener 1.
 *
 * ─── REDISEÑO (handoff design_handoff_rediseno_augc, pantalla "Tablero") ─────
 *
 * El handoff pide dos cards de totales (Imágenes / Videos) con las acciones del
 * LOTE adentro de cada una, y una TABLA de proyectos en vez de la grilla de cards
 * de T07. Es un cambio de forma, no de dato: las dos cards resumen exactamente los
 * mismos `totals.images` / `totals.videos` que ya devuelve `/api/batch`, y la tabla
 * lista los mismos `projects` con las mismas columnas de siempre (nombre, estado,
 * timeline, contadores, quitar). Se sigue usando `MiniTimeline` (ya migrado a
 * tokens) en vez de `ClipTimeline` local, que es lo que unifica el bloque de la
 * timeline con el resto de la app (home, videos, tablero: un solo componente).
 *
 * El "proyecto activo" y su panel grande de T07 se sacan: la tabla ya muestra el
 * progreso de TODOS los proyectos de un vistazo (esa es la idea del handoff, ver un
 * tablero como tabla), y con una fila por proyecto no hace falta elegir uno para
 * verlo en detalle — el link de "nombre" ya lleva al pipeline si hace falta más
 * detalle. Esto simplifica el estado local (se elimina `activoId`) sin tocar NINGUN
 * fetch ni payload.
 *
 * ─── LO QUE NO CAMBIO ────────────────────────────────────────────────────────
 *
 * El rediseño es VISUAL. `load`, `loadOptions`, `setIds` y `action` son los mismos,
 * con los mismos dos endpoints (`/api/batch` y `/api/projects`), los mismos payloads
 * y los mismos derivados. El parametro de la URL sigue siendo `ids`, y los links a
 * /batch/review y /batch/videos siguen usando `ids` y `focus`.
 *
 * El unico cambio de comportamiento (ya existía, se conserva): el `window.confirm`
 * de "largo los videos con imagenes sin aprobar" es el `Confirmar` del sistema
 * (mismo guard, misma condicion, mismo resultado).
 */
import {
  ArrowsClockwise,
  Cards,
  Check,
  FilmSlate,
  FilmStrip,
  Kanban,
  Pause,
  Play,
  Plus,
  Warning,
  X,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { MiniTimeline } from "@/components/MiniTimeline";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Confirmar,
  Dialog,
  DialogContent,
  EmptyState,
  Skeleton,
} from "@/components/ui";
import type { BatchCounts, BatchProject, BatchSnapshot } from "@/lib/batch";
import { cn } from "@/lib/cn";
import { estadoDeJob, type Tone } from "@/lib/ui-tokens";

interface ProjectOption {
  id: string;
  name: string;
  status: string;
  clipCount: number;
  imageCount: number;
  createdAt: string;
}

const POLL_MS = 2500;

/** Estado de la lista de proyectos disponibles. Sin esto "cargando" y "no hay" se ven igual. */
type CargaOpciones = "cargando" | "listo" | "error";

/**
 * Tono -> relleno de la barra y del punto de la leyenda.
 *
 * Mismo patron que `LogPanel` (texto) y `JobCard` (icono): el ESTADO se traduce a
 * tono en `ui-tokens`, y aca solo se elige la clase de ese tono. Ni un color
 * literal, y el tramo de un estado sale del mismo color que su badge.
 */
const RELLENO: Record<Tone, string> = {
  neutral: "bg-surface-hi",
  info: "bg-info",
  attention: "bg-accent",
  ok: "bg-ok",
  danger: "bg-danger",
};

/** Tono -> fondo y texto de un aviso de bloque. Ver P-14: no hay primitiva. */
const AVISO: Record<Tone, string> = {
  neutral: "bg-surface-hi text-fg-dim",
  info: "bg-info/10 text-info",
  attention: "bg-accent/10 text-accent",
  ok: "bg-ok/10 text-ok",
  danger: "bg-danger/10 text-danger",
};

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
  const [cargaOpciones, setCargaOpciones] = useState<CargaOpciones>("cargando");
  /** Pedido de confirmacion para largar videos con imagenes sin aprobar. */
  const [confirmarVideos, setConfirmarVideos] = useState(false);
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
    setCargaOpciones("cargando");
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      setOptions(data.projects ?? []);
      setCargaOpciones("listo");
    } catch {
      // Antes se tragaba en silencio y la lista quedaba vacia, que era
      // indistinguible de "no hay ningun proyecto todavia".
      setCargaOpciones("error");
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
        setNote(n > 0 ? `Aprobé ${n} clips.` : "No había clips esperando aprobación.");
        setTimeout(() => setNote(null), 5000);
      }
      if (kind === "retry-images" || kind === "retry-videos") {
        const n = Number(data.requeued ?? 0);
        setNote(
          n > 0
            ? `Reencolé ${n} ${kind === "retry-images" ? "imágenes" : "clips"}. Ya están generándose de nuevo.`
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

  const puedeSeguirImagenes =
    (imagesLeft > 0 || !imagesStarted) && imageTargets.length > 0;
  /** Todo lo que espera una decision tuya, que es lo que se lleva el acento (D6). */
  const teToca =
    awaiting > 0 || clipsWithFile > 0 || brokenImages > 0 || brokenVideos > 0;


  /* ------------------------------ sin lote ------------------------------ */
  if (ids.length === 0) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-display font-semibold text-fg">Tablero de lote</h1>
          <p className="mt-1 max-w-prose text-body text-fg-dim">
            Elegí los proyectos que querés manejar juntos: generás las imágenes de
            todos, las revisás de a una, y recién después largás los videos.
          </p>
        </header>

        {cargaOpciones === "cargando" ? (
          <Card className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </Card>
        ) : cargaOpciones === "error" ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-danger/10 p-3">
            <p role="alert" className="text-body text-danger">
              No se pudo leer la lista de proyectos. Los que ya existen siguen ahí.
            </p>
            <Button size="sm" onClick={() => void loadOptions()}>
              Reintentar
            </Button>
          </div>
        ) : options.length === 0 ? (
          <EmptyState
            icon={<Kanban className="size-6" aria-hidden />}
            title="Todavía no hay ningún proyecto"
            body="El tablero junta proyectos que ya existen. Importá una carpeta de PlanJSON o armá uno desde un brief, y volvé acá para manejarlos en lote."
            action={{
              label: "Ir a Nuevo proyecto",
              onClick: () => router.push("/"),
            }}
          />
        ) : (
          <Card className="space-y-3">
            <CardHeader className="mb-0">
              <div className="min-w-0">
                <CardTitle>Armar el tablero</CardTitle>
                <CardDescription className="mt-1">
                  Tildá los proyectos que van al lote. No se genera nada todavía.
                </CardDescription>
              </div>
            </CardHeader>
            <ProjectPicker
              options={options}
              selected={[]}
              onConfirm={(sel) => setIds(sel)}
              onCancel={() => router.push("/")}
              confirmLabel="Armar tablero"
            />
          </Card>
        )}
      </div>
    );
  }

  /* ------------------------------ tablero ------------------------------ */
  return (
    <div className="space-y-5">
      {/* ─────────────── encabezado: identidad del lote y botón de sumar ─────── */}
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-display font-semibold text-fg">
            Tablero de lote{" "}
            <span className="code tnum text-fg-dim">{projects.length}</span>{" "}
            <span className="text-title font-normal text-fg-dim">
              {projects.length === 1 ? "proyecto" : "proyectos"}
            </span>
          </h1>
          <p className="mt-1 max-w-prose text-body text-fg-dim">
            {!imagesStarted ? (
              <>
                Todavía no arrancó nada. Dale a{" "}
                <b className="font-medium text-fg">Comenzar imágenes</b> y revisá de a
                una.
              </>
            ) : allImagesReady && !anyVideoStage ? (
              <>Todas las imágenes aprobadas. Ya podés largar los videos.</>
            ) : (
              <>
                <span className="code tnum text-fg">{totals?.images.done ?? 0}</span>
                <span className="code tnum">/{totals?.images.total ?? 0}</span>{" "}
                imágenes aprobadas ·{" "}
                <span className="code tnum text-fg">
                  {(totals?.images.generating ?? 0) - (totals?.images.stuck ?? 0)}
                </span>{" "}
                generando ·{" "}
                <span className="code tnum text-fg">{awaiting}</span> esperando tu ojo
                {brokenImages > 0 && (
                  <>
                    {" · "}
                    <span className="code tnum text-danger">{brokenImages}</span>{" "}
                    <span className="text-danger">rotas</span>
                  </>
                )}
              </>
            )}
          </p>
        </div>

        {/*
          El handoff deja "Sumar proyectos" como la unica accion del encabezado:
          arrancar/pausar/reanudar/reintentar se mudan a las cards de totales, que es
          donde el handoff las pide agrupadas por Imagenes/Videos. Mismo `action()`,
          mismos payloads — solo cambio de UBICACION del boton.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              icon={<Pause className="size-3.5" aria-hidden />}
              loading={busy === "pause"}
              disabled={busy !== null}
              onClick={() => void action("pause")}
            >
              Pausar
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Play className="size-3.5" aria-hidden />}
              loading={busy === "resume"}
              disabled={busy !== null}
              onClick={() => void action("resume")}
            >
              Reanudar
            </Button>
          </div>
          <Button
            icon={<Plus className="size-4" aria-hidden />}
            onClick={() => setPickerOpen(true)}
          >
            Sumar proyectos
          </Button>
        </div>
      </header>

      {/* ─────────────────────────────── avisos ─────────────────────────────── */}
      {error && (
        <Aviso tone="danger" rol="alert" icon={<Warning className="size-4" aria-hidden />}>
          {error}
        </Aviso>
      )}

      {note && (
        <Aviso tone="ok" rol="status" icon={<Check className="size-4" aria-hidden />}>
          {note}
        </Aviso>
      )}

      {(totals?.images.stuck ?? 0) > 0 && (
        <Aviso tone="attention" icon={<Warning className="size-4" aria-hidden />}>
          Hay <span className="code tnum">{totals?.images.stuck}</span> imágenes
          colgadas en “generando” que en realidad no están corriendo (pasa cuando se
          reinicia el server). Dale a{" "}
          <b className="font-medium">Reintentar imágenes</b> y salen solas.
        </Aviso>
      )}

      {snap && snap.missingIds.length > 0 && (
        <Aviso tone="attention" icon={<Warning className="size-4" aria-hidden />}>
          {/*
            Texto NEUTRO a proposito. Esta lista mezcla proyectos borrados con
            proyectos de otro usuario (D6/D7 del plan de aislamiento-por-usuario): un
            id ajeno y uno inexistente devuelven la misma respuesta del server, y el
            cartel no puede decir mas que eso sin filtrar cual es cual. "Los borraste"
            era falso para el segundo caso; "no son tuyos" confirmaria que el proyecto
            existe (rompe D4). No le agregues el motivo.
          */}
          Estos proyectos no están disponibles en este tablero:{" "}
          <code className="code">{snap.missingIds.join(", ")}</code>{" "}
          <button
            type="button"
            onClick={() => setIds(ids.filter((id) => !snap.missingIds.includes(id)))}
            className="rounded-sm underline transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            quitarlos del tablero
          </button>
        </Aviso>
      )}

      {/* ─────────────── dos cards de totales: Imágenes y Videos ─────────────── */}
      {/*
        Pedido del handoff: cada card resume UN contador global (`totals.images` /
        `totals.videos`, que ya calcula `/api/batch`) y trae adentro las acciones que
        antes vivian sueltas en el encabezado o en la barra de "te toca a vos". Mismo
        dato, mismo endpoint — la accion sigue siendo `action(kind, targetIds)`.
      */}
      {snap === null && !error ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-1.5 w-full" />
          </Card>
          <Card className="space-y-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-1.5 w-full" />
          </Card>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <CardTotal
            titulo="Imágenes"
            counts={totals?.images ?? emptyCounts()}
            tono="info"
            acciones={
              <>
                {awaiting > 0 && (
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/batch/review?ids=${ids.join(",")}`}>
                      <Cards className="size-3.5" aria-hidden />
                      Revisar <span className="code tnum">{awaiting}</span>
                    </Link>
                  </Button>
                )}
                {puedeSeguirImagenes && (
                  <Button
                    size="sm"
                    icon={<Play className="size-3.5" aria-hidden />}
                    loading={busy === "start-images"}
                    disabled={busy !== null}
                    onClick={() => void action("start-images", imageTargets)}
                    title="Arranca los proyectos en fase imagenes de a uno, para no saturar la cuota (los videos quedan frenados)"
                  >
                    Arrancar de a uno
                  </Button>
                )}
                {brokenImages > 0 && (
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<ArrowsClockwise className="size-3.5" aria-hidden />}
                    loading={busy === "retry-images"}
                    disabled={busy !== null}
                    onClick={() => void action("retry-images", brokenImageIds)}
                    title="Reencola las imagenes que fallaron y las que quedaron colgadas en 'generando' (se les da presupuesto de reintentos nuevo)"
                  >
                    Reintentar <span className="code tnum">{brokenImages}</span>
                  </Button>
                )}
              </>
            }
          />
          <CardTotal
            titulo="Videos"
            counts={totals?.videos ?? emptyCounts()}
            tono="attention"
            acciones={
              <>
                {clipsWithFile > 0 && (
                  <Button asChild variant="secondary" size="sm">
                    <Link
                      href={`/batch/videos?ids=${ids.join(",")}`}
                      title="Ver los clips uno por uno, con el diálogo al lado, y aprobar o regenerar"
                    >
                      <FilmStrip className="size-3.5" aria-hidden />
                      Revisar <span className="code tnum">{videosAwaiting}</span> clips
                    </Link>
                  </Button>
                )}
                {canStartVideos && (
                  <Button
                    size="sm"
                    icon={<FilmSlate className="size-3.5" aria-hidden />}
                    loading={busy === "start-videos"}
                    disabled={busy !== null}
                    onClick={() => {
                      // Si todavia hay imagenes sin aprobar, esos clips no se van a
                      // generar (dependen de su imagen): avisamos antes de largar.
                      if (!allImagesReady) {
                        setConfirmarVideos(true);
                        return;
                      }
                      void action("start-videos", videoCandidates);
                    }}
                    title={`Libera los clips: se generan con Veo de a ${videoRate.max} cada ${Math.round(
                      videoRate.windowMs / 1000
                    )}s`}
                  >
                    Comenzar videos
                  </Button>
                )}
                {videosAwaiting > 0 && (
                  <Button
                    size="sm"
                    icon={<Check className="size-3.5" aria-hidden />}
                    loading={busy === "approve-videos"}
                    disabled={busy !== null}
                    onClick={() => void action("approve-videos")}
                    title="Aprueba de una todos los clips que están esperando"
                  >
                    Aprobar todos
                  </Button>
                )}
                {brokenVideos > 0 && (
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<ArrowsClockwise className="size-3.5" aria-hidden />}
                    loading={busy === "retry-videos"}
                    disabled={busy !== null}
                    onClick={() => void action("retry-videos", brokenVideoIds)}
                    title="Reencola los clips que fallaron o quedaron colgados"
                  >
                    Reintentar <span className="code tnum">{brokenVideos}</span>
                  </Button>
                )}
              </>
            }
          />
        </div>
      )}

      {/* Nota de fase videos: el check deja elegir si los clips se aprueban solos. */}
      {canStartVideos && (
        <Card className="space-y-2">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={autoApproveVideos}
              onChange={(e) => setAutoApproveVideos(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-accent"
            />
            <span className="min-w-0">
              <span className="block text-body font-medium text-fg">
                Aprobar los videos solos al terminar
              </span>
              <span className="mt-0.5 block text-label text-fg-dim">
                <b className="font-medium text-fg">Apagado</b> (recomendado): cada clip
                queda esperándote en <b className="font-medium text-fg">Revisar clips</b>
                , donde lo ves con el diálogo al lado y podés editarle el prompt antes
                de regenerarlo. Tildalo solo si querés dejarlo correr de largo sin
                revisar nada.
              </span>
            </span>
          </label>
          <p className="text-label text-fg-dim">
            Ritmo de Veo:{" "}
            <b className="code tnum font-medium text-fg">{videoRate.max}</b> clips cada{" "}
            <b className="code tnum font-medium text-fg">
              {Math.round(videoRate.windowMs / 1000)}s
            </b>{" "}
            (ventana deslizante). Si uno falla por cuota o red, vuelve solo a la cola y
            se reintenta más tarde. Se ajusta con{" "}
            <code className="code text-fg">PIPELINE_VIDEO_RATE_MAX</code> y{" "}
            <code className="code text-fg">PIPELINE_VIDEO_RATE_WINDOW_MS</code>.
          </p>
        </Card>
      )}

      {/* ─────────────────── tabla de proyectos (pedido del handoff) ─────────── */}
      {/*
        Reemplaza a la grilla de `ProjectCard` de T07: el handoff pide una TABLA,
        una fila por proyecto, con columnas fijas. Mismas acciones por fila
        (reintentar imagenes/videos, quitar del tablero) sobre los mismos ids.
      */}
      {snap === null && !error ? (
        <div className="space-y-1 rounded-lg bg-surface p-3" aria-busy aria-label="Cargando proyectos del lote">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : projects.length > 0 ? (
        <TablaProyectos
          projects={projects}
          ids={ids}
          busy={busy !== null}
          onRetryImages={(id) => void action("retry-images", [id])}
          onRetryVideos={(id) => void action("retry-videos", [id])}
          onRemove={(id) => setIds(ids.filter((x) => x !== id))}
        />
      ) : (
        <EmptyState
          icon={<Kanban className="size-6" aria-hidden />}
          title="El tablero quedó vacío"
          body="Ninguno de los proyectos que pedía la URL existe todavía. Elegí de nuevo cuáles querés manejar juntos."
          action={{ label: "Elegir proyectos", onClick: () => setPickerOpen(true) }}
        />
      )}

      {/* Composicion del tablero. En dialogo y no inline: aparecia entre el
          encabezado y la grilla, y empujaba todo el tablero hacia abajo. */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent
          title="Proyectos del tablero"
          description="Tildá los que querés manejar juntos. Sacar uno del tablero no lo borra."
          className="w-[min(34rem,calc(100vw-2rem))]"
        >
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
        </DialogContent>
      </Dialog>

      {/*
        Reemplaza al window.confirm, que en una app oscura aparece como un cuadro del
        sistema operativo y se acepta por reflejo. El guard es el mismo y el detalle
        dice lo mismo que decia antes.
      */}
      <Confirmar
        abierto={confirmarVideos}
        onCambio={setConfirmarVideos}
        title="¿Largo los videos igual?"
        detalle="Todavía hay imágenes sin aprobar. Los clips de esas imágenes no se van a generar hasta que las apruebes. Los de las imágenes ya aprobadas sí arrancan."
        labelConfirmar="Largar los videos"
        onConfirmar={() => void action("start-videos", videoCandidates)}
      />
    </div>
  );
}

/* ----------------------------- aviso de bloque ----------------------------- */

/**
 * Aviso de un parrafo. Existe local porque las 10 primitivas no cubren este caso:
 * `Field` cubre el error de UN campo y `Badge` el estado de UNA cosa, pero no el
 * aviso de bloque. Ver P-14: si se agrega la primitiva `Aviso`, esto se borra y se
 * importa. Los cuatro avisos de esta pantalla pasan por acá para que no divergan.
 */
function Aviso({
  tone,
  icon,
  rol,
  children,
}: {
  tone: Tone;
  icon?: React.ReactNode;
  /** `alert` interrumpe al lector de pantalla. Solo para lo que acaba de pasar. */
  rol?: "alert" | "status";
  children: React.ReactNode;
}) {
  return (
    <p
      role={rol}
      className={cn(
        "flex items-start gap-2 rounded-sm px-2.5 py-2 text-body",
        AVISO[tone]
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/* --------------------- card de totales (Imágenes / Videos) --------------------- */

/**
 * Una de las dos cards del handoff: numero mono de 24px + barra de 6px + las
 * acciones de ESE alcance (imagenes o videos) agrupadas adentro. Reemplaza al
 * `PanelActivo` de T07 (que mostraba UN proyecto elegido): acá el numero es la
 * SUMA de todos los proyectos del tablero, que es justo lo que trae `totals` del
 * snapshot sin ningun calculo nuevo.
 */
function CardTotal({
  titulo,
  counts,
  tono,
  acciones,
}: {
  titulo: string;
  counts: BatchCounts;
  /** Tono de la barra de 6px cuando no hay tramos que mostrar (total > 0 pero todo "done"). */
  tono: Tone;
  acciones: React.ReactNode;
}) {
  const tramos = tramosDe(counts);
  const conTramo = tramos.filter((t) => t.n > 0);
  return (
    <Card className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label font-medium text-fg-dim">{titulo}</span>
        <span className="code tnum text-fg-dim">
          <b className="text-display font-semibold text-fg">{counts.done}</b>
          <span className="text-title">/{counts.total}</span>
        </span>
      </div>
      {/*
        Barra de 6px, sin track de fondo: son los tramos reales y nada mas (mismo
        criterio que `Progress` de abajo). Con total 0 se usa el `tono` de la card
        para no dejar la barra completamente invisible sobre `surface`.
      */}
      <div aria-hidden className="flex h-1.5 overflow-hidden rounded-sm bg-surface-hi">
        {counts.total > 0 &&
          conTramo.map((t) => (
            <span
              key={t.clave}
              className={cn(
                "h-full min-w-px",
                RELLENO[t.tone],
                t.animado && "motion-safe:animate-pulse"
              )}
              style={{ width: `${(t.n / counts.total) * 100}%` }}
            />
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-3">
        {acciones}
      </div>
    </Card>
  );
}

function emptyCounts(): BatchCounts {
  return {
    total: 0,
    pending: 0,
    generating: 0,
    awaiting: 0,
    done: 0,
    failed: 0,
    stuck: 0,
  };
}

/* ------------------------------ tabla de proyectos ------------------------------ */

/**
 * Tabla de proyectos del handoff. Columnas fijas:
 * `minmax(160px,220px) 110px minmax(0,1fr) 90px 90px 32px` = nombre, estado,
 * mini-timeline, img a/b, vid a/b, quitar.
 *
 * Es una GRILLA CSS con `role="table"` explicito y no un `<table>` HTML: las
 * columnas de ancho variable (`minmax`) y el `MiniTimeline` ocupando `1fr` son mas
 * simples en grid que forzando `<col>` con anchos fijos, y los roles ARIA de tabla
 * (`row`/`cell`) mantienen la semantica para el lector de pantalla.
 */
function TablaProyectos({
  projects,
  ids,
  busy,
  onRetryImages,
  onRetryVideos,
  onRemove,
}: {
  projects: BatchProject[];
  ids: string[];
  busy: boolean;
  onRetryImages: (id: string) => void;
  onRetryVideos: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const columnas = "minmax(160px,220px) 110px minmax(0,1fr) 90px 90px 32px";
  return (
    <div role="table" aria-label="Proyectos del tablero" className="rounded-lg bg-surface">
      <div
        role="row"
        style={{ gridTemplateColumns: columnas }}
        className="grid items-center gap-3 border-b border-divider px-3 py-2 text-label text-fg-dim"
      >
        <span role="columnheader">Proyecto</span>
        <span role="columnheader">Estado</span>
        <span role="columnheader">Timeline</span>
        <span role="columnheader" className="text-right">
          Img
        </span>
        <span role="columnheader" className="text-right">
          Vid
        </span>
        <span role="columnheader" className="sr-only">
          Quitar
        </span>
      </div>
      <div className="divide-y divide-divider">
        {projects.map((p) => {
          const imgRoto = p.images.failed + p.images.stuck;
          const vidRoto = p.videos.failed + p.videos.stuck;
          return (
            <div
              key={p.id}
              role="row"
              style={{ gridTemplateColumns: columnas }}
              className="grid items-center gap-3 px-3 py-2"
            >
              <span role="cell" className="min-w-0">
                <Link
                  href={`/project/${p.id}/pipeline`}
                  className="block truncate text-body font-medium text-fg transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  title={p.name || p.id}
                >
                  {p.name || p.id}
                </Link>
              </span>
              <span role="cell">
                <StatusBadge status={p.status} />
              </span>
              <span role="cell" className="min-w-0">
                {p.timeline.length > 0 ? (
                  <MiniTimeline items={p.timeline} alto={22} />
                ) : (
                  <span className="text-label text-fg-dim">—</span>
                )}
              </span>
              <span role="cell" className="flex items-center justify-end gap-1.5">
                <span className="code tnum text-body text-fg">
                  {p.images.done}/{p.images.total}
                </span>
                {imgRoto > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-1.5 text-danger"
                    disabled={busy}
                    onClick={() => onRetryImages(p.id)}
                    aria-label={`Reintentar ${imgRoto} imágenes de ${p.name || p.id}`}
                    title="Reencola las imágenes falladas y las colgadas de este proyecto"
                  >
                    <ArrowsClockwise className="size-3.5" aria-hidden />
                  </Button>
                )}
              </span>
              <span role="cell" className="flex items-center justify-end gap-1.5">
                <span className="code tnum text-body text-fg">
                  {p.videos.done}/{p.videos.total}
                </span>
                {vidRoto > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-1.5 text-danger"
                    disabled={busy}
                    onClick={() => onRetryVideos(p.id)}
                    aria-label={`Reintentar ${vidRoto} clips de ${p.name || p.id}`}
                    title="Reencola los clips fallados y los colgados de este proyecto"
                  >
                    <ArrowsClockwise className="size-3.5" aria-hidden />
                  </Button>
                )}
              </span>
              <span role="cell">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(p.id)}
                  aria-label={`Quitar ${p.name || p.id} del tablero`}
                  title="Quitar del tablero (no borra el proyecto)"
                  className="px-1.5"
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------- progreso ------------------------------- */

/**
 * Un tramo de la barra. `nombre` es el sustantivo de la BOLSA ("3 con error"), no el
 * label del estado de un job: `estadoDeJob("failed").label` es "Falló", que como
 * contador se lee mal ("3 Falló"). El TONO si sale de `ui-tokens`, que es lo que §6
 * pide garantizar. Ver P-18.
 */
interface Tramo {
  clave: string;
  nombre: string;
  n: number;
  tone: Tone;
  animado?: boolean;
  detalle?: string;
}

/**
 * Los tramos de un contador, en el orden en que se dibujan: lo hecho primero, lo que
 * falta al final.
 *
 * `stuck` es un SUBCONJUNTO de `generating` (`batch.ts` lo dice), asi que hay que
 * restarlo o la barra suma mas que el total y miente. Y no tiene entrada en
 * `ui-tokens` porque no es un estado de job sino un contador derivado: se le da
 * `danger` porque es lo que el tablero ya hace con el ("roto = fallado + colgado", y
 * el mismo boton de reintentar arregla los dos).
 */
function tramosDe(c: BatchCounts): Tramo[] {
  const generando = Math.max(0, c.generating - c.stuck);
  return [
    { clave: "done", nombre: "listas", n: c.done, tone: estadoDeJob("done").tone },
    {
      clave: "awaiting",
      nombre: "por aprobar",
      n: c.awaiting,
      tone: estadoDeJob("awaiting_approval").tone,
    },
    {
      clave: "generating",
      nombre: "generando",
      n: generando,
      tone: estadoDeJob("generating").tone,
      animado: estadoDeJob("generating").animado,
    },
    {
      clave: "stuck",
      nombre: "sin correr",
      n: c.stuck,
      tone: "danger",
      detalle:
        "Dicen “generando” pero no están corriendo de verdad. Se arreglan con Reintentar.",
    },
    {
      clave: "failed",
      nombre: "con error",
      n: c.failed,
      tone: estadoDeJob("failed").tone,
    },
    {
      clave: "pending",
      nombre: "en cola",
      n: c.pending,
      tone: estadoDeJob("pending").tone,
    },
  ];
}

/* ------------------------------- picker ------------------------------- */

/**
 * Elige QUE proyectos componen el tablero. Es multi-seleccion, asi que no puede ser
 * un `Select`: el `Select` de arriba elige el proyecto que se ve en grande, que es
 * otra cosa.
 *
 * Viene sin marco a proposito: lo usa el vacio dentro de un `Card` y el boton
 * "Proyectos" dentro de un `Dialog`, y cada uno pone su propio encabezado.
 */
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
    <div className="space-y-3">
      {options.length === 0 ? (
        <p className="text-body text-fg-dim">
          No hay proyectos todavía. Importá una carpeta de PlanJSON desde{" "}
          <Link
            href="/"
            className="rounded-sm text-accent underline transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Nuevo proyecto
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="max-h-72 divide-y divide-divider overflow-y-auto rounded-lg bg-bg">
            {options.map((o) => (
              <label
                key={o.id}
                className="flex cursor-pointer items-center gap-3 px-3 py-2 text-body transition-colors hover:bg-surface-hi"
              >
                <input
                  type="checkbox"
                  checked={sel.includes(o.id)}
                  onChange={(e) =>
                    setSel((prev) =>
                      e.target.checked
                        ? [...prev, o.id]
                        : prev.filter((id) => id !== o.id)
                    )
                  }
                  className="size-4 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1 truncate text-fg">{o.name}</span>
                <span className="shrink-0 text-label text-fg-dim">
                  <span className="code tnum text-fg">{o.imageCount}</span> img ·{" "}
                  <span className="code tnum text-fg">{o.clipCount}</span> clips
                </span>
              </label>
            ))}
          </div>
          <p className="text-label text-fg-dim">
            <span className="code tnum text-fg">{sel.length}</span> elegidos
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={sel.length === 0}
          onClick={() => onConfirm(sel)}
        >
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
