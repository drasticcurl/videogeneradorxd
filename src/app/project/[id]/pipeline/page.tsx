"use client";
/**
 * Pantalla "Pipeline": el estado en vivo del proyecto, con TRES vistas.
 *
 *   - General            progreso por etapa, los grupos de jobs y el grafo del flujo.
 *   - Revisar / Arreglar  la lista compacta que aguanta 95 clips (video on-demand).
 *   - Storyboard          los frames en orden, con las tarjetas de job editables.
 *
 * Adentro de "Revisar / Arreglar" vive `ReviewStoryboard`, que es el storyboard
 * EDITABLE de los clips que marcaste: prompt visual, dialogo, duracion, modelo y el
 * prompt final read-only.
 *
 * ─── LO QUE NO SE TOCO, Y ES LO QUE IMPORTA ──────────────────────────────────
 *
 * EL EXPORT A FFMPEG LEE DEL PLAN, NO DE LOS JOBS. Todo lo que se edita en el
 * storyboard de revision se persiste al plan por el mismo camino que antes:
 * `onSave` -> `changePromptJob` del store -> POST al endpoint de prompt del job ->
 * `loadProject`, que vuelve a bajar el plan. Ni el payload ni el orden de esas tres
 * cosas cambio. Si se rompe, las ediciones se pierden EN SILENCIO y recien se
 * descubren en el video final exportado.
 *
 * `SavePayload` tiene exactamente la misma forma que antes: seis campos opcionales.
 *
 * Los TRES fetch de este archivo son los mismos, con el mismo metodo y el mismo
 * body: arrancar la generacion, aprobar el lote, y el preview de un job.
 *
 * El corte de 24 clips sigue: arriba de ese numero la pantalla arranca en la vista
 * liviana. Es lo unico que hace usable un VSL de 95 clips.
 *
 * ─── QUE CAMBIO ──────────────────────────────────────────────────────────────
 *
 * EL SWITCH DE ESTADOS LOCAL QUE TENIA ESTE ARCHIVO SE BORRO. Era una de las cuatro
 * copias divergentes que el rediseño elimina: tenia sus propios colores y su propia
 * tabla de labels, y por eso el mismo estado se veia distinto aca y en el resto de la
 * app. Ahora el tono y el label salen de `estadoDeJob` + `Badge`, que son la unica
 * fuente de verdad. El nombre viejo de esa funcion no se escribe en ningun lado del
 * archivo, justamente para que un `grep` pueda probar que se fue.
 *
 * El toggle de vistas ahora es `Tabs`, asi que se navega con las flechas del teclado
 * y el contenido inactivo NO queda montado. Con 95 clips eso es la diferencia entre
 * una pestaña usable y una pestaña con 95 `<video>` de fondo.
 *
 * "Regenerar todos sin editar" pide CONFIRMACION y dice cuantos jobs va a regenerar.
 * Antes era un click directo sobre algo que en un VSL cuesta decenas de dolares.
 *
 * Los callbacks que van a `JobCard` estan estabilizados con `useCallback` y los
 * objetos `meta` con `useMemo`. `JobCard` esta envuelta en `memo` y hasta ahora no
 * rendia nada, porque este archivo le pasaba arrows nuevas en cada render y la
 * comparacion shallow fallaba siempre. Con esto, escribir en el campo de numeros de
 * la vista de arreglo ya no re-renderiza las 95 tarjetas. Ojo con la expectativa: en
 * el tick del polling los objetos `job` vienen nuevos del server, asi que ahi el memo
 * sigue sin poder ahorrar nada. Lo que se gana son los renders por estado local, que
 * son los que el usuario siente mientras escribe.
 */
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowsClockwise,
  Broom,
  CaretDown,
  Check,
  CheckCircle,
  Coins,
  Copy,
  DownloadSimple,
  Eye,
  EyeSlash,
  FilmSlate,
  FloppyDisk,
  FlowArrow,
  ImageSquare,
  Images,
  ListChecks,
  MagnifyingGlass,
  Pause,
  Play,
  Stop,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FlowGraph } from "@/components/FlowGraph";
import { JobCard } from "@/components/JobCard";
import { LogPanel } from "@/components/LogPanel";
import { ProjectTabs } from "@/components/ProjectTabs";
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
  Input,
  Select,
  Skeleton,
  SkeletonGrid,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  type SelectOption,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import type { JobRecord } from "@/lib/types";
import { estadoDeJob } from "@/lib/ui-tokens";
import { useProjectStore } from "@/store/useProjectStore";

type View = "storyboard" | "flow" | "fix";

/** payload para guardar/regenerar un job desde la vista de revision. */
interface SavePayload {
  prompt?: string;
  dialogue?: string;
  durationSec?: number;
  model?: string;
  finalPrompt?: string;
  regenerate?: boolean;
}

/**
 * Arriba de este numero de clips la pantalla arranca sola en la vista liviana.
 *
 * NO SUBIRLO NI SACARLO. El storyboard monta una `JobCard` por clip y cada una monta
 * su `<video>`: con los 95 clips de un VSL real la pestaña se arrastra y la maquina
 * se cae. La vista de arreglo es una tabla y carga el video solo del que abris.
 */
const UMBRAL_VISTA_LIVIANA = 24;

/** Las duraciones que acepta el modelo de video. Igual que antes: 4, 6 u 8. */
const DURACION_OPCIONES: ReadonlyArray<SelectOption<string>> = [4, 6, 8].map((d) => ({
  value: String(d),
  label: `${d}s`,
}));

/**
 * Sustantivo de BOLSA para los contadores del resumen por etapa.
 *
 * Los labels de `estadoDeJob` estan escritos para el badge de UN job y en singular
 * imperativo ("Elegí variante"), asi que como contador no sirven: saldria
 * "4 Elegí variante". Ver P-18 en §10 del plan, que es donde tiene que vivir esto.
 *
 * El TONO igual sale de `estadoDeJob`, asi que no hay ni un color en este archivo y
 * el mismo estado no puede cambiar de color entre pantallas. Los nombres son
 * invariantes en genero a proposito: el mismo resumen cuenta imagenes y videos.
 */
const BOLSAS: ReadonlyArray<{ status: JobRecord["status"]; nombre: string }> = [
  { status: "generating", nombre: "generando" },
  { status: "awaiting_approval", nombre: "por aprobar" },
  { status: "failed", nombre: "con error" },
  { status: "pending", nombre: "en cola" },
];

