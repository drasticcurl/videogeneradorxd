"use client";

/**
 * Pantalla "Resultado": lo que salio del pipeline y como te lo llevas.
 *
 * ─── QUE CAMBIO Y POR QUE (§3 de T08) ────────────────────────────────────────
 *
 * Era una lista vertical de filas con el video en una columna de 128px: con 95 clips
 * medía metros de scroll y cada clip se veía del tamaño de una estampilla. Ahora es
 * una GRILLA en 9:16, que es el formato real de todo lo que genera la app, y es lo
 * primero que aparece.
 *
 * Las acciones de EXPORTAR quedaron arriba y se ven sin scrollear, porque bajarse el
 * zip es el proposito de esta pantalla. Antes el boton del zip compartía la fila con
 * el de ffmpeg, que la mayoría de las veces esta deshabilitado, y los dos tenían el
 * mismo peso visual.
 *
 * El JSON de todos los videos quedo COLAPSADO al final. Es una herramienta (se copia
 * para reusar la data en otro lado), no el contenido de la pantalla.
 *
 * ─── LO QUE NO SE TOCO ───────────────────────────────────────────────────────
 *
 * Los tres endpoints son los mismos y con el mismo payload: subir un clip filmado
 * (POST con FormData), unir con ffmpeg (POST) y bajar el zip (GET dentro de un <a>,
 * porque una descarga con Content-Disposition la maneja el navegador y no fetch).
 *
 * La condicion que habilita el zip es la misma de antes, y es a proposito la MISMA
 * que usa el server para armarlo (algun clip con archivo, o el final.mp4). Si
 * divergen, el boton se habilita y la descarga contesta 400.
 *
 * Las URLs de los archivos se copiaron tal cual, SIN `?v=`: la ruta que los sirve
 * manda `Cache-Control: no-store` y con `preload="none"` el browser no baja un byte
 * hasta que le das play, asi que no hay cache que romper. Ver P-17 en §10 del plan.
 *
 * ─── DOS COSAS QUE PARECEN UN OLVIDO Y SON DECISIONES ────────────────────────
 *
 * 1. Los `<video>` van con `preload="none"` y `controls`, y ninguno con autoplay. Son
 *    hasta 95 en pantalla: precargarlos son cientos de MB y la pestaña muerta.
 * 2. Y por eso mismo NO tienen `poster`. La miniatura obvia seria la imagen base del
 *    clip (`clip.image_id` -> `manifest.images`), pero `poster` no se puede diferir:
 *    el browser baja las 95 imagenes al montar la grilla, y son PNG de 1-2MB cada
 *    una. La caja queda negra con su barra de controles, y lo que hace escaneable la
 *    grilla es el numero de orden, el id y el estado.
 */

