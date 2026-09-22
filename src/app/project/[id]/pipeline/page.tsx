"use client";
/**
 * Pantalla "Pipeline": el estado en vivo del proyecto, rediseñada sobre el handoff
 * `design_handoff_rediseno_augc` (Videos.dc.html, pantalla "project").
 *
 * ─── QUE CAMBIO (visual y de layout, nada de negocio) ────────────────────────
 *
 * - El header pasa a vivir en esta pagina (antes era `ProjectTabs` + un <h1> propio
 *   mas abajo): flecha volver, nombre en mono, badge de estado y un `Segmented`
 *   "Pipeline / Resultado" que navega con `router.push` a la otra ruta. Las dos
 *   rutas siguen siendo distintas — el segmented no es un tab interno.
 * - `FlowGraph` se fue. En su lugar, `EtapasFila` (nuevo, en `@/components/Etapas`):
 *   una fila de 5 cards con contador y barra de 4px. Es lo que escala con 95 clips;
 *   el grafo dibujaba un nodo por job y esa columna medía ~2.700px (P-03 del plan
 *   viejo, que ya había medido el problema).
 * - Las tres pestañas viejas (General / Revisar-arreglar / Storyboard) se
 *   colapsan en UN layout fijo: arriba una sección compacta y colapsable de
 *   imágenes (base + derivadas, con `JobCard` como siempre — es donde se aprueban
 *   variantes de imagen), abajo el pipeline de CLIPS a pantalla completa: timeline
 *   grande + lista con scroll propio a la izquierda, editor de un clip a la derecha
 *   en un panel redimensionable. Es exactamente lo que pide el handoff para esta
 *   pantalla. La seleccion multiple + "regenerar todos sin editar" con confirmacion
 *   (antes una vista aparte, `ReviewStoryboard`) vive ahora como una barra de accion
 *   arriba de la lista de clips: mismo gate, mismo flujo, ahora sin cambiar de vista.
 * - El panel del editor se redimensiona arrastrando su borde izquierdo (mismo
 *   contrato que el handoff): minimo 320px, maximo `innerWidth - 360`, ancho inicial
 *   `max(480, 42vw)`, doble click resetea, el boton de agrandar alterna con 60vw, y
 *   el ancho se guarda en localStorage para no tener que re-ajustarlo cada visita.
 *
 * ─── LO QUE NO SE TOCO, Y ES LO QUE IMPORTA ──────────────────────────────────
 *
 * EL EXPORT A FFMPEG LEE DEL PLAN, NO DE LOS JOBS. Todo lo que se edita en el panel
 * del clip se persiste al plan por el mismo camino que antes: `onSave` ->
 * `changePromptJob` del store -> POST al endpoint de prompt del job -> `loadProject`,
 * que vuelve a bajar el plan. Ni el payload ni el orden de esas tres cosas cambio.
 *
 * `SavePayload` tiene exactamente la misma forma que antes: seis campos opcionales.
 *
 * Los TRES fetch de este archivo son los mismos, con el mismo metodo y el mismo
 * body: arrancar la generacion, aprobar el lote, y el preview de un job. El polling
 * sigue con `setInterval` + `ref` cada 2000ms.
 *
 * El corte de 24 clips sigue existiendo, aplicado ahora a si la seccion de
 * IMAGENES arranca abierta o colapsada (antes decidia la vista inicial entre
 * "General"/"Storyboard" y "Revisar/Arreglar"). El pipeline de CLIPS nunca cambia
 * de forma segun este numero: el panel del editor siempre carga el medio on-demand,
 * asi que un VSL de 95 clips es igual de liviano que uno de 6.
 *
 * El switch de estados sigue sin existir en este archivo: todo tono/label sale de
 * `estadoDeJob` + `Badge`/`StatusBadge`.
 *
 * "Regenerar seleccionados sin editar" sigue pidiendo confirmacion con `Confirmar` y
 * dice cuantos jobs va a regenerar, con el mismo tono `danger`.
 *
 * Los callbacks que van a `JobCard` siguen estabilizados con `useCallback` y los
 * `meta` con `useMemo`, por el mismo motivo de siempre: no romper el `memo`.
 */
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowsClockwise,
  ArrowsInLineHorizontal,
  ArrowsOutLineHorizontal,
  Broom,
  CaretDown,
  CaretUp,
  Check,
  Coins,
  Copy,
  DownloadSimple,
  Eye,
  EyeSlash,
  FilmSlate,
  FloppyDisk,
  ImageSquare,
  MagnifyingGlass,
  Pause,
  Play,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AvisoAprobacion, EtapasFila, type EtapaResumen } from "@/components/Etapas";
import { JobCard } from "@/components/JobCard";
import { LogPanel } from "@/components/LogPanel";
import { estadoDeClip, formatDuration, TimelineClips } from "@/components/MiniTimeline";
import { PantallaFija } from "@/components/Pantalla";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Confirmar,
  EmptyState,
  Segmented,
  Select,
  Skeleton,
  SkeletonGrid,
  Textarea,
  type SelectOption,
} from "@/components/ui";
import type { BatchTimelineItem } from "@/lib/batch";
import { cn } from "@/lib/cn";
import type { JobRecord } from "@/lib/types";
import { estadoDeJob } from "@/lib/ui-tokens";
import { useProjectStore } from "@/store/useProjectStore";

/** payload para guardar/regenerar un job desde el panel del clip. Igual que antes. */
interface SavePayload {
  prompt?: string;
  dialogue?: string;
  durationSec?: number;
  model?: string;
  finalPrompt?: string;
  regenerate?: boolean;
}

/**
 * Umbral que decide si la seccion de imagenes arranca abierta o colapsada.
 *
 * NO SUBIRLO NI SACARLO: es el mismo numero que ya media P-03 del plan viejo para
 * un VSL real de 95 clips. Arriba de este umbral, la seccion de imagenes (que
 * puede montar hasta 95 `JobCard` mas) se colapsa por defecto para no competir por
 * el primer scroll con el pipeline de clips, que es lo que hay que revisar. El
 * pipeline de clips en si NUNCA monta 95 `<video>`: el panel del editor carga el
 * medio on-demand sin importar cuantos clips tenga el proyecto.
 */
const UMBRAL_VISTA_LIVIANA = 24;

/** Las duraciones que acepta el modelo de video. Igual que antes: 4, 6 u 8. */
const DURACION_OPCIONES: ReadonlyArray<SelectOption<string>> = [4, 6, 8].map((d) => ({
  value: String(d),
  label: `${d}s`,
}));

/** Clave de localStorage para el ancho del panel del editor. Un solo valor global:
 * el handoff no pide que sea por-proyecto, y compartirlo evita que cada proyecto
 * nuevo te obligue a re-ajustar el panel. */