export default function PipelinePage({ params }: { params: { id: string } }) {
  const projectId = params.id;
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
  const [manualView, setManualView] = useState<View | null>(null);
  const [verGrafo, setVerGrafo] = useState<boolean | null>(null);
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

  // Vista efectiva: si el usuario eligio una, se respeta; si no, con muchos clips
  // arrancamos en la vista liviana "fix" (no monta 95 <video> -> no lagea la PC).
  const view: View =
    manualView ?? (groups.vids.length > UMBRAL_VISTA_LIVIANA ? "fix" : "storyboard");

  const progress = useMemo(() => {
    if (jobs.length === 0) return { done: 0, total: 0, pct: 0, awaiting: 0 };
    const done = jobs.filter((j) => j.status === "done").length;
    const awaiting = jobs.filter((j) => j.status === "awaiting_approval").length;
    return { done, total: jobs.length, pct: Math.round((done / jobs.length) * 100), awaiting };
  }, [jobs]);

  /*
    ─── LOS CALLBACKS ESTABLES QUE EL `memo` DE JobCard NECESITABA ─────────────
    Las acciones del store son estables (zustand las crea una sola vez), asi que
    estos `useCallback` no se invalidan nunca. Antes eran arrows nuevas en cada
    render dentro de un objeto literal, y por eso las 95 tarjetas se volvian a
    renderizar aunque no hubiera cambiado ni una.
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

  // Datos para precargar prompt + selector de modelo en cada tarjeta.
  const imageMeta = useMemo<JobMeta>(
    () => ({
      promptByRef,
      dialogueByRef,
      durationByRef,
      finalPromptByRef,
      modelOptions: imageModels,
      projectModel: projectImageModel,
    }),
    [
      promptByRef,
      dialogueByRef,
      durationByRef,
      finalPromptByRef,
      imageModels,
      projectImageModel,
    ]
  );
  const videoMeta = useMemo<JobMeta>(
    () => ({
      promptByRef,
      dialogueByRef,
      durationByRef,
      finalPromptByRef,
      assetTypeByRef,
      modelOptions: videoModels,
      projectModel: projectVideoModel,
    }),
    [
      promptByRef,
      dialogueByRef,
      durationByRef,
      finalPromptByRef,
      assetTypeByRef,
      videoModels,
      projectVideoModel,
    ]
  );

  // Props extra para videos (selector de resolucion por clip).
  const videoExtra = useMemo<VideoExtra>(
    () => ({ resByClip, resolutionOptions, onChangeResolution }),
    [resByClip, resolutionOptions, onChangeResolution]
  );

  const etapas = useMemo(
    () => [
      { titulo: "Imágenes base", jobs: groups.t2i },
      { titulo: "Imágenes derivadas", jobs: groups.i2i },
      { titulo: "Videos", jobs: groups.vids },
    ],
    [groups]
  );

  const cargando = project === null && loadError === null;
  const sinJobs = project !== null && jobs.length === 0;

  /*
    El grafo arranca abierto solo cuando cabe. Usa el MISMO umbral que la vista
    liviana y por el mismo motivo: P-03 midio que con 95 clips la columna de videos
    mide ~2.700px, y arriba de eso el grafo enterraba todo lo que sigue. Con pocos
    clips es util y se ve entero, asi que se muestra como siempre.
  */
  const grafoAbierto = verGrafo ?? groups.vids.length <= UMBRAL_VISTA_LIVIANA;

  return (
    <div className="flex flex-col gap-5">
      <ProjectTabs projectId={projectId} />

      {/* ─── 1. Cabecera: que proyecto es, como va, y los controles de la cola ─ */}
      <Card className="flex flex-col gap-4">
        <CardHeader className="mb-0 flex-wrap">
          <div className="min-w-0">
            {/*
              <h1> a mano y no `CardTitle`: esta tarjeta encabeza la pantalla y
              CardTitle renderiza un <h2> fijo (P-13), asi que el documento quedaria
              sin nivel 1. El tamaño tambien es distinto a proposito.
            */}
            <h1 className="truncate text-display font-semibold text-fg">
              {project?.name ?? "Pipeline"}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {project ? (
                <StatusBadge status={project.status} />
              ) : (
                <Skeleton className="h-5 w-24" />
              )}
              <p className="text-body text-fg-dim">
                <span className="font-mono tnum text-fg">
                  {progress.done}/{progress.total}
                </span>{" "}
                aprobados{" "}
                <span className="font-mono tnum">({progress.pct}%)</span>
              </p>
              {progress.awaiting > 0 && (
                <Badge tone="attention" punto>
                  <span className="tnum">{progress.awaiting}</span> esperando que
                  aprobés
                </Badge>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {progress.awaiting > 0 && (
              <Button
                variant="primary"
                onClick={() => void approveBatch()}
                title="Aprueba todo el lote que está esperando y deja que se genere el próximo"
                icon={<CheckCircle aria-hidden className="size-4" />}
              >
                Aprobar lote (<span className="tnum">{progress.awaiting}</span>)
              </Button>
            )}
            {/*
              Mismo endpoint para los dos casos: si el proyecto todavia no tiene jobs
              (recien importado en lote) arranca todo; si ya tiene, el armado de jobs
              es idempotente y solo reencola lo que quedo pendiente.
            */}
            <Button
              variant={sinJobs ? "primary" : "secondary"}
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
          </div>
        </CardHeader>

        {/* La barra de progreso global. `role=progressbar` para que se anuncie. */}
        <div
          role="progressbar"
          aria-valuenow={progress.pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Jobs aprobados"
          className="h-1.5 w-full overflow-hidden rounded-sm bg-surface-hi"
        >
          <div
            className="h-full rounded-sm bg-ok transition-all"
            style={{ width: `${progress.pct}%` }}
          />
        </div>

        {/*
          Pausar / Reanudar / Cancelar viven abajo y en `ghost`: son controles de la
          cola, no lo que venis a hacer. Antes tenian el mismo peso visual que
          "Generar todo", que es el que cuesta plata.
        */}
        <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-3">
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
        </div>
      </Card>

      {loadError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-body text-danger"
        >
          <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {loadError}
        </p>
      )}

      {/* ─── 2. Las tres vistas ────────────────────────────────────────────── */}
      {cargando ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-9 w-full max-w-md" />
          <SkeletonGrid items={8} />
        </div>
      ) : sinJobs ? (
        <EmptyState
          icon={<FilmSlate aria-hidden className="size-6" />}
          title="Todavía no hay jobs"
          body="Este proyecto tiene el plan cargado pero la cola nunca arrancó. Al generar se arma un job por imagen y uno por clip, y podés aprobar de a lotes."
          action={{ label: "Generar todo", onClick: () => void handleGenerateAll() }}
        />
      ) : (
        <Tabs value={view} onValueChange={(v) => setManualView(v as View)}>
          <TabsList>
            {/* inline-flex: el <button> de Radix no lo es, y sin esto el icono
                queda hundido respecto del texto. */}
            <TabsTrigger value="flow" className="inline-flex items-center gap-1.5">
              <ListChecks aria-hidden className="size-4" />
              General
            </TabsTrigger>
            <TabsTrigger
              value="fix"
              className="inline-flex items-center gap-1.5"
              title="Vista liviana: no carga los videos. Marcá los que están mal, editalos y regeneralos"
            >
              <Wrench aria-hidden className="size-4" />
              Revisar / Arreglar
            </TabsTrigger>
            <TabsTrigger
              value="storyboard"
              className="inline-flex items-center gap-1.5"
            >
              <FilmSlate aria-hidden className="size-4" />
              Storyboard
            </TabsTrigger>
          </TabsList>

          {/* ── General: el resumen por etapa primero, que es lo que se lee de un
                 vistazo, despues los grupos, y el grafo al final. ── */}
          <TabsContent value="flow" className="flex flex-col gap-5">
            <ProgresoPorEtapa etapas={etapas} />
            <Group
              title="1 · Imágenes base"
              jobs={groups.t2i}
              projectId={projectId}
              handlers={handlers}
              meta={imageMeta}
            />
            <Group
              title="2 · Imágenes derivadas"
              jobs={groups.i2i}
              projectId={projectId}
              handlers={handlers}
              meta={imageMeta}
            />
            <Group
              title="3 · Videos"
              jobs={groups.vids}
              projectId={projectId}
              handlers={handlers}
              meta={videoMeta}
              videoExtra={videoExtra}
            />
            {/*
              El grafo va ULTIMO y detras de un toggle. Ver P-03 del plan: con 95
              clips la columna de videos mide ~2.700px, asi que arriba enterraba todo
              lo demas. No se cambio el componente: la decision de reemplazarlo por
              barras por etapa sigue abierta y no es de esta task. El resumen de
              arriba es justamente lo que P-03 recomienda, y por eso el grafo ya no
              es lo primero que ves.
            */}
            <section className="flex flex-col gap-3">
              <CardHeader className="mb-0 items-baseline">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <FlowArrow aria-hidden className="size-4 text-fg-dim" />
                    Grafo del flujo
                  </CardTitle>
                  <CardDescription>
                    Un nodo por job, en columnas por etapa. Con muchos clips es una
                    columna muy larga: el resumen de arriba se lee mejor.
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setVerGrafo(!grafoAbierto)}
                  aria-expanded={grafoAbierto}
                  icon={
                    grafoAbierto ? (
                      <EyeSlash aria-hidden className="size-3.5" />
                    ) : (
                      <Eye aria-hidden className="size-3.5" />
                    )
                  }
                >
                  {grafoAbierto ? "Ocultar" : "Ver"}
                </Button>
              </CardHeader>
              {grafoAbierto && (
                <FlowGraph
                  stages={[
                    { title: "Imagenes base", jobs: groups.t2i },
                    { title: "Imagenes derivadas", jobs: groups.i2i },
                    { title: "Videos", jobs: groups.vids },
                  ]}
                />
              )}
            </section>
          </TabsContent>

          {/* ── Revisar / Arreglar: la que aguanta 95 clips ── */}
          <TabsContent value="fix">
            <FixView
              jobs={groups.vids}
              projectId={projectId}
              ordenByClip={ordenByClip}
              dialogueByRef={dialogueByRef}
              videoModels={videoModels}
              onRegenerateMany={onRegenerateMany}
              onRegenerate={onRegenerate}
              onSave={onChangePrompt}
            />
          </TabsContent>

          {/* ── Storyboard: los frames en orden ── */}
          <TabsContent value="storyboard" className="flex flex-col gap-5">
            <Group
              title="Imágenes base (text2image)"
              jobs={groups.t2i}
              projectId={projectId}
              handlers={handlers}
              meta={imageMeta}
            />
            <Group
              title="Imágenes derivadas (image2image · misma identidad)"
              jobs={groups.i2i}
              projectId={projectId}
              handlers={handlers}
              meta={imageMeta}
            />
            <Filmstrip
              title="Clips en orden"
              jobs={groups.vids}
              projectId={projectId}
              handlers={handlers}
              meta={videoMeta}
              videoExtra={videoExtra}
            />
          </TabsContent>
        </Tabs>
      )}

      <LogPanel logs={logs} />
    </div>
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
  assetTypeByRef?: Map<string, "avatar" | "broll">;
  modelOptions: { id: string; label: string }[];
  projectModel: string;
}

interface VideoExtra {
  resByClip: Map<string, string>;
  resolutionOptions: string[];
  onChangeResolution: (clipId: string, r: string) => void;
}

/* ------------------------- Resumen por etapa ----------------------------- */
/**
 * Las tres etapas con hechos/total y los contadores de lo que no esta hecho.
 *
 * Es lo unico que se agrego a la vista general, y es lo que P-03 recomienda en lugar
 * del grafo: con 95 clips, "78/95 hechos, 4 con error, 2 por aprobar" se lee en un
 * segundo y el grafo pide 2.700px de scroll para decir lo mismo.
 */
function ProgresoPorEtapa({
  etapas,
}: {
  etapas: { titulo: string; jobs: JobRecord[] }[];
}) {
  return (
    <Card className="flex flex-col gap-4">
      <CardHeader className="mb-0 items-baseline">
        <div>
          <CardTitle>Progreso por etapa</CardTitle>
          <CardDescription>
            Las imágenes se generan antes que los videos: un clip no arranca hasta que
            su frame inicial esté aprobado.
          </CardDescription>
        </div>
      </CardHeader>
      <div className="flex flex-col gap-3">
        {etapas.map((e) => (
          <EtapaFila key={e.titulo} titulo={e.titulo} jobs={e.jobs} />
        ))}
      </div>
    </Card>
  );
}

function EtapaFila({ titulo, jobs }: { titulo: string; jobs: JobRecord[] }) {
  const total = jobs.length;
  const hechos = jobs.filter((j) => j.status === "done").length;
  const pct = total === 0 ? 0 : Math.round((hechos / total) * 100);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h3 className="text-body font-medium text-fg">{titulo}</h3>
        <p className="font-mono tnum text-label text-fg-dim">
          <span className={total > 0 && hechos === total ? "text-ok" : "text-fg"}>
            {hechos}/{total}
          </span>{" "}
          hechos
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {BOLSAS.map(({ status, nombre }) => {
            const n = jobs.filter((j) => j.status === status).length;
            if (n === 0) return null;
            const estado = estadoDeJob(status);
            return (
              <Badge
                key={status}
                tone={estado.tone}
                punto
                animado={estado.animado}
              >
                <span className="tnum">{n}</span> {nombre}
              </Badge>
            );
          })}
        </div>
      </div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${titulo}: ${hechos} de ${total}`}
        className="h-1 w-full overflow-hidden rounded-sm bg-surface-hi"
      >
        <div
          className="h-full rounded-sm bg-ok transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* --------------------------- Grupos de tarjetas -------------------------- */

/** Encabezado de seccion con el conteo. Igual en Group y en Filmstrip. */
function TituloDeGrupo({
  title,
  cantidad,
  icono,
}: {
  title: string;
  cantidad: number;
  icono: React.ReactNode;
}) {
  return (
    <CardHeader className="mb-0 items-baseline">
      <CardTitle className="flex flex-wrap items-center gap-2">
        <span className="text-fg-dim">{icono}</span>
        {title}
        <span className="font-mono tnum text-label font-normal text-fg-dim">
          {cantidad}
        </span>
      </CardTitle>
    </CardHeader>
  );
}

function Group({
  title,
  jobs,
  projectId,
  handlers,
  meta,
  videoExtra,
}: {
  title: string;
  jobs: JobRecord[];
  projectId: string;
  handlers: GroupHandlers;
  meta: JobMeta;
  videoExtra?: VideoExtra;
}) {
  return (
    <section className="flex flex-col gap-3">
      <TituloDeGrupo
        title={title}
        cantidad={jobs.length}
        icono={
          videoExtra ? (
            <FilmSlate aria-hidden className="size-4" />
          ) : (
            <ImageSquare aria-hidden className="size-4" />
          )
        }
      />
      {jobs.length === 0 ? (
        <p className="text-body text-fg-dim">Sin items en esta etapa.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {jobs.map((j) => (
            <JobCard
              key={j.id}
              job={j}
              projectId={projectId}
              currentPrompt={meta.promptByRef.get(j.refId) ?? ""}
              currentDialogue={meta.dialogueByRef.get(j.refId) ?? ""}
              currentDuration={meta.durationByRef.get(j.refId)}
              currentFinalPrompt={meta.finalPromptByRef.get(j.refId) ?? ""}
              assetType={meta.assetTypeByRef?.get(j.refId)}
              modelOptions={meta.modelOptions}
              projectModel={meta.projectModel}
              {...handlers}
              resolution={videoExtra?.resByClip.get(j.refId)}
              resolutionOptions={videoExtra?.resolutionOptions}
              onChangeResolution={videoExtra?.onChangeResolution}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Filmstrip({
  title,
  jobs,
  projectId,
  handlers,
  meta,
  videoExtra,
}: {
  title: string;
  jobs: JobRecord[];
  projectId: string;
  handlers: GroupHandlers;
  meta: JobMeta;
  videoExtra?: VideoExtra;
}) {
  return (
    <section className="flex flex-col gap-3">
      <TituloDeGrupo
        title={title}
        cantidad={jobs.length}
        icono={<Images aria-hidden className="size-4" />}
      />
      {jobs.length === 0 ? (
        <p className="text-body text-fg-dim">Todavía no hay clips en el plan.</p>
      ) : (
        // La tira scrollea sola y es alcanzable con teclado: `tabIndex` + `role` para
        // que se pueda mover con las flechas sin tener que caer en un link de adentro.
        <ol
          tabIndex={0}
          aria-label={title}
          className="flex list-none gap-3 overflow-x-auto pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {jobs.map((j) => (
            <li key={j.id} className="w-56 shrink-0">
              <JobCard
                job={j}
                projectId={projectId}
                currentPrompt={meta.promptByRef.get(j.refId) ?? ""}
                currentDialogue={meta.dialogueByRef.get(j.refId) ?? ""}
                currentDuration={meta.durationByRef.get(j.refId)}
                currentFinalPrompt={meta.finalPromptByRef.get(j.refId) ?? ""}
                // `assetType` ANTES NO SE PASABA ACA y si en la otra vista, con el
                // mismo `meta`. Es lo que le dice a la tarjeta si el dialogo se arma
                // como selfie o como voz en off, asi que sin el, activar el override
                // del prompt final en esta vista precargaba un prompt de avatar para
                // un b-roll. La misma tarjeta daba dos resultados distintos segun la
                // pestaña. Ver P-23 en §10 del plan.
                assetType={meta.assetTypeByRef?.get(j.refId)}
                modelOptions={meta.modelOptions}
                projectModel={meta.projectModel}
                {...handlers}
                resolution={videoExtra?.resByClip.get(j.refId)}
                resolutionOptions={videoExtra?.resolutionOptions}
                onChangeResolution={videoExtra?.onChangeResolution}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ----------------------- Vista "Revisar / Arreglar" ---------------------- */
/**
 * Vista LIVIANA: tabla compacta de clips. NO monta los `<video>`, y por eso es la
 * unica que aguanta los 95 clips de un VSL. El video se carga solo del clip que
 * abris con "Ver", y con `preload="none"`.
 *
 * Marcás los que estan mal (o pegás sus numeros) y "Revisar seleccionados" abre un
 * storyboard SOLO con esos, donde podés EDITAR el prompt/dialogo y "Guardar y
 * regenerar". Todo lo editado se persiste al plan, que es de donde lee el export.
 */
function FixView({
  jobs,
  projectId,
  ordenByClip,
  dialogueByRef,
  videoModels,
  onRegenerateMany,
  onRegenerate,
  onSave,
}: {
  jobs: JobRecord[];
  projectId: string;
  ordenByClip: Map<string, number>;
  dialogueByRef: Map<string, string>;
  videoModels: { id: string; label: string }[];
  onRegenerateMany: (jobIds: string[]) => void;
  onRegenerate: (jobId: string) => void;
  onSave: (jobId: string, payload: SavePayload) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [numbersText, setNumbersText] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const rows = useMemo(
    () =>
      [...jobs].sort(
        (a, b) => (ordenByClip.get(a.refId) ?? 0) - (ordenByClip.get(b.refId) ?? 0)
      ),
    [jobs, ordenByClip]
  );

  function selectByNumbers() {
    const nums = new Set(
      numbersText
        .split(/[^0-9]+/)
        .filter(Boolean)
        .map((n) => Number(n))
    );
    if (nums.size === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const j of rows) {
        const o = ordenByClip.get(j.refId);
        if (o != null && nums.has(o)) next.add(j.id);
      }
      return next;
    });
  }

  /*
    Estos tres reciben el id en vez de cerrar sobre el: asi son estables y el `memo`
    de `FixRow` puede ahorrar el render de las 94 filas que no cambiaron cuando tocás
    un checkbox o escribis en el campo de numeros.
  */
  const toggleSel = useCallback((id: string) => {
    setSelected((s) => alternar(s, id));
  }, []);
  const toggleExp = useCallback((id: string) => {
    setExpanded((s) => alternar(s, id));
  }, []);

  const sel = selected.size;
  const selectedJobs = rows.filter((j) => selected.has(j.id));
  const fallidos = rows.filter((j) => j.status === "failed").length;

  // Storyboard de revision: solo los seleccionados, con prompt EDITABLE + imagen input + JSON.
  if (reviewing && selectedJobs.length > 0) {
    return (
      <ReviewStoryboard
        jobs={selectedJobs}
        projectId={projectId}
        ordenByClip={ordenByClip}
        videoModels={videoModels}
        onRegenerateAll={(ids) => onRegenerateMany(ids)}
        onSave={onSave}
        onClose={() => setReviewing(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          {/*
            Sin `hint`: el bloque del campo tiene que terminar en el input para que
            `items-end` alinee los botones con el borde de abajo del input y no con el
            de un texto de ayuda. La explicacion esta en el parrafo del final.
          */}
          <Input
            label="Números de los clips que están mal"
            placeholder="12, 45, 78…"
            value={numbersText}
            onChange={(e) => setNumbersText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                selectByNumbers();
              }
            }}
            className="font-mono tnum"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={selectByNumbers} disabled={numbersText.trim() === ""}>
            Marcar
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              setSelected(
                new Set(rows.filter((j) => j.status === "failed").map((j) => j.id))
              )
            }
            disabled={fallidos === 0}
            icon={<WarningCircle aria-hidden className="size-4" />}
            title="Marca todos los clips que fallaron"
          >
            Marcar fallidos (<span className="tnum">{fallidos}</span>)
          </Button>
          <Button
            variant="ghost"
            onClick={() => setSelected(new Set())}
            disabled={sel === 0}
            icon={<Broom aria-hidden className="size-4" />}
          >
            Limpiar
          </Button>
          <Button
            variant="primary"
            onClick={() => setReviewing(true)}
            disabled={sel === 0}
            icon={<MagnifyingGlass aria-hidden className="size-4" />}
          >
            Revisar / editar (<span className="tnum">{sel}</span>)
          </Button>
        </div>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          icon={<FilmSlate aria-hidden className="size-6" />}
          title="No hay clips de video"
          body="Este proyecto no tiene clips generados por IA en el plan, así que no hay nada que revisar acá."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg bg-surface">
          <table className="w-full text-body">
            <caption className="sr-only">
              Clips del proyecto, en orden de timeline
            </caption>
            <thead>
              <tr className="border-b border-divider text-left text-label uppercase tracking-wide text-fg-dim">
                <th scope="col" className="w-10 px-2 py-2">
                  <span className="sr-only">Marcar</span>
                </th>
                <th scope="col" className="w-12 px-2 py-2">
                  #
                </th>
                <th scope="col" className="px-2 py-2">
                  Clip
                </th>
                <th scope="col" className="w-32 px-2 py-2">
                  Estado
                </th>
                <th scope="col" className="px-2 py-2">
                  Diálogo
                </th>
                <th scope="col" className="w-28 px-2 py-2">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => (
                <FixRow
                  key={j.id}
                  job={j}
                  orden={ordenByClip.get(j.refId) ?? 0}
                  dialogo={dialogueByRef.get(j.refId) ?? ""}
                  selected={selected.has(j.id)}
                  expanded={expanded.has(j.id)}
                  projectId={projectId}
                  onToggleSel={toggleSel}
                  onToggleExp={toggleExp}
                  onRegenerate={onRegenerate}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="max-w-prose text-label text-fg-dim">
        <b className="font-medium text-fg">Ver</b> carga solo ese video: los demás no
        se bajan, y por eso la lista no se arrastra con 95 clips. Marcá los malos y{" "}
        <b className="font-medium text-fg">Revisar / editar</b> abre un storyboard solo
        con esos, donde podés editar el prompt y el diálogo. Lo que guardás queda en el
        plan, que es de donde lee el export a ffmpeg.
      </p>
    </div>
  );
}

/** Agrega o saca un id de un Set, sin mutar el original. */
function alternar(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Una fila de la tabla. Va en `memo` con callbacks que reciben el id, para que tocar
 * un checkbox no re-renderice las otras 94.
 */
const FixRow = memo(function FixRow({
  job,
  orden,
  dialogo,
  selected,
  expanded,
  projectId,
  onToggleSel,
  onToggleExp,
  onRegenerate,
}: {
  job: JobRecord;
  orden: number;
  dialogo: string;
  selected: boolean;
  expanded: boolean;
  projectId: string;
  onToggleSel: (jobId: string) => void;
  onToggleExp: (jobId: string) => void;
  onRegenerate: (jobId: string) => void;
}) {
  const estado = estadoDeJob(job.status);
  const ver = encodeURIComponent(job.updatedAt ?? "");
  const videoUrl = job.outputPath
    ? `/api/files/${projectId}/${job.outputPath}?v=${ver}`
    : null;
  return (
    <>
      <tr
        className={cn(
          "border-b border-divider transition-colors",
          selected ? "bg-accent/5" : "hover:bg-surface-hi/50"
        )}
      >
        <td className="px-2 py-2 align-top">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSel(job.id)}
            aria-label={`Marcar el clip ${orden}, ${job.label}`}
            className="size-4 accent-accent"
          />
        </td>
        <td className="px-2 py-2 align-top font-mono tnum text-fg-dim">{orden}</td>
        <td className="px-2 py-2 align-top">
          <div className="font-medium text-fg">{job.label}</div>
          {/*
            `job.error` puede estar poblado en un job que NO fallo (se usa como nota:
            "salieron 1/2 variantes"). Por eso el color sale del ESTADO del job y no
            de que exista el texto: el estado es `job.status` y nada mas.
          */}
          {job.error && (
            <div
              className={cn(
                "mt-0.5 text-label",
                estado.tone === "danger" ? "text-danger" : "text-fg-dim"
              )}
            >
              {job.error}
            </div>
          )}
        </td>
        <td className="px-2 py-2 align-top">
          <Badge tone={estado.tone} punto animado={estado.animado}>
            {estado.label}
          </Badge>
        </td>
        <td className="px-2 py-2 align-top text-label text-fg-dim">{dialogo}</td>
        <td className="px-2 py-2 align-top">
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onToggleExp(job.id)}
              aria-expanded={expanded}
              icon={
                expanded ? (
                  <EyeSlash aria-hidden className="size-3.5" />
                ) : (
                  <Eye aria-hidden className="size-3.5" />
                )
              }
            >
              {expanded ? "Ocultar" : "Ver"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRegenerate(job.id)}
              title="Regenerar solo este clip, sin editar. Cuesta plata."
              aria-label={`Regenerar el clip ${orden} sin editar`}
            >
              <ArrowCounterClockwise aria-hidden className="size-3.5" />
            </Button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-divider bg-bg/40">
          <td />
          <td colSpan={5} className="px-2 pb-3">
            {videoUrl ? (
              <div className="flex flex-col items-start gap-1.5">
                <video
                  key={videoUrl}
                  src={videoUrl}
                  controls
                  preload="none"
                  playsInline
                  aria-label={`Video del clip ${orden}`}
                  className="max-h-[70vh] w-auto max-w-full rounded-lg bg-bg"
                />
                <a
                  href={`${videoUrl}${videoUrl.includes("?") ? "&" : "?"}dl=1`}
                  download
                  className="inline-flex items-center gap-1.5 rounded-sm text-label text-accent transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  title="Baja este clip solo, sin el zip del proyecto entero"
                >
                  <DownloadSimple aria-hidden className="size-3.5" />
                  Descargar este clip
                </a>
              </div>
            ) : (
              <span className="text-label text-fg-dim">
                {estado.animado ? "Todavía se está generando." : "Sin video todavía."}
              </span>
            )}
          </td>
        </tr>
      )}
    </>
  );
});

/* --------------------- Storyboard de revisión (editable) --------------------- */

interface PreviewData {
  type: "image" | "video";
  label: string;
  status: JobRecord["status"];
  model?: string;
  durationSec?: number;
  resolution?: string;
  modo?: string;
  executedPrompt: string;
  autoPrompt?: string;
  promptOverride?: string | null;
  hasPromptOverride?: boolean;
  json: unknown;
  updatedAt?: string;
  outputPath?: string | null;
  inputImage?: { id: string; file: string | null; status: string; json: unknown };
  refs?: { id: string; kind: string; file: string | null }[];
}

function ReviewStoryboard({
  jobs,
  projectId,
  ordenByClip,
  videoModels,
  onRegenerateAll,
  onSave,
  onClose,
}: {
  jobs: JobRecord[];
  projectId: string;
  ordenByClip: Map<string, number>;
  videoModels: { id: string; label: string }[];
  onRegenerateAll: (ids: string[]) => void;
  onSave: (jobId: string, payload: SavePayload) => void;
  onClose: () => void;
}) {
  const [confirmar, setConfirmar] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          onClick={onClose}
          icon={<ArrowLeft aria-hidden className="size-4" />}
        >
          Volver a la lista
        </Button>
        <p className="text-body text-fg-dim">
          <span className="font-mono tnum text-fg">{jobs.length}</span>{" "}
          {jobs.length === 1 ? "clip" : "clips"} para revisar
        </p>
        {/*
          ─── EL BOTON MAS CARO DE LA APP ─────────────────────────────────────
          `danger` y con confirmacion que dice el numero. Regenera TODOS los
          seleccionados de una: en un VSL son decenas de dolares, y hasta ahora era un
          click directo sin vuelta atras. Los otros dos botones de guardado viven en
          cada tarjeta y son `secondary`, porque uno no gasta nada y el otro gasta
          por UN clip.
        */}
        <Button
          variant="danger"
          className="ml-auto"
          onClick={() => setConfirmar(true)}
          icon={<Coins aria-hidden className="size-4" />}
          title="Vuelve a generar todos los seleccionados con lo que ya está guardado en el plan"
        >
          Regenerar todos sin editar (<span className="tnum">{jobs.length}</span>)
        </Button>
        <Confirmar
          abierto={confirmar}
          onCambio={setConfirmar}
          title="¿Regenerar todos sin editar?"
          detalle={`Se vuelven a generar ${jobs.length} ${
            jobs.length === 1 ? "job" : "jobs"
          } con lo que ya está guardado en el plan. Cada video se cobra aparte y no hay forma de cancelar lo que ya salió.`}
          labelConfirmar={`Regenerar ${jobs.length}`}
          peligroso
          onConfirmar={() => onRegenerateAll(jobs.map((j) => j.id))}
        />
      </Card>
      <div className="flex flex-col gap-4">
        {jobs.map((j) => (
          <ReviewCard
            key={j.id}
            job={j}
            projectId={projectId}
            orden={ordenByClip.get(j.refId) ?? 0}
            videoModels={videoModels}
            onSave={onSave}
          />
        ))}
      </div>
    </div>
  );
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Bloque colapsable para el prompt final y el JSON.
 *
 * No es un `<details>` con un `<button>` adentro del `<summary>`, que es lo que tenia
 * antes: un control interactivo dentro de un summary es HTML invalido y el click se
 * pelea con el toggle. Y el contenido se renderiza SIEMPRE con `hidden`, para que el
 * `aria-controls` del boton no apunte a un id que no existe cuando esta cerrado.
 */
function Colapsable({
  id,
  titulo,
  abierto,
  onToggle,
  accion,
  nota,
  children,
}: {
  id: string;
  titulo: string;
  abierto: boolean;
  onToggle: () => void;
  accion?: React.ReactNode;
  nota?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-sm bg-bg">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={onToggle}
          aria-expanded={abierto}
          aria-controls={id}
          icon={
            <CaretDown
              aria-hidden
              className={cn("size-3.5 transition-transform", abierto && "rotate-180")}
            />
          }
        >
          {titulo}
        </Button>
        {accion}
      </div>
      <div id={id} hidden={!abierto}>
        {children}
        {nota && <p className="px-2 pb-2 text-label text-fg-dim">{nota}</p>}
      </div>
    </div>
  );
}

function ReviewCard({
  job,
  projectId,
  orden,
  videoModels,
  onSave,
}: {
  job: JobRecord;
  projectId: string;
  orden: number;
  videoModels: { id: string; label: string }[];
  onSave: (jobId: string, payload: SavePayload) => void;
}) {
  const [data, setData] = useState<PreviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [copiado, setCopiado] = useState<boolean | null>(null);
  const [verPrompt, setVerPrompt] = useState(false);
  const [verJson, setVerJson] = useState(false);

  // Campos editables (se inicializan desde el JSON del plan al cargar el preview).
  const [vprompt, setVprompt] = useState("");
  const [dialog, setDialog] = useState("");
  const [duration, setDuration] = useState<number>(8);
  const [selectedModel, setSelectedModel] = useState("");
  // Override del prompt final (avanzado).
  const [overrideOn, setOverrideOn] = useState(false);
  const [finalPromptText, setFinalPromptText] = useState("");

  const timerCopia = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
    ─── LA PRECARGA DE LOS CAMPOS. NO TOCAR EL ORDEN NI LAS DEPS ──────────────
    Depende de `job.updatedAt`, y eso es lo que hace que al guardar los campos
    vuelvan a leerse del PLAN ya persistido y que el prompt final read-only se
    recalcule. Si se saca esa dependencia, la tarjeta sigue mostrando lo que
    escribiste aunque el guardado haya fallado, y el error no se ve hasta el video
    final exportado.
  */
  useEffect(() => {
    let alive = true;
    fetch(`/api/jobs/${job.id}/preview`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const pd = d as PreviewData;
        setData(pd);
        const j = asRecord(pd.json);
        if (pd.type === "video") {
          setVprompt(String(j.video_prompt ?? ""));
          setDialog(String(j.dialogo ?? ""));
          setDuration(Number(j.duracion_seg ?? 8) || 8);
          setSelectedModel(pd.model ?? "");
          // Si el clip ya tiene override del prompt final, lo precargamos activo.
          const ov = (pd.promptOverride ?? "").trim();
          setOverrideOn(Boolean(ov));
          setFinalPromptText(ov || pd.autoPrompt || pd.executedPrompt || "");
        } else {
          setVprompt(String(j.prompt ?? ""));
        }
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [job.id, job.updatedAt]);

  useEffect(
    () => () => {
      if (timerCopia.current) clearTimeout(timerCopia.current);
    },
    []
  );

  const estado = estadoDeJob(job.status);
  const ver = encodeURIComponent(job.updatedAt ?? "");
  const fileUrl = (p: string) => `/api/files/${projectId}/${p}?v=${ver}`;
  const inputImg = data?.inputImage?.file ?? null;
  const outUrl = job.outputPath ? fileUrl(job.outputPath) : null;
  const isVideo = data?.type === "video";

  // Si el modelo guardado no esta en el catalogo, se agrega como opcion: sin esto el
  // selector arranca en blanco y guardar pisaria el modelo sin que nadie lo eligiera.
  const opcionesModelo = useMemo<ReadonlyArray<SelectOption<string>>>(() => {
    const base = videoModels.map((m) => ({ value: m.id, label: m.label }));
    if (selectedModel && !base.some((o) => o.value === selectedModel)) {
      base.push({ value: selectedModel, label: selectedModel });
    }
    return base;
  }, [videoModels, selectedModel]);

  /**
   * Copia el prompt final y dice la verdad sobre el resultado.
   *
   * `writeText` RECHAZA cuando la pestaña no tiene foco, cuando el permiso esta
   * denegado o cuando el contexto no es seguro, y `navigator.clipboard` puede no
   * existir. Antes no se esperaba ni se atajaba: quedaba una promesa rechazada sin
   * dueño y el boton decia "copiado" igual. Mismo arreglo que la pantalla de
   * resultado (P-20 del plan).
   */
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
    // El fallo se queda mas tiempo: hay que leerlo y hacer algo al respecto.
    timerCopia.current = setTimeout(() => setCopiado(null), ok ? 1500 : 5000);
  }

  /*
    ─── EL GUARDADO. ES EL CAMINO CRITICO DE LA PANTALLA ──────────────────────
    Arma el MISMO payload que antes, campo por campo, y lo manda por `onSave`, que es
    `changePromptJob` del store. Ese es el unico camino que persiste al PLAN, y el
    plan es de donde lee el export a ffmpeg: si esto se rompe, la edicion se pierde en
    silencio y aparece recien en el video final.

    `finalPrompt`: si el override esta activo se manda su contenido; si no, "" lo
    BORRA en el backend y vuelve al armado automatico. Los dos casos son
    intencionales y no se pueden colapsar en `undefined`.
  */
  function save(regenerate: boolean) {
    const payload: SavePayload = { prompt: vprompt, regenerate };
    if (isVideo) {
      payload.dialogue = dialog;
      payload.durationSec = duration;
      if (selectedModel) payload.model = selectedModel;
      payload.finalPrompt = overrideOn ? finalPromptText : "";
    }
    onSave(job.id, payload);
  }

  const botonCopiar = (
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
  );

  return (
    <Card className="flex flex-col gap-3">
      {/* ─── Cabecera de la tarjeta: quien es, como esta, y los dos guardados ─ */}
      <CardHeader className="mb-0 flex-wrap items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono tnum text-body font-semibold text-fg-dim">
            #{orden}
          </span>
          <CardTitle className="truncate">{job.label}</CardTitle>
          <Badge tone={estado.tone} punto animado={estado.animado}>
            {estado.label}
          </Badge>
          {data?.model && (
            <span className="font-mono text-label text-fg-dim">{data.model}</span>
          )}
        </div>
        {/*
          Los dos guardados de ESTE clip. Los dos `secondary` porque los dos son la
          accion normal de la tarjeta, y se distinguen por el icono y por el texto: el
          disquete no gasta nada, las monedas si. El tercer boton, el que regenera
          TODO el lote, vive arriba y es `danger`.
        */}
        <div className="flex shrink-0 flex-wrap gap-2">
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
            onClick={() => save(true)}
            icon={<Coins aria-hidden className="size-3.5" />}
            title="Guarda los cambios y vuelve a generar este clip con lo editado. Cuesta plata"
          >
            Guardar y regenerar
          </Button>
        </div>
      </CardHeader>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ─── Izquierda: la imagen de entrada y el resultado actual ───────── */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <p className="text-label font-medium uppercase tracking-wide text-fg-dim">
              Imagen de entrada
            </p>
            {inputImg ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={fileUrl(inputImg)}
                alt={`Frame inicial del clip ${orden}`}
                className="max-h-72 w-auto rounded-lg bg-bg"
              />
            ) : data?.refs && data.refs.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {data.refs.map((r) =>
                  r.file ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={r.id}
                      src={fileUrl(r.file)}
                      alt={`Referencia ${r.id}`}
                      className="max-h-48 w-auto rounded-lg bg-bg"
                    />
                  ) : (
                    <span key={r.id} className="text-label text-fg-dim">
                      {r.id} (sin archivo)
                    </span>
                  )
                )}
              </div>
            ) : (
              <p className="text-body text-fg-dim">Sin imagen de entrada.</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-label font-medium uppercase tracking-wide text-fg-dim">
              Resultado actual
            </p>
            {outUrl ? (
              showVideo ? (
                <>
                  {/*
                    `max-h-[70vh]` y no `max-h-72` (288px): un clip vertical en 288px de
                    alto queda de 162px de ancho, del tamaño de un sello, y esta es la
                    pantalla donde hay que decidir si el clip sirve o se regenera.
                    `max-w-full` para que en un formato horizontal no desborde la tarjeta.
                  */}
                  <video
                    key={outUrl}
                    src={outUrl}
                    controls
                    preload="none"
                    playsInline
                    aria-label={`Resultado del clip ${orden}`}
                    className="max-h-[70vh] w-auto max-w-full rounded-lg bg-bg"
                  />
                  <a
                    href={`${outUrl}${outUrl.includes("?") ? "&" : "?"}dl=1`}
                    download
                    className="inline-flex w-fit items-center gap-1.5 rounded-sm text-label text-accent transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    title="Baja este clip solo, sin el zip del proyecto entero"
                  >
                    <DownloadSimple aria-hidden className="size-3.5" />
                    Descargar este clip
                  </a>
                </>
              ) : (
                // El <video> se monta recien al tocar el boton: es el mismo criterio
                // de la lista, y con varios clips abiertos suma.
                <Button
                  size="sm"
                  onClick={() => setShowVideo(true)}
                  icon={<Play aria-hidden className="size-3.5" />}
                >
                  Ver resultado actual
                </Button>
              )
            ) : (
              <p className="text-body text-fg-dim">
                {estado.animado ? "Todavía se está generando." : "Sin resultado."}
              </p>
            )}
          </div>
        </div>

        {/* ─── Derecha: los campos editables, el prompt final y el JSON ────── */}
        <div className="flex flex-col gap-3">
          <Textarea
            label={isVideo ? "Prompt visual del video" : "Prompt de la imagen"}
            hint="Es lo que describe la escena. Se guarda en el plan."
            value={vprompt}
            onChange={(e) => setVprompt(e.target.value)}
            spellCheck={false}
            className="h-28 leading-relaxed"
          />

          {isVideo && (
            <>
              <Textarea
                label="Diálogo (es-AR, lo que dice la persona)"
                value={dialog}
                onChange={(e) => setDialog(e.target.value)}
                className="h-20 leading-relaxed"
              />
              <div className="flex flex-wrap items-start gap-3">
                <div className="w-24">
                  <Select
                    label="Duración"
                    value={String(duration)}
                    onValueChange={(v) => setDuration(Number(v))}
                    options={DURACION_OPCIONES}
                  />
                </div>
                {videoModels.length > 0 && (
                  <div className="min-w-[200px] flex-1">
                    <Select
                      label="Modelo"
                      value={selectedModel}
                      onValueChange={setSelectedModel}
                      options={opcionesModelo}
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {isVideo ? (
            /*
              El override del prompt final va en `accent` porque en este sistema el
              acento significa "esto espera una decision tuya", y esta es la unica
              casilla de la pantalla que cambia lo que se le manda al modelo.
            */
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
                  Editar a mano el prompt FINAL
                  <span className="block text-label text-fg-dim">
                    Se manda tal cual al modelo de video.
                  </span>
                </span>
              </label>
              {overrideOn ? (
                <>
                  <p className="max-w-prose text-label leading-relaxed text-fg-dim">
                    Ignora el armado automático (UGC/selfie, lip-sync, voz y acento).
                    Es para b-roll que NO tiene que mostrar a una persona hablando. Si
                    querés diálogo hablado, incluilo vos. Se guarda al tocar
                    «Guardar».
                  </p>
                  <Textarea
                    label="Prompt final que se ejecuta"
                    labelOculto
                    mono
                    value={finalPromptText}
                    onChange={(e) => setFinalPromptText(e.target.value)}
                    spellCheck={false}
                    className="h-40 whitespace-pre-wrap leading-relaxed"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="self-start"
                    onClick={() =>
                      setFinalPromptText(data?.autoPrompt ?? data?.executedPrompt ?? "")
                    }
                    icon={<ArrowCounterClockwise aria-hidden className="size-3.5" />}
                  >
                    Cargar el prompt automático
                  </Button>
                </>
              ) : (
                <Colapsable
                  id={`prompt-final-${job.id}`}
                  titulo="Ver el prompt final automático"
                  abierto={verPrompt}
                  onToggle={() => setVerPrompt((v) => !v)}
                  accion={botonCopiar}
                  nota="Se recalcula al guardar, a partir del prompt visual y el diálogo de arriba."
                >
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-label leading-relaxed text-fg-dim">
                    {data ? data.executedPrompt : "cargando…"}
                  </pre>
                </Colapsable>
              )}
            </div>
          ) : (
            <Colapsable
              id={`prompt-final-${job.id}`}
              titulo="Ver el prompt final que se ejecuta"
              abierto={verPrompt}
              onToggle={() => setVerPrompt((v) => !v)}
              accion={botonCopiar}
              nota="Se recalcula al guardar. Editá los campos de arriba, no este texto."
            >
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-label leading-relaxed text-fg-dim">
                {data ? data.executedPrompt : "cargando…"}
              </pre>
            </Colapsable>
          )}

          <Colapsable
            id={`json-${job.id}`}
            titulo={`Ver el JSON del ${isVideo ? "clip" : "imagen"}`}
            abierto={verJson}
            onToggle={() => setVerJson((v) => !v)}
          >
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-label leading-relaxed text-fg-dim">
              {data ? JSON.stringify(data.json, null, 2) : "cargando…"}
            </pre>
          </Colapsable>

          {/* El aviso de copia fallida se VE, porque hay que hacer algo al respecto. */}
          <div aria-live="polite">
            {copiado === false && (
              <p className="flex items-start gap-2 rounded-sm bg-danger/10 px-2.5 py-2 text-label text-danger">
                <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
                No se pudo copiar. Abrí el prompt y seleccioná el texto a mano.
              </p>
            )}
          </div>

          {err && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-sm bg-danger/10 px-2.5 py-2 text-body text-danger"
            >
              <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {err}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
