"use client";

/**
 * Pestaña "Generar" de /imagenes: sidebar con la lista de tandas + la galería de la
 * tanda abierta (grilla o visor) + el chat de cambios fijo abajo. "Nueva tanda" es
 * una sub-vista propia (`vista === "nueva"`), ya no un formulario siempre visible.
 *
 * Reusa el pipeline normal: crea un proyecto con `clips: []` (ver
 * /api/imagenes/route.ts) y despues habla con las MISMAS rutas que el flujo de brief
 * (`/jobs` para el polling, `/jobs/:id/approve` para elegir variante,
 * `/jobs/:id/prompt` para regenerar). No hay lógica de generación duplicada acá.
 *
 * ─── TRES COSAS QUE NO SE TOCAN (§2 de T06, siguen intactas en el rediseño) ──
 *
 * 1. EL POLLING VIVE EN UN `ref` Y SE APAGA. El intervalo se guarda en `pollRef`
 *    para poder pararlo desde un efecto sin re-crearlo en cada render. Si se mueve a
 *    `useState`, cada cambio de estado reinicia el intervalo y la pantalla le pega a
 *    la API mucho mas seguido de lo que dice POLL_MS. Esta pantalla queda abierta
 *    horas, asi que ademas se CORTA cuando no queda nada en curso.
 *
 * 2. `editando` ESTA SEPARADO DE `prompts`. `prompts` es lo que dice el manifest y lo
 *    pisa cada respuesta del polling; `editando` es lo que el usuario esta tipeando.
 *    Si fueran uno solo, lo tipeado se perderia cada 3 segundos.
 *
 * 3. MENOS CANDIDATAS QUE `variants` ES ESTADO LEGITIMO, NO UN FALLO. La cuota de los
 *    modelos de imagen es apretada y rechaza la segunda variante bastante seguido. El
 *    pipeline deja la nota en `job.error` y el job SIGUE SIENDO APROBABLE, asi que se
 *    muestra el conteo real (`1 de 2`) y la nota en tono informativo. El estado sale
 *    de `job.status` y de ningun otro lado (§3 del plan).
 *
 * Rediseño VISUAL (handoff `design_handoff_rediseno_augc`): no cambia ni un
 * endpoint, ni un payload, ni una regla. Cambia el LAYOUT: pantalla de alto fijo sin
 * scroll de página, sidebar de tandas a la izquierda, grilla en una fila al alto
 * completo con toggle Grilla/Visor, lightbox, y "Nueva tanda" como pantalla propia.
 */

