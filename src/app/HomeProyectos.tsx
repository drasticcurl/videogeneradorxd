"use client";
/**
 * Listado de proyectos de video: filtros por estado, seleccion multiple para armar
 * un tablero, y card por proyecto con mini-timeline + progreso de imagenes/videos.
 *
 * ─── LO QUE NO CAMBIA ────────────────────────────────────────────────────────
 *
 * `GET /api/projects` sigue siendo el UNICO fetch que trae la lista (mismo filtro
 * `!p.soloImagenes` que separaba los VSL de las tandas de imagenes), y el borrado
 * sigue siendo `DELETE /api/projects/:id` con el mismo dialogo de confirmacion. La
 * seleccion para el tablero sigue viajando como `?ids=a,b,c` a `/batch`, exactamente
 * como antes.
 *
 * ─── LO NUEVO: UN FETCH DE LECTURA QUE YA EXISTIA, EMPEZADO A USAR ACA ────────
 *
 * El spec pide, por card: mini-timeline de clips, dos barras de progreso (imagenes
 * y videos) y un CTA "N clips esperan tu aprobación". Eso necesita el desglose de
 * jobs por proyecto (cuantos pending/awaiting/done hay, y la duracion de cada clip
 * para el timeline), y `GET /api/projects` no lo trae — solo `clipCount`/`imageCount`
 * totales.
 *
 * Ese desglose es EXACTAMENTE lo que ya calcula `buildBatchSnapshot`, expuesto hoy
 * en `GET /api/batch?ids=a,b,c` (lo usan /batch, /batch/review y /batch/videos). Es
 * un GET de solo lectura: no dispara ninguna accion, no cambia estado, no es un
 * endpoint nuevo. La decision de esta task es EMPEZAR A LLAMARLO desde la home,
 * pidiendo el snapshot de los proyectos que ya trajo /api/projects, para pintar la
 * card completa sin inventar un cálculo propio (que hubiera sido un QUINTO lugar
 * calculando lo mismo que /batch, /batch/review, /batch/videos y result ya calculan
 * con `buildBatchSnapshot`).
 *
 * Si ese segundo fetch falla, la card cae a la version sin timeline/progreso (solo
 * nombre, meta y badge): mejor una card menos rica que una pantalla que no carga.
 */
