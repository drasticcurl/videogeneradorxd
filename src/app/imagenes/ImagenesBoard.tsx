"use client";

/**
 * Tablero de solo imagenes: se pegan prompts, se generan con N variantes, se elige
 * la que queda y se puede variar cualquiera sin tocar las demas.
 *
 * Reusa el pipeline normal: crea un proyecto con `clips: []` (ver
 * /api/imagenes/route.ts) y despues habla con las MISMAS rutas que el flujo de brief
 * (`/jobs` para el polling, `/jobs/:id/approve` para elegir variante,
 * `/jobs/:id/prompt` para regenerar). No hay lógica de generación duplicada acá.
 *
 * ─── TRES COSAS QUE NO SE TOCAN (§2 de T06) ──────────────────────────────────
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
 * Rediseño VISUAL: no cambia ni un endpoint, ni un payload, ni una regla.
 */

import {
  ArrowsClockwise,
  ArrowsOut,
  Check,
  CursorClick,
  DownloadSimple,
  ImageSquare,
  Info,
  Sparkle,
  Spinner,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Select,
  SkeletonGrid,
  Textarea,
  type SelectOption,
} from "@/components/ui";
import { Visor } from "@/components/Visor";
import { cn } from "@/lib/cn";
import type { ModelOption } from "@/lib/config";
/*
  De `@/lib/formatos` y NO de `@/lib/config`: config importa `node:path` y lee
  AUTH_SECRET y PASSWORD_*, asi que no puede entrar al bundle del cliente. `ModelOption`
  sigue viniendo de config porque es solo un tipo y se borra al compilar.
*/
import { IMAGE_ASPECT_RATIOS, IMAGE_SIZES, imageSizesFor } from "@/lib/formatos";
import { estadoDeJob } from "@/lib/ui-tokens";

interface Candidate {
  index: number;
  file: string;
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

const VARIANTES: ReadonlyArray<SelectOption<string>> = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: String(n),
}));

/**
 * La forma del formato, dibujada a escala.
 *
 * Es un `div` con las proporciones reales y no un icono de una fuente: la pregunta
 * que contesta es "¿esto es vertical u horizontal?", y para eso el rectangulo tiene
 * que tener LA proporcion, no una aproximada. Sale gratis y no agrega dependencias.
 *
 * `border-current` a proposito: el color lo hereda del texto del padre, asi que
 * cuando el boton queda elegido y cambia de color, la forma lo sigue sola. Sin esto
 * habria que pasarle el estado por prop.
 */
function Forma({ w, h }: { w: number; h: number }) {
  const MAX = 24;
  const escala = MAX / Math.max(w, h);
  return (
    <span
      aria-hidden
      style={{ width: Math.round(w * escala), height: Math.round(h * escala) }}
      className="block shrink-0 rounded-[2px] border-2 border-current"
    />
  );
}

/**
 * Selector de formato: los 10 que acepta Vertex, agrupados por orientacion.
 *
 * Son `<input type="radio">` de verdad (escondidos con sr-only y estilados por
 * `peer-checked`) y no botones con role="radio": el radio nativo trae la navegacion
 * con flechas del grupo gratis, y un radiogroup hecho a mano hay que teclearlo a
 * mano. El label envuelve al input, asi que toda la tarjeta es clickeable.
 */
