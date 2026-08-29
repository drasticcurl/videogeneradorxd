"use client";
/**
 * Tarjeta de un job. El componente mas reusado de la app: el pipeline de un VSL la
 * monta hasta 95 veces en una sola pantalla.
 *
 * ─── QUE COMUNICA, EN ORDEN DE PRIORIDAD (§3 de T03) ─────────────────────────
 *
 *   1. el medio (imagen o video): es el contenido, se queda con el espacio
 *   2. el estado, con icono ADEMAS de color (solo color es inaccesible)
 *   3. el label del job, en mono porque es un identificador
 *   4. las variantes, con la elegida en borde de acento
 *   5. las acciones, agrupadas y con la primaria distinguida
 *   6. el prompt, colapsado
 *
 * Antes todo tenia el mismo peso visual (todo `text-xs`, todo gris) y por eso no se
 * leia ninguna de las seis cosas.
 *
 * ─── EL FLUJO DE APROBACION NO CAMBIO ────────────────────────────────────────
 *
 *  - imagen esperando decision: se ven las candidatas, elegis una y Aprobas.
 *  - video esperando decision: se ve el video y Aprobas.
 *  - "Editar" PRECARGA el prompt actual (el que se uso para generar), el dialogo, la
 *    duracion, la resolucion y el modelo efectivo. Desde el editor:
 *      · "Guardar sin regenerar": solo persiste los cambios (texto/tiempo/dialogo)
 *        para poder revisarlos ANTES de generar en batch. No consume cuota.
 *      · "Guardar y regenerar": guarda y vuelve a generar ese item puntual.
 *
 * ─── DOS COSAS QUE NO SE TOCAN ───────────────────────────────────────────────
 *
 * 1. `Props` es CONTRATO: cuatro pantallas la usan, entre ellas las tres de mayor
 *    riesgo del proyecto (review, videos, pipeline). No se le agrega ni se le saca
 *    un campo desde este archivo.
 * 2. El cache-busting `?v=<updatedAt>` y el `key={url}` de los medios. Estan por un
 *    bug real: sin eso, al regenerar una imagen el browser servia la vieja de cache
 *    y la regeneracion parecia no haber hecho nada. Ver `withVer` mas abajo.
 *
 * Este archivo NO decide colores ni estados: el mapeo status -> tono/label sale de
 * `estadoDeJob` y de nadie mas (§6 del plan). Por eso no hay ni un literal de status
 * ni un color en todo el archivo.
 *
 * ─── NOTA HISTORICA sobre `cn()` ────────────────────────────────────────────
 *
 * Cuando se escribio esta tarjeta, `cn()` se comia el tamaño o el color de
 * cualquier string que mezclara los dos: la escala tipografica del proyecto usa
 * nombres propios (label/body/title/display) y tailwind-merge, que no lee
 * tailwind.config.ts, los tomaba como COLOR de texto. El caso peor era el primario
 * de Button (`bg-fg text-bg`), que perdia el color y quedaba invisible.
 *
 * YA ESTA ARREGLADO en `src/lib/cn.ts` con `extendTailwindMerge`, y hay un comando
 * que lo cuida: `node tasks/_verificacion-cn.mjs`. Los parches que habia acá se
 * borraron. Se deja escrito porque si alguien agrega un tamaño a `fontSize` sin
 * declararlo en `cn.ts`, el sintoma vuelve exactamente igual: componentes que
 * compilan, pasan el typecheck y no se ven.
 */
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  ArrowsOut,
  Check,
  CheckCircle,
  Clock,
  CursorClick,
  DownloadSimple,
  FastForward,
  FilmSlate,
  FloppyDisk,
  type Icon,
  ImageSquare,
  Info,
  LockSimple,
  PencilSimple,
  Spinner,
  WarningCircle,
} from "@phosphor-icons/react";
import { memo, useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  Select,
  Textarea,
  type SelectOption,
} from "@/components/ui";
import { Visor } from "@/components/Visor";
import { cn } from "@/lib/cn";
import { DEFAULT_VEO_PROMPT_TEMPLATE } from "@/lib/promptTemplate";
import { buildVeoVideoPrompt } from "@/lib/prompts";
import type { JobRecord } from "@/lib/types";
import { estadoDeJob, type Tone } from "@/lib/ui-tokens";