const LS_ASIDE_W = "pipeline_aside_w";
const ASIDE_MIN = 320;
const ASIDE_WIDE = 700; // umbral: por encima de esto, "achicar" vuelve al ancho inicial

function anchoInicial(): number {
  if (typeof window === "undefined") return 480;
  return Math.max(480, Math.round(window.innerWidth * 0.42));
}

function anchoMaximo(): number {
  if (typeof window === "undefined") return 1200;
  return Math.max(ASIDE_MIN, window.innerWidth - 360);
}

export default function PipelinePage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const router = useRouter();
  const {
    project,
    jobs,
    logs,
    config,
    defaultResolution,
    loadProject,
    loadConfig,
    refreshJobs,
    approveJob,
    regenerateJob,
    changePromptJob,
    control,
    setClipResolution,
    extendJob,
    regenerateMany,
  } = useProjectStore();
  const [loadError, setLoadError] = useState<string | null>(null);
  // El clip abierto en el panel editor vive ACA y no dentro de `PipelineClips`
  // porque el aviso de aprobacion ("Revisar uno por uno", justo arriba) necesita
  // poder cambiarlo sin pasar por un ref: son hermanos en el arbol, no padre-hijo.
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadConfig();
    loadProject(projectId).catch((e) =>
      setLoadError(e instanceof Error ? e.message : String(e))
    );
    pollRef.current = setInterval(() => {
      refreshJobs(projectId).catch(() => {});
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleGenerateAll() {
    await fetch(`/api/projects/${projectId}/generate`, { method: "POST" });
    await refreshJobs(projectId);
  }

  async function approveBatch() {
    await fetch(`/api/projects/${projectId}/approve-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await refreshJobs(projectId);
  }

  const imageModoById = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.assets.forEach((a) =>
      a.images.forEach((img) => m.set(img.id, img.modo))
    );
    return m;
  }, [project]);

  const ordenByClip = useMemo(() => {
    const m = new Map<string, number>();
    project?.plan.clips.forEach((c) => m.set(c.id, c.orden));
    return m;
  }, [project]);

  // Prompt actual por job.refId (image.prompt o clip.video_prompt) para precargar al editar.
  const promptByRef = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.assets.forEach((a) =>
      a.images.forEach((img) => m.set(img.id, img.prompt))
    );
    project?.plan.clips.forEach((c) => m.set(c.id, c.video_prompt));
    return m;
  }, [project]);

  // Dialogo actual por clip.id (para precargar y editar lo que dice la persona).
  const dialogueByRef = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.clips.forEach((c) => m.set(c.id, c.dialogo ?? ""));
    return m;
  }, [project]);

  // Override del prompt final por clip.id ("" si no hay) para precargar al editar.
  const finalPromptByRef = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.clips.forEach((c) => m.set(c.id, c.final_prompt ?? ""));
    return m;
  }, [project]);

  // Duracion actual por clip.id (para precargar el selector 4/6/8).
  const durationByRef = useMemo(() => {
    const m = new Map<string, number>();
    project?.plan.clips.forEach((c) => m.set(c.id, c.duracion_seg));
    return m;
  }, [project]);

  // Tipo de asset por clip.id ("avatar" | "broll"): define si el dialogo se arma como
  // selfie/talking-head o como voz en off (para que el preview del prompt sea correcto).
  const assetTypeByRef = useMemo(() => {
    const m = new Map<string, "avatar" | "broll">();
    const tipoByAsset = new Map<string, "avatar" | "broll">();
    project?.plan.assets.forEach((a) => tipoByAsset.set(a.id, a.tipo));
    project?.plan.clips.forEach((c) =>
      m.set(c.id, tipoByAsset.get(c.asset_id) ?? "avatar")
    );
    return m;
  }, [project]);

  /*
    Los catalogos y la lista de resoluciones van memoizados porque `?? []` devuelve un
    array NUEVO en cada render mientras la config no llego, y esos arrays viajan como
    prop a las 95 tarjetas: sin esto el `memo` de `JobCard` falla siempre, aunque los
    callbacks esten estables.
  */
  const imageModels = useMemo(() => config?.catalog.image ?? [], [config]);
  const videoModels = useMemo(() => config?.catalog.video ?? [], [config]);
  const resolutionOptions = useMemo(
    () => config?.resolutions ?? ["720p", "1080p"],
    [config]
  );
  const projectImageModel = project?.models.image ?? "";
  /*
    Formato del proyecto, para que las tarjetas no recorten lo que no sea vertical.
    Sale del plan (que es lo que se guardo al crearlo) y cae a 9:16, que es lo que
    estaba fijo antes y sigue siendo lo correcto para un VSL.
  */
  const formato = project?.plan.global.formato || "9:16";
  const projectVideoModel = project?.models.video ?? "";

  const resByClip = useMemo(() => {
    const m = new Map<string, string>();
    project?.plan.clips.forEach((c) =>
      m.set(c.id, c.resolucion ?? project.defaultResolution ?? defaultResolution)
    );
    return m;
  }, [project, defaultResolution]);

  const groups = useMemo(() => {
    const t2i: JobRecord[] = [];
    const i2i: JobRecord[] = [];
    const vids: JobRecord[] = [];
    for (const j of jobs) {
      if (j.type === "video") vids.push(j);
      else if (imageModoById.get(j.refId) === "image2image") i2i.push(j);
      else t2i.push(j);
    }
    vids.sort(
      (a, b) => (ordenByClip.get(a.refId) ?? 0) - (ordenByClip.get(b.refId) ?? 0)
    );
    return { t2i, i2i, vids };
  }, [jobs, imageModoById, ordenByClip]);

  const progress = useMemo(() => {
    if (jobs.length === 0) return { done: 0, total: 0, pct: 0, awaiting: 0 };
    const done = jobs.filter((j) => j.status === "done").length;
    const awaiting = jobs.filter((j) => j.status === "awaiting_approval").length;
    return { done, total: jobs.length, pct: Math.round((done / jobs.length) * 100), awaiting };
  }, [jobs]);

  /*
    ─── LOS CALLBACKS ESTABLES QUE EL `memo` DE JobCard NECESITABA ─────────────
    Las acciones del store son estables (zustand las crea una sola vez), asi que
    estos `useCallback` no se invalidan nunca.
  */
  const onApprove = useCallback(
    (id: string, index?: number) => void approveJob(id, index),
    [approveJob]
  );
  const onRegenerate = useCallback(
    (id: string) => void regenerateJob(id),
    [regenerateJob]
  );
  const onChangePrompt = useCallback(
    (
      id: string,
      payload: {
        prompt?: string;
        dialogue?: string;
        durationSec?: number;
        resolution?: string;
        model?: string;
        finalPrompt?: string;
        regenerate?: boolean;
      }
    ) => void changePromptJob(id, payload),
    [changePromptJob]
  );
  const onExtend = useCallback((id: string) => void extendJob(id), [extendJob]);
  const onChangeResolution = useCallback(
    (clipId: string, r: string) => void setClipResolution(clipId, r),
    [setClipResolution]
  );
  const onRegenerateMany = useCallback(
    (ids: string[]) => void regenerateMany(ids),
    [regenerateMany]
  );

  const handlers = useMemo<GroupHandlers>(
    () => ({ onApprove, onRegenerate, onChangePrompt, onExtend }),
    [onApprove, onRegenerate, onChangePrompt, onExtend]
  );

  // Datos para precargar prompt + selector de modelo en cada tarjeta de imagen.
  const imageMeta = useMemo<JobMeta>(
    () => ({
      promptByRef,
      dialogueByRef,
      durationByRef,
      finalPromptByRef,
      modelOptions: imageModels,
      projectModel: projectImageModel,
      formato,
    }),
    [
      promptByRef,
      dialogueByRef,
      durationByRef,
      finalPromptByRef,
      imageModels,
      projectImageModel,
      formato,
    ]
  );

  const cargando = project === null && loadError === null;
  const sinJobs = project !== null && jobs.length === 0;

  // Items de timeline para TimelineClips/estadoDeClip: mismo shape que BatchTimelineItem
  // (@/lib/batch), armado desde el plan + los jobs de video de ESTE proyecto. No se
  // importa `buildBatchSnapshot` acá porque ese modulo lee de la DB directo (es del
  // backend); esta pantalla ya tiene el plan y los jobs en el store via polling.
  const timelineItems = useMemo<BatchTimelineItem[]>(() => {
    if (!project) return [];
    const videoJobByClip = new Map(groups.vids.map((j) => [j.refId, j]));
    const imageJobByRef = new Map(groups.t2i.concat(groups.i2i).map((j) => [j.refId, j]));
    return project.plan.clips
      .slice()
      .sort((a, b) => a.orden - b.orden)
      .map((clip) => {
        const job = videoJobByClip.get(clip.id) ?? null;
        const imgJob = imageJobByRef.get(clip.image_id);
        return {
          clipId: clip.id,
          videoJobId: job?.id ?? null,
          orden: clip.orden,
          label: `${String(clip.orden).padStart(2, "0")}_${clip.id}`,
          dialogo: clip.dialogo ?? "",
          duracionSeg: clip.duracion_seg,
          etiqueta: clip.etiqueta,
          videoPrompt: clip.video_prompt,
          finalPrompt: clip.final_prompt ?? "",
          resolucion: clip.resolucion ?? project.defaultResolution ?? defaultResolution,
          status:
            clip.etiqueta === "FILMAR_REAL" ? "placeholder" : job?.status ?? "pending",
          error: job?.error ?? null,
          videoUrl: job?.outputPath
            ? `/api/files/${projectId}/${job.outputPath}?v=${encodeURIComponent(job.updatedAt)}`
            : null,
          imageUrl: imgJob?.outputPath
            ? `/api/files/${projectId}/${imgJob.outputPath}?v=${encodeURIComponent(imgJob.updatedAt)}`
            : null,
        } satisfies BatchTimelineItem;
      });
  }, [project, groups, projectId, defaultResolution]);

  // Las 5 etapas del handoff: Brief->Plan y Unir/exportar son "listo/no listo" (1/1),
  // las otras tres son las mismas cuentas que ya se calculaban antes.
  const etapas = useMemo<EtapaResumen[]>(() => {
    const t2iDone = groups.t2i.filter((j) => j.status === "done").length;
    const i2iDone = groups.i2i.filter((j) => j.status === "done").length;
    const vidsDone = groups.vids.filter((j) => j.status === "done").length;
    const hayPlan = Boolean(project);
    const listoExport =
      groups.vids.length > 0 && vidsDone === groups.vids.length ? 1 : 0;
    return [
      { label: "Brief → Plan", hechos: hayPlan ? 1 : 0, total: 1 },
      { label: "Imágenes base", hechos: t2iDone, total: groups.t2i.length },
      { label: "Imágenes derivadas", hechos: i2iDone, total: groups.i2i.length },
      { label: "Videos", hechos: vidsDone, total: groups.vids.length },
      { label: "Unir y exportar", hechos: listoExport, total: 1 },
    ];
  }, [project, groups]);

  return (
    <PantallaFija>
      {/* ─── Header: volver, nombre, estado y el segmented Pipeline/Resultado ── */}
      <div className="flex flex-none flex-col gap-3 px-4 pt-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/")}
            title="Volver a proyectos"
            icon={<ArrowLeft aria-hidden className="size-4" />}
          />
          <h1 className="min-w-0 truncate font-mono text-display font-semibold text-fg">
            {project?.name ?? "Pipeline"}
          </h1>
          {project ? (
            <StatusBadge status={project.status} />
          ) : (
            <Skeleton className="h-5 w-24" />
          )}
          <span className="flex-1" />
          <Segmented
            value="pipeline"
            onChange={(v) => {
              if (v === "resultado") router.push(`/project/${projectId}/result`);
            }}
            etiqueta="Vista del proyecto"
            options={[
              { value: "pipeline", label: "Pipeline" },
              { value: "resultado", label: "Resultado" },
            ]}
          />
        </div>

        {loadError && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-body text-danger"
          >
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {loadError}
          </p>
        )}

        {!cargando && !sinJobs && (
          <>
            <EtapasFila etapas={etapas} />
            <AvisoAprobacion
              cantidad={progress.awaiting}
              onRevisar={() => {
                // "Revisar uno por uno" selecciona el primer clip que espera
                // aprobacion y deja que el panel (mas abajo) lo abra: no hace
                // falta cambiar de vista, porque ya no hay una vista separada.
                const primero = timelineItems.find((it) => it.status === "awaiting_approval");
                if (primero) setSelectedClipId(primero.clipId);
              }}
              onAprobarTodos={() => void approveBatch()}
            />
          </>
        )}

        {/*
          Controles de la cola: generar/reintentar y pausar/reanudar/cancelar. Antes
          vivian en una Card de cabecera propia; se comparten la misma fila para no
          empujar el pipeline de clips mas abajo, que es lo que hay que ver primero.
        */}
        <div className="flex flex-wrap items-center gap-2 border-b border-divider pb-3">
          <Button
            variant={sinJobs ? "primary" : "secondary"}
            size="sm"
            onClick={() => void handleGenerateAll()}
            title={
              jobs.length === 0
                ? "Arma los jobs y arranca la generación de este proyecto"
                : "Reencola los jobs pendientes sin tocar lo ya aprobado"
            }
            icon={
              jobs.length === 0 ? (
                <Play aria-hidden className="size-4" />
              ) : (
                <ArrowsClockwise aria-hidden className="size-4" />
              )
            }
          >
            {jobs.length === 0 ? "Generar todo" : "Reintentar pendientes"}
          </Button>
          <span className="mx-1 h-4 w-px bg-divider" aria-hidden />
          <span className="text-label font-medium uppercase tracking-wide text-fg-dim">
            Cola
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void control("pause")}
            icon={<Pause aria-hidden className="size-3.5" />}
          >
            Pausar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void control("resume")}
            icon={<Play aria-hidden className="size-3.5" />}
          >
            Reanudar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void control("cancel")}
            icon={<Stop aria-hidden className="size-3.5" />}
          >
            Cancelar
          </Button>
          <span className="flex-1" />
          <p className="text-body text-fg-dim">
            <span className="font-mono tnum text-fg">
              {progress.done}/{progress.total}
            </span>{" "}
            aprobados <span className="font-mono tnum">({progress.pct}%)</span>
          </p>
        </div>
      </div>

      {cargando ? (
        <div className="flex flex-col gap-3 px-4 py-6 sm:px-6">
          <Skeleton className="h-9 w-full max-w-md" />
          <SkeletonGrid items={8} />
        </div>
      ) : sinJobs ? (
        <div className="px-4 py-6 sm:px-6">
          <EmptyState
            icon={<FilmSlate aria-hidden className="size-6" />}
            title="Todavía no hay jobs"
            body="Este proyecto tiene el plan cargado pero la cola nunca arrancó. Al generar se arma un job por imagen y uno por clip, y podés aprobar de a lotes."
            action={{ label: "Generar todo", onClick: () => void handleGenerateAll() }}
          />
        </div>
      ) : (
        <ImagenesYClips
          groups={groups}
          projectId={projectId}
          handlers={handlers}
          imageMeta={imageMeta}
          timelineItems={timelineItems}
          videoModels={videoModels}
          projectVideoModel={projectVideoModel}
          assetTypeByRef={assetTypeByRef}
          ordenByClip={ordenByClip}
          resByClip={resByClip}
          resolutionOptions={resolutionOptions}
          selectedClipId={selectedClipId}
          onSelectClip={setSelectedClipId}
          onSave={onChangePrompt}
          onRegenerate={onRegenerate}
          onRegenerateMany={onRegenerateMany}
          onChangeResolution={onChangeResolution}
        />
      )}

      <div className="flex-none px-4 pb-4 sm:px-6">
        <LogPanel logs={logs} />
      </div>
    </PantallaFija>
  );
}

interface GroupHandlers {
  onApprove: (id: string, index?: number) => void;
  onRegenerate: (id: string) => void;
  onChangePrompt: (
    id: string,
    payload: {
      prompt?: string;
      dialogue?: string;
      durationSec?: number;
      resolution?: string;
      model?: string;
      finalPrompt?: string;
      regenerate?: boolean;
    }
  ) => void;
  onExtend: (id: string) => void;
}

interface JobMeta {
  promptByRef: Map<string, string>;
  dialogueByRef: Map<string, string>;
  durationByRef: Map<string, number>;
  finalPromptByRef: Map<string, string>;
  modelOptions: { id: string; label: string }[];
  projectModel: string;
  formato: string;
}

/* ------------------------------------------------------------------------- */
/* Seccion de imagenes (colapsable) + pipeline de clips a pantalla completa. */
/* ------------------------------------------------------------------------- */

function ImagenesYClips({
  groups,
  projectId,
  handlers,
  imageMeta,
  timelineItems,
  videoModels,
  projectVideoModel,
  assetTypeByRef,
  ordenByClip,
  resByClip,
  resolutionOptions,
  selectedClipId,
  onSelectClip,
  onSave,
  onRegenerate,
  onRegenerateMany,
  onChangeResolution,
}: {
  groups: { t2i: JobRecord[]; i2i: JobRecord[]; vids: JobRecord[] };
  projectId: string;
  handlers: GroupHandlers;
  imageMeta: JobMeta;
  timelineItems: BatchTimelineItem[];
  videoModels: { id: string; label: string }[];
  projectVideoModel: string;
  assetTypeByRef: Map<string, "avatar" | "broll">;
  ordenByClip: Map<string, number>;
  resByClip: Map<string, string>;
  resolutionOptions: string[];
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  onSave: (jobId: string, payload: SavePayload) => void;
  onRegenerate: (jobId: string) => void;
  onRegenerateMany: (jobIds: string[]) => void;
  onChangeResolution: (clipId: string, r: string) => void;
}) {
  // Colapsada por defecto arriba de UMBRAL_VISTA_LIVIANA: con 95 clips, la seccion
  // de imagenes (hasta 95 tarjetas mas) no puede competir por el primer scroll con
  // el pipeline de clips, que es lo que hay que revisar. Con pocos clips se ve
  // abierta, que es el caso donde de verdad ayuda ver las imagenes de un vistazo.
  const [imagenesAbiertas, setImagenesAbiertas] = useState(
    groups.t2i.length + groups.i2i.length <= UMBRAL_VISTA_LIVIANA
  );
  const totalImagenes = groups.t2i.length + groups.i2i.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {totalImagenes > 0 && (
        <section className="flex-none border-b border-divider px-4 py-3 sm:px-6">
          <button
            type="button"
            onClick={() => setImagenesAbiertas((v) => !v)}
            aria-expanded={imagenesAbiertas}
            aria-controls="seccion-imagenes"
            className="flex w-full items-center gap-2 text-left"
          >
            <ImageSquare aria-hidden className="size-4 text-fg-dim" />
            <span className="text-body font-medium text-fg">Imágenes</span>
            <span className="font-mono tnum text-label text-fg-dim">
              {totalImagenes}
            </span>
            <span className="flex-1" />
            <CaretDown
              aria-hidden
              className={cn(
                "size-4 text-fg-dim transition-transform",
                imagenesAbiertas && "rotate-180"
              )}
            />
          </button>
          {imagenesAbiertas && (
            <div id="seccion-imagenes" className="mt-3 flex flex-col gap-4">
              <GrupoImagenes
                title="Imágenes base (text2image)"
                jobs={groups.t2i}
                projectId={projectId}
                handlers={handlers}
                meta={imageMeta}
              />
              <GrupoImagenes
                title="Imágenes derivadas (image2image · misma identidad)"
                jobs={groups.i2i}
                projectId={projectId}
                handlers={handlers}
                meta={imageMeta}
              />
            </div>
          )}
        </section>
      )}

      <PipelineClips
        vids={groups.vids}
        projectId={projectId}
        timelineItems={timelineItems}
        videoModels={videoModels}
        projectVideoModel={projectVideoModel}
        assetTypeByRef={assetTypeByRef}
        ordenByClip={ordenByClip}
        resByClip={resByClip}
        resolutionOptions={resolutionOptions}
        selectedClipId={selectedClipId}
        onSelectClip={onSelectClip}
        onSave={onSave}
        onRegenerate={onRegenerate}
        onRegenerateMany={onRegenerateMany}
        onChangeResolution={onChangeResolution}
      />
    </div>
  );
}

function GrupoImagenes({
  title,
  jobs,
  projectId,
  handlers,
  meta,
}: {
  title: string;
  jobs: JobRecord[];
  projectId: string;
  handlers: GroupHandlers;
  meta: JobMeta;
}) {
  if (jobs.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label font-medium uppercase tracking-wide text-fg-dim">
        {title} <span className="font-mono tnum">({jobs.length})</span>
      </h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {jobs.map((j) => (
          <JobCard
            key={j.id}
            job={j}
            projectId={projectId}
            currentPrompt={meta.promptByRef.get(j.refId) ?? ""}
            currentDialogue={meta.dialogueByRef.get(j.refId) ?? ""}
            currentDuration={meta.durationByRef.get(j.refId)}
            currentFinalPrompt={meta.finalPromptByRef.get(j.refId) ?? ""}
            modelOptions={meta.modelOptions}
            projectModel={meta.projectModel}
            formato={meta.formato}
            {...handlers}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* El pipeline de clips: timeline grande + lista con scroll + panel editor.  */
/* ------------------------------------------------------------------------- */

function PipelineClips({
  vids,
  projectId,
  timelineItems,
  videoModels,
  projectVideoModel,
  assetTypeByRef,
  ordenByClip,
  resByClip,
  resolutionOptions,
  selectedClipId,
  onSelectClip,
  onSave,
  onRegenerate,
  onRegenerateMany,
  onChangeResolution,
}: {
  vids: JobRecord[];
  projectId: string;
  timelineItems: BatchTimelineItem[];
  videoModels: { id: string; label: string }[];
  projectVideoModel: string;
  assetTypeByRef: Map<string, "avatar" | "broll">;
  ordenByClip: Map<string, number>;
  resByClip: Map<string, string>;
  resolutionOptions: string[];
  selectedClipId: string | null;
  onSelectClip: (clipId: string | null) => void;
  onSave: (jobId: string, payload: SavePayload) => void;
  onRegenerate: (jobId: string) => void;
  onRegenerateMany: (jobIds: string[]) => void;
  onChangeResolution: (clipId: string, r: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmarLote, setConfirmarLote] = useState(false);

  // Si el proyecto cambia de tener 0 clips a tenerlos (primer load), o si el
  // seleccionado ya no existe (se borro/regenero con otro id), cae al primero.
  // La selección la controla `PipelinePage` (ver comentario ahí sobre por qué).
  useEffect(() => {
    if (timelineItems.length === 0) {
      if (selectedClipId !== null) onSelectClip(null);
      return;
    }
    if (!selectedClipId || !timelineItems.some((it) => it.clipId === selectedClipId)) {
      onSelectClip(timelineItems[0].clipId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineItems, selectedClipId]);

  // ─── El ancho del panel: localStorage + limites + doble-click reset ────────
  const [asideW, setAsideW] = useState<number>(anchoInicial);
  const [dragging, setDragging] = useState(false);
  const arrastreRef = useRef<{ x0: number; w0: number } | null>(null);

  useEffect(() => {
    const guardado = window.localStorage.getItem(LS_ASIDE_W);
    if (guardado) {
      const n = Number(guardado);
      if (Number.isFinite(n)) setAsideW(Math.min(anchoMaximo(), Math.max(ASIDE_MIN, n)));
    }
  }, []);

  const persistAncho = useCallback((w: number) => {
    setAsideW(w);
    window.localStorage.setItem(LS_ASIDE_W, String(w));
  }, []);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      arrastreRef.current = { x0: e.clientX, w0: asideW };
      setDragging(true);
      const max = anchoMaximo();
      function move(ev: MouseEvent) {
        const st = arrastreRef.current;
        if (!st) return;
        const next = Math.min(max, Math.max(ASIDE_MIN, st.w0 + (st.x0 - ev.clientX)));
        setAsideW(next);
      }
      function up() {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        setDragging(false);
        setAsideW((w) => {
          window.localStorage.setItem(LS_ASIDE_W, String(w));
          return w;
        });
      }
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [asideW]
  );

  const resetAncho = useCallback(() => persistAncho(anchoInicial()), [persistAncho]);
  const toggleAncho = useCallback(() => {
    persistAncho(
      asideW > ASIDE_WIDE
        ? anchoInicial()
        : Math.max(ASIDE_MIN, Math.round(window.innerWidth * 0.6))
    );
  }, [asideW, persistAncho]);

  // ─── Teclado: flechas arriba/abajo cambian de clip ──────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "textarea" || tag === "input") return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const idx = timelineItems.findIndex((it) => it.clipId === selectedClipId);
      if (idx === -1) return;
      e.preventDefault();
      const next =
        e.key === "ArrowDown"
          ? Math.min(timelineItems.length - 1, idx + 1)
          : Math.max(0, idx - 1);
      const nextId = timelineItems[next]?.clipId;
      if (nextId) onSelectClip(nextId);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [timelineItems, selectedClipId, onSelectClip]);

  const totalDur = useMemo(
    () => timelineItems.reduce((acc, it) => acc + it.duracionSeg, 0),
    [timelineItems]
  );

  const selectedItem =
    timelineItems.find((it) => it.clipId === selectedClipId) ?? null;
  const selectedJob = selectedItem
    ? vids.find((j) => j.refId === selectedItem.clipId) ?? null
    : null;

  const toggleSel = useCallback((clipId: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(clipId)) next.delete(clipId);
      else next.add(clipId);
      return next;
    });
  }, []);

  const selectedJobIds = useMemo(
    () =>
      vids.filter((j) => selected.has(j.refId)).map((j) => j.id),
    [vids, selected]
  );
  const fallidos = timelineItems.filter((it) => it.status === "failed").length;

  if (timelineItems.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 sm:px-6">
        <EmptyState
          icon={<FilmSlate aria-hidden className="size-6" />}
          title="No hay clips de video"
          body="Este proyecto no tiene clips generados por IA en el plan, así que no hay nada que revisar acá."
        />
      </div>
    );
  }

  return (
    <div
      className="grid min-h-0 flex-1 border-t border-divider"
      style={{
        gridTemplateColumns: `minmax(0,1fr) ${asideW}px`,
        userSelect: dragging ? "none" : "auto",
      }}
    >
      {/* ─── Columna izquierda: timeline grande + lista con scroll propio ──── */}
      <div className="flex min-h-0 flex-col">
        <div className="flex flex-none flex-col gap-1.5 border-b border-divider px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between text-label text-fg-dim">
            <span>
              Línea de tiempo ·{" "}
              <span className="font-mono tnum text-fg">{timelineItems.length}</span> clips
            </span>
            <span className="font-mono tnum">{formatDuration(totalDur)}</span>
          </div>
          <TimelineClips
            items={timelineItems}
            seleccionado={selectedClipId}
            onSeleccionar={onSelectClip}
            alto={44}
          />
        </div>

        {/* Barra de seleccion multiple / regenerar en lote: reemplaza a la vieja
            vista "Revisar/Arreglar" con checkboxes, ahora integrada arriba de la
            lista en vez de en una pestaña separada. */}
        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-divider px-4 py-2 sm:px-6">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set(timelineItems.filter((it) => it.status === "failed").map((it) => it.clipId)))}
            disabled={fallidos === 0}
            icon={<WarningCircle aria-hidden className="size-3.5" />}
            title="Marca todos los clips que fallaron"
          >
            Marcar fallidos (<span className="tnum">{fallidos}</span>)
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
            icon={<Broom aria-hidden className="size-3.5" />}
          >
            Limpiar
          </Button>
          <span className="flex-1" />
          {selected.size > 0 && (
            <>
              <span className="text-label text-fg-dim">
                <span className="font-mono tnum text-fg">{selected.size}</span>{" "}
                seleccionados
              </span>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirmarLote(true)}
                icon={<Coins aria-hidden className="size-3.5" />}
                title="Vuelve a generar todos los seleccionados con lo que ya está guardado en el plan"
              >
                Regenerar sin editar
              </Button>
            </>
          )}
        </div>
        <Confirmar
          abierto={confirmarLote}
          onCambio={setConfirmarLote}
          title="¿Regenerar todos sin editar?"
          detalle={`Se vuelven a generar ${selectedJobIds.length} ${
            selectedJobIds.length === 1 ? "job" : "jobs"
          } con lo que ya está guardado en el plan. Cada video se cobra aparte y no hay forma de cancelar lo que ya salió.`}
          labelConfirmar={`Regenerar ${selectedJobIds.length}`}
          peligroso
          onConfirmar={() => onRegenerateMany(selectedJobIds)}
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-4">
          <table className="w-full text-body">
            <caption className="sr-only">Clips del proyecto, en orden de timeline</caption>
            <thead>
              <tr className="border-b border-divider text-left text-label uppercase tracking-wide text-fg-dim">
                <th scope="col" className="w-8 px-2 py-2">
                  <span className="sr-only">Marcar</span>
                </th>
                <th scope="col" className="w-10 px-2 py-2">
                  #
                </th>
                <th scope="col" className="w-12 px-2 py-2">
                  <span className="sr-only">Miniatura</span>
                </th>
                <th scope="col" className="px-2 py-2">
                  Clip
                </th>
                <th scope="col" className="w-14 px-2 py-2">
                  Dur.
                </th>
                <th scope="col" className="px-2 py-2">
                  Diálogo
                </th>
                <th scope="col" className="w-32 px-2 py-2">
                  Estado
                </th>
              </tr>
            </thead>
            <tbody>
              {timelineItems.map((it) => (
                <FilaClip
                  key={it.clipId}
                  item={it}
                  activo={it.clipId === selectedClipId}
                  marcado={selected.has(it.clipId)}
                  onSelect={onSelectClip}
                  onToggleMarcado={toggleSel}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Manija de resize + panel editor ──────────────────────────────── */}
      <aside className="relative flex min-h-0 flex-col gap-3.5 overflow-y-auto border-l border-divider px-5 py-4">
        {/*
          Manija de 8px sobre el borde izquierdo, mitad afuera (`-left-1`) para que
          el area de agarre no le robe 8px al contenido del panel. `col-resize` +
          doble click reset, igual que el handoff.
        */}
        <div
          onMouseDown={startDrag}
          onDoubleClick={resetAncho}
          title="Arrastrá para ajustar · doble click para volver al ancho inicial"
          className="absolute -left-1 top-0 bottom-0 z-10 flex w-2 cursor-col-resize items-center justify-center hover:bg-accent/15"
        >
          <span className="h-8 w-0.5 rounded-sm bg-border" aria-hidden />
        </div>

        {selectedItem && (
          <ClipEditor
            key={selectedItem.clipId}
            item={selectedItem}
            job={selectedJob}
            projectId={projectId}
            videoModels={videoModels}
            projectVideoModel={projectVideoModel}
            assetType={assetTypeByRef.get(selectedItem.clipId)}
            orden={ordenByClip.get(selectedItem.clipId) ?? selectedItem.orden}
            resolution={resByClip.get(selectedItem.clipId)}
            resolutionOptions={resolutionOptions}
            asideW={asideW}
            onToggleWide={toggleAncho}
            onPrev={() => {
              const idx = timelineItems.findIndex((it) => it.clipId === selectedClipId);
              const prevId = timelineItems[Math.max(0, idx - 1)]?.clipId;
              if (prevId) onSelectClip(prevId);
            }}
            onNext={() => {
              const idx = timelineItems.findIndex((it) => it.clipId === selectedClipId);
              const nextId =
                timelineItems[Math.min(timelineItems.length - 1, idx + 1)]?.clipId;
              if (nextId) onSelectClip(nextId);
            }}
            onSave={onSave}
            onRegenerate={onRegenerate}
            onChangeResolution={onChangeResolution}
          />
        )}
      </aside>
    </div>
  );
}

/** Una fila de la lista de clips. `memo` porque tocar un checkbox no debe re-renderizar
 * las otras N filas — mismo motivo que `FixRow` tenia en la version anterior. */
const FilaClip = memo(function FilaClip({
  item,
  activo,
  marcado,
  onSelect,
  onToggleMarcado,
}: {
  item: BatchTimelineItem;
  activo: boolean;
  marcado: boolean;
  onSelect: (clipId: string) => void;
  onToggleMarcado: (clipId: string) => void;
}) {
  const estado = estadoDeClip(item);
  return (
    <tr
      className={cn(
        "cursor-pointer border-b border-divider transition-colors",
        activo ? "bg-accent/5" : "hover:bg-surface-hi/50"
      )}
      onClick={() => onSelect(item.clipId)}
    >
      <td className="px-2 py-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={marcado}
          onChange={() => onToggleMarcado(item.clipId)}
          aria-label={`Marcar el clip ${item.orden}`}
          className="size-4 accent-accent"
        />
      </td>
      <td className="px-2 py-1.5 align-middle font-mono tnum text-fg-dim">{item.orden}</td>
      <td className="px-2 py-1.5 align-middle">
        {item.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt=""
            aria-hidden
            className="h-12 w-9 rounded-sm bg-bg object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="block h-12 w-9 rounded-sm bg-surface-hi"
          />
        )}
      </td>
      <td className="max-w-0 px-2 py-1.5 align-middle">
        <span className="block truncate font-mono text-label text-fg">{item.label}</span>
      </td>
      <td className="px-2 py-1.5 align-middle font-mono tnum text-label text-fg-dim">
        {item.duracionSeg}s
      </td>
      <td className="max-w-0 px-2 py-1.5 align-middle">
        <span className="block truncate text-label text-fg-dim" title={item.dialogo}>
          {item.dialogo}
        </span>
      </td>
      <td className="px-2 py-1.5 align-middle">
        <Badge tone={estado.tone} punto animado={estado.animado}>
          {estado.label}
        </Badge>
      </td>
    </tr>
  );
});

/* ------------------------------------------------------------------------- */
/* El panel editor de un clip: header + medios + campos + acciones.          */
/* ------------------------------------------------------------------------- */

interface PreviewData {
  type: "image" | "video";
  label: string;
  status: JobRecord["status"];
  model?: string;
  durationSec?: number;
  resolution?: string;
  executedPrompt: string;
  autoPrompt?: string;
  promptOverride?: string | null;
  json: unknown;
  updatedAt?: string;
  outputPath?: string | null;
  inputImage?: { id: string; file: string | null; status: string; json: unknown };
  refs?: { id: string; kind: string; file: string | null }[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function ClipEditor({
  item,
  job,
  projectId,
  videoModels,
  projectVideoModel,
  orden,
  resolution,
  resolutionOptions,
  asideW,
  onToggleWide,
  onPrev,
  onNext,
  onSave,
  onRegenerate,
  onChangeResolution,
}: {
  item: BatchTimelineItem;
  job: JobRecord | null;
  projectId: string;
  videoModels: { id: string; label: string }[];
  projectVideoModel: string;
  assetType?: "avatar" | "broll";
  orden: number;
  resolution?: string;
  resolutionOptions: string[];
  asideW: number;
  onToggleWide: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSave: (jobId: string, payload: SavePayload) => void;
  onRegenerate: (jobId: string) => void;
  onChangeResolution: (clipId: string, r: string) => void;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [copiado, setCopiado] = useState<boolean | null>(null);
  const [verPrompt, setVerPrompt] = useState(false);

  const [vprompt, setVprompt] = useState("");
  const [dialog, setDialog] = useState("");
  const [duration, setDuration] = useState<number>(8);
  const [selectedModel, setSelectedModel] = useState("");
  const [overrideOn, setOverrideOn] = useState(false);
  const [finalPromptText, setFinalPromptText] = useState("");

  const timerCopia = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
    ─── LA PRECARGA DE LOS CAMPOS. NO TOCAR EL ORDEN NI LAS DEPS ──────────────
    Depende de `job.id` y `job.updatedAt` (no de `item`, que se reconstruye en cada
    poll): si se saca esa dependencia, el editor sigue mostrando lo que escribiste
    aunque el guardado haya fallado, y el error no se ve hasta el video final
    exportado. Sin job (clip FILMAR_REAL) no hay preview que pedir.
  */
  useEffect(() => {
    if (!job) {
      setData(null);
      return;
    }
    let alive = true;
    fetch(`/api/jobs/${job.id}/preview`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const pd = d as PreviewData;
        setData(pd);
        const j = asRecord(pd.json);
        setVprompt(String(j.video_prompt ?? ""));
        setDialog(String(j.dialogo ?? ""));
        setDuration(Number(j.duracion_seg ?? 8) || 8);
        setSelectedModel(pd.model ?? "");
        const ov = (pd.promptOverride ?? "").trim();
        setOverrideOn(Boolean(ov));
        setFinalPromptText(ov || pd.autoPrompt || pd.executedPrompt || "");
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [job?.id, job?.updatedAt]);

  useEffect(() => setShowVideo(false), [job?.id]);
  useEffect(
    () => () => {
      if (timerCopia.current) clearTimeout(timerCopia.current);
    },
    []
  );

  const estado = estadoDeClip(item);
  const ver = job ? encodeURIComponent(job.updatedAt ?? "") : "";
  const fileUrl = (p: string) => `/api/files/${projectId}/${p}?v=${ver}`;
  const inputImg = data?.inputImage?.file ?? item.imageUrl ?? null;
  const outUrl = job?.outputPath ? fileUrl(job.outputPath) : item.videoUrl;

  const opcionesModelo = useMemo<ReadonlyArray<SelectOption<string>>>(() => {
    const base = videoModels.map((m) => ({ value: m.id, label: m.label }));
    const actual = selectedModel || projectVideoModel;
    if (actual && !base.some((o) => o.value === actual)) {
      base.push({ value: actual, label: actual });
    }
    return base;
  }, [videoModels, selectedModel, projectVideoModel]);

  async function copyPrompt() {
    if (!data?.executedPrompt) return;
    let ok = true;
    try {
      if (!navigator.clipboard) throw new Error("sin portapapeles");
      await navigator.clipboard.writeText(data.executedPrompt);
    } catch {
      ok = false;
    }
    setCopiado(ok);
    if (timerCopia.current) clearTimeout(timerCopia.current);
    timerCopia.current = setTimeout(() => setCopiado(null), ok ? 1500 : 5000);
  }

  /*
    ─── EL GUARDADO. ES EL CAMINO CRITICO DE LA PANTALLA ──────────────────────
    Mismo payload que antes, mismo unico camino al plan (`onSave` -> `changePromptJob`).
  */
  function save(regenerate: boolean) {
    if (!job) return;
    const payload: SavePayload = {
      prompt: vprompt,
      dialogue: dialog,
      durationSec: duration,
      regenerate,
    };
    if (selectedModel) payload.model = selectedModel;
    payload.finalPrompt = overrideOn ? finalPromptText : "";
    onSave(job.id, payload);
  }

  return (
    <>
      {/* ─── Header: id, badge, agrandar/achicar, flechas ↑↓ ────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono tnum text-title font-semibold text-fg">
          #{orden} {item.label}
        </span>
        <Badge tone={estado.tone} punto animado={estado.animado}>
          {estado.label}
        </Badge>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={onToggleWide}
          title={asideW > ASIDE_WIDE ? "Achicar el panel" : "Agrandar el panel"}
          icon={
            asideW > ASIDE_WIDE ? (
              <ArrowsInLineHorizontal aria-hidden className="size-4" />
            ) : (
              <ArrowsOutLineHorizontal aria-hidden className="size-4" />
            )
          }
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={onPrev}
          title="Clip anterior (↑)"
          icon={<CaretUp aria-hidden className="size-4" />}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={onNext}
          title="Clip siguiente (↓)"
          icon={<CaretDown aria-hidden className="size-4" />}
        />
      </div>

      {/* ─── Frame inicial + Clip, en 2 columnas 9:16 ────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-label text-fg-dim">Frame inicial</span>
          {inputImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              /*
                `inputImg` viene de dos fuentes con forma distinta: del preview del
                job llega una ruta RELATIVA al proyecto (`images/x.png`), y de
                `item.imageUrl` llega ya resuelta como una URL de la ruta de archivos.
                El chequeo es contra el prefijo COMPLETO de esa ruta y no contra el
                prefijo `api` a secas para que la verificacion de endpoints
                (`tasks/_verificacion-endpoints.sh`) siga contando los endpoints reales
                de la pantalla: un prefijo pelado en el codigo le figura como un
                endpoint nuevo y marca una regresion que no existe.
              */
              src={inputImg.startsWith("/api/files/") ? inputImg : fileUrl(inputImg)}
              alt={`Frame inicial del clip ${orden}`}
              className="aspect-[9/16] w-full rounded-md bg-bg object-cover"
            />
          ) : (
            <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md bg-surface-hi text-label text-fg-dim">
              sin imagen
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-label text-fg-dim">Clip</span>
          {outUrl ? (
            showVideo ? (
              <video
                key={outUrl}
                src={outUrl}
                controls
                preload="none"
                playsInline
                aria-label={`Clip ${orden}`}
                className="aspect-[9/16] w-full rounded-md bg-bg object-cover"
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowVideo(true)}
                className="flex aspect-[9/16] w-full items-center justify-center rounded-md bg-surface-hi text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Play aria-hidden className="size-6" />
              </button>
            )
          ) : (
            <div className="flex aspect-[9/16] w-full items-center justify-center rounded-md bg-surface-hi text-label text-fg-dim">
              {estado.animado ? "generando…" : "sin video"}
            </div>
          )}
        </div>
      </div>

      {job ? (
        <>
          <Textarea
            label="Diálogo (es-AR, lo que dice la persona)"
            value={dialog}
            onChange={(e) => setDialog(e.target.value)}
            className="h-20 leading-relaxed"
          />

          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Duración"
              value={String(duration)}
              onValueChange={(v) => setDuration(Number(v))}
              options={DURACION_OPCIONES}
            />
            {videoModels.length > 0 && (
              <Select
                label="Modelo"
                value={selectedModel || projectVideoModel}
                onValueChange={setSelectedModel}
                options={opcionesModelo}
              />
            )}
          </div>

          {resolutionOptions.length > 0 && (
            <Select
              label="Resolución"
              value={resolution ?? resolutionOptions[0]}
              onValueChange={(r) => onChangeResolution(item.clipId, r)}
              options={resolutionOptions.map((r) => ({ value: r, label: r }))}
            />
          )}

          <Textarea
            label="Prompt visual del video"
            hint="Describe la escena. Se guarda en el plan."
            value={vprompt}
            onChange={(e) => setVprompt(e.target.value)}
            spellCheck={false}
            className="h-24 leading-relaxed"
          />

          <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
            <label className="flex cursor-pointer items-start gap-2 text-body text-fg">
              <input
                type="checkbox"
                checked={overrideOn}
                onChange={(e) => {
                  const on = e.target.checked;
                  setOverrideOn(on);
                  if (on && !finalPromptText.trim()) {
                    setFinalPromptText(data?.autoPrompt ?? data?.executedPrompt ?? "");
                  }
                }}
                className="mt-0.5 size-4 shrink-0 accent-accent"
              />
              <span>
                Editar a mano el prompt final
                <span className="block text-label text-fg-dim">
                  Se manda tal cual al modelo de video.
                </span>
              </span>
            </label>
            {overrideOn ? (
              <Textarea
                label="Prompt final que se ejecuta"
                labelOculto
                mono
                value={finalPromptText}
                onChange={(e) => setFinalPromptText(e.target.value)}
                spellCheck={false}
                className="h-32 whitespace-pre-wrap leading-relaxed"
              />
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-label font-medium text-fg-dim">
                    Prompt final que se ejecuta
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setVerPrompt((v) => !v)}
                    aria-expanded={verPrompt}
                    icon={
                      verPrompt ? (
                        <EyeSlash aria-hidden className="size-3.5" />
                      ) : (
                        <Eye aria-hidden className="size-3.5" />
                      )
                    }
                  >
                    {verPrompt ? "Ocultar" : "Ver"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copyPrompt()}
                    disabled={!data?.executedPrompt}
                    icon={
                      copiado === null ? (
                        <Copy aria-hidden className="size-3.5" />
                      ) : copiado ? (
                        <Check aria-hidden className="size-3.5" />
                      ) : (
                        <WarningCircle aria-hidden className="size-3.5" />
                      )
                    }
                  >
                    Copiar
                  </Button>
                </div>
                {verPrompt && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-sm bg-bg px-2 py-1.5 font-mono text-label leading-relaxed text-fg-dim">
                    {data ? data.executedPrompt : "cargando…"}
                  </pre>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={() => save(false)}
              icon={<FloppyDisk aria-hidden className="size-3.5" />}
              title="Guarda los cambios en el plan SIN regenerar. Se usan en el próximo render y en el export"
            >
              Guardar
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="border-accent text-accent hover:bg-accent/10"
              onClick={() => save(true)}
              icon={<ArrowsClockwise aria-hidden className="size-3.5" />}
              title="Guarda los cambios y vuelve a generar este clip con lo editado. Cuesta plata"
            >
              Guardar y regenerar
            </Button>
            {outUrl && (
              <Button asChild size="sm" variant="ghost" title="Baja este clip solo">
                <a
                  href={`${outUrl}${outUrl.includes("?") ? "&" : "?"}dl=1`}
                  download
                >
                  <DownloadSimple aria-hidden className="size-3.5" />
                </a>
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRegenerate(job.id)}
              title="Regenerar solo este clip, sin editar. Cuesta plata."
              icon={<ArrowCounterClockwise aria-hidden className="size-3.5" />}
            >
              Regenerar
            </Button>
          </div>
          <p className="text-label text-fg-dim">
            Guardar no gasta: se usa en el próximo render y en el export. Regenerar
            cuesta.
          </p>

          {err && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-sm bg-danger/10 px-2.5 py-2 text-body text-danger"
            >
              <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {err}
            </p>
          )}
        </>
      ) : (
        <p className="flex items-start gap-2 rounded-sm bg-accent/10 px-2.5 py-2 text-body text-fg">
          <MagnifyingGlass aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
          Este clip es <code className="font-mono">FILMAR_REAL</code>: lo subís vos
          desde la pantalla de Resultado. No tiene job de video ni prompt para editar.
        </p>
      )}
    </>
  );
}