import {
  BracketsCurly,
  Check,
  Copy,
  DownloadSimple,
  FilmStrip,
  FolderOpen,
  Sparkle,
  Spinner,
  Stack,
  Textbox,
  UploadSimple,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { ProjectTabs } from "@/components/ProjectTabs";
import { StatusBadge } from "@/components/StatusBadge";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  SkeletonGrid,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import type { ManifestClip } from "@/lib/types";
import { estadoDeJob } from "@/lib/ui-tokens";
import { useProjectStore } from "@/store/useProjectStore";

/**
 * Clip que graba una persona en vez de la IA. Es el unico valor de `etiqueta` que
 * cambia lo que la pantalla puede hacer (habilita subir el archivo a mano), asi que
 * esta una sola vez y con nombre.
 */
const FILMAR_REAL = "FILMAR_REAL";

/** Segundos -> "8s" o "12m 40s". El total de un VSL son cientos de segundos. */
function duracion(seg: number): string {
  if (seg < 60) return `${seg}s`;
  const m = Math.floor(seg / 60);
  const s = seg % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * El icono del boton de copiar, que es lo unico que cambia: el TEXTO queda fijo. Un
 * boton que pasa de "Copiar JSON" a "Copiado" cambia de ancho y mueve la fila (§5
 * regla 1 del plan, por el mismo motivo que el `loading`).
 */
function IconoCopia({
  copia,
  que,
}: {
  copia: { que: "ruta" | "json"; ok: boolean } | null;
  que: "ruta" | "json";
}) {
  if (copia?.que !== que) return <Copy aria-hidden className="size-3.5" />;
  return copia.ok ? (
    <Check aria-hidden className="size-3.5" />
  ) : (
    <WarningCircle aria-hidden className="size-3.5" />
  );
}

export default function ResultPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const router = useRouter();
  const { project, manifest, config, loadProject, loadConfig, refreshJobs } =
    useProjectStore();

  const [busy, setBusy] = useState<string | null>(null);
  const [stitch, setStitch] = useState<{ ok: boolean; msg: string } | null>(null);
  const [copia, setCopia] = useState<{ que: "ruta" | "json"; ok: boolean } | null>(
    null,
  );
  const [verJson, setVerJson] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerCopia = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadConfig();
    // Antes este catch era vacio: si el proyecto no existia o la red se caia, la
    // pantalla quedaba en blanco para siempre y no se distinguia de "cargando".
    loadProject(projectId).catch((err: unknown) =>
      setError(
        err instanceof Error ? err.message : "No se pudo cargar el proyecto.",
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(
    () => () => {
      if (timerCopia.current) clearTimeout(timerCopia.current);
    },
    [],
  );

  /**
   * Copia y deja el aviso un rato. Un solo timer, para que dos copias no se peleen.
   *
   * SE ESPERA EL RESULTADO Y SE AVISA SI FALLA. `writeText` puede rechazar (permiso
   * denegado, pestaña sin foco, contexto no seguro) y ademas `navigator.clipboard`
   * puede no existir. Antes eso quedaba como una promesa rechazada sin dueño y el
   * boton igual decía "copiado": el usuario iba a pegar y no tenía nada. Verificado
   * con Chrome headless, que rechaza cuando el documento no tiene foco.
   */
  async function copiar(que: "ruta" | "json", texto: string) {
    let ok = true;
    try {
      if (!navigator.clipboard) throw new Error("sin portapapeles");
      await navigator.clipboard.writeText(texto);
    } catch {
      ok = false;
    }
    setCopia({ que, ok });
    if (timerCopia.current) clearTimeout(timerCopia.current);
    // El fallo se queda mas tiempo: hay que leerlo y hacer algo al respecto.
    timerCopia.current = setTimeout(() => setCopia(null), ok ? 1500 : 5000);
  }

  async function handleUpload(clipId: string, file: File) {
    setBusy(clipId);
    try {
      const fd = new FormData();
      fd.append("clipId", clipId);
      fd.append("file", file);
      await fetch(`/api/projects/${projectId}/upload`, {
        method: "POST",
        body: fd,
      });
      await refreshJobs(projectId);
      await loadProject(projectId);
    } finally {
      setBusy(null);
    }
  }

  async function handleStitch() {
    setBusy("stitch");
    setStitch(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/stitch`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        error?: string;
      };
      if (data.ok) {
        setStitch({ ok: true, msg: "final.mp4 listo. Ya entra en el zip." });
        await loadProject(projectId);
      } else {
        setStitch({ ok: false, msg: data.reason ?? data.error ?? "No se pudo unir." });
      }
    } catch (err) {
      setStitch({
        ok: false,
        msg: err instanceof Error ? err.message : "No se pudo unir.",
      });
    } finally {
      setBusy(null);
    }
  }

  const outputPath = project
    ? `${config?.outputDir ?? "./output"}/${project.id}`
    : "";

  // Ordenados por `orden` y no por el orden del manifest: es una TIMELINE, y que el
  // 03 aparezca antes del 02 es el tipo de cosa que hace desconfiar de la pantalla.
  const clips = useMemo(
    () => [...(manifest?.clips ?? [])].sort((a, b) => a.orden - b.orden),
    [manifest],
  );

  const conArchivo = clips.filter((c) => c.file).length;
  const segundosTotales = clips.reduce((t, c) => t + (c.duracion_seg || 0), 0);

  // Hay algo para descargar si al menos un clip tiene archivo (o esta el final.mp4).
  // Misma condicion que usa el server para armar el zip: no inventar una propia.
  const hasDownloadableVideos = Boolean(
    manifest?.clips.some((c) => c.file) || manifest?.final_video,
  );

  const hayQueFilmar = clips.some((c) => c.etiqueta === FILMAR_REAL);
  const cargando = manifest === null && error === null;
  /**
   * El proyecto no cargo (id inexistente o red caida). Sin esto la grilla mostraba su
   * encabezado con "Clips 0" y nada abajo, que se lee como "el proyecto esta vacio" y
   * no como "no lo pude leer". El aviso de arriba ya explica que paso.
   */
  const sinDatos = error !== null && manifest === null;

  /**
   * El vacio tapa la grilla, asi que solo se muestra cuando NO hay nada que ver ni
   * nada que hacer. Si quedan clips para filmar, la grilla se muestra igual aunque no
   * se haya generado nada: esta pantalla es el unico lugar donde se sube ese archivo,
   * y un EmptyState ahi esconderia el boton.
   */
  const vacio =
    manifest !== null &&
    (clips.length === 0 || (!hasDownloadableVideos && !hayQueFilmar));

  // JSON con todos los videos (clips) del proyecto, listo para copiar. Los campos son
  // exactamente los de antes: hay gente pegando esto en otras herramientas.
  const videosJson = useMemo(
    () =>
      manifest
        ? JSON.stringify(
            {
              project_id: manifest.project_id,
              name: manifest.name,
              final_video: manifest.final_video,
              clips: [...manifest.clips]
                .sort((a, b) => a.orden - b.orden)
                .map((c) => ({
                  id: c.id,
                  orden: c.orden,
                  etiqueta: c.etiqueta,
                  status: c.status,
                  duracion_seg: c.duracion_seg,
                  resolucion: c.resolucion ?? null,
                  dialogo: c.dialogo ?? "",
                  on_screen_text: c.on_screen_text ?? "",
                  model: c.model,
                  file: c.file,
                })),
            },
            null,
            2,
          )
        : "",
    [manifest],
  );

  return (
    <div className="flex flex-col gap-5">
      <ProjectTabs projectId={projectId} />

      {/*
        ─── 1. Cabecera y exportar. TODO ARRIBA, SIN SCROLLEAR ─────────────────
        El zip es primario y esta solo en su fila de la derecha; ffmpeg es secundario
        porque es opcional y depende de un binario que puede no estar.
      */}
      <Card className="flex flex-col gap-4">
        <CardHeader className="mb-0 flex-wrap">
          <div className="min-w-0">
            {/*
              <h1> escrito a mano y no `CardTitle`: esta tarjeta ES la pantalla, y
              CardTitle renderiza un <h2> fijo (P-13). El documento no tendria nivel 1.
              El tamaño tambien es distinto a proposito: `display`, no `title`.
            */}
            <h1 className="truncate text-display font-semibold text-fg">
              {project?.name ?? "Resultado"}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {project && <StatusBadge status={project.status} />}
              {manifest && (
                <p className="font-mono text-label tnum text-fg-dim">
                  <span className="text-fg">
                    {conArchivo}/{clips.length}
                  </span>{" "}
                  clips con archivo
                  {segundosTotales > 0 && ` · ${duracion(segundosTotales)}`}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/*
              Descarga en un <a> y no en un fetch: el server contesta con
              Content-Disposition y el navegador la guarda solo. Un <a> tampoco se
              puede `disabled`, asi que va `aria-disabled` + preventDefault (que es lo
              que ya hacia) y el estilo apagado sale de la variante `aria-disabled:`.
            */}
            <Button
              asChild
              variant="primary"
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              <a
                href={
                  hasDownloadableVideos
                    ? `/api/projects/${projectId}/download`
                    : undefined
                }
                aria-disabled={!hasDownloadableVideos}
                onClick={(e) => {
                  if (!hasDownloadableVideos) e.preventDefault();
                }}
                title={
                  hasDownloadableVideos
                    ? "Un .zip con todos los clips generados y el final.mp4 si existe"
                    : "Todavía no hay videos generados"
                }
              >
                <DownloadSimple aria-hidden className="size-4" />
                Descargar todo (.zip)
              </a>
            </Button>

            <Button
              onClick={() => void handleStitch()}
              loading={busy === "stitch"}
              disabled={!config?.ffmpeg}
              title={
                config?.ffmpeg
                  ? "Une los clips en orden en un único final.mp4"
                  : "ffmpeg no detectado en este server"
              }
              icon={<Stack aria-hidden className="size-4" />}
            >
              Unir en final.mp4
            </Button>
          </div>
        </CardHeader>

        {/*
          El resultado del stitch. `aria-live` porque ffmpeg tarda y el usuario ya
          dejo de mirar el boton cuando termina.
        */}
        <div aria-live="polite">
          {stitch && (
            <p
              role={stitch.ok ? undefined : "alert"}
              className={cn(
                "flex items-start gap-2 rounded-sm px-3 py-2 text-body",
                stitch.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger",
              )}
            >
              {stitch.ok ? (
                <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
              ) : (
                <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              )}
              {stitch.msg}
            </p>
          )}
        </div>

        {/* La carpeta local: la otra forma de llevarse esto es abrirla en el Finder. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-divider pt-3">
          <FolderOpen aria-hidden className="size-4 shrink-0 text-fg-dim" />
          <div className="min-w-0 flex-1">
            <p className="text-label text-fg-dim">Carpeta de salida (local)</p>
            <code className="block truncate font-mono text-label text-fg" title={outputPath}>
              {outputPath || "—"}
            </code>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copiar("ruta", outputPath)}
            disabled={!outputPath}
            icon={<IconoCopia copia={copia} que="ruta" />}
          >
            Copiar ruta
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a
              href={`/api/files/${projectId}/manifest.json`}
              target="_blank"
              rel="noreferrer"
              title="Ahí quedaron images/, clips/ y el manifest.json"
            >
              manifest.json
            </a>
          </Button>
        </div>
      </Card>

      {/*
        Copiado OK: no se ve, se anuncia (el cambio de icono ya lo dice en pantalla).
        Copiado FALLIDO: se ve, porque hay que hacer algo al respecto.
      */}
      <div role="status" aria-live="polite">
        {copia && !copia.ok ? (
          <p className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-body text-danger">
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            No se pudo copiar al portapapeles. Abrí el panel de JSON y seleccioná el
            texto a mano.
          </p>
        ) : (
          <span className="sr-only">
            {copia?.que === "ruta"
              ? "Ruta copiada"
              : copia?.que === "json"
                ? "JSON copiado"
                : ""}
          </span>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-body text-danger"
        >
          <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      {/* ─── 2. El video final unido, si existe ────────────────────────────── */}
      {manifest?.final_video && (
        <section className="flex flex-col gap-3">
          <CardHeader className="mb-0 items-baseline">
            <div>
              <CardTitle className="flex flex-wrap items-baseline gap-2">
                Video final
                <span className="font-mono text-label font-normal text-fg-dim">
                  {manifest.final_video}
                </span>
              </CardTitle>
              <CardDescription>
                Los clips unidos en orden con ffmpeg. Entra en el zip.
              </CardDescription>
            </div>
          </CardHeader>
          <video
            src={`/api/files/${projectId}/${manifest.final_video}`}
            controls
            preload="none"
            playsInline
            aria-label="Video final unido"
            className="max-h-[70vh] w-full rounded-lg bg-bg object-contain sm:w-auto"
          />
        </section>
      )}

      {/* ─── 3. Lo generado, en grilla y en 9:16 ───────────────────────────── */}
      {!sinDatos && (
        <section className="flex flex-col gap-3">
          <CardHeader className="mb-0 items-baseline">
            <div>
              <CardTitle className="flex flex-wrap items-baseline gap-2">
                Clips
                <span className="font-mono text-label tnum font-normal text-fg-dim">
                  {clips.length}
                </span>
              </CardTitle>
              <CardDescription>
                En orden de timeline. Los videos no se precargan: dale play al que
                quieras ver.
              </CardDescription>
            </div>
          </CardHeader>

          {cargando ? (
            <SkeletonGrid items={8} />
          ) : vacio ? (
            <EmptyState
              icon={<FilmStrip aria-hidden className="size-6" />}
              title="Todavía no hay nada generado"
              body={
                clips.length === 0
                  ? "Este proyecto no tiene clips en el plan. Revisá el plan en el pipeline."
                  : "Los clips todavía no se generaron. El pipeline te muestra en qué anda cada uno y te deja arrancar la cola."
              }
              action={{
                label: "Ir al pipeline",
                onClick: () => router.push(`/project/${projectId}/pipeline`),
              }}
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {clips.map((clip) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  projectId={projectId}
                  busy={busy === clip.id}
                  onUpload={handleUpload}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ─── 4. El JSON, colapsado: es una herramienta, no el contenido ────── */}
      {manifest && manifest.clips.length > 0 && (
        <Card className="flex flex-col gap-3">
          <CardHeader className="mb-0 flex-wrap">
            <div className="min-w-0">
              <CardTitle>JSON de todos los videos</CardTitle>
              <CardDescription>
                Los{" "}
                <span className="font-mono tnum text-fg">
                  {manifest.clips.length}
                </span>{" "}
                clips con orden, estado, diálogo, modelo y archivo. Copialo para
                reusarlo donde quieras.
              </CardDescription>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setVerJson((v) => !v)}
                aria-expanded={verJson}
                aria-controls="json-videos"
                icon={<BracketsCurly aria-hidden className="size-3.5" />}
              >
                {verJson ? "Ocultar" : "Ver"}
              </Button>
              <Button
                size="sm"
                onClick={() => void copiar("json", videosJson)}
                icon={<IconoCopia copia={copia} que="json" />}
              >
                Copiar JSON
              </Button>
            </div>
          </CardHeader>
          {/*
            Se renderiza SIEMPRE y se esconde con `hidden`, en lugar de montarse y
            desmontarse. Si no existe cuando esta colapsado, el `aria-controls` del
            boton apunta a un id que no esta en el DOM, que es el mismo defecto que
            P-07 documenta para las pestañas: el lector de pantalla anuncia que hay
            algo para abrir y no hay nada.
          */}
          <pre
            id="json-videos"
            hidden={!verJson}
            className="max-h-96 overflow-auto rounded-sm bg-bg p-3 font-mono text-label leading-relaxed text-fg-dim"
          >
            <code>{videosJson}</code>
          </pre>
        </Card>
      )}
    </div>
  );
}

/**
 * Un clip de la timeline. En 9:16 porque es el formato real de lo que genera la app:
 * la fila apaisada de antes recortaba mentalmente el video y no se podia comparar un
 * clip con otro.
 */
function ClipCard({
  clip,
  projectId,
  busy,
  onUpload,
}: {
  clip: ManifestClip;
  projectId: string;
  busy: boolean;
  onUpload: (clipId: string, file: File) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const fileUrl = clip.file ? `/api/files/${projectId}/${clip.file}` : null;
  const esReal = clip.etiqueta === FILMAR_REAL;

  // El label del estado lo pone `StatusBadge` (que pregunta a ui-tokens). De aca solo
  // sale el TONO, para decidir que dibujar en la caja vacia: nada de switch local ni
  // de imprimir el status crudo (§6 del plan).
  const estado = estadoDeJob(clip.status);
  const fallo = estado.tone === "danger";

  return (
    <Card flush className="flex flex-col overflow-hidden">
      {/* ─── El video primero: es el contenido ──────────────────────────── */}
      <div className="relative bg-bg">
        {fileUrl ? (
          <video
            src={fileUrl}
            controls
            preload="none"
            playsInline
            aria-label={`Clip ${clip.id}`}
            className="aspect-[9/16] w-full bg-bg object-contain"
          />
        ) : (
          <div
            className={cn(
              "flex aspect-[9/16] w-full flex-col items-center justify-center gap-1.5 px-2 text-center text-label",
              fallo ? "text-danger" : "text-fg-dim",
            )}
          >
            {estado.animado ? (
              <>
                <Spinner aria-hidden className="size-5 motion-safe:animate-spin" />
                generando…
              </>
            ) : fallo ? (
              <>
                <WarningCircle aria-hidden className="size-5" />
                no salió
              </>
            ) : esReal ? (
              <>
                <VideoCamera aria-hidden className="size-5" />
                lo filmás vos
              </>
            ) : (
              <>
                <FilmStrip aria-hidden className="size-5" />
                sin generar
              </>
            )}
          </div>
        )}
        {/*
          El numero de orden encima del video y no en la fila de abajo: con 95 clips
          en grilla, ubicarse es lo primero que se necesita. `pointer-events-none`
          para no robarle el click al player.
        */}
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-sm bg-bg/80 px-1.5 py-px font-mono text-label tnum font-semibold text-fg">
          {String(clip.orden).padStart(2, "0")}
        </span>
      </div>

      {/* ─── Identificacion, estado y textos ────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate font-mono text-body font-medium text-fg" title={clip.id}>
            {clip.id}
          </p>
          <span className="shrink-0">
            <StatusBadge status={clip.status} />
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/*
            `FILMAR_REAL` no se muestra crudo: es un nombre interno. Y va en
            `attention` porque significa exactamente eso, que espera algo de vos (D6).
          */}
          <Badge tone={esReal ? "attention" : "neutral"}>
            {esReal ? (
              <>
                <VideoCamera aria-hidden className="size-3 shrink-0" />
                Filmás vos
              </>
            ) : (
              <>
                <Sparkle aria-hidden className="size-3 shrink-0" />
                {clip.etiqueta}
              </>
            )}
          </Badge>
          <Badge tone="neutral" className="tnum">
            {clip.duracion_seg}s
          </Badge>
          {clip.resolucion && (
            <Badge tone="neutral" className="tnum">
              {clip.resolucion}
            </Badge>
          )}
        </div>

        {/*
          `line-clamp` va en el <p> y no en un <span> de adentro: la clase pone
          `display:-webkit-box`, asi que en un span inline rompe el renglon en dos.
        */}
        {clip.dialogo && (
          <p className="line-clamp-2 text-label text-fg" title={clip.dialogo}>
            <span className="text-fg-dim">diálogo: </span>“{clip.dialogo}”
          </p>
        )}

        {clip.on_screen_text && (
          <p
            className="flex items-start gap-1.5 text-label text-fg-dim"
            title={clip.on_screen_text}
          >
            <Textbox aria-hidden className="mt-px size-3.5 shrink-0" />
            <span className="line-clamp-2">{clip.on_screen_text}</span>
          </p>
        )}

        {clip.file && (
          <code
            className="block truncate font-mono text-label text-fg-dim"
            title={clip.file}
          >
            {clip.file}
          </code>
        )}

        {/* Subir el clip filmado. Solo para los que no genera la IA. */}
        {esReal && (
          <div className="mt-auto pt-1">
            <input
              ref={fileInput}
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(clip.id, f);
                // Se limpia para que subir el MISMO archivo dos veces vuelva a
                // disparar el change (si no, el input lo considera sin cambios).
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              loading={busy}
              onClick={() => fileInput.current?.click()}
              icon={<UploadSimple aria-hidden className="size-3.5" />}
            >
              {clip.file ? "Reemplazar" : "Subir clip"}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