interface ModelOption {
  id: string;
  label: string;
}

interface Props {
  job: JobRecord;
  projectId: string;
  /** prompt actual del item (image.prompt o clip.video_prompt) para precargar al editar */
  currentPrompt: string;
  /** dialogo actual del clip (solo videos) para precargar al editar */
  currentDialogue?: string;
  /** duracion actual del clip en segundos (solo videos) */
  currentDuration?: number;
  /** override del prompt final actual del clip (solo videos); "" si no hay override */
  currentFinalPrompt?: string;
  /** tipo de asset del clip ("avatar" | "broll"); define si el dialogo es selfie o voz en off */
  assetType?: "avatar" | "broll";
  /** opciones de modelo para el selector (catalogo de imagen o de video segun el tipo) */
  modelOptions: ModelOption[];
  /** modelo del proyecto para este tipo (default si no hay override) */
  projectModel: string;
  onApprove: (jobId: string, index?: number) => void;
  onRegenerate: (jobId: string) => void;
  onChangePrompt: (
    jobId: string,
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
  /** Solo videos: extender el video +7s. */
  onExtend?: (jobId: string) => void;
  /** Solo videos: resolucion actual del clip y callback para cambiarla. */
  resolution?: string;
  resolutionOptions?: string[];
  onChangeResolution?: (jobRefId: string, resolution: string) => void;
  /**
   * Formato del proyecto ("16:9", "4:5", ...). Define la proporcion del medio.
   *
   * OPCIONAL y con default "9:16", que es exactamente lo que estaba hardcodeado antes:
   * ningun caller existente cambia de comportamiento si no la pasa. Se agrega igual a
   * pesar de la nota de arriba sobre no tocar `Props`, porque el formato dejo de ser
   * fijo cuando se pudo elegir en /imagenes y sin esto la tarjeta RECORTA todo lo que
   * no sea vertical. La regla estaba para que un rediseño en paralelo no rompiera las
   * cuatro pantallas; una prop opcional con default identico no rompe ninguna.
   */
  formato?: string;
}

function fileUrl(projectId: string, rel: string) {
  return `/api/files/${projectId}/${rel}`;
}

const DURATION_OPTIONS = [4, 6, 8];
const RESOLUCIONES_DEFAULT = ["720p", "1080p"];

const DURACION_OPCIONES: ReadonlyArray<SelectOption<string>> = DURATION_OPTIONS.map(
  (d) => ({ value: String(d), label: `${d}s` }),
);

/**
 * Un icono por tono, para que el estado no dependa SOLO del color: un daltonismo
 * rojo-verde no distingue "Listo" de "Fallo" si lo unico que cambia es el tinte.
 * Las claves son los tonos de `ui-tokens`, no los status: el mapeo de status vive
 * en un solo lugar y no se duplica acá.
 */
const ICONO_DE_TONO: Record<Tone, Icon> = {
  neutral: Clock,
  info: Spinner,
  attention: CursorClick,
  ok: CheckCircle,
  danger: WarningCircle,
};

/**
 * La plantilla del prompt de Veo se pide UNA vez por carga de pagina, no una por
 * tarjeta. El pipeline de un VSL monta hasta 95 tarjetas de video y cada una hacia
 * su propio GET a `/api/prompt-template`: misma URL, mismo momento (al montar), 95
 * veces. Compartiendo la promesa quedan en una sola request.
 *
 * El endpoint, el metodo y el momento en que se pide son los de antes. Lo unico que
 * cambia es que no se repite.
 *
 * Contra conocida: si alguien edita `prompts/veo-video-prompt.md` con la pagina
 * abierta, el texto nuevo entra al recargar. Antes tampoco entraba en las tarjetas
 * ya montadas, asi que no se pierde nada.
 */
let plantillaEnVuelo: Promise<string | null> | null = null;

function cargarPlantilla(): Promise<string | null> {
  if (!plantillaEnVuelo) {
    plantillaEnVuelo = fetch("/api/prompt-template")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: unknown) => {
        const contenido = (d as { content?: unknown } | null)?.content;
        return typeof contenido === "string" && contenido.trim() ? contenido : null;
      })
      .catch(() => null); // si falla, queda el DEFAULT embebido
  }
  return plantillaEnVuelo;
}