function SelectorFormato({
  valor,
  onChange,
}: {
  valor: string;
  onChange: (v: string) => void;
}) {
  // Para qué sirve el formato elegido, al lado del label: reemplaza los tres titulos
  // de grupo que se sacaron y ocupa cero espacio vertical.
  const elegido = IMAGE_ASPECT_RATIOS.find((f) => f.id === valor);
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-label font-medium text-fg-dim">Formato</span>
        <span className="text-label text-fg-dim">{elegido?.uso}</span>
      </div>
      {/*
        UNA fila que envuelve, no tres bloques con titulo "Vertical / Cuadrado /
        Horizontal" como estaba. Los titulos eran redundantes: la forma dibujada YA dice
        la orientacion, que es justo el motivo por el que se dibuja. Sacarlos bajo el
        selector de tres bloques verticales a uno.

        El orden del catalogo va de vertical a horizontal, asi que la fila queda
        ordenada por proporcion sola y se lee como una escala. El separador marca donde
        cambia la orientacion sin gastar una linea de texto.
      */}
      <div role="radiogroup" aria-label="Formato de la imagen" className="flex flex-wrap items-center gap-1.5">
        {IMAGE_ASPECT_RATIOS.map((f, i) => {
          const anterior = IMAGE_ASPECT_RATIOS[i - 1];
          const cambiaOrientacion = anterior && anterior.orientacion !== f.orientacion;
          return (
            <Fragment key={f.id}>
              {cambiaOrientacion && (
                <span aria-hidden className="h-8 w-px shrink-0 bg-divider" />
              )}
              <label
                className="cursor-pointer"
                title={f.uso ? `${f.id} · ${f.uso}` : f.id}
              >
                <input
                  type="radio"
                  name="formato-imagen"
                  value={f.id}
                  checked={valor === f.id}
                  onChange={() => onChange(f.id)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    "flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-md",
                    "border border-divider bg-surface text-fg-dim transition-colors",
                    "hover:text-fg",
                    "peer-checked:border-accent peer-checked:bg-accent peer-checked:text-on-accent",
                    "peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-accent",
                  )}
                >
                  <Forma w={f.w} h={f.h} />
                  <span className="code text-label">{f.id}</span>
                </span>
              </label>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Selector de calidad. Las que el modelo no soporta quedan DESHABILITADAS y con el
 * motivo al lado, en vez de desaparecer: si se esconden, el usuario que ya vio 4K en
 * otro modelo cree que la app se rompio.
 */
function SelectorCalidad({
  valor,
  onChange,
  permitidas,
}: {
  valor: string;
  onChange: (v: string) => void;
  permitidas: readonly string[];
}) {
  const recortado = permitidas.length < IMAGE_SIZES.length;
  return (
    <div>
      <span className="mb-1 block text-label font-medium text-fg-dim">Calidad</span>
      <div className="flex flex-wrap gap-1.5">
        {IMAGE_SIZES.map((s) => {
          const habilitada = permitidas.includes(s);
          return (
            <label
              key={s}
              className={habilitada ? "cursor-pointer" : "cursor-not-allowed"}
              title={
                habilitada ? undefined : "El modelo elegido no soporta esta calidad"
              }
            >
              <input
                type="radio"
                name="calidad-imagen"
                value={s}
                checked={valor === s}
                disabled={!habilitada}
                onChange={() => onChange(s)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "flex h-9 min-w-[3.25rem] items-center justify-center rounded-md px-3",
                  "border border-divider bg-surface text-body text-fg-dim transition-colors",
                  habilitada ? "hover:text-fg" : "opacity-40",
                  "peer-checked:border-accent peer-checked:bg-accent peer-checked:font-medium peer-checked:text-on-accent",
                  "peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-accent",
                )}
              >
                {s}
              </span>
            </label>
          );
        })}
      </div>
      <p className="mt-1 text-label text-fg-dim">
        {recortado ? (
          <>Este modelo solo genera en 1K. Cambiá de modelo para 2K o 4K.</>
        ) : (
          <>4K tarda bastante más y pesa ~15 MB por imagen.</>
        )}
      </p>
    </div>
  );
}

/**
 * Como va a quedar el nombre del archivo. Es la misma transformación que hace
 * `slugify` en el server (`src/lib/storage.ts`), escrita acá porque ese módulo es de
 * Node y no baja al cliente. Es un PREVIEW, no la fuente de verdad: se mantiene
 * porque saber que `crema manos` sale como `crema_manos_01.png` es información
 * concreta y útil antes de gastar.
 */
function slugPreview(nombre: string): string {
  return (
    (nombre.trim() || "nombre")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "nombre"
  );
}

export default function ImagenesBoard({
  modelos,
  modeloDefault,
}: {
  modelos: ModelOption[];
  modeloDefault: string;
}) {
  const [nombre, setNombre] = useState("");
  const [texto, setTexto] = useState("");
  const [variantes, setVariantes] = useState(2);
  const [modelo, setModelo] = useState(modeloDefault);
  const [formato, setFormato] = useState("9:16");
  const [calidad, setCalidad] = useState("1K");
  const [negativo, setNegativo] = useState("");

  /*
    Las calidades dependen del modelo. Si estabas en 4K y cambias al lite (que solo
    hace 1K), la calidad se baja SOLA: dejarla en 4K mandaria un pedido que el server
    rechaza con 400 y el boton de Generar parecería roto sin explicación.
  */
  const calidadesPermitidas = useMemo(() => imageSizesFor(modelo), [modelo]);
  useEffect(() => {
    if (!calidadesPermitidas.includes(calidad as (typeof calidadesPermitidas)[number])) {
      setCalidad(calidadesPermitidas[0]);
    }
  }, [calidadesPermitidas, calidad]);

  /*
    ─── EL PROYECTO ABIERTO VIVE EN LA URL ─────────────────────────────────────

    Antes era `useState(null)` y eso causaba dos bugs que parecian perdida de datos:

      1. refrescar la pagina mostraba "todavia no generaste nada", porque el id solo
         estaba en memoria de React. El proyecto seguia entero en el disco.
      2. apretar Generar de nuevo hacia setProjectId(nuevo) + setJobs([]) y las
         imagenes anteriores desaparecian de la vista. Tampoco se borraban, pero no
         habia forma de volver a ellas.

    Con el id en `?id=` el refresh lo conserva, el link se puede compartir y el boton
    de atras del browser funciona. Y como abajo hay una lista de los proyectos de
    imagenes, generar uno nuevo ya no tapa nada: los anteriores siguen a un click.
  */
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("id");

  /** Ancla de los resultados, para poder traerlos a la vista al cambiar de tanda. */
  const resultadosRef = useRef<HTMLElement | null>(null);

  const abrirProyecto = useCallback(
    (id: string | null) => {
      router.replace(id ? `/imagenes?id=${encodeURIComponent(id)}` : "/imagenes", {
        scroll: false,
      });
      /*
        `scroll: false` evita el salto brusco al tope que hace el router por defecto,
        pero entonces hay que mover la vista a mano: si no, se elige una tanda y el
        cambio ocurre en una parte de la pagina que no se esta mirando. Eso fue
        exactamente lo que se reporto como "no me deja elegir".

        Se marca la intencion y el scroll lo hace un efecto, DESPUES del commit de
        React. Con un `requestAnimationFrame` acá no alcanzaba: la primera tanda que se
        abre monta la seccion de resultados en este mismo render, asi que el nodo
        todavia no existe y el scroll se perdia en silencio.
      */
      pedirScroll.current = true;
    },
    [router],
  );

  /** Se pidio traer los resultados a la vista al elegir una tanda. */
  const pedirScroll = useRef(false);

  /** Los proyectos de SOLO IMAGENES, para la lista de abajo. */
  const [lista, setLista] = useState<ProyectoImagenes[]>([]);
  const [cargandoLista, setCargandoLista] = useState(true);
  /** Formato con el que se genero lo que se esta viendo (sale del manifest). */
  const [formatoGenerado, setFormatoGenerado] = useState<string | null>(null);
  /** Imagen abierta en el visor grande, o null. */
  const [ampliada, setAmpliada] = useState<{ url: string; titulo: string } | null>(
    null,
  );
  const [jobs, setJobs] = useState<Job[]>([]);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Prompts en edicion, por refId. Separado de `prompts` para no perder lo tipeado
  // cuando llega una respuesta del polling.
  const [editando, setEditando] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState<Record<string, boolean>>({});
  const [aprobandoLote, setAprobandoLote] = useState(false);

  // Para que el boton del estado vacio lleve al campo que hay que llenar.
  const promptsRef = useRef<HTMLTextAreaElement | null>(null);

  /*
    Trae los resultados a la vista cuando se elige una tanda de la lista.
    Corre DESPUES del commit de React, y depende tambien de `jobs.length` para cubrir el
    caso de la primera tanda que se abre: en ese render la seccion de resultados todavia
    no existe, asi que el efecto sale sin hacer nada y reintenta cuando ya monto.
  */
  useEffect(() => {
    if (!pedirScroll.current) return;
    if (!resultadosRef.current) return;
    pedirScroll.current = false;
    // `smooth`: un salto instantaneo no deja ver que la pagina se movio, y ahi no se
    // entiende de donde salio el contenido nuevo.
    resultadosRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [projectId, jobs.length]);

  /*
    Hay UN prompt por proyecto, asi que los saltos de linea son parte del prompt y no
    un separador. Antes esto contaba lineas: un prompt de imagen con encuadre, luz y
    estilo en renglones distintos se convertia en cuatro prompts cortados al medio.
  */
  const tienePrompt = texto.trim().length > 0;

  /**
   * Si el modelo guardado no esta en el catalogo, se agrega como opcion. Con el
   * `<select>` nativo esto no hacia falta (mostraba la primera opcion); con Radix
   * el trigger queda VACIO y sin ningun error si el `value` no matchea ningun item.
   * Mismo resguardo que `ModelSelectorBar`.
   */
  const opcionesModelo = useMemo<ReadonlyArray<SelectOption<string>>>(() => {
    const base = modelos.map((m) => ({ value: m.id, label: m.label, hint: m.id }));
    if (modelo && !base.some((o) => o.value === modelo)) {
      base.push({ value: modelo, label: modelo, hint: "fuera del catálogo actual" });
    }
    return base;
  }, [modelos, modelo]);

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
      for (const img of data.manifest?.images ?? []) mapa[img.id] = img.prompt;
      setPrompts(mapa);
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

  // ─── Acciones ─────────────────────────────────────────────────────────────

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const res = await fetch("/api/imagenes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre,
          prompt: texto,
          variantes,
          model: modelo,
          aspectRatio: formato,
          imageSize: calidad,
          negativePrompt: negativo,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        project?: { id: string };
        error?: string;
        detail?: unknown;
      };
      if (!res.ok || !data.project) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }
      setJobs([]);
      // El nuevo pasa a ser el abierto, pero los anteriores NO se pierden: quedan en
      // la lista de abajo, que se recarga acá mismo.
      abrirProyecto(data.project.id);
      void cargarLista();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red");
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
   * exactamente lo que pasaria si el usuario clickeara cada tarjeta a mano. No hay
   * ruta nueva ni lógica nueva, y respeta la variante que el usuario ya haya elegido
   * (si no eligió ninguna, queda la primera, igual que en el resto de la app).
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

  // ─── Derivados de la vista ────────────────────────────────────────────────
  // Se leen del TONO que devuelve `estadoDeJob`, no de los strings de status: asi esta
  // pantalla no repite el mapeo de estados (§6.1 del plan) y no imprime ni compara los
  // nombres internos. `ok` = terminado, `attention` = espera tu decisión, `animado` =
  // la maquina esta trabajando.
  const tono = (j: Job) => estadoDeJob(j.status).tone;

  const listas = jobs.filter((j) => tono(j) === "ok").length;
  const esperandoDecision = jobs.filter((j) => tono(j) === "attention");
  const generando = jobs.some((j) => estadoDeJob(j.status).animado);
  // Los que la cola todavia no arrancó: en curso pero sin generarse. `EN_CURSO` se
  // mantiene tal cual porque es el mismo criterio con el que se corta el polling.
  const frenados = jobs.filter(
    (j) => EN_CURSO.has(j.status) && !estadoDeJob(j.status).animado,
  ).length;

  /**
   * ─── EL AVISO DEL GATE POR LOTES (§5 de T06, P-01 del plan) ────────────────
   *
   * `PIPELINE_APPROVAL_BATCH=5` frena la cola cuando se juntan 5 jobs del mismo tipo
   * sin aprobar, y esta pantalla crea los proyectos con `autoApprove: false`, asi que
   * con mas de 5 prompts la tanda SE DETIENE a mitad de camino. Es correcto, pero se
   * lee como que se colgó.
   *
   * La condición no repite el 5 (`src/lib/config.ts` es intocable y ese numero no baja
   * al cliente): se deduce de lo observable. Si hay jobs esperando decisión, quedan
   * jobs sin arrancar y NINGUNO se esta generando, la cola esta parada esperandote.
   * Durante la rampa siempre hay alguno generandose, asi que no salta de mas.
   */
  const gateFrenado =
    esperandoDecision.length > 0 && frenados > 0 && !generando && !aprobandoLote;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-5">
      {/* ─── 1. El formulario ─────────────────────────────────────────────── */}
      <form onSubmit={generar}>
        <Card className="flex flex-col gap-4">
          <CardHeader className="mb-0">
            <div>
              <CardTitle>Generar imágenes</CardTitle>
              <CardDescription>
                Un prompt, con las variantes que quieras. El archivo se nombra con el
                nombre del proyecto.
              </CardDescription>
            </div>
          </CardHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Input
                id="nombre"
                label="Nombre del proyecto"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                required
                placeholder="crema manos"
                autoComplete="off"
                // El preview va aparte y no en `hint` porque `hint` es un string y
                // este necesita mono para que se lea como un nombre de archivo.
                aria-describedby="nombre-archivo"
              />
              <p id="nombre-archivo" className="mt-1 text-label text-fg-dim">
                El archivo va a salir como{" "}
                <code className="font-mono text-fg">{slugPreview(nombre)}.png</code>
              </p>
            </div>

            <Select
              label="Modelo"
              value={modelo}
              onValueChange={setModelo}
              options={opcionesModelo}
            />
          </div>

          <Textarea
            ref={promptsRef}
            id="prompts"
            label="Prompt"
            hint="Un prompt por proyecto. Podés usar varios renglones: todo es parte del mismo prompt."
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            required
            rows={8}
            mono
            spellCheck={false}
            placeholder={
              "A woman applying hand cream, close up on dry hands.\nNatural window light, shallow depth of field.\nPhotorealistic, documentary style."
            }
          />

          <SelectorFormato valor={formato} onChange={setFormato} />

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectorCalidad
              valor={calidad}
              onChange={setCalidad}
              permitidas={calidadesPermitidas}
            />
            <Select
              label="Variantes"
              value={String(variantes)}
              onValueChange={(v) => setVariantes(Number(v))}
              options={VARIANTES}
            />
          </div>

          <Input
            id="negativo"
            label="Negative prompt (opcional)"
            value={negativo}
            onChange={(e) => setNegativo(e.target.value)}
            placeholder="text, watermark, extra fingers"
            autoComplete="off"
          />

          <div aria-live="polite">
            {error && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-sm bg-danger/10 px-3 py-2 text-body text-danger"
              >
                <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-divider pt-4">
            <Button
              type="submit"
              variant="primary"
              loading={enviando}
              disabled={!tienePrompt || nombre.trim().length === 0}
              icon={<Sparkle aria-hidden className="size-4" />}
            >
              Generar
            </Button>
            {/*
              El resumen de lo que se va a gastar. Va en mono con .tnum porque cambia
              con cada tecla y en proporcional los numeros bailan de ancho (D4).
            */}
            {tienePrompt && (
              <p className="font-mono text-label tnum text-fg-dim">
                <span className="text-fg">{variantes}</span>{" "}
                {variantes === 1 ? "imagen" : "imágenes"} ·{" "}
                <span className="text-fg">{formato}</span> ·{" "}
                <span className="text-fg">{calidad}</span>
              </p>
            )}
          </div>
        </Card>
      </form>

      {/* ─── 1. Elegir que tanda mirar ───
           Va ARRIBA de los resultados, no al final: es NAVEGACION, y tiene que
           estar antes de lo que controla. Estaba abajo de todo y el usuario
           reportaba que "no deja elegir": el click funcionaba, pero las imagenes
           se pintaban ~500px mas arriba, fuera de la pantalla, asi que desde donde
           estaba mirando no pasaba nada. ─── */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-divider pt-5">
          <h2 className="text-title font-semibold text-fg">
            Tandas de imágenes{" "}
            {lista.length > 0 && (
              <span className="font-mono text-label tnum font-normal text-fg-dim">
                {lista.length}
              </span>
            )}
          </h2>
          <Button size="sm" onClick={() => void cargarLista()}>
            Actualizar
          </Button>
        </div>

        {cargandoLista && lista.length === 0 ? (
          <SkeletonGrid items={3} />
        ) : lista.length === 0 ? (
          <p className="text-body text-fg-dim">
            Todavía no generaste ninguna. Las que generes van a quedar acá, no se
            borran al generar otra.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {lista.map((p) => {
              const abierto = p.id === projectId;
              return (
                <li key={p.id}>
                  {/*
                    Un boton y no un <Link>: no hay navegacion real, se cambia el
                    parametro de la URL de la misma pantalla. `aria-current` es lo que
                    le dice al lector de pantalla cual esta abierto, porque el borde de
                    acento solo lo comunica por color.
                  */}
                  <button
                    type="button"
                    onClick={() => abrirProyecto(p.id)}
                    aria-current={abierto ? "true" : undefined}
                    className={cn(
                      "w-full rounded-lg border p-2.5 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      abierto
                        ? "border-accent bg-accent/10"
                        : "border-divider bg-surface hover:border-border",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-body font-medium text-fg">
                        {p.name}
                      </span>
                      {abierto && (
                        <span className="shrink-0 text-label font-medium text-accent">
                          abierta
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-label text-fg-dim">
                      <span className="font-mono tnum">
                        {p.imageCount} {p.imageCount === 1 ? "imagen" : "imágenes"}
                      </span>
                      <span aria-hidden>·</span>
                      <span>{estadoDeJob(p.status).label}</span>
                      <span aria-hidden>·</span>
                      <span className="font-mono tnum">
                        {new Date(p.createdAt).toLocaleDateString("es-AR", {
                          day: "2-digit",
                          month: "2-digit",
                        })}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ─── 2. Los resultados de la tanda abierta ─────────────────────────── */}
      {!projectId ? (
        <EmptyState
          icon={<ImageSquare aria-hidden className="size-6" />}
          title="Todavía no generaste nada"
          body="Escribí el prompt, elegí formato, calidad y cuántas variantes querés, y dale Generar: las miniaturas caen acá y elegís la que queda."
          action={{
            label: "Escribir el prompt",
            onClick: () => promptsRef.current?.focus(),
          }}
        />
      ) : (
        /*
          `section` y NO otra `Card`: las tarjetas de la grilla ya son `surface`, y
          `surface` sobre `surface` no se distingue. La separación la da el cambio de
          superficie contra el `bg` de la pagina, que sobre oscuro alcanza y sobra.
        */
        <section ref={resultadosRef} className="flex flex-col gap-4">
          <CardHeader className="mb-0 items-baseline">
            <div>
              <CardTitle className="flex flex-wrap items-baseline gap-2">
                Resultados
                <span className="font-mono text-label tnum font-normal text-fg-dim">
                  {listas}/{jobs.length} listas
                </span>
              </CardTitle>
              <CardDescription>
                Tocá una miniatura para que quede esa variante. Los botones de arriba de
                cada una la abren en grande o la bajan sola.
              </CardDescription>
            </div>
            {/*
              `?que=imagenes` explicito. El default de la ruta es automatico y en un
              proyecto sin clips ya devolveria imagenes, pero decirlo evita que el dia
              que este proyecto tenga un video el boton de ESTA pantalla empiece a bajar
              otra cosa.
            */}
            <a
              href={`/api/projects/${projectId}/download?que=imagenes`}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-sm text-body text-accent transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              title="Un .zip con las imágenes aprobadas del proyecto"
            >
              <DownloadSimple aria-hidden className="size-4" />
              Descargar todas (zip)
            </a>
          </CardHeader>

          {/*
            El aviso del gate. `aria-live` porque aparece solo, minutos despues de
            apretar Generar, cuando el usuario ya no esta mirando.
          */}
          <div aria-live="polite">
            {gateFrenado && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-accent/10 px-3 py-2.5">
                <CursorClick aria-hidden className="size-5 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium text-fg">
                    <span className="font-mono tnum">
                      {esperandoDecision.length} de {jobs.length}
                    </span>{" "}
                    listas. Aprobá para que siga el resto.
                  </p>
                  <p className="text-label text-fg-dim">
                    La cola se frena cuando se junta un lote sin aprobar: no está
                    colgada, te espera.{" "}
                    <span className="font-mono tnum">{frenados}</span> sin arrancar.
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

          {jobs.length === 0 ? (
            <div className="flex flex-col gap-3">
              <p className="text-body text-fg-dim">Encolando…</p>
              <SkeletonGrid items={4} />
            </div>
          ) : (
            /*
              GRILLA, no lista vertical de bloques (§4 de T06). Con 40 prompts la lista
              vieja medía metros y no se podia comparar una imagen con otra.
            */
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {jobs.map((job) => (
                <TarjetaImagen
                  key={job.id}
                  job={job}
                  projectId={projectId}
                  prompt={prompts[job.refId] ?? ""}
                  formato={formatoGenerado ?? formato}
                  enEdicion={editando[job.refId]}
                  ocupado={Boolean(ocupado[job.id])}
                  onEditar={(valor) =>
                    setEditando((ed) => ({ ...ed, [job.refId]: valor }))
                  }
                  onElegir={(index) => void elegir(job, index)}
                  onVariar={() => void variar(job)}
                  onAmpliar={(url, titulo) => setAmpliada({ url, titulo })}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {ampliada && (
        <Visor
          url={ampliada.url}
          titulo={ampliada.titulo}
          tipo="image"
          onCerrar={() => setAmpliada(null)}
        />
      )}
    </div>
  );
}

/**
 * Una imagen con sus variantes. Se separó del tablero porque la grilla la monta hasta
 * 40 veces y tenerla suelta hace que el `map` se lea de un vistazo.
 *
 * NO usa `JobCard`: esa tarjeta recibe un `JobRecord` completo con los handlers del
 * pipeline (aprobar / regenerar / editar prompt+diálogo+duración+resolución) y su
 * `Props` es contrato de cuatro pantallas. Acá el modelo es otro: elegir variante y
 * variar, sobre la vista angosta de job que devuelve esta pantalla.
 */
function TarjetaImagen({
  job,
  projectId,
  prompt,
  formato,
  enEdicion,
  ocupado,
  onEditar,
  onElegir,
  onVariar,
  onAmpliar,
}: {
  job: Job;
  projectId: string;
  prompt: string;
  /** Formato del proyecto ("16:9", "4:5", ...). Define la proporcion de la miniatura. */
  formato: string;
  enEdicion: string | undefined;
  ocupado: boolean;
  onEditar: (valor: string) => void;
  onElegir: (index: number) => void;
  onVariar: () => void;
  onAmpliar: (url: string, titulo: string) => void;
}) {
  // El estado y el label salen de `estadoDeJob` y de ningun switch local (§6.1 del
  // plan). Los derivados se leen del TONO, no del string de status, asi que si mañana
  // aparece un status nuevo se agrega en un solo lugar.
  const estado = estadoDeJob(job.status);
  const fallo = estado.tone === "danger";
  const trabajando = ocupado || EN_CURSO.has(job.status);

  /*
    "16:9" -> "16 / 9", que es lo que entiende la propiedad CSS aspect-ratio. Va por
    `style` y no por una clase de Tailwind porque el valor es dinamico: Tailwind
    compila las clases que encuentra en el codigo y `aspect-[${x}]` armado en runtime
    no existe en el CSS final.
  */
  const proporcionCss = formato.replace(":", " / ");

  const candidatas = job.candidates.length;
  // Menos candidatas que las pedidas es LEGITIMO: se resalta el conteo, pero el tono
  // es `attention` ("mirá esto"), nunca `danger`. La tarjeta no se ve fallada.
  const mostrarConteo = job.variants > 1 && candidatas > 0;
  const faltanVariantes = mostrarConteo && candidatas < job.variants;

  // Cache-busting: los candidatos se escriben siempre en el mismo path, asi que sin
  // esto el browser sirve la imagen vieja despues de variar.
  const ver = encodeURIComponent(job.updatedAt ?? "");

  return (
    <Card flush className="flex flex-col overflow-hidden">
      {/* ─── Las variantes primero: son el contenido ────────────────────── */}
      <div className="bg-bg">
        {candidatas > 0 ? (
          <div
            role="group"
            aria-label={`Variantes de ${job.refId}`}
            className={cn("grid gap-1 p-1", candidatas > 1 ? "grid-cols-2" : "grid-cols-1")}
          >
            {job.candidates.map((c) => {
              const elegida = job.selectedIndex === c.index;
              const url = `/api/files/${projectId}/${c.file}?v=${ver}`;
              return (
                <button
                  key={c.index}
                  type="button"
                  onClick={() => onElegir(c.index)}
                  disabled={trabajando}
                  aria-pressed={elegida}
                  aria-label={`Elegir la variante ${c.index} de ${job.refId}`}
                  title={elegida ? `v${c.index} es la que queda` : `Elegir v${c.index}`}
                  className={cn(
                    // `border-2` en los dos estados: si solo la elegida tuviera borde,
                    // la miniatura cambiaria de tamaño al elegirla y saltaria la fila.
                    // Los botones de ver/bajar van SIEMPRE visibles, no en hover: ver
                    // el comentario en el <span> que los agrupa, mas abajo.
                    "group relative overflow-hidden rounded-sm border-2 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    elegida
                      ? "border-accent"
                      : "border-divider hover:border-border",
                  )}
                >
                  {/*
                    `object-contain` y la proporcion REAL del proyecto, no un 9/16 fijo
                    con object-cover como estaba: generando en 16:9 la miniatura
                    recortaba la imagen a un rectangulo vertical y se veia cortada,
                    justo lo que hay que evitar en una pantalla que existe para elegir
                    entre variantes.
                  */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={url}
                    src={url}
                    alt={`Variante ${c.index} de ${job.refId}`}
                    loading="lazy"
                    decoding="async"
                    style={{ aspectRatio: proporcionCss }}
                    className="w-full bg-bg object-contain"
                  />
                  <span
                    className={cn(
                      "absolute bottom-1 right-1 inline-flex items-center gap-0.5",
                      "rounded-sm px-1 py-px font-mono text-label tnum font-semibold",
                      elegida ? "bg-accent text-on-accent" : "bg-bg/80 text-fg-dim",
                    )}
                  >
                    {elegida && <Check aria-hidden className="size-3" />}v{c.index}
                  </span>

                  {/*
                    Ver en grande y bajar, arriba de cada variante.

                    Son <span role="button"> y no <button>, y el click hace
                    stopPropagation: esto vive DENTRO del boton que elige la variante, y
                    un <button> anidado en otro <button> es HTML invalido (el browser lo
                    desanida y el layout se rompe). Con role + onKeyDown quedan igual de
                    accesibles por teclado.
                  */}
                  {/*
                    SIEMPRE visibles. Estaban en `opacity-0` hasta pasar el mouse y el
                    usuario reporto que no habia forma de bajar una imagen sola: los
                    botones existian pero eran invisibles, o sea que no existian. Un
                    control que hay que descubrir pasando el mouse por encima no es un
                    control. En touch, ademas, no hay hover.
                  */}
                  <span className="absolute right-1 top-1 flex gap-1">
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Ver la variante ${c.index} en grande`}
                      title="Ver en grande"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAmpliar(url, `${job.refId} · v${c.index}`);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          onAmpliar(url, `${job.refId} · v${c.index}`);
                        }
                      }}
                      className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm bg-bg/85 text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <ArrowsOut aria-hidden className="size-3.5" />
                    </span>
                    <a
                      href={`${url}&dl=1&name=${encodeURIComponent(`${job.refId}_v${c.index}.png`)}`}
                      download
                      aria-label={`Descargar la variante ${c.index}`}
                      title="Descargar esta imagen"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex size-6 items-center justify-center rounded-sm bg-bg/85 text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <DownloadSimple aria-hidden className="size-3.5" />
                    </a>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div
            style={{ aspectRatio: proporcionCss }}
            className="flex max-h-56 items-center justify-center"
          >
            <span
              className={cn(
                "flex flex-col items-center gap-1.5 px-2 text-center text-label",
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
                  no salió ninguna
                </>
              ) : (
                <>
                  <ImageSquare aria-hidden className="size-5" />
                  en cola…
                </>
              )}
            </span>
          </div>
        )}
      </div>

      {/* ─── Identificador, estado y conteos ────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <p
            className="truncate font-mono text-body font-medium text-fg"
            title={job.refId}
          >
            {job.refId}
          </p>
          {/*
            El punto (con su pulso cuando la maquina trabaja) lo dibuja `Badge`, que
            respeta prefers-reduced-motion. El label va en castellano: el status crudo
            no se muestra nunca (§6.2).
          */}
          <Badge
            tone={estado.tone}
            punto
            animado={estado.animado}
            className="shrink-0 whitespace-nowrap"
          >
            {estado.label}
          </Badge>
        </div>

        {(mostrarConteo || job.attempts > 1) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {mostrarConteo && (
              <Badge tone={faltanVariantes ? "attention" : "neutral"} className="tnum">
                {candidatas} de {job.variants} variantes
              </Badge>
            )}
            {/*
              `attempts > 1` es la unica señal de que hubo un 429 y la cola reintentó.
              Antes se mezclaba dentro del texto del estado.
            */}
            {job.attempts > 1 && (
              <Badge tone="neutral" className="tnum">
                <ArrowsClockwise aria-hidden className="size-3 shrink-0" />
                intento {job.attempts}
              </Badge>
            )}
          </div>
        )}

        {/*
          `job.error` puede estar poblado en un job que NO falló: el pipeline lo usa
          como nota informativa ("salieron 1/2 variantes"). Por eso el tinte sale del
          TONO DEL ESTADO y no de que haya texto acá. Este era el bug de percepcion
          mas importante de la pantalla: la nota se veia igual de roja siempre y una
          tanda perfectamente aprobable parecia rota.
        */}
        {job.error && (
          <p
            title={job.error}
            className={cn(
              "flex items-start gap-1.5 rounded-sm p-1.5 text-label",
              fallo ? "bg-danger/10 text-danger" : "bg-surface-hi text-fg-dim",
            )}
          >
            {fallo ? (
              <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
            ) : (
              <Info aria-hidden className="mt-px size-3.5 shrink-0" />
            )}
            <span className="line-clamp-3">{job.error}</span>
          </p>
        )}

        {/*
          El prompt, colapsado. Sin `open` controlado a proposito: React no toca el
          atributo si no se lo pasamos, asi que el polling no le cierra el bloque al
          usuario mientras escribe. Lo tipeado vive en `editando`, en el tablero, asi
          que sobrevive igual a que se colapse.
        */}
        <details className="rounded-sm bg-bg">
          <summary
            className={cn(
              "cursor-pointer select-none rounded-sm px-2 py-1 text-label text-fg-dim",
              "transition-colors hover:text-fg",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            )}
          >
            Prompt{" "}
            {enEdicion !== undefined && (
              // Que hay una edicion sin aplicar tiene que verse con el bloque cerrado.
              <Badge tone="attention">editado</Badge>
            )}
          </summary>
          <div className="px-2 pb-2">
            <Textarea
              label={`Prompt de ${job.refId}`}
              labelOculto
              mono
              rows={4}
              spellCheck={false}
              value={enEdicion ?? prompt}
              onChange={(e) => onEditar(e.target.value)}
            />
          </div>
        </details>

        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {/*
            El texto del boton NO cambia con `enEdicion`: en una grilla, un boton que
            pasa de "Variar" a "Variar con el prompt editado" ensancha la tarjeta y
            salta la fila entera. Que hay una edicion pendiente lo dice el badge
            "editado" de arriba, y el `title` explica que se manda.
          */}
          <Button
            size="sm"
            variant="secondary"
            loading={trabajando}
            onClick={onVariar}
            icon={<ArrowsClockwise aria-hidden className="size-3.5" />}
            title="Vuelve a generar las variantes de esta imagen. Si editaste el prompt, usa el texto editado."
          >
            Variar
          </Button>
        </div>
      </div>
    </Card>
  );
}
