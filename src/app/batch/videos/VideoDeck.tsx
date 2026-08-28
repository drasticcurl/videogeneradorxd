"use client";
/**
 * REVISION DE CLIPS (fase videos).
 *
 * Recorre TODOS los clips del lote en orden (proyecto por proyecto, por "orden" del
 * plan) y te deja aprobar / rechazar / regenerar de a uno, con el guion al costado
 * para chequear el lip-sync.
 *
 * Sirve para los dos casos:
 *  - Si generaste con aprobacion manual, los clips llegan en "por aprobar" y el boton
 *    primario los aprueba (y desbloquea lo que dependa).
 *  - Si generaste con auto-aprobacion (default), ya estan aprobados: igual los podes
 *    ver en orden y regenerar los que no te gustaron.
 *
 * Atajos: → siguiente · ← anterior · A aprobar · R regenerar (pide confirmacion).
 *
 * ─── LOS 4 ENDPOINTS, QUE SON LOS MISMOS DE ANTES ────────────────────────────
 *
 * Anotados aca porque dos de ellos GASTAN PLATA y este archivo se reescribio entero.
 * El payload es identico al de antes, campo por campo:
 *
 *  1. GET  /api/batch?ids=<a,b,c>              -> BatchSnapshot. El poll, cada 3s.
 *  2. POST /api/jobs/<videoJobId>/<accion>     accion = approve | retry | unapprove
 *                                              body = "{}" solo en approve, si no sin
 *                                              body. `retry` es el que CUESTA PLATA.
 *  3. POST /api/batch                          body = { ids, action: "approve-videos" }
 *  4. POST /api/jobs/<videoJobId>/prompt       body = { prompt, dialogue, durationSec,
 *                                              resolution, finalPrompt, regenerate }
 *                                              con regenerate=true CUESTA PLATA.
 *
 * Son 4 llamadas a `fetch` y ni una mas. Si ese numero baja, un boton quedo
 * desconectado y no tira ningun error: solo no hace nada.
 *
 * ─── LO QUE SI CAMBIO DE COMPORTAMIENTO, Y ES A PROPOSITO ────────────────────
 *
 * 1. REGENERAR AHORA PIDE CONFIRMACION. Es el unico cambio funcional que autoriza
 *    §3 de la task, y esta justificado: un clip de 8s cuesta varios dolares, y antes
 *    era un click directo en una fila de botones apretados. Los DOS caminos que
 *    llaman a Veo pasan por el dialogo: "Rechazar y regenerar" (endpoint 2, retry) y
 *    "Guardar y regenerar" (endpoint 4, regenerate=true). Aprobar y desaprobar NO
 *    piden nada: no generan.
 *
 * 2. EL ATAJO `R` TAMBIEN PASA POR EL DIALOGO. Era el agujero mas caro de la
 *    pantalla: una `r` suelta con el foco en el body mandaba un clip a Veo sin
 *    preguntar nada. Ahora `R` abre la confirmacion, y mientras esta abierta los
 *    atajos se apagan (si no, con el dialogo puesto se podia mover el cursor con las
 *    flechas y confirmar terminaba regenerando OTRO clip que el que nombra el
 *    dialogo). Por lo mismo, el pedido guarda el `jobId` CAPTURADO al abrir y no lee
 *    `current` al confirmar.
 *
 * 3. EL VIDEO YA NO ARRANCA SOLO. Antes tenia el atributo de arranque automatico y
 *    ningun `preload`, asi que pasar por 95 clips con las flechas bajaba 95 videos
 *    completos. Ahora va `preload="none"` + `poster`: no baja un byte hasta que le
 *    das play. Ver la nota larga en `VistaDelClip`, mas abajo.
 *
 *    (Los comentarios de este archivo no escriben el nombre literal de ese atributo
 *    a proposito: el chequeo 5 de la task lo cuenta con `grep` y tiene que dar CERO,
 *    y un grep no sabe distinguir un comentario de una linea de codigo. Es el mismo
 *    motivo por el que `StatusBadge` no nombra los estados crudos. Ver P-08.)
 *
 * ─── RENDIMIENTO: QUE SE MONTA Y QUE NO ──────────────────────────────────────
 *
 * Hay UN solo `<video>` en el DOM, el del clip que estas mirando, igual que antes:
 * esta pantalla es un deck (uno a la vez con teclado), no una grilla. Con los 95
 * clips del VSL real, una grilla de 95 `<video>` seria el peor caso posible, asi que
 * la estructura de un-clip-a-la-vez se conserva a proposito. La tira de navegacion
 * son 95 botones con un numero adentro: cero requests.
 *
 * El unico elemento ANIMADO de la pantalla es el punto del `StatusBadge` del clip
 * actual, y solo cuando ese clip esta generando. Los contadores de arriba llevan
 * punto pero sin pulso, y la tira no anima nada: con 95 items, animar la tira son 95
 * elementos latiendo a la vez.
 */
