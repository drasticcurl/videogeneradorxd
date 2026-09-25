"use client";

/**
 * Pantalla "Resultado": lo que salio del pipeline y como te lo llevas.
 *
 * ─── REDISEÑO SOBRE EL HANDOFF (Videos.dc.html, pantalla "project" / tab Resultado) ──
 *
 * El video final ahora ocupa TODO el alto disponible con container queries: el
 * contenedor lleva `cq-size` (ya definida en globals.css, container-type:size) y el
 * reproductor `height:100cqh` con `width:min(calc(100cqh*0.5625), 55cqw)`, que es
 * exactamente 9:16 sin desbordar el ancho cuando el alto disponible es muy grande.
 * A la derecha quedan las tres descargas (final, zip, JSON) apiladas, y abajo la
 * grilla de clips en 72px fijos con badge de estado — la misma info que antes, en
 * las medidas que pide el handoff.
 *
 * El header (volver, nombre, badge, segmented Pipeline/Resultado) ahora vive en esta
 * pagina en vez de en `ProjectTabs`: el segmented navega con `router.push` a
 * `/project/:id/pipeline`, que sigue siendo una ruta distinta.
 *
 * La pantalla pasa de `PantallaScroll` a `PantallaFija`: es una pantalla de TRABAJO
 * (ver el comentario de `Pantalla.tsx`), y el video a `100cqh` necesita que su
 * contenedor tenga un alto real y no "lo que ocupe el contenido". El resto de la
 * pagina (las descargas, la grilla de clips, el JSON colapsado) sigue scrolleando,
 * pero adentro de su propia columna con `min-h-0 flex-1 overflow-y-auto`, nunca en
 * el body entero.
 *
 * ─── LO QUE NO SE TOCO ───────────────────────────────────────────────────────
 *
 * Los tres endpoints son los mismos y con el mismo payload: subir un clip filmado
 * (POST con FormData), unir con ffmpeg (POST) y bajar el zip (GET dentro de un <a>,
 * porque una descarga con Content-Disposition la maneja el navegador y no fetch).
 *
 * La condicion que habilita el zip es la misma de antes, y es a proposito la MISMA
 * que usa el server para armarlo (algun clip con archivo, o el video unido). Si
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
  ArrowClockwise,
  ArrowLeft,
  BracketsCurly,
  Check,
  Copy,
  DownloadSimple,
  FileZip,
  FilmStrip,
  FolderOpen,
  Play,
  Sparkle,
  Spinner,
  Stack,
  Textbox,
  Trash,
  UploadSimple,
  VideoCamera,
  Waveform,
  WarningCircle,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { CambiarVozDialog } from "@/components/CambiarVozDialog";
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
  Progreso,
  Segmented,
  Skeleton,
  SkeletonGrid,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import type { ManifestClip, RespuestaEstadoVoz, VersionDeVoz } from "@/lib/types";
import { estadoDeJob, estadoDeVersionDeVoz } from "@/lib/ui-tokens";
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

  /*
    Cambio de voz (tasks/cambio-de-voz/02-DISENO.md §12.1). `voz` es la respuesta de
    GET /voz tal cual: un solo lugar de verdad para el panel, el dialogo y el polling.
    `elegida` es la version que muestra el reproductor (null = el original).
  */
  const [voz, setVoz] = useState<RespuestaEstadoVoz | null>(null);
  const [elegida, setElegida] = useState<string | null>(null);
  const [dialogoVoz, setDialogoVoz] = useState(false);
  const [preseleccion, setPreseleccion] = useState<VersionDeVoz | null>(null);
  const [confirmarUnir, setConfirmarUnir] = useState(false);
  const [aBorrar, setABorrar] = useState<VersionDeVoz | null>(null);
  const [errorVoz, setErrorVoz] = useState<string | null>(null);
  const [anuncio, setAnuncio] = useState("");
  /** Estado anterior de cada version, para detectar la que acaba de quedar lista. */
  const estadosPrevios = useRef<Map<string, string> | null>(null);

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

  async function cargarVoz() {
    try {
      const res = await fetch(`/api/projects/${projectId}/voz`);
      if (!res.ok) return;
      const data = (await res.json()) as RespuestaEstadoVoz;
      /*
        Una version que pasa a "lista" con la pantalla abierta queda elegida sola y se
        anuncia: el usuario ya dejo de mirar el panel cuando termina. En la PRIMERA
        carga no se anuncia nada: esas ya estaban listas antes de entrar.
      */
      const previos = estadosPrevios.current;
      if (previos) {
        const recien = data.versiones.find(
          (v) => v.estado === "lista" && previos.has(v.id) && previos.get(v.id) !== "lista",
        );
        if (recien) {
          setElegida(recien.id);
          setAnuncio(`Lista la versión con la voz ${recien.voz.nombre}`);
        }
      }
      estadosPrevios.current = new Map(data.versiones.map((v) => [v.id, v.estado]));
      setVoz(data);
    } catch {
      // Best-effort: si el polling falla una vez, el siguiente tick lo intenta de nuevo.
    }
  }

  useEffect(() => {
    void cargarVoz();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /*
    Polling cada 2 s SOLO mientras hay una conversion activa, y se limpia al desmontar:
    un setInterval vivo despues de salir de la pantalla le seguiria pegando al server
    cada 2 s para nadie.
  */
  const hayActiva = Boolean(voz?.activa);
  useEffect(() => {
    if (!hayActiva) return;
    const t = setInterval(() => void cargarVoz(), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hayActiva, projectId]);

  /** Reintentar / Rehacer: un POST con las MISMAS opciones de esa version (§12.1). */
  async function repetirVersion(v: VersionDeVoz) {
    setErrorVoz(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/voz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accion: v.prueba ? "probar" : "convertir",
          voz: v.voz,
          ajustes: v.ajustes,
          quitarRuido: v.quitarRuido,
          incluirFilmados: v.incluirFilmados,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; version?: VersionDeVoz } | null;
      if (!res.ok) throw new Error(data?.error ?? "No se pudo iniciar el cambio de voz.");
      if (data?.version) estadosPrevios.current?.set(data.version.id, "en_cola");
    } catch (err) {
      setErrorVoz(err instanceof Error ? err.message : "No se pudo iniciar el cambio de voz.");
    }
    await cargarVoz();
  }

  async function cancelarVoz() {
    setErrorVoz(null);
    try {
      await fetch(`/api/projects/${projectId}/voz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: "cancelar" }),
      });
    } finally {
      await cargarVoz();
    }
  }

  async function borrarVersion(v: VersionDeVoz) {
    setErrorVoz(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/voz?version=${encodeURIComponent(v.id)}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "No se pudo borrar la versión.");
      if (elegida === v.id) setElegida(null);
    } catch (err) {
      setErrorVoz(err instanceof Error ? err.message : "No se pudo borrar la versión.");
    }
    await cargarVoz();
  }

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
      /*
        Una respuesta NO-JSON es casi siempre el 524 de Cloudflare: el proxy corta a
        los 100 s pero el server sigue uniendo (P-04). Antes eso se mostraba como "No se
        pudo unir." y el usuario volvia a apretar, con el primer stitch todavia corriendo.
      */
      const texto = await res.text();
      let data: { ok?: boolean; finalPath?: string; reason?: string; error?: string };
      try {
        data = JSON.parse(texto) as typeof data;
      } catch {
        setStitch({
          ok: false,
          msg: "El servidor sigue uniendo: los videos largos tardan más de lo que espera el proxy. Recargá en unos minutos.",
        });
        return;
      }
      if (data.ok) {
        /*
          El nombre sale de la respuesta y no esta escrito aca: el archivo se llama
          como el proyecto, asi que hardcodear "final.mp4" mostraria un nombre que no
          existe en el disco.
        */
        setStitch({
          ok: true,
          msg: `${data.finalPath ?? "El video unido"} listo. Ya entra en el zip.`,
        });
        setElegida(null);
        await loadProject(projectId);
        await cargarVoz();
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

  // Hay algo para descargar si al menos un clip tiene archivo (o esta el video unido).
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

  /*
    Los clips y el JSON se extraen a variables porque los renderizan DOS layouts
    distintos: con video final van adentro de la columna derecha (la que scrollea), y
    sin video final van sueltos en la columna de la pagina. Duplicar el JSX era la
    otra opcion, y es como se desincronizan dos copias de lo mismo.
  */
  const seccionClips = !sinDatos ? (
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
        <div className="grid grid-cols-[repeat(auto-fill,72px)] gap-2">
          {clips.map((clip) => (
            <ClipThumb
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
  ) : null;

  const seccionJson =
    manifest && manifest.clips.length > 0 ? (
      <Card className="flex flex-col gap-3">
        <CardHeader className="mb-0 flex-wrap">
          <div className="min-w-0">
            <CardTitle>JSON de todos los videos</CardTitle>
            <CardDescription>
              Los{" "}
              <span className="font-mono tnum text-fg">{manifest.clips.length}</span>{" "}
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
    ) : null;

  return (
    <PantallaFija>
      {/* ─── Header: volver, nombre, estado y el segmented Pipeline/Resultado ── */}
      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-divider px-4 py-3 sm:px-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/")}
          title="Volver a proyectos"
          icon={<ArrowLeft aria-hidden className="size-4" />}
        />
        <h1 className="min-w-0 truncate font-mono text-display font-semibold text-fg">
          {project?.name ?? "Resultado"}
        </h1>
        {project ? (
          <StatusBadge status={project.status} />
        ) : (
          <Skeleton className="h-5 w-24" />
        )}
        {manifest && (
          <p className="font-mono text-label tnum text-fg-dim">
            <span className="text-fg">
              {conArchivo}/{clips.length}
            </span>{" "}
            clips con archivo
            {segundosTotales > 0 && ` · ${duracion(segundosTotales)}`}
          </p>
        )}
        <span className="flex-1" />
        <Segmented
          value="resultado"
          onChange={(v) => {
            if (v === "pipeline") router.push(`/project/${projectId}/pipeline`);
          }}
          etiqueta="Vista del proyecto"
          options={[
            { value: "pipeline", label: "Pipeline" },
            { value: "resultado", label: "Resultado" },
          ]}
        />
      </div>

      {/*
        ─── DOS LAYOUTS, Y LA DIFERENCIA NO ES COSMETICA ──────────────────────

        CON video final la pantalla es de ALTO FIJO: el video ocupa todo el alto que
        quedo (container query, `100cqh`) y lo que scrollea es la columna derecha.
        Es lo que pide el handoff, y es lo que hace que un vertical 9:16 se vea
        grande sin tener que abrir el archivo aparte. Antes el video estaba clavado
        en `70vh` adentro de un scroll de pagina: en un monitor alto desperdiciaba
        pantalla y en uno bajo volvia a aparecer la barra de scroll que el rediseño
        vino a sacar.

        SIN video final no hay nada que dimensionar contra el alto, asi que la
        pantalla scrollea como una lista normal. Forzar el alto fijo ahi solo achica
        la grilla de clips, que es lo unico que hay para mirar.
      */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6",
          !manifest?.final_video && "overflow-y-auto",
        )}
      >
        {error && (
          <p
            role="alert"
            className="flex flex-none items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-body text-danger"
          >
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        {/*
          Copiado OK: no se ve, se anuncia (el cambio de icono ya lo dice en pantalla).
          Copiado FALLIDO: se ve, porque hay que hacer algo al respecto.
        */}
        <div role="status" aria-live="polite" className="flex-none">
          {copia && !copia.ok ? (
            <p className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-body text-danger">
              <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              No se pudo copiar al portapapeles. Abrí el panel de JSON y seleccioná
              el texto a mano.
            </p>
          ) : (
            <span className="sr-only">
              {copia?.que === "ruta"
                ? "Ruta copiada"
                : copia?.que === "json"
                  ? "JSON copiado"
                  : anuncio}
            </span>
          )}
        </div>

        {cargando ? (
          <Skeleton className="aspect-[9/16] w-full max-w-sm rounded-lg" />
        ) : manifest?.final_video ? (
          /*
            Los clips y el JSON van como HIJOS del video: viven adentro de la columna
            derecha, que es la que scrollea. Afuera quedarian abajo del fold de una
            pantalla que no scrollea, o sea invisibles.
          */
          <VideoFinal
            projectId={projectId}
            finalVideo={manifest.final_video}
            totalDur={duracion(segundosTotales)}
            outputPath={outputPath}
            onCopiarRuta={() => void copiar("ruta", outputPath)}
            copia={copia}
            voz={voz}
            elegida={elegida}
            onElegir={setElegida}
            busyUnir={busy === "stitch"}
            puedeUnir={Boolean(config?.ffmpeg)}
            onVolverAUnir={() => setConfirmarUnir(true)}
            stitch={stitch}
            errorVoz={errorVoz}
            onCambiarVoz={() => {
              setPreseleccion(null);
              setDialogoVoz(true);
            }}
            onRepetir={(v) => void repetirVersion(v)}
            onCancelar={() => void cancelarVoz()}
            onBorrar={setABorrar}
          >
            {seccionClips}
            {seccionJson}
          </VideoFinal>
        ) : (
          <>
            <SinVideoFinal
              busy={busy === "stitch"}
              puedeUnir={Boolean(config?.ffmpeg)}
              onUnir={() => void handleStitch()}
              stitch={stitch}
              hasDownloadableVideos={hasDownloadableVideos}
              projectId={projectId}
              outputPath={outputPath}
              onCopiarRuta={() => void copiar("ruta", outputPath)}
              copia={copia}
            />
            {seccionClips}
            {seccionJson}
          </>
        )}
      </div>

      {voz && (
        <CambiarVozDialog
          abierto={dialogoVoz}
          onCambio={setDialogoVoz}
          proyectoId={projectId}
          estado={voz}
          preseleccion={preseleccion}
          onIniciada={(v) => {
            // Se registra ya como "en_cola": si termina antes del primer polling, igual
            // se detecta la transicion a "lista" y queda elegida sola.
            estadosPrevios.current?.set(v.id, "en_cola");
            void cargarVoz();
          }}
        />
      )}
      <Confirmar
        abierto={confirmarUnir}
        onCambio={setConfirmarUnir}
        title="Volver a unir el video"
        detalle={`Se vuelve a generar ${manifest?.final_video ?? "el video unido"} con los clips actuales. Tarda ~1 s por segundo de video (~${duracion(segundosTotales)}). Las versiones con otra voz se conservan.`}
        labelConfirmar="Volver a unir"
        onConfirmar={() => void handleStitch()}
      />
      <Confirmar
        abierto={aBorrar !== null}
        onCambio={(v) => {
          if (!v) setABorrar(null);
        }}
        title="Borrar esta versión"
        detalle={
          aBorrar
            ? `Se borra ${aBorrar.prueba ? "la prueba" : "la versión"} con la voz ${aBorrar.voz.nombre}. El video original no se toca.`
            : ""
        }
        labelConfirmar="Borrar"
        peligroso
        onConfirmar={() => {
          if (aBorrar) void borrarVersion(aBorrar);
        }}
      />
    </PantallaFija>
  );
}

/**
 * El video final + las tres descargas a la derecha, en el layout de container
 * query que pide el handoff: el contenedor `cq-size` le da al video un `100cqh` de
 * alto real para medirse contra, y el ancho sale de `min(100cqh*0.5625, 55cqw)` para
 * no desbordar si el contenedor es muy ancho y muy bajo.
 *
 * Es un componente aparte de `SinVideoFinal` (mismo lugar en el layout, contenido
 * excluyente) porque comparten poco: uno tiene video real y descarga directa, el
 * otro tiene el boton de unir y el estado de esa union.
 */
function VideoFinal({
  projectId,
  finalVideo,
  totalDur,
  outputPath,
  onCopiarRuta,
  copia,
  voz,
  elegida,
  onElegir,
  busyUnir,
  puedeUnir,
  onVolverAUnir,
  stitch,
  errorVoz,
  onCambiarVoz,
  onRepetir,
  onCancelar,
  onBorrar,
  children,
}: {
  projectId: string;
  finalVideo: string;
  totalDur: string;
  outputPath: string;
  onCopiarRuta: () => void;
  copia: { que: "ruta" | "json"; ok: boolean } | null;
  /** GET /voz. null mientras carga. */
  voz: RespuestaEstadoVoz | null;
  /** La version que muestra el reproductor; null = el original. */
  elegida: string | null;
  onElegir: (id: string | null) => void;
  busyUnir: boolean;
  puedeUnir: boolean;
  onVolverAUnir: () => void;
  stitch: { ok: boolean; msg: string } | null;
  errorVoz: string | null;
  onCambiarVoz: () => void;
  onRepetir: (v: VersionDeVoz) => void;
  onCancelar: () => void;
  onBorrar: (v: VersionDeVoz) => void;
  /** Los clips y el JSON: van adentro de la columna que scrollea, no abajo. */
  children?: React.ReactNode;
}) {
  const versionElegida = voz?.versiones.find((v) => v.id === elegida && v.file) ?? null;
  const src = `/api/files/${projectId}/${versionElegida?.file ?? finalVideo}`;
  const activa = voz?.activa ?? null;
  const unido = voz?.unido ?? null;
  // Aviso de "los clips cambiaron" o "se unio antes del modulo" (R8.2, R8.4).
  const aviso = unido && (unido.desactualizado || !unido.conReceta) ? unido.motivo : null;
  return (
    /*
      `min-h-0 flex-1` y no un alto en `vh`: el alto disponible lo define el shell
      (header de 56px + el header propio de la pantalla), y en `vh` habria que
      restar esas dos cosas a mano y volver a hacerlo cada vez que una cambie.
      `cq-size` convierte ese alto en la unidad `100cqh`, que es lo que usa el video.
    */
    <div className="cq-size flex min-h-0 flex-1 gap-6">
      {/*
        `key={src}`: al elegir otra version el <video> se vuelve a montar. Cambiar solo
        el `src` deja al navegador mostrando el ultimo frame del video anterior hasta
        que el usuario le da play.
      */}
      <video
        key={src}
        src={src}
        controls
        preload="none"
        playsInline
        aria-label={versionElegida ? `Video con la voz ${versionElegida.voz.nombre}` : "Video final unido"}
        style={{ height: "100cqh", width: "min(calc(100cqh * 0.5625), 55cqw)" }}
        className="flex-none rounded-lg bg-bg object-contain"
      />
      <div className="flex min-w-0 min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-label text-fg-dim">Video final</p>
            <p className="font-mono text-body text-fg">
              {finalVideo} <span className="text-fg-dim">· {totalDur}</span>
            </p>
          </div>
          <Button
            size="sm"
            onClick={onVolverAUnir}
            loading={busyUnir}
            disabled={!puedeUnir || Boolean(activa)}
            title={
              activa
                ? "Hay un cambio de voz en curso: esperá a que termine o cancelalo."
                : puedeUnir
                  ? "Vuelve a generar el video con los clips actuales."
                  : "ffmpeg no detectado en este server"
            }
            icon={<ArrowClockwise aria-hidden className="size-3.5" />}
          >
            Volver a unir
          </Button>
        </div>
        {aviso && (
          <p className="flex items-start gap-2 rounded-sm bg-accent/10 px-3 py-2 text-body text-accent">
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {unido?.desactualizado ? `Los clips cambiaron desde que se unió: ${aviso}` : aviso}
          </p>
        )}
        {/* aria-live porque unir tarda y el usuario ya dejo de mirar el boton cuando termina. */}
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
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="primary" icon={<DownloadSimple aria-hidden className="size-4" />}>
            <a href={`/api/files/${projectId}/${finalVideo}?dl=1`} download>
              Descargar video final
            </a>
          </Button>
          <Button asChild variant="secondary" icon={<FileZip aria-hidden className="size-4" />}>
            <a href={`/api/projects/${projectId}/download`}>Todo (zip)</a>
          </Button>
          <Button asChild variant="secondary" icon={<BracketsCurly aria-hidden className="size-4" />}>
            <a href={`/api/files/${projectId}/manifest.json`} target="_blank" rel="noreferrer">
              JSON de los videos
            </a>
          </Button>
        </div>
        <PanelVoz
          projectId={projectId}
          voz={voz}
          elegida={elegida}
          onElegir={onElegir}
          totalDur={totalDur}
          errorVoz={errorVoz}
          onCambiarVoz={onCambiarVoz}
          onRepetir={onRepetir}
          onCancelar={onCancelar}
          onBorrar={onBorrar}
        />
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
            onClick={onCopiarRuta}
            disabled={!outputPath}
            icon={<IconoCopia copia={copia} que="ruta" />}
          >
            Copiar ruta
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** "2026-09-25T14:02..." -> "25/9 14:02". */
function fechaCorta(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Bytes -> "214 MB". */
function peso(bytes: number | null): string {
  if (!bytes) return "";
  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/**
 * Nombre legible para la descarga: `<proyecto>__voz-<voz>.mp4` (R5.2). Sale del nombre
 * del archivo sin el `-<id6>` del final, que esta para que dos versiones con la misma
 * voz no se pisen en disco pero no le dice nada a quien baja el archivo.
 */
function nombreDescarga(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/-[0-9a-f]{6}\.mp4$/, ".mp4");
}

/**
 * El panel "Voz" de Resultado (tasks/cambio-de-voz/02-DISENO.md §12.1): el original y
 * cada version, con lo que se puede hacer con cada una. Solo existe con video unido
 * (vive adentro de `VideoFinal`): sin unido no hay nada que cambiar.
 */
function PanelVoz({
  projectId,
  voz,
  elegida,
  onElegir,
  totalDur,
  errorVoz,
  onCambiarVoz,
  onRepetir,
  onCancelar,
  onBorrar,
}: {
  projectId: string;
  voz: RespuestaEstadoVoz | null;
  elegida: string | null;
  onElegir: (id: string | null) => void;
  totalDur: string;
  errorVoz: string | null;
  onCambiarVoz: () => void;
  onRepetir: (v: VersionDeVoz) => void;
  onCancelar: () => void;
  onBorrar: (v: VersionDeVoz) => void;
}) {
  const unido = voz?.unido ?? null;
  /*
    Por que "Cambiar voz" esta deshabilitado, VISIBLE debajo del boton: un `title` no
    se ve en touch ni navegando con teclado (R8.3).
  */
  const motivo = !voz
    ? null
    : !voz.disponible
      ? voz.motivoNoDisponible
      : !unido?.conReceta
        ? unido?.motivo ?? null
        : unido.desactualizado
          ? `${unido.motivo} Volvé a unir antes de cambiar la voz.`
          : voz.activa
            ? "Hay un cambio de voz en curso en este proyecto."
            : null;

  return (
    <section className="flex flex-col gap-2 border-t border-divider pt-3" aria-label="Voz">
      <div className="flex flex-wrap items-center gap-2">
        <Waveform aria-hidden className="size-4 shrink-0 text-fg-dim" />
        <h2 className="flex-1 text-body font-medium text-fg">Voz</h2>
        <Button size="sm" variant="primary" onClick={onCambiarVoz} disabled={!voz || motivo !== null}>
          Cambiar voz
        </Button>
      </div>
      {motivo && <p className="text-label text-fg-dim">{motivo}</p>}
      {errorVoz && (
        <p role="alert" className="flex items-start gap-2 rounded-sm bg-danger/10 px-3 py-2 text-body text-danger">
          <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {errorVoz}
        </p>
      )}

      <ul className="flex flex-col divide-y divide-divider rounded-md border border-divider">
        <li className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1 text-body text-fg">
            Original
            <span className="text-label text-fg-dim">
              {unido?.creadoEn ? ` · unido ${fechaCorta(unido.creadoEn)}` : ""}
            </span>
          </span>
          <Button size="sm" variant="ghost" aria-pressed={elegida === null} onClick={() => onElegir(null)}>
            Ver
          </Button>
        </li>
        {(voz?.versiones ?? []).map((v) => {
          const visual = estadoDeVersionDeVoz(v.estado);
          const viva = voz?.activa?.id === v.id;
          const vieja = v.estado === "lista" && unido?.creadoEn != null && v.recetaCreadaEn !== unido.creadoEn;
          return (
            <li key={v.id} className="flex flex-col gap-1.5 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={visual.tone} punto animado={visual.animado}>
                  {visual.label}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-body text-fg">
                  {v.prueba ? `Prueba 20 s · ${v.voz.nombre}` : v.voz.nombre}
                  <span className="text-label text-fg-dim">
                    {" · "}
                    {fechaCorta(v.creadoEn)}
                    {v.estado === "lista" && !v.prueba ? ` · ${totalDur}` : ""}
                    {v.estado === "lista" && v.bytes ? ` · ${peso(v.bytes)}` : ""}
                  </span>
                </span>
                {v.estado === "lista" && v.file && (
                  <>
                    <Button size="sm" variant="ghost" aria-pressed={elegida === v.id} onClick={() => onElegir(v.id)}>
                      Ver
                    </Button>
                    {!v.prueba && (
                      <Button asChild size="sm" variant="ghost">
                        <a
                          href={`/api/files/${projectId}/${v.file}?dl=1&name=${encodeURIComponent(nombreDescarga(v.file))}`}
                          download
                        >
                          Descargar
                        </a>
                      </Button>
                    )}
                  </>
                )}
                {viva && (
                  <Button size="sm" variant="ghost" onClick={onCancelar}>
                    Cancelar
                  </Button>
                )}
                {(v.estado === "fallida" || v.estado === "cancelada") && (
                  <Button size="sm" variant="ghost" onClick={() => onRepetir(v)} disabled={Boolean(voz?.activa)}>
                    Reintentar
                  </Button>
                )}
                {!viva && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onBorrar(v)}
                    aria-label={`Borrar la versión con la voz ${v.voz.nombre}`}
                    icon={<Trash aria-hidden className="size-3.5" />}
                  >
                    Borrar
                  </Button>
                )}
              </div>
              {v.estado === "procesando" && (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-label tnum text-fg-dim">
                    tramo {Math.min(v.progreso.tramosListos + 1, v.progreso.tramosTotal)} de {v.progreso.tramosTotal}
                  </span>
                  <Progreso
                    hechos={v.progreso.tramosListos}
                    total={v.progreso.tramosTotal}
                    tono="info"
                    etiqueta={`Convirtiendo a ${v.voz.nombre}`}
                    className="flex-1"
                  />
                </div>
              )}
              {v.estado === "fallida" && v.error && <p className="text-label text-danger">{v.error}</p>}
              {vieja && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="attention">Hecha sobre un unido anterior</Badge>
                  <Button size="sm" variant="ghost" onClick={() => onRepetir(v)} disabled={motivo !== null}>
                    Rehacer con esta voz
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Cuando todavia no hay video unido: el boton para unir (ffmpeg), su resultado, y
 * las mismas descargas de zip/manifest que ya sirven aunque no haya stitch (el zip
 * arma con los clips sueltos).
 */
function SinVideoFinal({
  busy,
  puedeUnir,
  onUnir,
  stitch,
  hasDownloadableVideos,
  projectId,
  outputPath,
  onCopiarRuta,
  copia,
}: {
  busy: boolean;
  puedeUnir: boolean;
  onUnir: () => void;
  stitch: { ok: boolean; msg: string } | null;
  hasDownloadableVideos: boolean;
  projectId: string;
  outputPath: string;
  onCopiarRuta: () => void;
  copia: { que: "ruta" | "json"; ok: boolean } | null;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={onUnir}
          loading={busy}
          disabled={!puedeUnir}
          title={
            puedeUnir
              ? "Une los clips en orden en un solo mp4 con el nombre del proyecto. Tarda ~1s por segundo de video."
              : "ffmpeg no detectado en este server"
          }
          icon={<Stack aria-hidden className="size-4" />}
        >
          Unir en un video
        </Button>
        {/*
          Descarga en un <a> y no en un fetch: el server contesta con
          Content-Disposition y el navegador la guarda solo. Un <a> tampoco se
          puede `disabled`, asi que va `aria-disabled` + preventDefault.
        */}
        <Button
          asChild
          variant="secondary"
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        >
          <a
            href={hasDownloadableVideos ? `/api/projects/${projectId}/download` : undefined}
            aria-disabled={!hasDownloadableVideos}
            onClick={(e) => {
              if (!hasDownloadableVideos) e.preventDefault();
            }}
            title={
              hasDownloadableVideos
                ? "Un .zip con todos los clips generados y el video unido si existe"
                : "Todavía no hay videos generados"
            }
          >
            <FileZip aria-hidden className="size-4" />
            Descargar todo (.zip)
          </a>
        </Button>
        <Button asChild variant="ghost">
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

      {/* aria-live porque ffmpeg tarda y el usuario ya dejo de mirar el boton cuando termina. */}
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
          onClick={onCopiarRuta}
          disabled={!outputPath}
          icon={<IconoCopia copia={copia} que="ruta" />}
        >
          Copiar ruta
        </Button>
      </div>
    </Card>
  );
}

/**
 * Un clip de la grilla de resultado, en 72px de ancho fijo (pide el handoff). Con
 * hasta 95 clips, `auto-fill,72px` los deja tan chicos que la funcion es ubicarse
 * (numero + estado), no evaluar el encuadre — para eso esta el pipeline.
 */
function ClipThumb({
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
    <div className="flex w-[72px] flex-col gap-1">
      <div className="relative aspect-[9/16] w-[72px] overflow-hidden rounded-md bg-bg">
        {fileUrl ? (
          /*
            LINK AL ARCHIVO, no un `<video controls>`. En 72px de ancho la barra de
            controles nativa no entra: el navegador la colapsa al menú de ⋮ y la
            tarjeta queda con tres puntitos y una barra de progreso de 60px encima
            del video, que es exactamente el "queda horrible" que se reporto.
            Verificado con Chrome a 1366x660.

            Un <a> abre el clip a tamaño real en una pestaña, que es lo que se
            quiere de una miniatura de 72px, y de paso no monta un elemento de
            medios por cada uno de los 95 clips de un VSL. El `<video>` grande
            sigue existiendo arriba para el video final unido.
          */
          <a
            href={fileUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Ver el clip ${clip.id} a tamaño real`}
            className="group/thumb flex size-full items-center justify-center bg-surface-hi transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Play
              aria-hidden
              weight="fill"
              className="size-5 text-fg-dim transition-colors group-hover/thumb:text-fg"
            />
          </a>
        ) : (
          <div
            className={cn(
              "flex size-full flex-col items-center justify-center gap-1 px-1 text-center text-label",
              fallo ? "text-danger" : "text-fg-dim",
            )}
          >
            {estado.animado ? (
              <Spinner aria-hidden className="size-4 motion-safe:animate-spin" />
            ) : fallo ? (
              <WarningCircle aria-hidden className="size-4" />
            ) : esReal ? (
              <VideoCamera aria-hidden className="size-4" />
            ) : (
              <FilmStrip aria-hidden className="size-4" />
            )}
          </div>
        )}
        <span className="pointer-events-none absolute left-1 top-1 rounded-sm bg-bg/80 px-1 py-px font-mono text-label tnum font-semibold text-fg">
          {String(clip.orden).padStart(2, "0")}
        </span>
        <span className="pointer-events-none absolute bottom-1 right-1 rounded-sm bg-bg/80 px-1 py-px font-mono text-label tnum text-fg-dim">
          {clip.duracion_seg}s
        </span>
      </div>

      <span className="truncate text-label">
        <StatusBadge status={clip.status} />
      </span>

      {clip.dialogo && (
        <p className="line-clamp-2 text-label text-fg-dim" title={clip.dialogo}>
          “{clip.dialogo}”
        </p>
      )}

      {clip.on_screen_text && (
        <p
          className="flex items-start gap-1 text-label text-fg-dim"
          title={clip.on_screen_text}
        >
          <Textbox aria-hidden className="mt-px size-3 shrink-0" />
          <span className="line-clamp-1">{clip.on_screen_text}</span>
        </p>
      )}

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
            {clip.file ? "Reemplazar" : "Subir"}
          </Button>
        </div>
      )}
    </div>
  );
}
