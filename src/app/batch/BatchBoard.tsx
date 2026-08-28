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
 * ─── ESTRUCTURA NUEVA (§3 de T07) ────────────────────────────────────────────
 *
 * El problema de antes era que el progreso y la identidad del proyecto competian:
 * cada card tenia la miniatura del proyecto a sangre completa en opacity-10 detras
 * de las barras, ocho botones de ocho colores distintos en el encabezado, y el
 * progreso de los 8 proyectos con el mismo peso visual. La jerarquia ahora es:
 *
 *   1. selector del proyecto activo, arriba, con `Select`
 *   2. el progreso de ESE proyecto como la informacion dominante, con los numeros
 *      grandes en mono y las barras segmentadas por estado
 *   3. los accesos a Revisar y a Videos como acciones con nombre, no links perdidos
 *   4. la grilla de los demas proyectos, con el progreso resumido
 *
 * Y las acciones del LOTE (arrancar, pausar, reintentar, aprobar todo) quedan
 * agrupadas por alcance: las de "seguir avanzando" en el encabezado, y las que
 * requieren una decision tuya en su propia barra con el acento (D6).
 *
 * ─── LO QUE NO CAMBIO ────────────────────────────────────────────────────────
 *
 * El rediseño es VISUAL. `load`, `loadOptions`, `setIds` y `action` son los mismos,
 * con los mismos dos endpoints (`/api/batch` y `/api/projects`), los mismos payloads
 * y los mismos derivados. El parametro de la URL sigue siendo `ids`, y los links a
 * /batch/review y /batch/videos siguen usando `ids` y `focus`, que son de T09 y T10.
 *
 * Los dos unicos cambios de comportamiento, los dos pedidos por el plan:
 *   - el `window.confirm` de "largo los videos con imagenes sin aprobar" pasa a ser
 *     el `Confirmar` del sistema (mismo guard, misma condicion, mismo resultado);
 *   - el "proyecto activo" no existia: es estado LOCAL de esta pantalla, no de la
 *     URL ni del store. Ver el comentario de `activoId` para por que no se deriva
 *     del polling.
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
  Select,
  Skeleton,
} from "@/components/ui";
import type { BatchCounts, BatchProject, BatchSnapshot } from "@/lib/batch";
import { cn } from "@/lib/cn";
import { estadoDeJob, type Tone } from "@/lib/ui-tokens";

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
  /**
   * El proyecto que se ve en grande. Es estado LOCAL: no viene de la URL ni del
   * store, porque el tablero nunca tuvo la nocion de "activo" y agregarle un
   * parametro a la URL le tocaria el contrato a /batch/review y /batch/videos.
   *
   * A proposito NO se deriva de los datos (ej. "el que tiene mas cosas esperando"):
   * el snapshot se refresca cada 2.5s, asi que el panel te cambiaria de proyecto
   * solo mientras lo estas mirando. Si el activo desaparece del tablero, cae al
   * primero, y eso lo resuelve el `?? projects[0]` de abajo sin ningun effect.
   */
  const [activoId, setActivoId] = useState<string | null>(null);
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

  /**
   * El proyecto dominante. `?? projects[0]` es lo que hace que no haga falta ningun
   * effect: si `activoId` es null (primera carga) o quedo apuntando a un proyecto
   * que se saco del tablero, cae solo al primero.
   */
  const activo: BatchProject | null =
    projects.find((p) => p.id === activoId) ?? projects[0] ?? null;

  const opcionesDeProyecto = projects.map((p) => ({
    value: p.id,
    label: p.name || p.id,
    hint: `${p.images.done}/${p.images.total} imágenes · ${p.videos.done}/${p.videos.total} clips`,
  }));

  const segundosDelActivo =
    activo?.timeline.reduce((a, c) => a + c.duracionSeg, 0) ?? 0;

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
      {/* ─────────────── encabezado: identidad del lote y avance ─────────────── */}
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
              <>
                Todas las imágenes aprobadas. Ya podés largar los videos.
              </>
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

        {/* Avanzar la fase, pausar, y la composicion del tablero. */}
        <div className="flex flex-wrap items-center gap-2">
          {puedeSeguirImagenes && (
            <Button
              variant="primary"
              icon={<Play className="size-4" aria-hidden />}
              loading={busy === "start-images"}
              disabled={busy !== null}
              onClick={() => void action("start-images", imageTargets)}
              title="Encola todos los proyectos en fase imagenes (los videos quedan frenados)"
            >
              {imagesStarted ? "Seguir con las imágenes" : "Comenzar imágenes"}
            </Button>
          )}
          {canStartVideos && (
            <Button
              // El primario sigue a la FASE: mientras falten imagenes, el paso
              // siguiente son las imagenes y esto es secundario.
              variant={puedeSeguirImagenes ? "secondary" : "primary"}
              icon={<FilmSlate className="size-4" aria-hidden />}
              loading={busy === "start-videos"}
              disabled={busy !== null}
              onClick={() => {
                // Si todavia hay imagenes sin aprobar, esos clips no se van a generar
                // (dependen de su imagen): avisamos antes de largar.
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
            Proyectos
          </Button>
        </div>
      </header>

      {/* ─────────────── lo que espera una decision tuya (D6) ─────────────── */}
      {/*
        El acento vive en la BARRA y no en los botones: `Button` no tiene variante de
        acento y su contrato esta congelado (§5), asi que meterle el color por
        className seria duplicarle la chapa. El contenedor comunica "esto te espera"
        y los botones de adentro quedan con las variantes del sistema.
      */}
      {teToca && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-accent/10 p-2.5">
          <span className="mr-1 flex items-center gap-1.5 text-label font-medium text-accent">
            <Warning className="size-4 shrink-0" aria-hidden />
            Te toca a vos
          </span>

          {awaiting > 0 && (
            <Button asChild variant="primary" size="sm">
              <Link href={`/batch/review?ids=${ids.join(",")}`}>
                <Cards className="size-3.5" aria-hidden />
                Revisar imágenes
                <span className="code tnum">{awaiting}</span>
              </Link>
            </Button>
          )}

          {clipsWithFile > 0 && (
            <Button asChild variant={videosAwaiting > 0 ? "primary" : "secondary"} size="sm">
              <Link
                href={`/batch/videos?ids=${ids.join(",")}`}
                title="Ver los clips uno por uno, con el diálogo al lado, y aprobar o regenerar"
              >
                <FilmStrip className="size-3.5" aria-hidden />
                Revisar clips
                {videosAwaiting > 0 && (
                  <span className="code tnum">{videosAwaiting}</span>
                )}
              </Link>
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
              Aprobar todos los clips (<span className="code tnum">{videosAwaiting}</span>)
            </Button>
          )}

          {brokenImages > 0 && (
            <Button
              size="sm"
              icon={<ArrowsClockwise className="size-3.5" aria-hidden />}
              loading={busy === "retry-images"}
              disabled={busy !== null}
              onClick={() => void action("retry-images", brokenImageIds)}
              title="Reencola las imagenes que fallaron y las que quedaron colgadas en 'generando' (se les da presupuesto de reintentos nuevo)"
            >
              Reintentar imágenes (<span className="code tnum">{brokenImages}</span>)
            </Button>
          )}

          {brokenVideos > 0 && (
            <Button
              size="sm"
              icon={<ArrowsClockwise className="size-3.5" aria-hidden />}
              loading={busy === "retry-videos"}
              disabled={busy !== null}
              onClick={() => void action("retry-videos", brokenVideoIds)}
              title="Reencola los clips que fallaron o quedaron colgados"
            >
              Reintentar clips (<span className="code tnum">{brokenVideos}</span>)
            </Button>
          )}
        </div>
      )}

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
          Estos proyectos ya no existen (los borraste):{" "}
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

      {/* ─────────── 1: selector del proyecto activo ─────────── */}
      {/*
        Con muchos proyectos la lista de checkboxes era incomoda para lo unico que se
        hace seguido, que es mirar UNO. El picker sigue existiendo (boton "Proyectos"
        del encabezado) pero para lo otro: cambiar la composicion del tablero.
      */}
      {projects.length > 0 && activo && (
        <Select
          label="Proyecto"
          value={activo.id}
          onValueChange={(v) => setActivoId(v)}
          options={opcionesDeProyecto}
          className="sm:max-w-sm"
        />
      )}

      {/* ─────────── 2 y 3: el activo, dominante, con sus accesos ─────────── */}
      {snap === null && !error ? (
        <Card className="space-y-3">
          <Skeleton className="h-5 w-48" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-1.5 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-1.5 w-full" />
            </div>
          </div>
        </Card>
      ) : activo ? (
        <PanelActivo
          project={activo}
          ids={ids}
          totalSeconds={segundosDelActivo}
          busy={busy !== null}
          onStartImages={() => void action("start-images", [activo.id])}
          onRetryImages={() => void action("retry-images", [activo.id])}
          onRetryVideos={() => void action("retry-videos", [activo.id])}
        />
      ) : (
        <EmptyState
          icon={<Kanban className="size-6" aria-hidden />}
          title="El tablero quedó vacío"
          body="Ninguno de los proyectos que pedía la URL existe todavía. Elegí de nuevo cuáles querés manejar juntos."
          action={{ label: "Elegir proyectos", onClick: () => setPickerOpen(true) }}
        />
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

      {/* ─────────────── 4: la grilla, con el progreso resumido ─────────────── */}
      {projects.length > 1 && (
        <section className="space-y-3">
          <h2 className="text-title font-semibold text-fg">Todos los proyectos</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <ProjectCard
                  project={p}
                  activo={p.id === activo?.id}
                  ids={ids}
                  busy={busy !== null}
                  onSeleccionar={() => setActivoId(p.id)}
                  onStartImages={() => void action("start-images", [p.id])}
                  onRetryImages={() => void action("retry-images", [p.id])}
                  onRetryVideos={() => void action("retry-videos", [p.id])}
                  onRemove={() => setIds(ids.filter((id) => id !== p.id))}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {snap === null && !error && (
        <ul aria-busy aria-label="Cargando proyectos del lote" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="space-y-2 rounded-lg bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-1.5 w-full" />
              <Skeleton className="h-1.5 w-full" />
            </li>
          ))}
        </ul>
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

/* --------------------------- el proyecto dominante --------------------------- */

function PanelActivo({
  project: p,
  ids,
  totalSeconds,
  busy,
  onStartImages,
  onRetryImages,
  onRetryVideos,
}: {
  project: BatchProject;
  ids: string[];
  totalSeconds: number;
  busy: boolean;
  onStartImages: () => void;
  onRetryImages: () => void;
  onRetryVideos: () => void;
}) {
  const mostrarVideos =
    p.videos.total > 0 &&
    (p.stage === "videos" || p.videos.done > 0 || p.videos.awaiting > 0);

  return (
    <Card className="space-y-4">
      <CardHeader className="mb-0">
        <div className="flex min-w-0 items-start gap-3">
          {/*
            La miniatura, del tamaño de una miniatura. Antes iba a sangre completa
            detras de las barras en opacity-10, y era exactamente la competencia
            entre identidad y progreso que §3 mandaba resolver.
          */}
          {p.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={p.thumbUrl}
              src={p.thumbUrl}
              alt=""
              aria-hidden
              className="hidden aspect-[9/16] w-16 shrink-0 rounded-md bg-bg object-cover sm:block"
            />
          ) : (
            <span
              aria-hidden
              className="hidden aspect-[9/16] w-16 shrink-0 items-center justify-center rounded-md bg-bg text-fg-dim sm:flex"
            >
              <FilmSlate className="size-5" />
            </span>
          )}

          <div className="min-w-0">
            <CardTitle className="truncate">{p.name || p.id}</CardTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={p.status} />
              {p.stage && (
                <Badge tone={p.stage === "images" ? "info" : "attention"}>
                  fase {p.stage === "images" ? "imágenes" : "videos"}
                </Badge>
              )}
              {p.imageVariants > 1 && (
                <Badge tone="neutral">
                  <span className="code tnum">{p.imageVariants}</span> variantes
                </Badge>
              )}
            </div>
          </div>
        </div>
      </CardHeader>

      {/* El progreso, dominante: numeros grandes en mono y barra por estado. */}
      <div className={cn("grid gap-5", mostrarVideos && "sm:grid-cols-2")}>
        <Progress label="Imágenes" counts={p.images} destacado />
        {mostrarVideos && <Progress label="Videos" counts={p.videos} destacado />}
      </div>

      {p.timeline.length > 0 && (
        <ClipTimeline items={p.timeline} totalSeconds={totalSeconds} />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-3">
        {p.images.awaiting > 0 && (
          <Button asChild variant="primary" size="sm">
            <Link href={`/batch/review?ids=${ids.join(",")}&focus=${p.id}`}>
              <Cards className="size-3.5" aria-hidden />
              Revisar imágenes
              <span className="code tnum">{p.images.awaiting}</span>
            </Link>
          </Button>
        )}
        {p.images.total === 0 && (
          <Button
            variant="primary"
            size="sm"
            icon={<Play className="size-3.5" aria-hidden />}
            disabled={busy}
            onClick={onStartImages}
          >
            Arrancar imágenes
          </Button>
        )}
        {p.videos.done + p.videos.awaiting > 0 && (
          <Button asChild variant={p.videos.awaiting > 0 ? "primary" : "secondary"} size="sm">
            <Link href={`/batch/videos?ids=${p.id}`}>
              <FilmStrip className="size-3.5" aria-hidden />
              Clips
              {p.videos.awaiting > 0 && (
                <span className="code tnum">{p.videos.awaiting}</span>
              )}
            </Link>
          </Button>
        )}
        {p.images.failed + p.images.stuck > 0 && (
          <Button
            size="sm"
            icon={<ArrowsClockwise className="size-3.5" aria-hidden />}
            disabled={busy}
            onClick={onRetryImages}
            title="Reencola las imagenes falladas y las colgadas de ESTE proyecto"
          >
            Reintentar{" "}
            <span className="code tnum">{p.images.failed + p.images.stuck}</span>{" "}
            {p.images.stuck > 0 && p.images.failed === 0 ? "colgadas" : "con error"}
          </Button>
        )}
        {p.videos.failed + p.videos.stuck > 0 && (
          <Button
            size="sm"
            icon={<ArrowsClockwise className="size-3.5" aria-hidden />}
            disabled={busy}
            onClick={onRetryVideos}
            title="Reencola los clips fallados y los colgados de ESTE proyecto"
          >
            Reintentar <span className="code tnum">{p.videos.failed + p.videos.stuck}</span>{" "}
            clips
          </Button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/project/${p.id}/pipeline`}>Pipeline →</Link>
          </Button>
          {p.videos.done > 0 && (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/project/${p.id}/result`}>Resultado →</Link>
            </Button>
          )}
        </span>
      </div>
    </Card>
  );
}

/* -------------------------------- card -------------------------------- */

function ProjectCard({
  project: p,
  activo,
  ids,
  busy,
  onSeleccionar,
  onStartImages,
  onRetryImages,
  onRetryVideos,
  onRemove,
}: {
  project: BatchProject;
  activo: boolean;
  ids: string[];
  busy: boolean;
  onSeleccionar: () => void;
  onStartImages: () => void;
  onRetryImages: () => void;
  onRetryVideos: () => void;
  onRemove: () => void;
}) {
  const mostrarVideos =
    p.videos.total > 0 &&
    (p.stage === "videos" || p.videos.done > 0 || p.videos.awaiting > 0);

  return (
    <Card
      // El activo se marca con un anillo del acento, no con otro fondo: la grilla
      // tiene que seguir leyendose como una grilla.
      className={cn(
        "flex h-full flex-col gap-3",
        activo && "ring-1 ring-inset ring-accent"
      )}
      aria-current={activo ? "true" : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/*
            El titulo es el selector. No usa `Button` porque no es un control con
            chapa de boton: es un titulo que ademas se puede activar, igual que el
            titulo de las tarjetas de la home, que es un <Link> con estilo de titulo.
          */}
          <button
            type="button"
            onClick={onSeleccionar}
            className="max-w-full rounded-sm text-left text-body font-medium text-fg transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            title="Ver este proyecto en grande"
          >
            <span className="block truncate">{p.name || p.id}</span>
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={p.status} />
            {p.stage && (
              <Badge tone={p.stage === "images" ? "info" : "attention"}>
                fase {p.stage === "images" ? "imágenes" : "videos"}
              </Badge>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={`Quitar ${p.name || p.id} del tablero`}
          title="Quitar del tablero (no borra el proyecto)"
          className="shrink-0 px-1.5"
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>

      <div className="space-y-3">
        <Progress label="Imágenes" counts={p.images} />
        {mostrarVideos && <Progress label="Videos" counts={p.videos} />}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-divider pt-3">
        {p.images.awaiting > 0 && (
          <Button asChild variant="primary" size="sm">
            <Link href={`/batch/review?ids=${ids.join(",")}&focus=${p.id}`}>
              <Cards className="size-3.5" aria-hidden />
              Revisar
              <span className="code tnum">{p.images.awaiting}</span>
            </Link>
          </Button>
        )}
        {p.images.total === 0 && (
          <Button
            variant="primary"
            size="sm"
            icon={<Play className="size-3.5" aria-hidden />}
            disabled={busy}
            onClick={onStartImages}
          >
            Arrancar
          </Button>
        )}
        {p.videos.done + p.videos.awaiting > 0 && (
          <Button asChild variant={p.videos.awaiting > 0 ? "primary" : "secondary"} size="sm">
            <Link href={`/batch/videos?ids=${p.id}`}>
              <FilmStrip className="size-3.5" aria-hidden />
              Clips
              {p.videos.awaiting > 0 && (
                <span className="code tnum">{p.videos.awaiting}</span>
              )}
            </Link>
          </Button>
        )}
        {p.images.failed + p.images.stuck > 0 && (
          <Button
            size="sm"
            icon={<ArrowsClockwise className="size-3.5" aria-hidden />}
            disabled={busy}
            onClick={onRetryImages}
            title="Reencola las imagenes falladas y las colgadas de ESTE proyecto"
          >
            <span className="code tnum">{p.images.failed + p.images.stuck}</span>{" "}
            {p.images.stuck > 0 && p.images.failed === 0 ? "colgadas" : "con error"}
          </Button>
        )}
        {p.videos.failed + p.videos.stuck > 0 && (
          <Button
            size="sm"
            icon={<ArrowsClockwise className="size-3.5" aria-hidden />}
            disabled={busy}
            onClick={onRetryVideos}
            title="Reencola los clips fallados y los colgados de ESTE proyecto"
          >
            <span className="code tnum">{p.videos.failed + p.videos.stuck}</span> clips
          </Button>
        )}
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link href={`/project/${p.id}/pipeline`}>Pipeline →</Link>
        </Button>
      </div>
    </Card>
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

/**
 * Progreso de un contador del lote.
 *
 * SIN TRACK DE FONDO: la barra son los tramos y nada mas, cada uno del ancho de su
 * proporcion real. Un riel gris al 100% con una porcion de color adentro dibuja algo
 * que no existe en los datos, y es la firma visual de dashboard generico. Lo que
 * manda son los NUMEROS, que van en mono con `.tnum` para que el polling no los
 * cambie de ancho cada 2.5s (D4); la barra es la lectura rapida y va `aria-hidden`,
 * porque la leyenda de abajo ya dice lo mismo en texto.
 */
function Progress({
  label,
  counts,
  destacado,
}: {
  label: string;
  counts: BatchCounts;
  /** Para el proyecto activo: el numero pasa a `display`. */
  destacado?: boolean;
}) {
  const tramos = tramosDe(counts);
  const conTramo = tramos.filter((t) => t.n > 0);
  // La leyenda solo lista lo que NO es "hecho" ni "en cola": eso ya lo dice el
  // hechos/total de arriba, y repetirlo son dos chips que estan siempre.
  const leyenda = conTramo.filter(
    (t) => t.clave !== "done" && t.clave !== "pending"
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label font-medium text-fg-dim">{label}</span>
        {counts.total > 0 ? (
          <span className="code tnum text-fg-dim">
            <b
              className={cn(
                "font-semibold text-fg",
                destacado ? "text-display" : "text-body"
              )}
            >
              {counts.done}
            </b>
            <span className={destacado ? "text-title" : "text-label"}>
              /{counts.total}
            </span>
          </span>
        ) : (
          <span className="text-label text-fg-dim">sin arrancar</span>
        )}
      </div>

      {counts.total > 0 && (
        <div aria-hidden className="flex h-1.5 overflow-hidden rounded-sm">
          {conTramo.map((t) => (
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
      )}

      {leyenda.length > 0 && (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-fg-dim">
          {leyenda.map((t) => (
            <li key={t.clave} className="flex items-center gap-1.5" title={t.detalle}>
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  RELLENO[t.tone],
                  t.animado && "motion-safe:animate-pulse"
                )}
              />
              <span>
                <span className="code tnum text-fg">{t.n}</span> {t.nombre}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