/**
 * `memo` porque el padre la renderiza en listas de hasta 95 items y el polling
 * actualiza el store cada pocos segundos.
 *
 * OJO, y esto le toca al padre, no acá: hoy el pipeline arma `handlers` como un
 * objeto literal con arrow functions nuevas en cada render, asi que la comparacion
 * shallow de `memo` falla siempre y las 95 tarjetas se vuelven a renderizar igual.
 * El memo queda puesto porque es correcto y gratis, pero no rinde hasta que la
 * pantalla que la monta estabilice `onApprove`/`onRegenerate`/`onChangePrompt`/
 * `onExtend` con `useCallback` y el objeto `meta` con `useMemo`.
 */
export const JobCard = memo(function JobCard({
  job,
  projectId,
  currentPrompt,
  currentDialogue,
  currentDuration,
  currentFinalPrompt,
  assetType,
  modelOptions,
  projectModel,
  onApprove,
  onRegenerate,
  onChangePrompt,
  onExtend,
  resolution,
  resolutionOptions,
  onChangeResolution,
  formato = "9:16",
}: Props) {
  const [selected, setSelected] = useState<number | null>(job.selectedIndex);
  const [editing, setEditing] = useState(false);
  /** Medio abierto en el visor a pantalla completa, o null. */
  const [ampliado, setAmpliado] = useState<string | null>(null);
  /** "16:9" -> "16 / 9", que es lo que entiende la propiedad CSS aspect-ratio. */
  const proporcionCss = formato.replace(":", " / ");
  const [promptText, setPromptText] = useState("");
  const [dialogueText, setDialogueText] = useState("");
  const [durationChoice, setDurationChoice] = useState<number>(8);
  const [resChoice, setResChoice] = useState<string>("720p");
  const [modelChoice, setModelChoice] = useState("");
  // Override del prompt final (avanzado): si esta activo, se manda TAL CUAL a Veo.
  const [overrideOn, setOverrideOn] = useState(false);
  const [finalPromptText, setFinalPromptText] = useState("");
  // El <details> del prompt monta su contenido recien cuando se abre: 95 tarjetas
  // por 2.000 caracteres de prompt son 190 KB de nodos de texto que nadie mira.
  const [promptAbierto, setPromptAbierto] = useState(false);
  // Texto de la plantilla del prompt (prompts/veo-video-prompt.md). Arranca con el
  // DEFAULT embebido y se actualiza con el .md real para que el preview del editor
  // coincida con lo que ejecuta el server.
  const [templateText, setTemplateText] = useState<string>(DEFAULT_VEO_PROMPT_TEMPLATE);

  useEffect(() => {
    if (job.type === "image") return; // la plantilla solo aplica a videos
    let alive = true;
    cargarPlantilla().then((texto) => {
      if (alive && texto) setTemplateText(texto);
    });
    return () => {
      alive = false;
    };
  }, [job.type]);

  const isImage = job.type === "image";

  // ─── El estado sale de `estadoDeJob` y de ningun switch local ───────────────
  // Los tres derivados de abajo se leen del tono, no del string de status: asi este
  // archivo no repite el mapeo (§6.1 del plan) y si mañana aparece un status nuevo,
  // se agrega en un solo lugar.
  //   attention -> el job espera una decision del usuario
  //   animado   -> la maquina esta trabajando; es lo UNICO que se anima
  //   danger    -> el job fallo de verdad
  const estado = estadoDeJob(job.status);
  const IconoEstado = ICONO_DE_TONO[estado.tone];
  const esperaDecision = estado.tone === "attention";
  const trabajando = estado.animado;
  const fallo = estado.tone === "danger";

  // Cache-busting: la URL cambia cuando el job se actualiza (regenera/aprueba), asi el
  // navegador NO muestra el video/imagen viejo cacheado (el archivo va al mismo path).
  const ver = encodeURIComponent(job.updatedAt ?? "");
  const withVer = (u: string) => `${u}?v=${ver}`;
  const approvedUrl = job.outputPath
    ? withVer(fileUrl(projectId, job.outputPath))
    : null;
  const chosen = selected ?? job.selectedIndex ?? job.candidates[0]?.index ?? null;

  // El modelo efectivo de este job: override > modelo usado > modelo del proyecto.
  const effectiveModel = job.modelOverride || job.model || projectModel;

  // Menos candidatas que `variants` es un estado LEGITIMO: la cuota del modelo
  // rechazo una variante y el pipeline lo dejo escrito en `job.error`. El job sigue
  // siendo aprobable, asi que se muestra el conteo real y NO se pinta como fallado.
  const candidatas = job.candidates.length;
  const mostrarConteo = isImage && job.variants > 1 && candidatas > 0;
  const faltanVariantes = mostrarConteo && candidatas < job.variants;

  const opcionesResolucion = useMemo<ReadonlyArray<SelectOption<string>>>(
    () => (resolutionOptions ?? RESOLUCIONES_DEFAULT).map((r) => ({ value: r, label: r })),
    [resolutionOptions],
  );

  // Si el modelo efectivo no esta en el catalogo (quedo uno viejo guardado en el
  // job), se agrega como opcion: sin esto el selector arranca en blanco y guardar
  // pisaria el modelo con otro sin que el usuario lo haya elegido.
  const opcionesModelo = useMemo<ReadonlyArray<SelectOption<string>>>(() => {
    const base = modelOptions.map((o) => ({ value: o.id, label: o.label }));
    if (modelChoice && !base.some((o) => o.value === modelChoice)) {
      base.push({ value: modelChoice, label: modelChoice });
    }
    return base;
  }, [modelOptions, modelChoice]);

  function openEditor() {
    // PRECARGAMOS prompt + dialogo + duracion + resolucion + modelo efectivo.
    setPromptText(currentPrompt ?? "");
    setDialogueText(currentDialogue ?? "");
    setDurationChoice(currentDuration ?? 8);
    setResChoice(resolution ?? "720p");
    setModelChoice(effectiveModel);
    // Override del prompt final: si el clip ya tiene uno, arrancamos con el editor abierto.
    const existingOverride = (currentFinalPrompt ?? "").trim();
    setOverrideOn(Boolean(existingOverride));
    setFinalPromptText(existingOverride);
    setEditing(true);
  }

  /** Arma el prompt final "automatico" (lo que mandaria el sistema sin override). */
  function computeAutoFinalPrompt(): string {
    return buildVeoVideoPrompt({
      videoPrompt: promptText,
      dialogue: dialogueText,
      assetType,
      template: templateText,
      durationSec: durationChoice,
      aspectRatio: "9:16",
    });
  }

  // Al activar el override por primera vez, precargamos el prompt automatico actual
  // para que el usuario lo edite/recorte (ej. sacar la parte de "persona hablando").
  function toggleOverride(on: boolean) {
    setOverrideOn(on);
    if (on && !finalPromptText.trim()) {
      setFinalPromptText(computeAutoFinalPrompt());
    }
  }

  // Guarda los cambios del editor. Si regenerate=false SOLO persiste (no genera),
  // util para ajustar texto/tiempo/dialogo antes de generar en batch.
  function submitEdits(regenerate: boolean) {
    // finalPrompt: si el override esta activo y tiene contenido, se manda; si no, ""
    // lo BORRA en el backend (vuelve al armado automatico). undefined = no aplica a imagenes.
    const finalPrompt = overrideOn ? finalPromptText : "";
    const payload = isImage
      ? { prompt: promptText.trim(), model: modelChoice, regenerate }
      : {
          prompt: promptText.trim(),
          dialogue: dialogueText,
          durationSec: durationChoice,
          resolution: resChoice,
          model: modelChoice,
          finalPrompt,
          regenerate,
        };
    if (payload.prompt) onChangePrompt(job.id, payload);
    setEditing(false);
  }

  const IconoTipo = isImage ? ImageSquare : FilmSlate;
  const tipoLabel = isImage ? "imagen" : "video";

  return (
    <Card flush className="flex flex-col overflow-hidden">
      {/* ─── 1. El contenido primero: candidatas o preview ─────────────────── */}
      <div className="bg-bg">
        {esperaDecision && isImage && job.candidates.length > 0 ? (
          <div
            role="group"
            aria-label={`Variantes de ${job.label}`}
            className={cn(
              "grid gap-1 p-1",
              job.candidates.length > 1 ? "grid-cols-2" : "grid-cols-1",
            )}
          >
            {job.candidates.map((c) => {
              const elegida = chosen === c.index;
              const url = withVer(fileUrl(projectId, c.file));
              return (
                <button
                  key={c.index}
                  type="button"
                  onClick={() => setSelected(c.index)}
                  aria-pressed={elegida}
                  aria-label={`Variante ${c.index}${elegida ? " (elegida)" : ""}`}
                  title={`Variante ${c.index}`}
                  className={cn(
                    "relative overflow-hidden rounded-sm transition-shadow",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    elegida
                      ? "ring-2 ring-inset ring-accent"
                      : "ring-1 ring-inset ring-divider hover:ring-border",
                  )}
                >
                  {/*
                    `object-contain` con la proporcion del PROYECTO, no un 9/16 fijo con
                    object-cover: desde que el formato se elige, una imagen 16:9 o 21:9
                    entraba a la fuerza en un rectangulo vertical y se veia cortada.
                    Va por `style` porque el valor es dinamico y una clase
                    `aspect-[${x}]` armada en runtime no existe en el CSS compilado.
                  */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={url}
                    src={url}
                    alt={`Variante ${c.index} de ${job.label}`}
                    loading="lazy"
                    decoding="async"
                    style={{ aspectRatio: proporcionCss }}
                    className="w-full bg-bg object-contain"
                  />
                  {/* string plano, no cn(): mezcla tamaño con color. Ver cabecera. */}
                  <span
                    className={
                      "absolute bottom-1 right-1 inline-flex items-center gap-0.5 " +
                      "rounded-sm px-1 py-px font-mono text-label font-semibold tnum " +
                      (elegida ? "bg-accent text-on-accent" : "bg-bg/80 text-fg-dim")
                    }
                  >
                    {elegida && <Check aria-hidden className="size-3" />}v{c.index}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          /*
            `max-h-[28rem]` (448px) y no `max-h-56` (224px). Medido: con 224px de tope y
            proporcion vertical, un clip quedaba de 126x224, del tamaño de un sello, y
            esta tarjeta es donde se decide si el clip sirve o se regenera (que cuesta
            plata). El doble sigue entrando bien en la grilla, y para verlo de verdad
            esta el boton de ampliar.
          */
          <div
            style={{ aspectRatio: proporcionCss }}
            className="relative flex max-h-[28rem] items-center justify-center"
          >
            {approvedUrl ? (
              <>
                {/*
                  Ampliar. La tarjeta es una miniatura por necesidad (el pipeline monta
                  hasta 95), pero decidir si un clip sirve o se regenera no se puede
                  hacer en 126 pixeles de ancho. Un boton, sin tocar el resto.
                */}
                <button
                  type="button"
                  onClick={() => setAmpliado(approvedUrl)}
                  aria-label={`Ver ${tipoLabel} ${job.label} en grande`}
                  title="Ver en grande"
                  className="absolute right-1 top-1 z-10 inline-flex size-7 items-center justify-center rounded-sm bg-bg/85 text-fg-dim transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <ArrowsOut aria-hidden className="size-4" />
                </button>
                {isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={approvedUrl}
                    src={approvedUrl}
                    alt={job.label}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  /*
                    preload="none" y sin autoplay, a proposito: la pantalla del VSL monta
                    hasta 95 clips y con preload="metadata" el browser dispara 95 requests
                    de rango al abrir la pagina. El video se baja cuando el usuario le da
                    play, no antes.
                  */
                  <video
                    key={approvedUrl}
                    src={approvedUrl}
                    controls
                    preload="none"
                    playsInline
                    className="h-full w-full object-contain"
                  />
                )}
              </>
            ) : (
              <span
                className={
                  "flex flex-col items-center gap-1.5 px-2 text-center text-label " +
                  (fallo ? "text-danger" : "text-fg-dim")
                }
              >
                {trabajando ? (
                  <>
                    <Spinner
                      aria-hidden
                      className="size-5 motion-safe:animate-spin"
                    />
                    generando…
                  </>
                ) : fallo ? (
                  <>
                    <WarningCircle aria-hidden className="size-5" />
                    no se generó
                  </>
                ) : (
                  <>
                    <IconoTipo aria-hidden className="size-5" />
                    en cola…
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ─── 2 y 3. Estado + identificador ─────────────────────────────────── */}
      <div className="flex min-w-0 flex-col gap-2 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p
              className="truncate font-mono text-body font-medium text-fg"
              title={job.label}
            >
              {job.label}
            </p>
            <p
              className="flex items-center gap-1 truncate text-label text-fg-dim"
              title={effectiveModel ? `${tipoLabel} · ${effectiveModel}` : tipoLabel}
            >
              <IconoTipo aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">
                {tipoLabel}
                {effectiveModel ? ` · ${effectiveModel}` : ""}
              </span>
            </p>
          </div>
          <Badge tone={estado.tone} className="shrink-0 whitespace-nowrap">
            <IconoEstado
              aria-hidden
              className={cn(
                "size-3.5 shrink-0",
                estado.animado && "motion-safe:animate-spin",
              )}
            />
            {estado.label}
          </Badge>
        </div>

        {/* ─── 4. Variantes, reintentos y candado ──────────────────────────── */}
        {(mostrarConteo || job.attempts > 1 || job.locked) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {mostrarConteo && (
              <Badge
                tone={faltanVariantes ? "attention" : "neutral"}
                className="tnum"
                // El conteo real, no el pedido. Si faltan, se resalta pero NO se
                // pinta como error: el job es aprobable igual.
              >
                {candidatas} de {job.variants} variantes
              </Badge>
            )}
            {/*
              `attempts > 1` es la UNICA señal de que hubo un 429 y la cola reintento.
              Antes no se veia en ningun lado y el job parecia haber salido derecho.
            */}
            {job.attempts > 1 && (
              <Badge
                tone="neutral"
                className="tnum"
              >
                <ArrowsClockwise aria-hidden className="size-3 shrink-0" />
                intento {job.attempts}/{job.maxAttempts}
              </Badge>
            )}
            {job.locked && (
              <span
                className="inline-flex items-center gap-1 text-label text-fg-dim"
                title="Aprobado y bloqueado: 'reanudar' no lo vuelve a generar"
              >
                <LockSimple aria-hidden className="size-3.5" />
                bloqueado
              </span>
            )}
          </div>
        )}

        {/*
          `job.error` puede estar poblado en un job que NO fallo: el pipeline lo usa
          como nota informativa ("Salieron 1/2 variantes"). El estado sale de
          `job.status`, nunca de `error`, asi que el tinte de este bloque depende del
          tono del estado y no de que haya texto acá.
        */}
        {job.error && (
          <p
            title={job.error}
            className={
              "flex items-start gap-1.5 rounded-sm p-1.5 text-label " +
              (fallo ? "bg-danger/10 text-danger" : "bg-surface-hi text-fg-dim")
            }
          >
            {fallo ? (
              <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
            ) : (
              <Info aria-hidden className="mt-px size-3.5 shrink-0" />
            )}
            <span className="line-clamp-3">{job.error}</span>
          </p>
        )}

        {/* ─── 6. El prompt, colapsado ─────────────────────────────────────── */}
        {(currentPrompt || currentDialogue) && (
          <details
            className="rounded-sm bg-bg"
            onToggle={(e) => setPromptAbierto(e.currentTarget.open)}
          >
            <summary
              className={
                "cursor-pointer select-none rounded-sm px-2 py-1 text-label text-fg-dim " +
                "transition-colors hover:text-fg " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              }
            >
              Prompt
            </summary>
            {promptAbierto && (
              <div className="max-h-44 space-y-2 overflow-auto px-2 pb-2">
                {currentPrompt && (
                  <pre className="whitespace-pre-wrap break-words font-mono text-label text-fg-dim">
                    {currentPrompt}
                  </pre>
                )}
                {currentDialogue && (
                  <div>
                    <p className="text-label font-medium text-fg-dim">Diálogo</p>
                    <pre className="whitespace-pre-wrap break-words font-mono text-label text-fg-dim">
                      {currentDialogue}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </details>
        )}

        {/*
          Resolucion del clip (solo videos): cambia el plan, NO regenera. Es la misma
          accion que tenia la tarjeta antes, con el mismo callback.
          El label queda visible: un combo que solo dice "720p" al lado de un video no
          se entiende, y el original tambien lo mostraba. Ancho acotado para que un
          control secundario no ocupe todo el ancho de la tarjeta.
        */}
        {!isImage && onChangeResolution && (
          <Select
            label="Resolución"
            value={resolution ?? "720p"}
            onValueChange={(r) => onChangeResolution(job.refId, r)}
            options={opcionesResolucion}
            disabled={trabajando}
            className="max-w-[8rem]"
          />
        )}

        {/* ─── 5. Acciones: primaria distinguida, el resto en dos niveles ──── */}
        <div className="flex flex-wrap gap-1.5">
          {esperaDecision && (
            <Button
              size="sm"
              variant="primary"
              icon={<Check aria-hidden className="size-3.5" />}
              onClick={() =>
                onApprove(job.id, isImage ? chosen ?? undefined : undefined)
              }
            >
              Aprobar
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon={<ArrowsClockwise aria-hidden className="size-3.5" />}
            onClick={() => onRegenerate(job.id)}
            title="Vuelve a generar este item. Sirve tambien para destrabar uno colgado en 'generando'."
          >
            Regenerar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<PencilSimple aria-hidden className="size-3.5" />}
            onClick={openEditor}
            disabled={trabajando}
            title="Editá prompt, diálogo, tiempo y resolución. Podés guardar sin regenerar para controlarlo antes del batch."
          >
            Editar
          </Button>
          {!isImage && onExtend && job.outputPath && (
            <Button
              size="sm"
              variant="ghost"
              icon={<FastForward aria-hidden className="size-3.5" />}
              onClick={() => onExtend(job.id)}
              disabled={trabajando}
              title="Genera 7s más de continuación y los une al final del video"
            >
              Extender +7s
            </Button>
          )}
        </div>
      </div>

      {/*
        Editor en dialogo grande, para ver TODO el prompt. Se monta recien cuando se
        abre: 95 Radix Dialog dormidos son 95 arboles de contexto que nadie usa.
      */}
      {editing && (
        <Dialog open onOpenChange={(abierto) => !abierto && setEditing(false)}>
          <DialogContent
            title={`Editar · ${job.label}`}
            description={
              effectiveModel ? `${tipoLabel} · ${effectiveModel}` : tipoLabel
            }
            className="w-[min(52rem,calc(100vw-2rem))] max-h-[90vh] overflow-y-auto"
          >
            <div className="flex flex-col gap-4">
              <Textarea
                label={
                  isImage
                    ? "Prompt de la imagen (editá lo que quieras)"
                    : "Prompt visual del video (cámara, acción, escena)"
                }
                hint={`${promptText.length} caracteres`}
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                placeholder="Prompt…"
                spellCheck={false}
                mono
                rows={10}
              />

              {/* Solo videos: el DIALOGO que dice la persona (lo que se escucha). */}
              {!isImage && (
                <Textarea
                  label="Diálogo (lo que dice la persona · es-AR)"
                  hint={`${dialogueText.length} caracteres`}
                  value={dialogueText}
                  onChange={(e) => setDialogueText(e.target.value)}
                  placeholder="Texto hablado… (vacío = b-roll mudo)"
                  spellCheck={false}
                  rows={4}
                />
              )}

              {/* Solo videos: duracion (4/6/8) + resolucion, campo por campo. */}
              {!isImage && (
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Duración (segundos)"
                    value={String(durationChoice)}
                    onValueChange={(v) => setDurationChoice(Number(v))}
                    options={DURACION_OPCIONES}
                  />
                  <Select
                    label="Resolución"
                    value={resChoice}
                    onValueChange={setResChoice}
                    options={opcionesResolucion}
                  />
                </div>
              )}

              {/* Solo videos: OVERRIDE del prompt final que se ejecuta en Veo (avanzado). */}
              {!isImage && (
                <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
                  <label className="flex cursor-pointer items-start gap-2 text-body text-fg">
                    <input
                      type="checkbox"
                      checked={overrideOn}
                      onChange={(e) => toggleOverride(e.target.checked)}
                      className="mt-0.5 size-4 shrink-0 accent-accent"
                    />
                    Editar manualmente el prompt final que se ejecuta (avanzado)
                  </label>
                  {overrideOn ? (
                    <>
                      <p className="text-label leading-relaxed text-fg-dim">
                        Esto se manda <b className="text-fg">TAL CUAL</b> a Veo: ignora
                        el armado automático (estilo de grabación, lip-sync,
                        voz/acento). Útil para b-roll que NO debe mostrar a una persona
                        hablando. Si querés que se escuche el diálogo, incluilo acá vos
                        mismo.
                      </p>
                      <Textarea
                        label="Prompt final exacto que se ejecuta"
                        hint={`${finalPromptText.length} caracteres`}
                        value={finalPromptText}
                        onChange={(e) => setFinalPromptText(e.target.value)}
                        placeholder="Prompt final exacto que se le manda a Veo…"
                        spellCheck={false}
                        mono
                        rows={9}
                      />
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<ArrowCounterClockwise aria-hidden className="size-3.5" />}
                          onClick={() => setFinalPromptText(computeAutoFinalPrompt())}
                          title="Reemplaza el texto por el prompt automático actual (visual + voz/acento + diálogo) para editarlo desde ahí"
                        >
                          Cargar prompt automático
                        </Button>
                      </div>
                    </>
                  ) : (
                    <details className="rounded-sm bg-bg">
                      <summary className="cursor-pointer select-none px-2 py-1 text-label text-fg-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                        Ver prompt final automático (lo que se ejecuta si no lo editás)
                      </summary>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-2 py-2 font-mono text-label text-fg-dim">
                        {computeAutoFinalPrompt()}
                      </pre>
                    </details>
                  )}
                  <p className="text-label leading-relaxed text-fg-dim">
                    El texto base del prompt (estilo de grabación, voz/acento, voz en
                    off de b-roll) vive en la plantilla{" "}
                    <code className="font-mono text-fg">prompts/veo-video-prompt.md</code>
                    . Editá ese archivo para cambiar el estilo de todos los clips.{" "}
                    <a
                      href="/api/prompt-template?download=1"
                      className="inline-flex items-center gap-1 text-accent underline hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <DownloadSimple aria-hidden className="size-3.5" />
                      Descargar plantilla (MD)
                    </a>
                  </p>
                </div>
              )}

              <Select
                label="Modelo para regenerar"
                value={modelChoice}
                onValueChange={setModelChoice}
                options={opcionesModelo}
              />

              <div className="flex flex-col gap-2 border-t border-divider pt-3">
                <p className="text-label leading-relaxed text-fg-dim">
                  «Guardar sin regenerar» actualiza el texto, el tiempo y el diálogo
                  (audio) sin volver a generar — útil para revisarlos y controlarlos
                  antes de generar en batch. No consume cuota.
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" onClick={() => setEditing(false)}>
                    Cancelar
                  </Button>
                  {/*
                    `submitEdits` no guarda nada si el prompt quedo vacio. Antes el
                    dialogo se cerraba igual y parecia que habia guardado, asi que
                    ahora la guarda esta a la vista en vez de escondida.
                  */}
                  <Button
                    variant="secondary"
                    icon={<FloppyDisk aria-hidden className="size-4" />}
                    onClick={() => submitEdits(false)}
                    disabled={!promptText.trim()}
                  >
                    Guardar sin regenerar
                  </Button>
                  <Button
                    variant="primary"
                    icon={<ArrowsClockwise aria-hidden className="size-4" />}
                    onClick={() => submitEdits(true)}
                    disabled={!promptText.trim()}
                  >
                    Guardar y regenerar
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Visor a pantalla completa del medio aprobado. */}
      {ampliado && (
        <Visor
          url={ampliado}
          titulo={job.label}
          tipo={isImage ? "image" : "video"}
          onCerrar={() => setAmpliado(null)}
        />
      )}
    </Card>
  );
});