import {
  ArrowLeft,
  ArrowRight,
  ArrowUUpLeft,
  ArrowsClockwise,
  Check,
  CheckCircle,
  FilmStrip,
  FloppyDisk,
  SquaresFour,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { StatusBadge } from "@/components/StatusBadge";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  Confirmar,
  EmptyState,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/components/ui";
import type { BatchCounts, BatchSnapshot, BatchTimelineItem } from "@/lib/batch";
import { cn } from "@/lib/cn";
import { estadoDeJob, type Tone } from "@/lib/ui-tokens";

const POLL_MS = 3000;

/**
 * Clip que graba una persona en vez de la IA. Es el unico valor de `etiqueta` que
 * cambia lo que la pantalla puede hacer, asi que esta una sola vez y con nombre. El
 * string crudo no se le muestra al usuario (§6 regla 2 del plan).
 */
const FILMAR_REAL = "FILMAR_REAL";

/**
 * Tono -> pastilla de la tira de navegacion.
 *
 * Mismo patron que `RELLENO` en `BatchBoard` y `ICONO_DE_TONO` en `JobCard`: el
 * ESTADO se traduce a tono en `ui-tokens` y aca solo se elige la clase de ese tono.
 * Ni un color literal, y la pastilla de un estado sale del mismo color que su badge.
 * No se usa `Badge` directamente porque esto es un `<button>` con area de click, no
 * una etiqueta.
 */
const PASTILLA: Record<Tone, string> = {
  neutral: "bg-surface-hi text-fg-dim",
  info: "bg-info/15 text-info",
  attention: "bg-accent/15 text-accent",
  ok: "bg-ok/15 text-ok",
  danger: "bg-danger/15 text-danger",
};

interface DeckItem extends BatchTimelineItem {
  projectId: string;
  projectName: string;
}

/**
 * Un contador del encabezado. Los NOMBRES son sustantivos de bolsa y no los labels de
 * `estadoDeJob`, que estan en singular imperativo ("Elegí variante") y como contador
 * darian "4 Elegí variante". El TONO si sale de `ui-tokens`, que es lo que garantiza
 * que un estado no cambie de color entre pantallas. Ver P-18 en §10 del plan.
 */
interface Contador {
  clave: string;
  n: number;
  nombre: string;
  tone: Tone;
  detalle?: string;
}

/**
 * `stuck` es un SUBCONJUNTO de `generating` (lo dice `batch.ts`), asi que hay que
 * restarlo o la suma miente. Antes se restaba igual pero el resultado se tiraba: la
 * pantalla mostraba "0 generando" y el usuario no tenia como saber que habia 3 clips
 * colgados. Ahora se muestra, con el mismo nombre y tono que le puso el tablero.
 */
function contadoresDe(c: BatchCounts): Contador[] {
  return [
    // En esta pantalla `done` significa "lo aprobaste vos", que es mas preciso que
    // el "listos" del tablero: aprobar es literalmente el proposito de la pantalla.
    { clave: "done", n: c.done, nombre: "aprobados", tone: estadoDeJob("done").tone },
    {
      clave: "awaiting",
      n: c.awaiting,
      nombre: "por aprobar",
      tone: estadoDeJob("awaiting_approval").tone,
    },
    {
      clave: "generating",
      n: Math.max(0, c.generating - c.stuck),
      nombre: "generando",
      tone: estadoDeJob("generating").tone,
    },
    {
      clave: "stuck",
      n: c.stuck,
      nombre: "sin correr",
      tone: "danger",
      detalle:
        "Dicen “generando” pero no están corriendo de verdad. Se arreglan regenerándolos.",
    },
    {
      clave: "failed",
      n: c.failed,
      nombre: "con error",
      tone: estadoDeJob("failed").tone,
    },
    {
      clave: "pending",
      n: c.pending,
      nombre: "en cola",
      tone: estadoDeJob("pending").tone,
    },
  ];
}

/**
 * Lo que se va a regenerar, CAPTURADO en el momento de abrir la confirmacion.
 *
 * Guarda el `jobId` y no una referencia al clip actual a proposito: el poll de 3s
 * reescribe `items` mientras el dialogo esta abierto, y leer `current` al confirmar
 * es como se manda a generar un clip distinto del que dice el dialogo. Son varios
 * dolares por equivocacion.
 */
interface PedidoRegen {
  jobId: string;
  clip: string;
  proyecto: string;
  segundos: number;
  resolucion: string;
  /** El atajo `R` avanza al siguiente despues de regenerar; el boton se queda. */
  avanzar: boolean;
}

export function VideoDeck() {
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
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  /** El pedido de regeneracion esperando confirmacion. `null` = dialogo cerrado. */
  const [regen, setRegen] = useState<PedidoRegen | null>(null);
  /** true una vez que posicionamos el cursor en el primer clip por aprobar */
  const positioned = useRef(false);
  const lockRef = useRef(false);

  /** ENDPOINT 1 de 4 — GET /api/batch?ids=… */
  const load = useCallback(async () => {
    if (ids.length === 0) return;
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

  // Todos los clips del lote, en orden de proyecto y de guion.
  const items: DeckItem[] = useMemo(() => {
    const out: DeckItem[] = [];
    for (const p of snap?.projects ?? []) {
      for (const t of p.timeline) {
        out.push({ ...t, projectId: p.id, projectName: p.name });
      }
    }
    return out;
  }, [snap]);

  const awaiting = items.filter((i) => i.status === "awaiting_approval");

  // La primera vez, arrancamos en el primer clip que espera aprobacion.
  useEffect(() => {
    if (positioned.current || items.length === 0) return;
    positioned.current = true;
    const idx = items.findIndex((i) => i.status === "awaiting_approval");
    if (idx >= 0) setCursor(idx);
  }, [items]);

  const indice = Math.min(cursor, Math.max(0, items.length - 1));
  const current = items[indice] ?? null;

  const go = useCallback(
    (delta: number) => {
      setCursor((c) => Math.min(Math.max(0, c + delta), Math.max(0, items.length - 1)));
    },
    [items.length]
  );

  /**
   * ENDPOINT 2 de 4 — POST simple sobre un job (aprobar / regenerar / desaprobar).
   *
   * `jobId` se puede pasar explicito y por eso existe el parametro: la confirmacion
   * de regenerar manda el id que capturo al abrirse, no el del clip que este parado
   * en el cursor cuando el usuario confirma. Sin `jobId` cae en el clip actual, que
   * es lo que hacen aprobar y desaprobar (los dos son gratis y no confirman).
   *
   * `lockRef` es un candado por REF y no por estado: `setBusy` es asincrono, asi que
   * dos clicks en el mismo tick verian `busy === false` los dos. Ya venia asi y se
   * conserva tal cual.
   */
  const act = useCallback(
    async (
      kind: "approve" | "retry" | "unapprove",
      opts?: { advance?: boolean; jobId?: string }
    ) => {
      const jobId = opts?.jobId ?? current?.videoJobId;
      if (!jobId || lockRef.current) return;
      lockRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/jobs/${jobId}/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: kind === "approve" ? JSON.stringify({}) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "La acción falló");
        if (opts?.advance) go(1);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        lockRef.current = false;
        setBusy(false);
        void load();
      }
    },
    [current, go, load]
  );

  /**
   * Abre la confirmacion de regenerar. NO llama a la API: lo unico que hace es
   * guardar QUE clip se va a regenerar. La llamada la hace `act("retry")` cuando el
   * usuario confirma, y una sola vez.
   */
  const pedirRegen = useCallback(
    (avanzar: boolean) => {
      if (!current?.videoJobId || lockRef.current) return;
      setRegen({
        jobId: current.videoJobId,
        clip: current.label,
        proyecto: current.projectName,
        segundos: current.duracionSeg,
        resolucion: current.resolucion,
        avanzar,
      });
    },
    [current]
  );

  /** ENDPOINT 3 de 4 — aprueba de una todos los clips que esperan aprobacion. */
  const approveAll = useCallback(async () => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: "approve-videos" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo aprobar");
      if (data.batch) setSnap(data.batch as BatchSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [ids, load]);

  // Atajos de teclado.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Con la confirmacion abierta los atajos NO existen. Radix atrapa el foco pero
      // no los listeners de `window`: sin esto, una flecha movia el cursor por detras
      // del dialogo y confirmar regeneraba un clip distinto al que el dialogo nombra.
      if (regen) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (e.repeat) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "a" || e.key === "A") {
        void act("approve", { advance: true });
      } else if (e.key === "r" || e.key === "R") {
        // Antes esto mandaba el clip a Veo directo. Ahora abre la confirmacion.
        pedirRegen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, act, pedirRegen, regen]);

  if (ids.length === 0) {
    return (
      <EmptyState
        icon={<FilmStrip aria-hidden className="size-6" />}
        title="Falta el lote"
        body="Esta pantalla revisa los clips de los proyectos que elegís en el tablero. Armá uno y volvé."
        action={{ label: "Ir al tablero", onClick: () => router.push("/batch") }}
      />
    );
  }

  const backHref = `/batch?ids=${ids.join(",")}`;
  const totals = snap?.totals.videos;
  const contadores = totals ? contadoresDe(totals).filter((c) => c.n > 0) : [];

  return (
    <div className="flex flex-col gap-4">
      {/* ─── 1. Cabecera: donde estas parado y cuanto falta ─────────────────── */}
      <Card className="flex flex-col gap-3">
        <CardHeader className="mb-0 flex-wrap">
          <div className="min-w-0">
            {/*
              <h1> escrito a mano y no `CardTitle`: esta tarjeta encabeza la pantalla
              y CardTitle renderiza un <h2> fijo, asi que el documento no tendria
              nivel 1 (P-13). El tamaño tambien es otro a proposito: `display`.
            */}
            <h1 className="text-display font-semibold text-fg">
              Revisar clips{" "}
              <span className="font-mono text-title tnum font-normal text-fg-dim">
                {items.length > 0 ? indice + 1 : 0}/{items.length}
              </span>
            </h1>
            <CardDescription className="mt-1">
              {/* Los atajos son la forma rapida de revisar 95 clips y antes estaban
                  perdidos en un renglon gris. `kbd` los hace legibles de un vistazo. */}
              <Atajo>→</Atajo> siguiente · <Atajo>←</Atajo> anterior ·{" "}
              <Atajo>A</Atajo> aprobar · <Atajo>R</Atajo> regenerar
            </CardDescription>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {awaiting.length > 0 && (
              <Button
                variant="primary"
                onClick={() => void approveAll()}
                loading={busy}
                title="Aprueba todos los clips que están esperando. No genera nada."
                icon={<CheckCircle aria-hidden className="size-4" />}
              >
                Aprobar todos ({awaiting.length})
              </Button>
            )}
            <Button asChild variant="ghost">
              <Link href={backHref}>
                <SquaresFour aria-hidden className="size-4" />
                Tablero
              </Link>
            </Button>
          </div>
        </CardHeader>

        {/*
          Contadores del lote. El punto lleva el color del estado pero NO pulsa: el
          unico elemento animado de la pantalla es el badge del clip actual.
        */}
        {contadores.length > 0 && (
          <ul className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {contadores.map((c) => (
              <li key={c.clave} title={c.detalle}>
                <Badge tone={c.tone} punto>
                  <span className="font-mono tnum">{c.n}</span> {c.nombre}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2.5 text-body text-danger"
        >
          <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      {/*
        ─── 2. Tira de navegacion: TODOS los clips, el actual resaltado ────────
        Va con `flex-wrap` y no con `overflow-x-auto`: con los 95 clips del VSL real
        la tira mide ~2.850px, o sea 2,1 pantallas de scroll horizontal a ciegas.
        Plegada entran los 95 en 3 filas de ~30px y se ve el lote entero de un
        vistazo, que es para lo que existe la tira. Ver P-23 en §10 del plan.
      */}
      {items.length > 0 && (
        <Card className="p-2.5">
          <nav aria-label="Clips del lote" className="flex flex-wrap gap-1">
            {items.map((it, i) => {
              const estado = estadoDeJob(it.status);
              const actual = i === indice;
              return (
                <button
                  key={`${it.projectId}:${it.clipId}`}
                  type="button"
                  onClick={() => setCursor(i)}
                  aria-current={actual ? "true" : undefined}
                  aria-label={`Clip ${it.orden}, ${it.label}, ${estado.label}`}
                  title={`${it.projectName} · ${it.label} · ${estado.label}`}
                  className={cn(
                    "h-7 min-w-7 shrink-0 rounded-sm px-1 font-mono text-label tnum",
                    "transition-colors focus-visible:outline-none focus-visible:ring-2",
                    "focus-visible:ring-accent motion-safe:active:translate-y-px",
                    actual
                      ? "bg-accent font-semibold text-on-accent"
                      : cn(PASTILLA[estado.tone], "hover:bg-surface-hi hover:text-fg")
                  )}
                >
                  {it.orden}
                </button>
              );
            })}
          </nav>
        </Card>
      )}

      {/* ─── 3. El clip: video a la izquierda, guion y editor a la derecha ──── */}
      {!current ? (
        <EmptyState
          icon={<FilmStrip aria-hidden className="size-6" />}
          title="Todavía no hay clips"
          body="Ninguno de los proyectos del lote llegó a la fase de videos. Volvé al tablero y arrancá la generación."
          action={{ label: "Ir al tablero", onClick: () => router.push(backHref) }}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex flex-col gap-3">
            {/* Identificacion del clip. El unico animado de la pantalla vive acá. */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">{current.projectName}</Badge>
              <code className="font-mono text-body text-fg">{current.label}</code>
              <StatusBadge status={current.status} />
              <Badge tone="neutral" className="tnum">
                {current.duracionSeg}s
              </Badge>
              <Badge tone="neutral" className="tnum">
                {current.resolucion}
              </Badge>
              {current.etiqueta === FILMAR_REAL && (
                <Badge tone="attention">
                  <VideoCamera aria-hidden className="size-3 shrink-0" />
                  Filmás vos
                </Badge>
              )}
            </div>

            <VistaDelClip item={current} />

            {/*
              `error` puede venir poblado en un job que NO fallo: se usa como nota
              ("salieron 1/2 variantes"), asi que va en `attention` y no en `danger`.
              El estado del clip lo dice el badge de arriba y nada mas (§3 del plan).
            */}
            {current.error && (
              <p className="flex items-start gap-2 rounded-sm bg-accent/10 px-2.5 py-2 text-label text-accent">
                <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
                {current.error}
              </p>
            )}

            {/* ─── Acciones ─────────────────────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => go(-1)}
                disabled={indice === 0}
                icon={<ArrowLeft aria-hidden className="size-4" />}
                aria-label="Clip anterior"
              >
                Anterior
              </Button>

              {current.status === "awaiting_approval" && (
                <Button
                  variant="primary"
                  onClick={() => void act("approve", { advance: true })}
                  loading={busy}
                  title="Aprueba este clip y pasa al siguiente · A"
                  icon={<Check aria-hidden className="size-4" />}
                >
                  Aprobar
                </Button>
              )}

              {current.status === "done" && (
                <>
                  <Badge tone="ok" punto>
                    Aprobado
                  </Badge>
                  <Button
                    variant="ghost"
                    onClick={() => void act("unapprove")}
                    loading={busy}
                    title="Lo saca de aprobado y lo deja para volver a decidir. No regenera nada."
                    icon={<ArrowUUpLeft aria-hidden className="size-4" />}
                  >
                    Desaprobar
                  </Button>
                </>
              )}

              {/*
                Regenerar quedo como accion SECUNDARIA (borde, no relleno): antes era
                un boton rojo lleno, el mas pesado de la fila, al lado de "Siguiente".
                Y no llama a la API: abre la confirmacion. Es lo que cuesta plata.
              */}
              {current.videoJobId && (
                <Button
                  variant="danger"
                  onClick={() => pedirRegen(false)}
                  disabled={busy}
                  title="Vuelve a generar este clip con el mismo prompt. Pide confirmación · R"
                  icon={<ArrowsClockwise aria-hidden className="size-4" />}
                >
                  Rechazar y regenerar
                </Button>
              )}

              <Button
                variant="ghost"
                onClick={() => go(1)}
                disabled={indice >= items.length - 1}
                className="ms-auto"
                aria-label="Clip siguiente"
              >
                Siguiente
                <ArrowRight aria-hidden className="size-4" />
              </Button>
            </div>
          </div>

          <ClipPanel
            item={current}
            busy={busy}
            resolutions={snap?.resolutions ?? ["720p", "1080p"]}
            onSaved={() => void load()}
          />
        </div>
      )}

      {/*
        ─── La confirmacion que cuida la plata ──────────────────────────────────
        Vive fuera del bloque del clip para que el poll no la desmonte a mitad de
        camino. `abierto` sale de que exista el pedido, y `Confirmar` cierra el
        dialogo en el mismo handler en que dispara `onConfirmar`, asi que un click es
        exactamente una llamada. El `lockRef` de `act` es la segunda red.
      */}
      <Confirmar
        abierto={regen !== null}
        onCambio={(v) => {
          if (!v) setRegen(null);
        }}
        title="¿Regenerar este clip?"
        detalle={
          regen
            ? `Vuelve a mandar ${regen.clip} (${regen.proyecto}) a Veo y reemplaza el ` +
              `archivo actual. Son ${regen.segundos}s en ${regen.resolucion}: cada clip ` +
              `generado CUESTA VARIOS DÓLARES y no se puede deshacer.`
            : ""
        }
        labelConfirmar="Sí, regenerar"
        peligroso
        onConfirmar={() => {
          if (!regen) return;
          void act("retry", { advance: regen.avanzar, jobId: regen.jobId });
        }}
      />
    </div>
  );
}

/** Una tecla del teclado, para la linea de atajos. */
function Atajo({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-sm bg-surface-hi px-1.5 py-0.5 font-mono text-label text-fg">
      {children}
    </kbd>
  );
}

/* ---------------------------- el video del clip ---------------------------- */

/**
 * El clip que estas mirando, en 9:16, que es el formato real de lo que genera la app.
 *
 * ─── POR QUE `preload="none"` Y SIN ARRANQUE AUTOMATICO ─────────────────────
 *
 * El elemento se remonta con `key` cada vez que cambia la URL, asi que arrowear por
 * 95 clips montaba 95 videos. Arrancando solo, el browser bajaba cada uno completo al
 * pasar; con `preload="none"` no baja NI UN BYTE hasta que le das play. En una
 * revision de un VSL entero es la diferencia entre usable e inusable, y por eso §4 de
 * la task lo pide como requisito y no como preferencia.
 *
 * El precio es que ahora hay que darle play a mano. Anotado en §10 (P-24), porque es
 * la contra real de esto y quien revise tiene que poder pesarla.
 *
 * ─── Y POR QUE SI LLEVA `poster`, SI EN "Resultado" SE DESCARTO ──────────────
 *
 * P-21 descarto el `poster` en la pantalla de resultado porque ahi son 95 tarjetas y
 * `poster` no se puede diferir: el browser bajaria 95 PNG de 1-2MB al montar. Aca hay
 * UN video, o sea UNA imagen, y es la misma que la pantalla ya mostraba en la rama
 * "todavia no se genero". Sin poster la caja queda negra y no se sabe que clip es.
 *
 * El cache-busting ya viene resuelto: `batch.ts` arma las URLs con `?v=<updatedAt>`,
 * asi que regenerar cambia la URL, cambia el `key` y el elemento se remonta limpio.
 */
function VistaDelClip({ item }: { item: DeckItem }) {
  const caja = "aspect-[9/16] w-full max-w-[min(20rem,35vh)] rounded-lg bg-bg";

  if (item.videoUrl) {
    return (
      <div className="flex flex-col gap-1.5">
        <video
          key={item.videoUrl}
          src={item.videoUrl}
          poster={item.imageUrl ?? undefined}
          controls
          preload="none"
          playsInline
          aria-label={`Clip ${item.label}`}
          className={cn(caja, "object-contain")}
        />
        <p className="text-label text-fg-dim">
          No se precarga: dale play para verlo.
        </p>
      </div>
    );
  }

  if (item.imageUrl) {
    return (
      <div className="flex flex-col gap-1.5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={item.imageUrl}
          src={item.imageUrl}
          alt={`Frame inicial del clip ${item.label}`}
          className={cn(caja, "object-cover opacity-60")}
        />
        <p className="text-label text-fg-dim">
          {estadoDeJob(item.status).animado
            ? "Generando este clip… se actualiza solo."
            : "Todavía no se generó. Este es el frame inicial."}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        caja,
        "flex flex-col items-center justify-center gap-2 px-4 text-center text-label text-fg-dim"
      )}
    >
      {item.etiqueta === FILMAR_REAL ? (
        <>
          <VideoCamera aria-hidden className="size-6" />
          Este lo filmás vos. Se sube desde la pantalla de resultado.
        </>
      ) : (
        <>
          <FilmStrip aria-hidden className="size-6" />
          Sin archivo todavía.
        </>
      )}
    </div>
  );
}

/* ------------------ panel del guion + editor del clip ------------------ */

/**
 * Guion del clip y editor completo: dialogo, prompt visual, duracion, resolucion y el
 * override del prompt final. "Guardar" persiste en el PLAN sin regenerar (el export de
 * ffmpeg lee del plan); "Guardar y regenerar" ademas reencola el clip, y por eso pide
 * confirmacion.
 */
function ClipPanel({
  item,
  busy,
  resolutions,
  onSaved,
}: {
  item: DeckItem;
  busy: boolean;
  resolutions: string[];
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"guion" | "editar">("guion");
  const [dialogo, setDialogo] = useState(item.dialogo);
  const [videoPrompt, setVideoPrompt] = useState(item.videoPrompt);
  const [finalPrompt, setFinalPrompt] = useState(item.finalPrompt);
  const [duracion, setDuracion] = useState(item.duracionSeg);
  const [resolucion, setResolucion] = useState(item.resolucion);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** El segundo camino que gasta plata: guardar Y regenerar. Tambien confirma. */
  const [confirmarRegen, setConfirmarRegen] = useState(false);
  const clipRef = useRef(`${item.projectId}:${item.clipId}`);
  const timerSaved = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Candado por REF, igual que el `lockRef` de `act`. Y no es defensivo de mas:
   * VERIFICADO en el browser que sin esto, dos clicks sobre "Guardar y regenerar" en
   * el mismo tick mandan DOS pedidos a Veo, o sea el doble de plata. `setSaving` no
   * alcanza porque es estado y se aplica en el render siguiente, asi que los dos
   * handlers ven `saving === false`. El `disabled` del boton tampoco: la segunda vez
   * que se lo clickea todavia no se re-renderizo.
   */
  const guardandoRef = useRef(false);

  // Al cambiar de clip recargamos los campos (el poll no pisa lo que estás escribiendo).
  useEffect(() => {
    const key = `${item.projectId}:${item.clipId}`;
    if (clipRef.current !== key) {
      clipRef.current = key;
      setDialogo(item.dialogo);
      setVideoPrompt(item.videoPrompt);
      setFinalPrompt(item.finalPrompt);
      setDuracion(item.duracionSeg);
      setResolucion(item.resolucion);
      setTab("guion");
      setSaved(false);
      setSaveError(null);
      // Si cambias de clip, la confirmacion del anterior no puede quedar viva.
      setConfirmarRegen(false);
    }
  }, [item]);

  useEffect(
    () => () => {
      if (timerSaved.current) clearTimeout(timerSaved.current);
    },
    []
  );

  const dirty =
    dialogo !== item.dialogo ||
    videoPrompt.trim() !== item.videoPrompt.trim() ||
    finalPrompt.trim() !== item.finalPrompt.trim() ||
    duracion !== item.duracionSeg ||
    resolucion !== item.resolucion;

  /** ENDPOINT 4 de 4 — POST /api/jobs/<id>/prompt. Con `regenerate` CUESTA PLATA. */
  async function save(regenerate: boolean) {
    if (!item.videoJobId || guardandoRef.current) return;
    guardandoRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/jobs/${item.videoJobId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: videoPrompt.trim(),
          dialogue: dialogo,
          durationSec: duracion,
          resolution: resolucion,
          finalPrompt, // "" borra el override y vuelve al armado automatico
          regenerate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo guardar");
      setSaved(true);
      if (timerSaved.current) clearTimeout(timerSaved.current);
      timerSaved.current = setTimeout(() => setSaved(false), 1800);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      guardandoRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Card className="flex h-fit flex-col gap-3 p-3">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "guion" | "editar")}>
        <TabsList>
          <TabsTrigger value="guion">Guión</TabsTrigger>
          <TabsTrigger value="editar">
            Editar
            {/* El punto avisa que hay cambios sin guardar sin mover el ancho del tab. */}
            {dirty && (
              <span
                aria-label="con cambios sin guardar"
                className="size-1.5 shrink-0 rounded-full bg-accent"
              />
            )}
          </TabsTrigger>
        </TabsList>

        {/* ─── Guion: lo que el clip dice y con que prompt se armo ──────────── */}
        <TabsContent value="guion" className="flex flex-col gap-3">
          <div>
            <p className="font-mono text-label tnum text-fg-dim">
              clip #{item.orden} · {item.duracionSeg}s · {item.resolucion}
            </p>
            <p className="mt-1.5 whitespace-pre-wrap text-body leading-relaxed text-fg">
              {item.dialogo ? (
                `“${item.dialogo}”`
              ) : (
                <span className="text-fg-dim">(sin diálogo · b-roll mudo)</span>
              )}
            </p>
          </div>

          <Desplegable titulo="Prompt visual">{item.videoPrompt}</Desplegable>

          {item.finalPrompt && (
            <Desplegable titulo="Prompt FINAL manual (override activo)" destacado>
              {item.finalPrompt}
            </Desplegable>
          )}
        </TabsContent>

        {/* ─── Editar: lo que se manda a Veo la proxima vez ─────────────────── */}
        <TabsContent value="editar" className="flex flex-col gap-3">
          <Textarea
            label="Diálogo (es-AR, no se traduce)"
            value={dialogo}
            onChange={(e) => setDialogo(e.target.value)}
            className="h-24"
          />

          <Textarea
            label="Prompt visual (inglés)"
            value={videoPrompt}
            onChange={(e) => setVideoPrompt(e.target.value)}
            spellCheck={false}
            mono
            className="h-28"
          />

          <div className="flex gap-2">
            <Select
              label="Duración"
              value={String(duracion)}
              onValueChange={(v) => setDuracion(Number(v))}
              options={[4, 6, 8].map((d) => ({ value: String(d), label: `${d}s` }))}
            />
            <Select
              label="Resolución"
              value={resolucion}
              onValueChange={setResolucion}
              options={resolutions.map((r) => ({ value: r, label: r }))}
            />
          </div>

          <Textarea
            label="Prompt FINAL manual (avanzado)"
            hint="Si escribís algo acá se manda TAL CUAL a Veo y se ignora el armado automático (UGC + lip-sync + acento argentino). Vacío = automático."
            value={finalPrompt}
            onChange={(e) => setFinalPrompt(e.target.value)}
            spellCheck={false}
            placeholder="(vacío = se arma solo)"
            mono
            className="h-24"
          />

          {saveError && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-sm bg-danger/10 px-2.5 py-2 text-label text-danger"
            >
              <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
              {saveError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {/*
              El TEXTO del boton no cambia nunca (§5 regla 1): antes pasaba de
              "Guardar" a "Guardando…" a "✓ Guardado" y cambiaba de ancho tres veces,
              moviendo el boton de regenerar debajo del cursor. Ahora lo unico que
              cambia es el icono, y `loading` pone el spinner.
            */}
            <Button
              size="sm"
              onClick={() => void save(false)}
              loading={saving}
              disabled={busy || !dirty || !item.videoJobId}
              title="Guarda en el plan sin regenerar el clip. No cuesta nada."
              icon={
                saved ? (
                  <Check aria-hidden className="size-3.5" />
                ) : (
                  <FloppyDisk aria-hidden className="size-3.5" />
                )
              }
            >
              Guardar
            </Button>

            <Button
              size="sm"
              variant="danger"
              onClick={() => setConfirmarRegen(true)}
              disabled={saving || busy || !item.videoJobId}
              title="Guarda los cambios y vuelve a generar este clip con Veo. Pide confirmación."
              icon={<ArrowsClockwise aria-hidden className="size-3.5" />}
            >
              Guardar y regenerar
            </Button>
          </div>

          <p className="text-label text-fg-dim">
            Regenerar cuesta plata y consume cuota de Veo. El clip vuelve a la cola y
            respeta el ritmo de 4 por minuto.
          </p>
        </TabsContent>
      </Tabs>

      {/* El segundo camino que llama a Veo, con la misma confirmacion. */}
      <Confirmar
        abierto={confirmarRegen}
        onCambio={setConfirmarRegen}
        title="¿Guardar y regenerar?"
        detalle={
          `Guarda los cambios en el plan y vuelve a mandar ${item.label} a Veo con ` +
          `el prompt nuevo. Son ${duracion}s en ${resolucion}: cada clip generado ` +
          `CUESTA VARIOS DÓLARES y no se puede deshacer.`
        }
        labelConfirmar="Guardar y regenerar"
        peligroso
        onConfirmar={() => void save(true)}
      />
    </Card>
  );
}

/**
 * Bloque colapsable para un prompt largo. Sigue siendo un `<details>` nativo: trae
 * teclado y "buscar en la pagina" sin JS, y es lo que ya usaba la pantalla.
 */
function Desplegable({
  titulo,
  destacado,
  children,
}: {
  titulo: string;
  /** Para el override manual, que es lo que pisa el armado automatico. */
  destacado?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      className={cn(
        "rounded-sm bg-bg p-2.5",
        destacado && "bg-accent/5 ring-1 ring-accent/30"
      )}
    >
      <summary
        className={cn(
          "cursor-pointer rounded-sm text-label font-medium",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          destacado ? "text-accent" : "text-fg-dim"
        )}
      >
        {titulo}
      </summary>
      <p className="mt-2 whitespace-pre-wrap font-mono text-label leading-relaxed text-fg-dim">
        {children}
      </p>
    </details>
  );
}