import {
  CaretRight,
  FilmSlate,
  Rows,
  Trash,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { MiniTimeline, formatDuration } from "@/components/MiniTimeline";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Button,
  Confirmar,
  EmptyState,
  ProgresoConLabel,
  Skeleton,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import type { BatchProject } from "@/lib/batch";
import { SAMPLE_BRIEF } from "@/lib/sampleBrief";
import { useProjectStore } from "@/store/useProjectStore";

export interface ProjectSummary {
  id: string;
  name: string;
  status: "draft" | "running" | "review" | "done" | "failed" | "partial" | "paused";
  createdAt: string;
  clipCount: number;
  imageCount: number;
  /** true = proyecto de la pantalla de solo imagenes; no va en esta lista. */
  soloImagenes?: boolean;
}

type CargaLista = "cargando" | "listo" | "error";

/** Filtro por estado de proyecto. `null` = todos. Los contadores usan `estadoDeProyecto`. */
const FILTROS: { status: ProjectSummary["status"] | null; label: string }[] = [
  { status: null, label: "Todos" },
  { status: "draft", label: "Borrador" },
  { status: "running", label: "Generando" },
  { status: "review", label: "Esperándote" },
  { status: "done", label: "Listo" },
  { status: "partial", label: "Incompleto" },
  { status: "failed", label: "Falló" },
  { status: "paused", label: "Pausado" },
];

export function HomeProyectos({
  onNuevoProyecto,
  refreshKey,
}: {
  onNuevoProyecto: () => void;
  refreshKey: number;
}) {
  const setBrief = useProjectStore((s) => s.setBrief);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [cargaLista, setCargaLista] = useState<CargaLista>("cargando");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [aBorrar, setABorrar] = useState<ProjectSummary | null>(null);
  const [filtro, setFiltro] = useState<ProjectSummary["status"] | null>(null);
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set());

  // Snapshot de /api/batch para el desglose por proyecto (timeline + progreso).
  // Ver el comentario del header: es un fetch de lectura que ya existia.
  const [snapshots, setSnapshots] = useState<Record<string, BatchProject>>({});

  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  async function loadProjects() {
    setCargaLista("cargando");
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      const todos = (data.projects ?? []) as ProjectSummary[];
      const propios = todos.filter((p) => !p.soloImagenes);
      setProjects(propios);
      setCargaLista("listo");

      // Snapshot de detalle (timeline + progreso), best-effort: si falla, las
      // cards se muestran igual con lo basico. No bloquea el estado "listo".
      if (propios.length > 0) {
        try {
          const ids = propios.map((p) => p.id).join(",");
          const snapRes = await fetch(`/api/batch?ids=${encodeURIComponent(ids)}`);
          const snapData = await snapRes.json();
          const byId: Record<string, BatchProject> = {};
          for (const bp of (snapData.projects ?? []) as BatchProject[]) {
            byId[bp.id] = bp;
          }
          setSnapshots(byId);
        } catch {
          setSnapshots({});
        }
      } else {
        setSnapshots({});
      }
    } catch {
      // Antes esto se tragaba en silencio y la lista quedaba vacia, indistinguible
      // de "todavia no hay proyectos". Con el vacio explicito de abajo eso seria
      // una mentira, asi que el fallo se muestra.
      setCargaLista("error");
    }
  }

  /**
   * Borra un proyecto: registro en db.json + jobs + logs + la carpeta
   * output/<id>/ ENTERA. Es irreversible, y por eso pasa por el dialogo de
   * confirmacion, que muestra cuantos archivos se pierden. Mismo endpoint y mismo
   * comportamiento que el formulario original.
   */
  async function handleDeleteProject(p: ProjectSummary) {
    setDeletingId(p.id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo borrar el proyecto");
      if (data.filesError) {
        setDeleteError(
          `Proyecto borrado, pero no se pudieron eliminar los archivos: ${data.filesError}`,
        );
      }
      setProjects((prev) => prev.filter((x) => x.id !== p.id));
      setSeleccionados((prev) => {
        const next = new Set(prev);
        next.delete(p.id);
        return next;
      });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  function toggleSeleccion(id: string) {
    setSeleccionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const proyectosFiltrados = useMemo(
    () => (filtro ? projects.filter((p) => p.status === filtro) : projects),
    [projects, filtro],
  );

  const contadorPorEstado = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of projects) out[p.status] = (out[p.status] ?? 0) + 1;
    return out;
  }, [projects]);

  /** Clips que esperan aprobacion, sumados de todos los snapshots que llegaron. */
  const clipsEsperando = useMemo(() => {
    let total = 0;
    for (const bp of Object.values(snapshots)) {
      total += bp.images.awaiting + bp.videos.awaiting;
    }
    return total;
  }, [snapshots]);

  return (
    <div className="space-y-6">
      {/* ─────────────────────────── encabezado ─────────────────────────── */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display font-semibold text-fg">Proyectos de video</h1>
          <p className="mt-1 text-body text-fg-dim">
            <span className="code tnum text-fg">{projects.length}</span>{" "}
            {projects.length === 1 ? "proyecto" : "proyectos"}
            {clipsEsperando > 0 && (
              <>
                {" · "}
                <span className="code tnum text-accent">{clipsEsperando}</span>{" "}
                {clipsEsperando === 1 ? "clip espera" : "clips esperan"} tu aprobación
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {seleccionados.size > 0 && (
            <Button asChild variant="secondary">
              <Link href={`/batch?ids=${Array.from(seleccionados).join(",")}`}>
                <Rows className="size-4" aria-hidden />
                Armar tablero con {seleccionados.size}
              </Link>
            </Button>
          )}
          <Button
            variant="primary"
            className="bg-accent text-on-accent hover:bg-accent/90"
            onClick={onNuevoProyecto}
          >
            Nuevo proyecto
          </Button>
        </div>
      </header>

      {/* ─────────────────────────── chips de filtro ─────────────────────────── */}
      {projects.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {FILTROS.map((f) => {
            const activo = f.status === filtro;
            const count = f.status === null ? projects.length : contadorPorEstado[f.status] ?? 0;
            if (f.status !== null && count === 0) return null;
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => setFiltro(f.status)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-label font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  activo
                    ? "bg-accent/10 text-accent"
                    : "bg-surface text-fg-dim hover:text-fg",
                )}
              >
                {f.label}
                <span className="code tnum">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {deleteError && (
        <p role="alert" className="rounded-sm bg-danger/10 p-2 text-body text-danger">
          {deleteError}
        </p>
      )}

      {/* ─────────────────────────── grilla de proyectos ─────────────────────────── */}
      {cargaLista === "cargando" ? (
        <ul
          aria-busy
          aria-label="Cargando proyectos"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
          className="grid gap-3"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="space-y-3 rounded-lg bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
            </li>
          ))}
        </ul>
      ) : cargaLista === "error" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-danger/10 p-3">
          <p role="alert" className="text-body text-danger">
            No se pudo leer la lista de proyectos. Los que ya existen siguen ahí.
          </p>
          <Button size="sm" onClick={() => void loadProjects()}>
            Reintentar
          </Button>
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FilmSlate className="size-6" aria-hidden />}
          title="Todavía no hay ningún proyecto de video"
          body="Creá uno nuevo desde un brief o desde un PlanJSON. Las tandas de imágenes sueltas viven en la pantalla Imágenes, no acá."
          action={{
            label: "Nuevo proyecto",
            onClick: () => {
              setBrief(SAMPLE_BRIEF);
              onNuevoProyecto();
            },
          }}
        />
      ) : proyectosFiltrados.length === 0 ? (
        <EmptyState
          title="Ningún proyecto tiene este estado"
          body="Probá otro filtro, o volvé a “Todos”."
          action={{ label: "Ver todos", onClick: () => setFiltro(null) }}
        />
      ) : (
        <ul
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
          className="grid gap-3"
        >
          {proyectosFiltrados.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              snapshot={snapshots[p.id]}
              seleccionado={seleccionados.has(p.id)}
              onToggleSeleccion={() => toggleSeleccion(p.id)}
              onBorrar={() => setABorrar(p)}
              borrando={deletingId === p.id}
            />
          ))}
        </ul>
      )}

      {/*
        Confirmacion de borrado. Reemplaza al window.confirm, que en una app oscura
        aparece como un cuadro del sistema operativo y se acepta por reflejo.
      */}
      {aBorrar && (
        <Confirmar
          abierto
          onCambio={(v) => {
            if (!v) setABorrar(null);
          }}
          title={`¿Borrar "${aBorrar.name || aBorrar.id}"?`}
          detalle={
            `Se eliminan también los archivos generados: ${aBorrar.imageCount} imágenes y ` +
            `${aBorrar.clipCount} clips (la carpeta output/${aBorrar.id}/ entera). ` +
            `Esto no se puede deshacer.`
          }
          labelConfirmar="Borrar todo"
          peligroso
          onConfirmar={() => void handleDeleteProject(aBorrar)}
        />
      )}
    </div>
  );
}