import {
  ArrowsClockwise,
  ArrowsOut,
  CaretLeft,
  CaretRight,
  Check,
  CursorClick,
  DownloadSimple,
  Image as ImageIcon,
  ImageSquare,
  MagicWand,
  Rectangle,
  SquaresFour,
  TextAlignLeft,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Badge,
  Button,
  EmptyState,
  Segmented,
  SkeletonGrid,
  Textarea,
  type SelectOption,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import type { ModelOption } from "@/lib/config";
import { estadoDeJob } from "@/lib/ui-tokens";

import { CabeceraSidebar, type Tab } from "./ImagenesTabs";
import NuevaTanda from "./NuevaTanda";

interface Candidate {
  index: number;
  file: string;
  /**
   * Modelo/etiqueta de prompt de ESTA variante puntual. Solo vienen completos con
   * "prompt dual" (generador masivo): en el caso normal el backend los deja
   * `undefined` porque ya se sabe que las 4 comparten el mismo modelo/prompt (ver
   * el comentario de `Candidate` en types.ts).
   */
  model?: string;
  promptLabel?: string;
}

interface Job {
  id: string;
  refId: string;
  label: string;
  status: string;
  type: string;
  error: string | null;
  outputPath: string | null;
  candidates: Candidate[];
  selectedIndex: number | null;
  variants: number;
  attempts: number;
  /**
   * Solo para romper el cache del browser. Los candidatos se escriben SIEMPRE en el
   * mismo path (`images/_candidates/<slug>__v1.png`, ver `candidateRelPath`), asi que
   * al variar una imagen el navegador servia la vieja de cache y parecia que "Variar"
   * no habia hecho nada. Es el mismo `?v=` que usa `JobCard` por el mismo bug.
   * Opcional porque este tipo es una vista angosta de `JobRecord`, no el registro.
   */
  updatedAt?: string;
}

interface ManifestImage {
  id: string;
  prompt: string;
  /**
   * Imagen (u otra referencia) de la que depende. Presente cuando `modo` es
   * image2image. Se usa para armar el HILO del chat iterativo: seguir este puntero
   * hacia atras reconstruye v1 -> v2 -> v3 sin pedirle nada nuevo al server.
   */
  ref_image_id?: string;
}

/** Un proyecto de solo imagenes, para la lista. */
interface ProyectoImagenes {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  imageCount: number;
  soloImagenes?: boolean;
}

const EN_CURSO = new Set(["pending", "queued", "generating", "waiting"]);

/** Cada cuanto se pregunta por el estado. Un solo lugar, para que no divergan. */
const POLL_MS = 3000;

export default function ImagenesBoard({
  modelos,
  modeloDefault,
  tab,
  onCambiarTab,
}: {
  modelos: ModelOption[];
  modeloDefault: string;
  tab: Tab;
  onCambiarTab: (t: Tab) => void;
}) {
  /**
   * Sub-vista de ESTA pestaña: la galería de siempre, o la pantalla de "Nueva
   * tanda". Es estado local (no en la URL, ver el comentario de `ImagenesTabs`)
   * porque no necesita ser un link compartible y así no colisiona con `?id=`.
   */
  const [vista, setVista] = useState<"galeria" | "nueva">("galeria");

  // ─── EL PROYECTO ABIERTO VIVE EN LA URL (se mantiene tal cual) ─────────────
  //
  // Antes era `useState(null)` y eso causaba dos bugs que parecian perdida de datos:
  //   1. refrescar la pagina mostraba "todavia no generaste nada", porque el id solo
  //      estaba en memoria de React. El proyecto seguia entero en el disco.
  //   2. apretar Generar de nuevo hacia setProjectId(nuevo) + setJobs([]) y las
  //      imagenes anteriores desaparecian de la vista.
  // Con el id en `?id=` el refresh lo conserva y el link se puede compartir.
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("id");

  const abrirProyecto = useCallback(
    (id: string | null) => {
      router.replace(id ? `/imagenes?id=${encodeURIComponent(id)}` : "/imagenes", {
        scroll: false,
      });
      setVista("galeria");
    },
    [router],
  );

  /** Los proyectos de SOLO IMAGENES, para la lista del sidebar. */
  const [lista, setLista] = useState<ProyectoImagenes[]>([]);
  const [cargandoLista, setCargandoLista] = useState(true);
  /** Formato con el que se genero lo que se esta viendo (sale del manifest). */
  const [formatoGenerado, setFormatoGenerado] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  /**
   * `ref_image_id` por imagen, del manifest. Es lo que permite armar el HILO del
   * chat iterativo en el cliente (seguir el puntero hacia atras) sin pedirle al
   * server un endpoint nuevo de solo lectura: el dato ya viaja en `/jobs`.
   */
  const [refImageIds, setRefImageIds] = useState<Record<string, string | undefined>>(
    {},
  );
  const [enviando, setEnviando] = useState(false);
  // Prompts en edicion, por refId. Separado de `prompts` para no perder lo tipeado
  // cuando llega una respuesta del polling.
  const [editando, setEditando] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState<Record<string, boolean>>({});
  const [aprobandoLote, setAprobandoLote] = useState(false);
  // Texto del chat en curso, por imageId "cabeza" de la cadena (la mas nueva de cada
  // hilo). Separado de `prompts`/`editando` porque no edita nada existente: es lo que
  // se va a mandar como el PROXIMO turno.
  const [chatTexto, setChatTexto] = useState<Record<string, string>>({});
  const [chatEnviando, setChatEnviando] = useState<Record<string, boolean>>({});
  const [chatError, setChatError] = useState<Record<string, string | null>>({});

  /*
    Hay UN prompt por proyecto, asi que los saltos de linea son parte del prompt y no
    un separador. Antes esto contaba lineas: un prompt de imagen con encuadre, luz y
    estilo en renglones distintos se convertia en cuatro prompts cortados al medio.
  */

  // ─── Vista Grilla/Visor + hilo activo (nuevo estado del rediseño) ──────────
  // No persiste (sin localStorage en la app, ver README): vuelve a "grilla" al
  // recargar. Cada hilo tiene su propia variante seleccionada dentro de la grilla,
  // asi que lo que hace falta acá es solo CUAL hilo esta activo (el "Hilo" de
  // pastillas v1->v2 del spec reemplaza la lista apilada de antes).
  const [modoVista, setModoVista] = useState<"grilla" | "visor">("grilla");
  const [hiloActivo, setHiloActivo] = useState(0);
  const [promptAbierto, setPromptAbierto] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);

  // Para que el boton del estado vacio lleve al campo que hay que llenar (ahora abre
  // "Nueva tanda" en vez de hacer foco en un textarea que ya no esta siempre visible).

  /*
    Hay UN prompt por proyecto, asi que los saltos de linea son parte del prompt y no
    un separador. Antes esto contaba lineas.
  */

  /**
   * Si el modelo guardado no esta en el catalogo, se agrega como opcion. Con el
   * `<select>` nativo esto no hacia falta (mostraba la primera opcion); con Radix
   * el trigger queda VACIO y sin ningun error si el `value` no matchea ningun item.
   * Mismo resguardo que `ModelSelectorBar`. Se sigue calculando acá porque
   * `NuevaTanda` lo recibe como prop (necesita `modeloDefault` y el catalogo).
   */
  const opcionesModelo = useMemo<ReadonlyArray<SelectOption<string>>>(() => {
    return modelos.map((m) => ({ value: m.id, label: m.label, hint: m.id }));
  }, [modelos]);

  // ─── Polling ──────────────────────────────────────────────────────────────
  // Se guarda en un ref para poder pararlo desde el efecto sin re-crearlo en cada
  // render (si no, cada cambio de estado reinicia el intervalo y el polling se
  // dispara mucho mas seguido de lo que dice el numero).
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Trae los proyectos de solo imagenes. Filtra por `soloImagenes`, que el server
   * deriva de que el plan no tenga clips: asi esta pantalla nunca muestra un VSL y la
   * home nunca muestra una tanda de imagenes.
   */
  const cargarLista = useCallback(async () => {
    setCargandoLista(true);
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { projects?: ProyectoImagenes[] };
      setLista((data.projects ?? []).filter((p) => p.soloImagenes));
    } catch {
      // Un fallo de red no tiene que romper la pantalla; el proximo render reintenta.
    } finally {
      setCargandoLista(false);
    }
  }, []);

  useEffect(() => {
    void cargarLista();
  }, [cargarLista]);

  /*
    Abre la primera tanda cuando hay lista y no hay ninguna abierta.

    Sin esto, entrar a /imagenes con 20 tandas generadas mostraba el sidebar lleno
    y el centro vacio: habia que adivinar que el paso siguiente era tocar una de la
    izquierda. La galeria del handoff siempre tiene una tanda activa.

    `vista === "galeria"` es la condicion que lo hace seguro: si el usuario esta en
    el formulario de "Nueva tanda", abrir una tanda le cambiaria la pantalla abajo
    de los dedos. Y `router.replace` (no `push`) para no ensuciar el historial: el
    boton de atras del navegador tiene que salir de /imagenes, no recorrer las
    tandas que se abrieron solas.
  */
  useEffect(() => {
    if (projectId || vista !== "galeria" || lista.length === 0) return;
    abrirProyecto(lista[0].id);
  }, [projectId, vista, lista, abrirProyecto]);

  const traerEstado = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}/jobs`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        jobs?: Job[];
        manifest?: { images?: ManifestImage[]; global?: { formato?: string } };
      };
      setJobs((data.jobs ?? []).filter((j) => j.type === "image"));
      const mapa: Record<string, string> = {};
      const refs: Record<string, string | undefined> = {};
      for (const img of data.manifest?.images ?? []) {
        mapa[img.id] = img.prompt;
        refs[img.id] = img.ref_image_id;
      }
      setPrompts(mapa);
      setRefImageIds(refs);
      /*
        El formato del proyecto GENERADO, que no es necesariamente el que dice el
        selector: si ya generaste en 16:9 y despues moviste el selector a 9:16, las
        miniaturas de lo que ya existe tienen que seguir mostrandose en 16:9.
      */
      const fmt = data.manifest?.global?.formato;
      if (fmt) setFormatoGenerado(fmt);
    } catch {
      // Un fallo de red puntual no tiene que romper la pantalla: el proximo tick
      // reintenta solo.
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    void traerEstado(projectId);
    pollRef.current = setInterval(() => void traerEstado(projectId), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [projectId, traerEstado]);

  // Cuando no queda nada en curso, se corta el polling: esta pantalla puede quedar
  // abierta horas y no tiene sentido pegarle a la API cada 3s sin nada que mirar.
  const hayEnCurso = jobs.some((j) => EN_CURSO.has(j.status));
  useEffect(() => {
    if (!hayEnCurso && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [hayEnCurso]);

  /** Prende el intervalo si estaba apagado. Nunca monta un segundo. */
  const relanzarPolling = useCallback(
    (id: string) => {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => void traerEstado(id), POLL_MS);
      }
    },
    [traerEstado],
  );

  // Al cambiar de proyecto, el hilo activo vuelve al primero: el indice viejo podria
  // no existir en la tanda nueva.
  useEffect(() => {
    setHiloActivo(0);
    setModoVista("grilla");
    setPromptAbierto(false);
  }, [projectId]);

  // ─── Acciones ─────────────────────────────────────────────────────────────

  /**
   * Crea la tanda. Recibe el FormData/JSON ya armado por `NuevaTanda` (que sigue
   * siendo la unica que sabe la forma exacta del payload) y hace EXACTAMENTE el
   * mismo POST /api/imagenes que hacia el formulario viejo.
   */
  async function generar(payload: FormData | Record<string, unknown>) {
    setEnviando(true);
    try {
      const res =
        payload instanceof FormData
          ? await fetch("/api/imagenes", { method: "POST", body: payload })
          : await fetch("/api/imagenes", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
      const data = (await res.json().catch(() => ({}))) as {
        project?: { id: string };
        error?: string;
      };
      if (!res.ok || !data.project) {
        return { ok: false as const, error: data.error ?? `Error ${res.status}` };
      }
      setJobs([]);
      // El nuevo pasa a ser el abierto, pero los anteriores NO se pierden: quedan en
      // la lista del sidebar, que se recarga acá mismo.
      abrirProyecto(data.project.id);
      void cargarLista();
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Error de red",
      };
    } finally {
      setEnviando(false);
    }
  }

  /** Elegir cual de las variantes queda como la imagen definitiva. */
  async function elegir(job: Job, index: number) {
    setOcupado((o) => ({ ...o, [job.id]: true }));
    try {
      await fetch(`/api/jobs/${job.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      if (projectId) await traerEstado(projectId);
    } finally {
      setOcupado((o) => ({ ...o, [job.id]: false }));
    }
  }

  /**
   * Variar: regenera las variantes de UNA imagen, con el prompt editado si se toco.
   * Es la ruta que ya usa el flujo de brief, asi que el cambio queda persistido en el
   * plan del proyecto y no solo en la pantalla.
   */
  async function variar(job: Job) {
    setOcupado((o) => ({ ...o, [job.id]: true }));
    try {
      const nuevo = editando[job.refId];
      await fetch(`/api/jobs/${job.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: (nuevo ?? prompts[job.refId] ?? "").trim() || undefined,
          regenerate: true,
        }),
      });
      setEditando((ed) => {
        const { [job.refId]: _, ...resto } = ed;
        return resto;
      });
      if (projectId) {
        await traerEstado(projectId);
        // El job vuelve a "generating": se relanza el polling si estaba parado.
        relanzarPolling(projectId);
      }
    } finally {
      setOcupado((o) => ({ ...o, [job.id]: false }));
    }
  }

  /**
   * Aprueba de una todas las que estan esperando decisión. Es lo que DESTRABA la cola
   * cuando el gate por lotes la frenó (ver el aviso mas abajo y P-01 del plan).
   *
   * Usa el MISMO endpoint y el MISMO payload que `elegir`, una vez por job: es
   * exactamente lo que pasaria si el usuario clickeara cada tarjeta a mano.
   */
  async function aprobarLote(pendientes: Job[]) {
    setAprobandoLote(true);
    try {
      for (const job of pendientes) {
        const index = job.selectedIndex ?? job.candidates[0]?.index;
        if (index === undefined) continue;
        await fetch(`/api/jobs/${job.id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index }),
        });
      }
      if (projectId) {
        await traerEstado(projectId);
        relanzarPolling(projectId);
      }
    } finally {
      setAprobandoLote(false);
    }
  }

  /**
   * Manda un turno del chat iterativo: la imagen `fromImageId` (ya aprobada) mas el
   * texto escrito se convierten en una imagen NUEVA (`POST /api/projects/:id/images`,
   * ver ese endpoint para el porque de una imagen nueva y no un `changePrompt`). No
   * hay optimismo local: se limpia el input recien cuando el server confirma, asi que
   * si el pedido falla el texto queda ahi para reintentar sin volver a escribirlo.
   */
  async function enviarTurnoChat(fromImageId: string) {
    if (!projectId) return;
    const prompt = (chatTexto[fromImageId] ?? "").trim();
    if (!prompt) return;
    setChatEnviando((e) => ({ ...e, [fromImageId]: true }));
    setChatError((e) => ({ ...e, [fromImageId]: null }));
    try {
      const res = await fetch(`/api/projects/${projectId}/images`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromImageId, prompt }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        created?: boolean;
        error?: string;
      };
      if (!res.ok || !data.created) {
        setChatError((e) => ({ ...e, [fromImageId]: data.error ?? `Error ${res.status}` }));
        return;
      }
      setChatTexto((t) => ({ ...t, [fromImageId]: "" }));
      await traerEstado(projectId);
      relanzarPolling(projectId);
    } catch (err) {
      setChatError((e) => ({
        ...e,
        [fromImageId]: err instanceof Error ? err.message : "Error de red",
      }));
    } finally {
      setChatEnviando((e) => ({ ...e, [fromImageId]: false }));
    }
  }

  // ─── Derivados de la vista ────────────────────────────────────────────────
  // Se leen del TONO que devuelve `estadoDeJob`, no de los strings de status, asi que
  // esta pantalla no repite el mapeo de estados (§6.1 del plan) y no imprime ni
  // compara los nombres internos.
  const tono = (j: Job) => estadoDeJob(j.status).tone;

  /**
   * Agrupa los jobs de imagen en HILOS de chat: cada hilo es la cadena completa
   * v1 -> v2 -> v3 de una misma imagen base, ordenada de mas vieja a mas nueva.
   * (Misma lógica que antes del rediseño; ver el comentario largo del archivo viejo
   * para el detalle de por que se sigue `ref_image_id` y no un sufijo del id.)
   */
  const hilos = useMemo(() => {
    const byId = new Map(jobs.map((j) => [j.refId, j]));
    const children = new Map<string, Job[]>();
    for (const job of jobs) {
      const ref = refImageIds[job.refId];
      if (!ref || !byId.has(ref)) continue;
      children.set(ref, [...(children.get(ref) ?? []), job]);
    }
    const raices = jobs.filter((j) => {
      const ref = refImageIds[j.refId];
      return !ref || !byId.has(ref);
    });
    return raices.map((raiz) => {
      const cadena: Job[] = [raiz];
      let actual = raiz;
      for (let i = 0; i < 200; i++) {
        const hijos = children.get(actual.refId);
        if (!hijos || hijos.length === 0) break;
        const siguiente = hijos.reduce((a, b) =>
          (b.updatedAt ?? "") > (a.updatedAt ?? "") ? b : a,
        );
        cadena.push(siguiente);
        actual = siguiente;
      }
      return cadena;
    });
  }, [jobs, refImageIds]);

  // El hilo activo, acotado a un indice valido (la cadena pudo encogerse al cambiar
  // de proyecto, o crecer al llegar un turno nuevo del polling).
  const indiceHiloValido = Math.min(hiloActivo, Math.max(hilos.length - 1, 0));
  const cadenaActiva: Job[] = hilos[indiceHiloValido] ?? [];
  // El job "cabeza" de la cadena activa: la ultima imagen, que es la que se muestra
  // en la grilla/visor y desde la que sigue el chat.
  const jobActivo: Job | undefined = cadenaActiva[cadenaActiva.length - 1];

  const listas = jobs.filter((j) => tono(j) === "ok").length;
  const esperandoDecision = jobs.filter((j) => tono(j) === "attention");
  const generando = jobs.some((j) => estadoDeJob(j.status).animado);
  const frenados = jobs.filter(
    (j) => EN_CURSO.has(j.status) && !estadoDeJob(j.status).animado,
  ).length;

  /**
   * ─── EL AVISO DEL GATE POR LOTES (§5 de T06, P-01 del plan) ────────────────
   * (sin cambios de lógica, ver el archivo viejo para el detalle completo)
   */
  const gateFrenado =
    esperandoDecision.length > 0 && frenados > 0 && !generando && !aprobandoLote;

  // Proyecto abierto, para el header de resultados.
  const proyectoAbierto = lista.find((p) => p.id === projectId);
  const formato = formatoGenerado ?? "9:16";

  // ─── Teclado: flechas cambian de variante, Enter abre el lightbox, Esc cierra ──
  useEffect(() => {
    if (vista !== "galeria" || !jobActivo) return;
    const candidatas = jobActivo.candidates;
    if (candidatas.length === 0) return;

    function indiceSeleccionado() {
      const i = candidatas.findIndex((c) => c.index === jobActivo!.selectedIndex);
      return i >= 0 ? i : 0;
    }

    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "textarea" || tag === "input") return;

      if (lightbox !== null) {
        if (e.key === "Escape") {
          e.preventDefault();
          setLightbox(null);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          setLightbox((i) => (i === null ? 0 : (i + 1) % candidatas.length));
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          setLightbox((i) =>
            i === null ? 0 : (i + candidatas.length - 1) % candidatas.length,
          );
        } else if (e.key === "Enter") {
          e.preventDefault();
          const elegida = candidatas[lightbox];
          if (elegida) void elegir(jobActivo!, elegida.index);
        }
        return;
      }

      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const actual = indiceSeleccionado();
        const paso = e.key === "ArrowRight" ? 1 : -1;
        const siguiente = candidatas[(actual + paso + candidatas.length) % candidatas.length];
        if (siguiente) void elegir(jobActivo!, siguiente.index);
      } else if (e.key === "Enter") {
        e.preventDefault();
        setLightbox(indiceSeleccionado());
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vista, jobActivo, lightbox]);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (vista === "nueva") {
    return (
      <>
        <aside className="flex min-h-0 flex-col border-r border-divider">
          <CabeceraSidebar
            tab={tab}
            onCambiarTab={onCambiarTab}
            onNuevaTanda={() => setVista("nueva")}
            labelNueva="Nueva tanda"
          />
        </aside>
        <NuevaTanda
          modelos={opcionesModelo}
          modeloDefault={modeloDefault}
          enviando={enviando}
          onGenerar={generar}
          onCancelar={() => setVista("galeria")}
        />
      </>
    );
  }

  return (
    <>
      {/* ─── Sidebar: segmented + Nueva tanda + lista de tandas ────────────── */}
      <aside className="flex min-h-0 flex-col border-r border-divider">
        <CabeceraSidebar
          tab={tab}
          onCambiarTab={onCambiarTab}
          onNuevaTanda={() => setVista("nueva")}
          labelNueva="Nueva tanda"
        />
        <div className="flex items-baseline justify-between px-4 pb-2">
          <span className="text-label font-medium text-fg-dim">
            Tandas{" "}
            {lista.length > 0 && (
              <span className="code tnum font-normal">{lista.length}</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => void cargarLista()}
            className="text-label text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ArrowsClockwise aria-hidden className="size-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {cargandoLista && lista.length === 0 ? (
            <div className="flex flex-col gap-2 px-2">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="h-14 animate-pulse rounded-md bg-surface-hi" />
              ))}
            </div>
          ) : lista.length === 0 ? (
            <p className="px-2 text-label text-fg-dim">
              Todavía no generaste ninguna. Las que generes van a quedar acá.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {lista.map((p) => {
                const abierto = p.id === projectId;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => abrirProyecto(p.id)}
                      aria-current={abierto ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md border p-2 text-left transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        abierto
                          ? "border-accent bg-accent/10"
                          : "border-transparent hover:bg-surface",
                      )}
                    >
                      {/*
                        Miniatura 28x40 (proporcion 9:16 aproximada): placeholder con
                        rayas, sin pedir la imagen real acá. La lista puede tener
                        decenas de tandas y esta pantalla ya hace polling; pedir la
                        miniatura de cada una multiplicaria los requests sin necesidad,
                        el dato que importa (nombre + meta) ya esta en la respuesta de
                        /api/projects.
                      */}
                      <span
                        aria-hidden
                        className="block h-10 w-7 shrink-0 rounded-sm bg-surface-hi"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body font-medium text-fg">
                          {p.name}
                        </span>
                        <span className="code truncate text-label text-fg-dim">
                          {p.imageCount} {p.imageCount === 1 ? "img" : "img"} ·{" "}
                          {estadoDeJob(p.status).label}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* ─── Resultados de la tanda abierta ────────────────────────────────── */}
      <main className="flex min-h-0 flex-col">
        {!projectId ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            {/*
              DOS VACIOS DISTINTOS, y antes los dos decian lo mismo. Con tandas en
              el sidebar y ninguna abierta, el centro decia "Todavía no generaste
              nada" mientras la izquierda listaba las tandas: se contradecian en la
              misma pantalla. El de abajo solo aparece cuando la lista esta de
              verdad vacia; si hay tandas, el efecto de mas abajo abre la primera y
              este bloque no se ve nunca.
            */}
            {lista.length === 0 ? (
              <EmptyState
                icon={<ImageSquare aria-hidden className="size-6" />}
                title="Todavía no generaste nada"
                body="Abrí 'Nueva tanda' para escribir el prompt, elegir formato, calidad y cuántas variantes querés."
                action={{ label: "Nueva tanda", onClick: () => setVista("nueva") }}
              />
            ) : (
              <EmptyState
                icon={<ImageSquare aria-hidden className="size-6" />}
                title="Elegí una tanda"
                body="Tocá una de la lista de la izquierda para ver sus variantes, o armá una nueva."
                action={{ label: "Nueva tanda", onClick: () => setVista("nueva") }}
              />
            )}
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-6">
            <p className="text-body text-fg-dim">Encolando…</p>
            <SkeletonGrid items={4} />
          </div>
        ) : (
          <>
            {/* Header de resultados */}
            <div className="flex flex-none flex-wrap items-center gap-3 p-4 pb-3">
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1
                  className="code min-w-0 max-w-full truncate text-display font-semibold text-fg"
                  title={proyectoAbierto?.name}
                >
                  {proyectoAbierto?.name ?? "Tanda"}
                </h1>
                <Badge tone={estadoDeJob(proyectoAbierto?.status ?? "").tone} punto>
                  {estadoDeJob(proyectoAbierto?.status ?? "").label}
                </Badge>
                {/*
                  `attempts > 1` es la unica señal de que hubo un 429 y la cola
                  reintento (mismo criterio que la pantalla vieja). Se muestra acá,
                  al lado del estado, para no perderla del todo en el rediseño.
                */}
                {jobActivo && jobActivo.attempts > 1 && (
                  <Badge tone="neutral">
                    <ArrowsClockwise aria-hidden className="size-3 shrink-0" />
                    intento <span className="tnum">{jobActivo.attempts}</span>
                  </Badge>
                )}
                <span className="code text-label text-fg-dim">
                  {formato}
                  {jobActivo ? ` · ${jobActivo.variants} variantes` : ""}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={promptAbierto ? "secondary" : "ghost"}
                  onClick={() => setPromptAbierto((v) => !v)}
                  icon={<TextAlignLeft aria-hidden className="size-3.5" />}
                >
                  Prompt
                  {/* Hay una edicion sin aplicar: se ve aunque el bloque este colapsado. */}
                  {jobActivo && editando[jobActivo.refId] !== undefined && (
                    <Badge tone="attention">editado</Badge>
                  )}
                </Button>
                {jobActivo && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={Boolean(ocupado[jobActivo.id])}
                    onClick={() => void variar(jobActivo)}
                    icon={<ArrowsClockwise aria-hidden className="size-3.5" />}
                  >
                    Variar
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  asChild
                  icon={<DownloadSimple aria-hidden className="size-3.5" />}
                >
                  <a href={`/api/projects/${projectId}/download?que=imagenes`}>
                    Descargar (zip)
                  </a>
                </Button>
                <Segmented
                  etiqueta="Vista de la galería"
                  tamanio="sm"
                  value={modoVista}
                  onChange={setModoVista}
                  options={[
                    {
                      value: "grilla",
                      label: <SquaresFour aria-hidden className="size-4" />,
                      titulo: "Grilla",
                    },
                    {
                      value: "visor",
                      label: <Rectangle aria-hidden className="size-4" />,
                      titulo: "Visor",
                    },
                  ]}
                />
              </div>
            </div>

            {/* Hilo: pastillas v1 -> v2 -> ... por cadena de chat */}
            {hilos.length > 0 && (
              <div className="flex flex-none flex-wrap items-center gap-1.5 px-4 pb-3">
                <span className="text-label text-fg-dim">Hilo</span>
                {hilos.map((cadena, i) => {
                  const activo = i === indiceHiloValido;
                  return (
                    <button
                      key={cadena[0].id}
                      type="button"
                      onClick={() => setHiloActivo(i)}
                      className={cn(
                        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-label transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        activo
                          ? "border-border bg-surface-hi text-fg"
                          : "border-divider bg-transparent text-fg-dim hover:text-fg",
                      )}
                    >
                      <span className="code tnum">{i + 1}</span>
                      {cadena[0].refId}
                    </button>
                  );
                })}
              </div>
            )}

            {/*
              Bloque de prompt, colapsable y EDITABLE. El spec del handoff lo muestra
              como un bloque mono de solo lectura, pero convertirlo en read-only real
              hubiera perdido la unica forma que tenia la pantalla vieja de editar el
              prompt antes de "Variar" (el `editando` separado de `prompts`, punto 2
              del comentario del encabezado): sin un campo para escribir, `editando`
              nunca se puebla y el boton "Variar" del header pasa a repetir siempre
              el mismo prompt. Es una textarea en vez de un <p> para no perder esa
              funcionalidad — el look sigue siendo "un bloque mono debajo del toggle
              Prompt", que es lo que pide el spec.
            */}
            {promptAbierto && jobActivo && (
              <div className="mx-4 mb-3 flex-none">
                <Textarea
                  label={`Prompt de ${jobActivo.refId}`}
                  labelOculto
                  mono
                  rows={4}
                  spellCheck={false}
                  value={editando[jobActivo.refId] ?? prompts[jobActivo.refId] ?? ""}
                  onChange={(e) =>
                    setEditando((ed) => ({ ...ed, [jobActivo.refId]: e.target.value }))
                  }
                  hint={
                    editando[jobActivo.refId] !== undefined
                      ? "Editado: se usa este texto la próxima vez que apretés Variar."
                      : undefined
                  }
                />
              </div>
            )}

            {/*
              La nota de `job.error`. Puede estar poblada en un job que NO falló: el
              pipeline la usa tambien como nota informativa ("salieron 1/2 variantes",
              ver el punto 3 del comentario del encabezado). El tinte sale del TONO
              DEL ESTADO y no de que haya texto: mostrarla siempre en rojo era el bug
              de percepcion mas grande de la pantalla vieja, una tanda perfectamente
              aprobable parecia rota.
            */}
            {jobActivo?.error && (
              <div className="mx-4 mb-3 flex-none">
                <p
                  title={jobActivo.error}
                  className={cn(
                    "flex items-start gap-1.5 rounded-sm p-1.5 text-label",
                    estadoDeJob(jobActivo.status).tone === "danger"
                      ? "bg-danger/10 text-danger"
                      : "bg-surface-hi text-fg-dim",
                  )}
                >
                  {estadoDeJob(jobActivo.status).tone === "danger" ? (
                    <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
                  ) : (
                    <ImageSquare aria-hidden className="mt-px size-3.5 shrink-0" />
                  )}
                  <span className="line-clamp-2">{jobActivo.error}</span>
                </p>
              </div>
            )}

            {/* Aviso del gate por lotes */}
            <div aria-live="polite" className="flex-none px-4">
              {gateFrenado && (
                <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-accent/10 px-3 py-2.5">
                  <CursorClick aria-hidden className="size-5 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-medium text-fg">
                      <span className="code tnum">
                        {esperandoDecision.length} de {jobs.length}
                      </span>{" "}
                      listas. Aprobá para que siga el resto.
                    </p>
                    <p className="text-label text-fg-dim">
                      La cola se frena cuando se junta un lote sin aprobar: no está
                      colgada, te espera.{" "}
                      <span className="code tnum">{frenados}</span> sin arrancar.
                    </p>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={aprobandoLote}
                    onClick={() => void aprobarLote(esperandoDecision)}
                    icon={<Check aria-hidden className="size-3.5" />}
                    title="Aprueba las que están esperando con la variante que elegiste, o con la primera si todavía no elegiste ninguna."
                  >
                    Aprobar las {esperandoDecision.length}
                  </Button>
                </div>
              )}
            </div>

            {/* Grilla o visor, al alto completo */}
            {jobActivo && jobActivo.candidates.length > 0 ? (
              modoVista === "grilla" ? (
                <GrillaVariantes
                  job={jobActivo}
                  projectId={projectId}
                  formato={formato}
                  onElegir={(index) => void elegir(jobActivo, index)}
                  onAmpliar={(i) => setLightbox(i)}
                />
              ) : (
                <VisorVariantes
                  job={jobActivo}
                  projectId={projectId}
                  formato={formato}
                  onElegir={(index) => void elegir(jobActivo, index)}
                  onAmpliar={(i) => setLightbox(i)}
                />
              )
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <EstadoSinCandidatas job={jobActivo} />
              </div>
            )}

            {/* Chat de cambios, FIJO abajo */}
            <ChatDeCambios
              job={jobActivo}
              texto={jobActivo ? chatTexto[jobActivo.refId] ?? "" : ""}
              enviando={jobActivo ? Boolean(chatEnviando[jobActivo.refId]) : false}
              error={jobActivo ? chatError[jobActivo.refId] ?? null : null}
              onTexto={(v) => jobActivo && setChatTexto((t) => ({ ...t, [jobActivo.refId]: v }))}
              onEnviar={() => jobActivo && void enviarTurnoChat(jobActivo.refId)}
            />
          </>
        )}
      </main>

      {/* ─── Lightbox ───────────────────────────────────────────────────────── */}
      {lightbox !== null && jobActivo && projectId && (
        <Lightbox
          job={jobActivo}
          projectId={projectId}
          indice={lightbox}
          onCerrar={() => setLightbox(null)}
          onNavegar={setLightbox}
          onElegir={(index) => void elegir(jobActivo, index)}
        />
      )}
    </>
  );
}

/** Cache-busting: los candidatos se escriben siempre en el mismo path. */
function urlDe(projectId: string, job: Job, file: string) {
  const ver = encodeURIComponent(job.updatedAt ?? "");
  return `/api/files/${projectId}/${file}?v=${ver}`;
}

function labelVariante(c: Candidate, index: number): string {
  if (c.promptLabel) {
    const modelo = c.model?.includes("pro") ? "Pro" : c.model ? "Flash" : undefined;
    return modelo ? `${c.promptLabel} · ${modelo}` : c.promptLabel;
  }
  return `v${index + 1}`;
}

/**
 * La grilla: las N variantes en UNA fila al alto completo.
 *
 * `cq-size` (definida en globals.css por otra pantalla del rediseño — layout.tsx y
 * globals.css son intocables por esta task, pero `container-type: size` es CSS
 * estandar y se puede aplicar igual por `style` inline si la clase no existiera
 * todavia: así este archivo no depende de que otro agente haya terminado su parte).
 */
function GrillaVariantes({
  job,
  projectId,
  formato,
  onElegir,
  onAmpliar,
}: {
  job: Job;
  projectId: string;
  formato: string;
  onElegir: (index: number) => void;
  onAmpliar: (i: number) => void;
}) {
  const n = job.candidates.length;
  const gaps = 16 * (n - 1) + 32; // gap entre tarjetas + padding lateral aproximado
  return (
    <div
      style={{ containerType: "size" }}
      className="min-h-0 flex-1 overflow-hidden px-4 pb-4"
    >
      <div className="flex h-full items-start gap-4">
        {job.candidates.map((c, i) => {
          const elegida = job.selectedIndex === c.index;
          const url = urlDe(projectId, job, c.file);
          return (
            <button
              key={c.index}
              type="button"
              onClick={() => onElegir(c.index)}
              aria-pressed={elegida}
              aria-label={`Elegir la variante ${i + 1} de ${job.refId}`}
              style={{
                width: `min(calc((100cqw - ${gaps}px) / ${n}), calc(100cqh * 0.5625))`,
                aspectRatio: "9 / 16",
              }}
              className={cn(
                "group relative shrink-0 overflow-hidden rounded-lg border-2 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                elegida ? "border-accent" : "border-divider hover:border-border",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={url}
                src={url}
                alt={`Variante ${i + 1} de ${job.refId}`}
                loading="lazy"
                decoding="async"
                className="size-full bg-bg object-cover"
              />

              {/* Ampliar / descargar, en hover arriba a la derecha */}
              <span className="absolute right-2 top-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Ver la variante ${i + 1} en grande`}
                  title="Ver en grande"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAmpliar(i);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onAmpliar(i);
                    }
                  }}
                  className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md bg-bg/85 text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <ArrowsOut aria-hidden className="size-4" />
                </span>
                <a
                  href={`${url}&dl=1&name=${encodeURIComponent(`${job.refId}_v${i + 1}.png`)}`}
                  download
                  aria-label={`Descargar la variante ${i + 1}`}
                  title="Descargar esta imagen"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex size-8 items-center justify-center rounded-md bg-bg/85 text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <DownloadSimple aria-hidden className="size-4" />
                </a>
              </span>

              {/* Degradado + label + check */}
              <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-bg/85 to-transparent px-2.5 pb-2.5 pt-6">
                <span className="code min-w-0 truncate whitespace-nowrap text-label text-fg">
                  {labelVariante(c, i)}
                </span>
                {elegida && (
                  <span
                    title="Elegida"
                    className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-sm bg-accent text-on-accent"
                  >
                    <Check aria-hidden className="size-3.5" />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * El visor: tira vertical de miniaturas de 64px a la izquierda y la elegida en
 * grande. Click en la grande abre el lightbox.
 */
function VisorVariantes({
  job,
  projectId,
  formato,
  onElegir,
  onAmpliar,
}: {
  job: Job;
  projectId: string;
  formato: string;
  onElegir: (index: number) => void;
  onAmpliar: (i: number) => void;
}) {
  const seleccionIndex = job.candidates.findIndex((c) => c.index === job.selectedIndex);
  const activo = seleccionIndex >= 0 ? seleccionIndex : 0;
  const c = job.candidates[activo];
  const url = urlDe(projectId, job, c.file);

  return (
    <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4">
      <div className="flex w-16 shrink-0 flex-col gap-2 overflow-y-auto">
        {job.candidates.map((cand, i) => {
          const elegida = job.selectedIndex === cand.index;
          const activa = i === activo;
          const miniUrl = urlDe(projectId, job, cand.file);
          return (
            <button
              key={cand.index}
              type="button"
              onClick={() => onElegir(cand.index)}
              aria-label={`Ver variante ${i + 1}`}
              style={{ aspectRatio: "9 / 16" }}
              className={cn(
                "relative w-16 shrink-0 overflow-hidden rounded-md border-2 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                activa ? "border-border" : elegida ? "border-accent" : "border-divider",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={miniUrl}
                alt={`Miniatura variante ${i + 1}`}
                loading="lazy"
                className="size-full object-cover"
              />
              <span className="code absolute bottom-0.5 left-1 text-label text-fg">
                v{i + 1}
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ containerType: "size" }} className="min-h-0 min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onAmpliar(activo)}
          style={{
            height: "min(100cqh, calc(100cqw * 1.7778))",
            aspectRatio: "9 / 16",
          }}
          className="group relative cursor-zoom-in overflow-hidden rounded-lg border-2 border-accent"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={url}
            src={url}
            alt={`Variante ${activo + 1} de ${job.refId}`}
            className="size-full bg-bg object-cover"
          />
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-bg/85 to-transparent px-3 pb-3 pt-6">
            <span className="code min-w-0 truncate text-label text-fg">
              {labelVariante(c, activo)}
            </span>
            <span
              title="Elegida"
              className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-sm bg-accent text-on-accent"
            >
              <Check aria-hidden className="size-3.5" />
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

/** El job activo esta generando, en cola, o fallo sin ninguna candidata. */
function EstadoSinCandidatas({ job }: { job: Job | undefined }) {
  if (!job) return null;
  const estado = estadoDeJob(job.status);
  const fallo = estado.tone === "danger";
  return (
    <span
      className={cn(
        "flex flex-col items-center gap-1.5 text-center text-body",
        fallo ? "text-danger" : "text-fg-dim",
      )}
    >
      {estado.animado ? (
        <>
          <ArrowsClockwise aria-hidden className="size-6 motion-safe:animate-spin" />
          generando…
        </>
      ) : fallo ? (
        <>
          <WarningCircle aria-hidden className="size-6" />
          no salió ninguna variante
        </>
      ) : (
        <>
          <ImageIcon aria-hidden className="size-6" />
          en cola…
        </>
      )}
    </span>
  );
}

/** Lightbox: fixed inset-0, imagen al 100% del alto, flechas de 44px. */
function Lightbox({
  job,
  projectId,
  indice,
  onCerrar,
  onNavegar,
  onElegir,
}: {
  job: Job;
  projectId: string;
  indice: number;
  onCerrar: () => void;
  onNavegar: (i: number) => void;
  onElegir: (index: number) => void;
}) {
  const n = job.candidates.length;
  const c = job.candidates[indice];
  if (!c) return null;
  const url = urlDe(projectId, job, c.file);
  const yaElegida = job.selectedIndex === c.index;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Vista ampliada de ${job.refId}`}
      className="fixed inset-0 z-50 flex flex-col bg-bg/[.94]"
    >
      <div className="flex h-14 flex-none items-center gap-3 px-4">
        <span className="code text-body">
          {job.refId} · {labelVariante(c, indice)}
        </span>
        <span className="code text-label text-fg-dim">
          {indice + 1} / {n}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="primary"
          onClick={() => onElegir(c.index)}
          icon={<Check aria-hidden className="size-3.5" />}
        >
          {yaElegida ? "Elegida" : "Elegir esta"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          asChild
          icon={<DownloadSimple aria-hidden className="size-3.5" />}
        >
          <a
            href={`${url}&dl=1&name=${encodeURIComponent(`${job.refId}_v${indice + 1}.png`)}`}
            download
          >
            Descargar
          </a>
        </Button>
        <button
          type="button"
          onClick={onCerrar}
          title="Cerrar (Esc)"
          aria-label="Cerrar"
          className="inline-flex size-8 items-center justify-center rounded-md bg-surface-hi text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center gap-4 px-4 pb-6">
        <button
          type="button"
          onClick={() => onNavegar((indice + n - 1) % n)}
          title="Anterior (←)"
          aria-label="Variante anterior"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-hi text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <CaretLeft aria-hidden className="size-5" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`Variante ${indice + 1} de ${job.refId}`}
          className="h-full max-w-[calc(100vw-152px)] rounded-lg object-contain"
        />
        <button
          type="button"
          onClick={() => onNavegar((indice + 1) % n)}
          title="Siguiente (→)"
          aria-label="Siguiente variante"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-hi text-fg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <CaretRight aria-hidden className="size-5" />
        </button>
      </div>
    </div>
  );
}

/**
 * Chat de cambios, fijo abajo del todo (afuera del scroll de la grilla/visor). Solo
 * se habilita cuando el job activo esta aprobado (`outputPath` presente): pedir un
 * turno nuevo contra algo que todavia no tiene archivo en disco es exactamente el
 * 400 que devuelve el endpoint.
 */
function ChatDeCambios({
  job,
  texto,
  enviando,
  error,
  onTexto,
  onEnviar,
}: {
  job: Job | undefined;
  texto: string;
  enviando: boolean;
  error: string | null;
  onTexto: (v: string) => void;
  onEnviar: () => void;
}) {
  const aprobada = Boolean(job?.outputPath) && job?.status === "done";
  return (
    <div className="flex-none p-4 pt-0">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (aprobada) onEnviar();
        }}
        className="flex items-end gap-2 rounded-lg border border-divider bg-surface p-2"
      >
        <div className="flex-1">
          <Textarea
            label="Pedir un cambio sobre la imagen elegida"
            labelOculto
            rows={1}
            value={texto}
            disabled={!aprobada}
            onChange={(e) => onTexto(e.target.value)}
            placeholder="Ej: cambiá el fondo a un living luminoso, mantené la pose"
            className="min-h-9 resize-none border-0 bg-transparent focus-visible:ring-0"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (aprobada) onEnviar();
              }
            }}
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="md"
          loading={enviando}
          disabled={!aprobada || !texto.trim()}
          icon={<MagicWand aria-hidden className="size-4" />}
        >
          Modificar
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-label text-danger">
          <WarningCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      )}
      <p className="mt-1.5 text-label text-fg-dim">
        {aprobada ? (
          <>
            Crea una imagen nueva a partir de{" "}
            <span className="code text-fg">{job?.refId}</span> — la anterior queda en
            el hilo, no se reemplaza.
          </>
        ) : (
          <>Elegí una variante para poder pedir un cambio desde ahí.</>
        )}
      </p>
    </div>
  );
}