function ProjectCard({
  project,
  snapshot,
  seleccionado,
  onToggleSeleccion,
  onBorrar,
  borrando,
}: {
  project: ProjectSummary;
  snapshot: BatchProject | undefined;
  seleccionado: boolean;
  onToggleSeleccion: () => void;
  onBorrar: () => void;
  borrando: boolean;
}) {
  const duracionTotal = snapshot
    ? snapshot.timeline.reduce((acc, it) => acc + it.duracionSeg, 0)
    : 0;
  const fecha = new Date(project.createdAt);
  const fechaCorta = `${fecha.getDate()}/${fecha.getMonth() + 1}`;

  // Cuantos clips esperan aprobacion (imagenes + videos) EN ESTE proyecto puntual,
  // para el CTA "N clips esperan tu aprobación". Sin snapshot no hay como saberlo,
  // asi que el CTA simplemente no aparece (no se inventa un numero).
  const esperando = snapshot ? snapshot.images.awaiting + snapshot.videos.awaiting : 0;

  return (
    <li>
      <div className="flex h-full flex-col gap-3 rounded-lg bg-surface p-4">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={seleccionado}
            onChange={onToggleSeleccion}
            aria-label={`Sumar "${project.name || project.id}" al tablero`}
            className="mt-1 size-4 shrink-0 accent-accent"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/project/${project.id}/pipeline`}
                className="min-w-0 rounded-sm text-body font-medium text-fg transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="code block truncate">{project.name || project.id}</span>
              </Link>
              <span className="shrink-0">
                <StatusBadge status={project.status} />
              </span>
            </div>
            <p className="code tnum mt-0.5 text-label text-fg-dim">
              {project.clipCount} clips
              {duracionTotal > 0 && <> · {formatDuration(duracionTotal)}</>}
              {" · "}
              {fechaCorta}
            </p>
          </div>
        </div>

        {/* Mini-timeline: solo si hay snapshot con clips (fase videos). En fase
            imagenes o sin snapshot todavia, se omite en vez de mostrar una tira
            vacia que no dice nada. */}
        {snapshot && snapshot.timeline.length > 0 && (
          <MiniTimeline items={snapshot.timeline} alto={28} />
        )}

        {/* Progreso de imagenes y videos. Solo con snapshot: sin el, no hay
            desglose de jobs y una barra "0/0" mentiria mostrando el 100%. */}
        {snapshot && (
          <div className="space-y-2">
            <ProgresoConLabel
              label="Imágenes"
              hechos={snapshot.images.done}
              total={snapshot.images.total}
              tono="ok"
              alto={4}
            />
            <ProgresoConLabel
              label="Videos"
              hechos={snapshot.videos.done}
              total={snapshot.videos.total}
              tono="ok"
              alto={4}
            />
          </div>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-divider pt-3">
          {esperando > 0 ? (
            <Link
              href={`/batch/review?ids=${project.id}`}
              className="inline-flex min-w-0 flex-1 items-center justify-between gap-2 rounded-sm bg-accent/10 px-2.5 py-1.5 text-label font-medium text-accent transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="truncate">
                <span className="code tnum">{esperando}</span>{" "}
                {esperando === 1 ? "clip espera" : "clips esperan"} tu aprobación
              </span>
              <CaretRight className="size-3.5 shrink-0" aria-hidden />
            </Link>
          ) : (
            <span className="text-label text-fg-dim">
              <span className="code tnum text-fg">{project.imageCount}</span> imágenes
            </span>
          )}
          <Button
            size="sm"
            variant="danger"
            icon={<Trash className="size-3.5" aria-hidden />}
            loading={borrando}
            onClick={onBorrar}
            title="Borrar el proyecto y TODOS sus archivos (imágenes y videos)"
          >
            Borrar
          </Button>
        </div>
      </div>
    </li>
  );
}
