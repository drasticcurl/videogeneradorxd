"use client";
/**
 * REVISION DE IMAGENES DE A UNA ("tipo tinder").
 *
 * Toma la cola de imagenes que estan esperando aprobacion en TODO el lote
 * (?ids=a,b,c) y te las muestra una por una:
 *
 *  - Si el proyecto genera varias variantes, las ves juntas y elegís cual aprobar.
 *    Rechazar rechaza TODAS (regenera la imagen completa).
 *  - Si la imagen es image2image, arriba aparecen las imagenes de referencia
 *    (la foto subida o la imagen previa) para comparar la cara.
 *  - A la derecha, el guion: todos los dialogos de los clips que usan esta imagen,
 *    con una pestaña para editarlos (se guardan en el plan).
 *
 * Atajos: → aprobar · ← rechazar y regenerar · S saltar · Z deshacer · 1-4 variante.
 *
 * ─── LOS 7 ENDPOINTS QUE VIVEN EN ESTE ARCHIVO ───────────────────────────────
 *
 * Es la pantalla con mas handlers de la app. El rediseño es VISUAL: los 7 `fetch`
 * quedan con la MISMA url, el MISMO metodo y el MISMO payload. Un payload que cambia
 * de forma es un 400 silencioso, y un `fetch` que se pierde deja un boton que no hace
 * nada, compila y pasa el typecheck. Por eso van listados: el que reescriba esto
 * despues tiene que poder contarlos sin leer las 900 lineas.
 *
 *   1. `load`         GET  /api/batch?ids=…              -> BatchSnapshot. Poll cada 2s.
 *   2. `approve`      POST /api/jobs/:id/approve         { index }
 *   3. `reject`       POST /api/jobs/:id/retry           sin body y sin headers
 *   4. `undo`         POST /api/jobs/:id/unapprove       sin body y sin headers
 *   5. `retryBroken`  POST /api/batch                    { ids, action: "retry-images" }
 *   6. `save` (loop)  POST /api/jobs/:videoJobId/prompt  { dialogue, regenerate: false }
 *   7. `save`         POST /api/jobs/:jobId/prompt       { prompt, regenerate }
 *
 * Los dos ultimos son el MISMO endpoint con payloads distintos y sobre jobs
 * distintos: el 6 toca el job de VIDEO de cada clip (para guardar el dialogo) y el 7
 * el job de IMAGEN que estas revisando (para el prompt visual). Unificarlos manda el
 * dialogo al job equivocado.
 *
 * ─── CUATRO COSAS QUE NO SE TOCAN ────────────────────────────────────────────
 *
 * 1. EL CANDADO ES UN `ref`, NO STATE. `lockRef` corta en seco las acciones dobles.
 *    El state de React se actualiza async, asi que con un click + una tecla (o con
 *    key repeat) se disparaban dos acciones sobre el mismo job, y rechazar dos veces
 *    es GENERAR DOS VECES. Si esto pasa a `useState`, la guarda llega tarde.
 *
 * 2. NO HAY SELECCION MULTIPLE DE TARJETAS, Y NO SE AGREGO. La unica seleccion es de
 *    UNA variante dentro de la imagen actual (`selectedIndex`, teclas 1-4), que es la
 *    que viaja en el payload de aprobar. La cola es de a una a proposito.
 *
 * 3. `snap.review` SON JOBS `awaiting_approval` Y NADA MAS (lo filtra `batch.ts`).
 *    O sea que la tarjeta NUNCA esta fallada, y por lo tanto `item.error` de esta
 *    pantalla es SIEMPRE una nota informativa ("salieron 1/2 variantes"), nunca un
 *    fallo. Se muestra en tono neutro y el job sigue siendo aprobable (§3 del plan).
 *
 * 4. `ScriptPanel` GUARDA LO TIPEADO EN SU PROPIO STATE Y LO SINCRONIZA POR `jobIdRef`.
 *    El poll de 2s reescribe `item` entero; si los campos leyeran de `item` en cada
 *    render, lo que estas escribiendo se perderia dos veces por segundo.
 *
 * Rediseño VISUAL: no cambia ni un endpoint, ni un payload, ni una regla.
 */
import {
  ArrowLeft,
  ArrowRight,
  ArrowUUpLeft,
  ArrowsClockwise,
  Camera,
  Check,
  CheckCircle,
  FloppyDisk,
  ImageSquare,
  Info,
  SkipForward,
  Spinner,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Badge,
  Button,
  EmptyState,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/components/ui";
import type { BatchCounts, BatchReviewItem, BatchSnapshot } from "@/lib/batch";
import { cn } from "@/lib/cn";
import { estadoDeJob, type Tone } from "@/lib/ui-tokens";

const POLL_MS = 2000;

/**
 * Tono -> relleno de la barra de progreso. Mismo mapa (y mismo motivo) que el del
 * tablero: el ESTADO se traduce a tono en `ui-tokens` y aca solo se elige la clase de
 * ese tono, asi que un estado sale del mismo color que su badge. Ni un color literal.
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
  neutral: "bg-surface text-fg-dim",
  info: "bg-info/10 text-info",
  attention: "bg-accent/10 text-accent",
  ok: "bg-ok/10 text-ok",
  danger: "bg-danger/10 text-danger",
};

interface Tramo {
  clave: string;
  n: number;
  tone: Tone;
  animado?: boolean;
}

/**
 * Los contadores del lote como tramos de barra.
 *
 * `stuck` es un SUBCONJUNTO de `generating` (lo dice `batch.ts`), asi que hay que
 * restarlo o la barra suma mas que el total y miente. No tiene entrada en
 * `ui-tokens` porque no es un estado de job sino un contador derivado (P-18): se le
 * da `danger` porque es lo que esta pantalla ya hace con el, contarlo como "roto"
 * junto con los fallados, y el mismo boton arregla los dos.
 */
function tramosDe(c: BatchCounts): Tramo[] {
  const generando = Math.max(0, c.generating - c.stuck);
  const gen = estadoDeJob("generating");
  const todos: Tramo[] = [
    { clave: "done", n: c.done, tone: estadoDeJob("done").tone },
    { clave: "awaiting", n: c.awaiting, tone: estadoDeJob("awaiting_approval").tone },
    { clave: "generating", n: generando, tone: gen.tone, animado: gen.animado },
    { clave: "stuck", n: c.stuck, tone: "danger" },
    { clave: "failed", n: c.failed, tone: estadoDeJob("failed").tone },
    { clave: "pending", n: c.pending, tone: estadoDeJob("pending").tone },
  ];
  return todos.filter((t) => t.n > 0);
}

export function ReviewDeck() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const idsParam = searchParams.get("ids") ?? "";
  const focusId = searchParams.get("focus");

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
  /**
   * Candado SINCRONICO. El state de React se actualiza async, asi que con un click
   * + una tecla (o key repeat) se podian disparar dos acciones sobre el mismo job
   * (y rechazar dos veces = generar dos veces). Con el ref cortamos en seco.
   */
  const lockRef = useRef(false);
  /** jobs ya resueltos localmente (para pasar de card sin esperar el poll) */
  const [resolved, setResolved] = useState<string[]>([]);
  /** jobs salteados: se ven al final */
  const [skipped, setSkipped] = useState<string[]>([]);
  /** ultima aprobacion, para poder deshacerla */
  const [lastApproved, setLastApproved] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [tab, setTab] = useState<"guion" | "editar">("guion");

  const load = useCallback(async () => {
    if (ids.length === 0) return;
    try {
      const res = await fetch(`/api/batch?ids=${ids.join(",")}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo leer el lote");
      setSnap(data as BatchSnapshot);
      // Limpiamos los "resueltos" que el backend ya confirmo que salieron de la cola.
      const stillThere = new Set(
        (data as BatchSnapshot).review.map((r) => r.jobId)
      );
      setResolved((prev) => prev.filter((id) => stillThere.has(id)));
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

  /* --------------------------- cola y card actual --------------------------- */

  const queue = useMemo(() => {
    const review = snap?.review ?? [];
    const pendientes = review.filter((r) => !resolved.includes(r.jobId));
    // Si venís de un card puntual del tablero, ese proyecto va primero.
    if (focusId) {
      return [
        ...pendientes.filter((r) => r.projectId === focusId),
        ...pendientes.filter((r) => r.projectId !== focusId),
      ];
    }
    return pendientes;
  }, [snap, resolved, focusId]);

  const current = useMemo(
    () => queue.find((r) => !skipped.includes(r.jobId)) ?? null,
    [queue, skipped]
  );
  const skippedPending = queue.filter((r) => skipped.includes(r.jobId)).length;

  // Al cambiar de imagen: variante 1 seleccionada y volvemos a la pestaña del guion.
  const currentJobId = current?.jobId ?? null;
  useEffect(() => {
    setSelectedIndex(current?.variants[0]?.index ?? null);
    setTab("guion");
  }, [currentJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------- acciones ------------------------------- */

  const resolve = useCallback((jobId: string) => {
    setResolved((prev) => (prev.includes(jobId) ? prev : [...prev, jobId]));
    setSkipped((prev) => prev.filter((id) => id !== jobId));
  }, []);

  const approve = useCallback(async () => {
    if (!current || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    const jobId = current.jobId;
    try {
      const res = await fetch(`/api/jobs/${jobId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: selectedIndex ?? undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo aprobar");
      resolve(jobId);
      setLastApproved(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [current, selectedIndex, resolve, load]);

  const reject = useCallback(async () => {
    if (!current || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    const jobId = current.jobId;
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "No se pudo regenerar");
      }
      resolve(jobId);
      setLastApproved(null); // no hay nada que deshacer: ya se esta regenerando
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [current, resolve, load]);

  const undo = useCallback(async () => {
    if (!lastApproved || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${lastApproved}/unapprove`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo deshacer");
      setResolved((prev) => prev.filter((id) => id !== lastApproved));
      setLastApproved(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [lastApproved, load]);

  const skip = useCallback(() => {
    if (!current) return;
    setSkipped((prev) => [...prev, current.jobId]);
  }, [current]);

  /**
   * Reintenta las imagenes rotas del lote: las que fallaron y las que quedaron
   * colgadas en "generando" sin estar corriendo (si no, la cola no sigue sola).
   */
  const retryBroken = useCallback(async () => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: "retry-images" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo reintentar");
      if (data.batch) setSnap(data.batch as BatchSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [ids, load]);

  /* ------------------------------- teclado ------------------------------- */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      // No secuestramos las teclas mientras escribís.
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      /*
        Ni mientras el foco esta en una pestaña. Radix usa las flechas para moverse
        entre pestañas, asi que sin esta guarda un → para pasar de "Guión" a "Editar"
        APROBARIA la imagen. Es la unica linea que el rediseño le agrego al handler, y
        esta para tapar el agujero que abrio el rediseño mismo (antes las pestañas
        eran dos <button> sueltos y las flechas no hacian nada ahi).
      */
      if (el?.getAttribute("role") === "tab") return;
      if (e.repeat) return; // sin auto-repeat: una tecla = una decision
      if (e.key === "ArrowRight") {
        e.preventDefault();
        void approve();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        void reject();
      } else if (e.key === "s" || e.key === "S") {
        skip();
      } else if (e.key === "z" || e.key === "Z") {
        void undo();
      } else if (/^[1-4]$/.test(e.key)) {
        const idx = Number(e.key);
        if (current?.variants.some((v) => v.index === idx)) setSelectedIndex(idx);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [approve, reject, skip, undo, current]);

  /* ------------------------------- render ------------------------------- */

  if (ids.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-display font-semibold text-fg">Revisar imágenes</h1>
        <EmptyState
          icon={<ImageSquare aria-hidden className="size-6" />}
          title="Falta el lote"
          body="Esta pantalla revisa las imágenes de los proyectos que armaste en el tablero. Armá uno, elegí los proyectos y volvé: las que estén esperando tu ojo caen acá de a una."
          action={{ label: "Armar un tablero", onClick: () => router.push("/batch") }}
        />
      </div>
    );
  }

  const totals = snap?.totals.images;
  const stuck = totals?.stuck ?? 0;
  // "generando" real = las que estan corriendo de verdad (sin las colgadas).
  const generating = (totals?.generating ?? 0) - stuck;
  const pending = totals?.pending ?? 0;
  const broken = (totals?.failed ?? 0) + stuck;
  const backHref = `/batch?ids=${ids.join(",")}`;
  const enCola = queue.length - skippedPending;
  const tramos = totals ? tramosDe(totals) : [];
  /**
   * Cuantas variantes PIDIO el proyecto. `BatchReviewItem.variants` son las que
   * salieron, asi que sin este dato no se puede decir "1 de 2" y una tanda a la que
   * la cuota le rechazo una variante se ve igual que una completa. Sale del snapshot
   * que ya tenemos: ni un fetch nuevo.
   */
  const pedidasPorProyecto = new Map(
    (snap?.projects ?? []).map((p) => [p.id, p.imageVariants])
  );

  return (
    <div className="space-y-4">
      {/*
        ─── Encabezado: que estas revisando y cuanto falta ───────────────────
        `sticky`: en una cola de 40 imagenes el avance es la unica referencia de
        cuanto queda, y con la imagen en 9:16 hay que scrollear. Si el contador vive
        arriba y se va, no sirve de nada.
      */}
      <header className="sticky top-0 z-20 -mx-4 border-b border-divider bg-bg px-4 pb-3 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-baseline gap-x-2 text-display font-semibold text-fg">
              Revisar imágenes
              {totals && totals.total > 0 && (
                <span className="code tnum text-title font-normal text-fg-dim">
                  <b className="font-semibold text-fg">{totals.done}</b> de{" "}
                  {totals.total} revisadas
                </span>
              )}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge tone={enCola > 0 ? "attention" : "neutral"} className="tnum">
                {enCola} en cola
              </Badge>
              {skippedPending > 0 && (
                <Badge tone="neutral" className="tnum">
                  {skippedPending} salteadas
                </Badge>
              )}
              {generating > 0 && (
                <Badge tone="info" punto animado className="tnum">
                  {generating} generando
                </Badge>
              )}
              {pending > 0 && (
                <Badge tone="neutral" className="tnum">
                  {pending} en fila
                </Badge>
              )}
              {broken > 0 && (
                <Badge tone="danger" className="tnum">
                  {broken} rotas
                </Badge>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {broken > 0 && (
              <Button
                size="sm"
                // Primario solo cuando NO hay nada corriendo: ahi la cola esta
                // trabada y este boton es lo unico que la desatasca.
                variant={generating === 0 ? "primary" : "secondary"}
                loading={busy}
                onClick={() => void retryBroken()}
                icon={<ArrowsClockwise aria-hidden className="size-3.5" />}
                title="Reencola las imágenes falladas y las colgadas en “generando”. Les da presupuesto de reintentos nuevo."
              >
                Reintentar <span className="tnum">{broken}</span> rotas
              </Button>
            )}
            {lastApproved && (
              <Button
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void undo()}
                icon={<ArrowUUpLeft aria-hidden className="size-3.5" />}
                title="Vuelve la última aprobada a la cola. No regenera nada y no gasta cuota · Z"
              >
                Deshacer
              </Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <Link href={backHref}>
                <ArrowLeft aria-hidden className="size-3.5" />
                Tablero
              </Link>
            </Button>
          </div>
        </div>
        {/*
          La barra son los tramos y nada mas, cada uno del ancho de su proporcion
          real: sin riel de fondo, que dibuja algo que no esta en los datos. Va
          `aria-hidden` porque los badges de arriba ya dicen lo mismo en texto.
        */}
        {tramos.length > 0 && (
          <div aria-hidden className="mt-2 flex h-1.5 overflow-hidden rounded-sm">
            {tramos.map((t) => (
              <span
                key={t.clave}
                className={cn(
                  "h-full min-w-px",
                  RELLENO[t.tone],
                  t.animado && "motion-safe:animate-pulse"
                )}
                style={{ width: `${(t.n / (totals?.total || 1)) * 100}%` }}
              />
            ))}
          </div>
        )}
      </header>

      {/* El error del deck: aparece solo, despues de un click, asi que se anuncia. */}
      <div aria-live="polite">
        {error && (
          <p
            role="alert"
            className={cn(
              "flex items-start gap-2 rounded-lg px-3 py-2 text-body",
              AVISO.danger
            )}
          >
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
      </div>

      {!current ? (
        <ColaVacia
          generating={generating}
          pending={pending}
          broken={broken}
          busy={busy}
          onRetryBroken={() => void retryBroken()}
          skippedPending={skippedPending}
          onUnskip={() => setSkipped([])}
          backHref={backHref}
          onIrAlTablero={() => router.push(backHref)}
          allDone={Boolean(totals && totals.total > 0 && totals.done === totals.total)}
        />
      ) : (
        <ReviewCard
          item={current}
          modelos={snap?.imageModels ?? []}
          pedidas={pedidasPorProyecto.get(current.projectId) ?? current.variants.length}
          selectedIndex={selectedIndex}
          onSelectIndex={setSelectedIndex}
          tab={tab}
          onTab={setTab}
          busy={busy}
          onApprove={() => void approve()}
          onReject={() => void reject()}
          onSkip={skip}
          onSaved={() => void load()}
          onRegenerated={(jobId) => {
            resolve(jobId);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ cola vacia ------------------------------ */

/**
 * Los cinco finales posibles de la cola. Se llama `ColaVacia` y no `EmptyState`
 * porque `EmptyState` ahora es la primitiva de `ui/` (§5 del plan) y tener las dos
 * con el mismo nombre en el mismo archivo es un import que se resuelve al que no
 * querias, sin ningun error.
 *
 * Dos de los cinco usan la primitiva tal cual (nada esperando revision, y quedan
 * salteadas). Los otros tres no son un vacio sino un ESTADO del lote —la cola se
 * trabo, todo aprobado, todavia generando— y van como aviso de bloque en el tono que
 * corresponde: la primitiva es un recuadro punteado neutro y aplanaria los tres.
 */
function ColaVacia({
  generating,
  pending,
  broken,
  busy,
  onRetryBroken,
  skippedPending,
  onUnskip,
  backHref,
  onIrAlTablero,
  allDone,
}: {
  generating: number;
  pending: number;
  broken: number;
  busy: boolean;
  onRetryBroken: () => void;
  skippedPending: number;
  onUnskip: () => void;
  backHref: string;
  onIrAlTablero: () => void;
  allDone: boolean;
}) {
  if (skippedPending > 0) {
    return (
      <EmptyState
        icon={<SkipForward aria-hidden className="size-6" />}
        title="Ya revisaste todo lo que había"
        body={`Quedan ${skippedPending} que salteaste para el final. Volvé a verlas y decidí, o dejalas y seguí desde el tablero.`}
        action={{ label: "Volver a verlas", onClick: onUnskip }}
      />
    );
  }
  // Nada esperando revision + nada corriendo + hay roto => la cola quedo trabada.
  if (broken > 0 && generating === 0) {
    return (
      <div
        role="status"
        className={cn("flex flex-col items-start gap-3 rounded-lg p-5", AVISO.attention)}
      >
        <p className="flex items-start gap-2 text-title font-semibold">
          <WarningCircle aria-hidden className="mt-0.5 size-5 shrink-0" />
          La cola se trabó
        </p>
        <p className="max-w-prose text-body text-fg-dim">
          Hay <b className="code tnum font-semibold text-fg">{broken}</b> imágenes con
          error o colgadas en “generando”, y ninguna corriendo. Reintentarlas les da
          presupuesto de reintentos nuevo y la cola arranca de vuelta.
        </p>
        <Button
          variant="primary"
          loading={busy}
          onClick={onRetryBroken}
          icon={<ArrowsClockwise aria-hidden className="size-4" />}
        >
          Reintentar las <span className="tnum">{broken}</span> rotas
        </Button>
      </div>
    );
  }
  if (allDone) {
    return (
      <div
        role="status"
        className={cn("flex flex-col items-start gap-3 rounded-lg p-5", AVISO.ok)}
      >
        <p className="flex items-start gap-2 text-title font-semibold">
          <CheckCircle aria-hidden className="mt-0.5 size-5 shrink-0" />
          Todas las imágenes aprobadas
        </p>
        <p className="max-w-prose text-body text-fg-dim">
          No queda nada por revisar. Volvé al tablero y largá la generación de videos,
          que es el paso que cuesta plata: revisá el guion antes.
        </p>
        <Button asChild variant="primary">
          <Link href={backHref}>Ir al tablero</Link>
        </Button>
      </div>
    );
  }
  if (generating > 0 || pending > 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-start gap-3 rounded-lg bg-surface p-5"
      >
        <p className="flex items-center gap-2 text-title font-semibold text-fg">
          <Spinner aria-hidden className="size-5 text-info motion-safe:animate-spin" />
          Generando
        </p>
        <p className="max-w-prose text-body text-fg-dim">
          <b className="code tnum font-semibold text-fg">{generating}</b> en curso y{" "}
          <b className="code tnum font-semibold text-fg">{pending}</b> en fila. La
          próxima imagen aparece acá sola cuando termina: dejá esta pantalla abierta.
        </p>
        {broken > 0 && (
          <Button
            size="sm"
            loading={busy}
            onClick={onRetryBroken}
            icon={<ArrowsClockwise aria-hidden className="size-3.5" />}
          >
            Reintentar <span className="tnum">{broken}</span> rotas
          </Button>
        )}
      </div>
    );
  }
  return (
    <EmptyState
      icon={<ImageSquare aria-hidden className="size-6" />}
      title="No hay imágenes esperando revisión"
      body="Ninguna imagen del lote está pidiendo tu decisión ahora mismo. Si todavía no arrancaste la generación, se larga desde el tablero."
      action={{ label: "Ir al tablero", onClick: onIrAlTablero }}
    />
  );
}

/* ------------------------------- la card ------------------------------- */

function ReviewCard({
  item,
  modelos,
  pedidas,
  selectedIndex,
  onSelectIndex,
  tab,
  onTab,
  busy,
  onApprove,
  onReject,
  onSkip,
  onSaved,
  onRegenerated,
}: {
  item: BatchReviewItem;
  /** Catalogo de modelos de imagen, para el selector del editor. */
  modelos: { id: string; label: string }[];
  /** Variantes que PIDIO el proyecto, para poder decir "1 de 2". */
  pedidas: number;
  selectedIndex: number | null;
  onSelectIndex: (i: number) => void;
  tab: "guion" | "editar";
  onTab: (t: "guion" | "editar") => void;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onSkip: () => void;
  onSaved: () => void;
  onRegenerated: (jobId: string) => void;
}) {
  const salieron = item.variants.length;
  const multi = salieron > 1;
  /*
    El estado sale de `estadoDeJob` y de ningun switch local (§6.1). Es siempre
    `awaiting_approval` porque `batch.ts` filtra la cola de revision por ese estado, y
    de ahi se sigue lo mas importante de esta pantalla: LA TARJETA NUNCA ESTA FALLADA.
    Menos variantes de las pedidas es estado LEGITIMO (la cuota rechazo una), se
    muestra el conteo real y la nota queda en tono informativo (§3 y §4 del plan).
  */
  const estado = estadoDeJob("awaiting_approval");
  const mostrarConteo = pedidas > 1 && salieron > 0;
  const faltanVariantes = mostrarConteo && salieron < pedidas;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      {/* ---------------------------- lo generado ---------------------------- */}
      <div className="space-y-3">
        {/* Identidad: de que proyecto es, que imagen es y como se genero. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <p className="truncate text-body font-medium text-fg" title={item.projectName}>
            {item.projectName}
          </p>
          <code className="code truncate text-label text-fg-dim" title={item.imageId}>
            {item.imageId}
          </code>
          <Badge tone={estado.tone} punto animado={estado.animado}>
            {estado.label}
          </Badge>
          <Badge tone={item.modo === "image2image" ? "info" : "neutral"}>
            {item.modo}
          </Badge>
          <Badge tone="neutral">{item.assetTipo}</Badge>
          {mostrarConteo && (
            <Badge tone={faltanVariantes ? "attention" : "neutral"} className="tnum">
              {salieron} de {pedidas} variantes
            </Badge>
          )}
          {item.attempts > 1 && (
            <Badge tone="neutral" className="tnum">
              <ArrowsClockwise aria-hidden className="size-3 shrink-0" />
              intento {item.attempts}
            </Badge>
          )}
          {item.model && (
            <code
              className="code max-w-[14rem] truncate text-label text-fg-dim"
              title={`Modelo: ${item.model}`}
            >
              {item.model}
            </code>
          )}
        </div>

        {/* Referencias: para image2image, de donde sale la identidad de la cara. */}
        {item.refs.length > 0 && (
          <section className="rounded-lg bg-surface p-3">
            <h2 className="text-label font-medium text-fg-dim">
              {item.refs.length === 1
                ? "Viene de esta referencia"
                : `Viene de estas ${item.refs.length} referencias`}
              : tiene que ser la misma cara
            </h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {item.refs.map((r) => (
                <li key={r.id} className="w-24 shrink-0">
                  {r.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={r.url}
                      src={r.url}
                      alt={`Referencia: ${r.label}`}
                      decoding="async"
                      className="aspect-[9/16] w-full rounded-sm bg-bg object-cover"
                    />
                  ) : (
                    <div className="flex aspect-[9/16] w-full items-center justify-center rounded-sm border border-dashed border-divider px-1 text-center text-label text-fg-dim">
                      sin archivo
                    </div>
                  )}
                  <p
                    className="mt-1 flex items-center gap-1 text-label text-fg-dim"
                    title={r.label}
                  >
                    {r.kind === "reference" ? (
                      <Camera aria-hidden className="size-3.5 shrink-0" />
                    ) : (
                      <ImageSquare aria-hidden className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{r.label}</span>
                  </p>
                  {/*
                    Una referencia que es otra imagen del proyecto y todavia no esta
                    aprobada: el dato ya venia en el snapshot y no se mostraba en
                    ninguna parte. Importa, porque significa que estas comparando
                    contra algo que todavia puede cambiar.
                  */}
                  {r.pending && <Badge tone="attention">sin aprobar</Badge>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/*
          Las variantes. Es EL contenido de la pantalla, asi que ocupa el espacio:
          ~22rem de ancho por variante, que en 9:16 son ~39rem de alto y entra en una
          pantalla sin scroll. Con una sola variante queda una columna; con 2 a 4, dos.
        */}
        {salieron > 0 ? (
          <div
            role="group"
            aria-label={`Variantes de ${item.imageId}`}
            className={cn(
              "grid gap-2",
              multi ? "max-w-[46rem] grid-cols-2" : "max-w-[23rem] grid-cols-1"
            )}
          >
            {item.variants.map((v) => {
              const active = selectedIndex === v.index;
              return (
                <button
                  key={v.url}
                  type="button"
                  onClick={() => onSelectIndex(v.index)}
                  aria-pressed={active}
                  aria-label={`Elegir la variante ${v.index}`}
                  title={
                    multi
                      ? `Elegir la variante ${v.index} · tecla ${v.index}`
                      : "La única variante que salió"
                  }
                  className={cn(
                    // `border-2` en los dos estados: si solo la elegida tuviera
                    // borde, la imagen cambiaria de tamaño al elegirla y saltaria la
                    // fila entera.
                    "relative overflow-hidden rounded-lg border-2 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    active ? "border-accent" : "border-divider hover:border-border"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={v.url}
                    src={v.url}
                    alt={`Variante ${v.index} de ${item.imageId}`}
                    decoding="async"
                    className="aspect-[9/16] w-full bg-bg object-cover"
                  />
                  {multi && (
                    <span
                      className={cn(
                        "absolute left-2 top-2 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5",
                        "code tnum text-label font-semibold",
                        active ? "bg-accent text-on-accent" : "bg-bg/80 text-fg"
                      )}
                    >
                      {active && <Check aria-hidden className="size-3" />}v{v.index}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          /*
            `awaiting_approval` sin ningun archivo. No es un fallo del job (el estado
            sigue siendo "elegí variante") pero no hay nada que aprobar, asi que el
            boton de aprobar queda deshabilitado y el camino es regenerar.
          */
          <p
            className={cn(
              "flex max-w-prose items-start gap-2 rounded-lg p-3 text-body",
              AVISO.attention
            )}
          >
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            No hay ningún archivo generado para mostrar. Rechazá para volver a
            generarla.
          </p>
        )}

        {/*
          `item.error` en ESTA pantalla es siempre una nota, no un fallo: la cola de
          revision son jobs `awaiting_approval` y el pipeline usa el campo para dejar
          avisos del tipo "salieron 1/2 variantes". Por eso va en tono neutro con
          icono de info. Pintarlo de rojo era el bug de percepcion de la pantalla
          vieja: una tanda perfectamente aprobable parecia rota.
        */}
        {item.error && (
          <p className="flex max-w-prose items-start gap-2 rounded-sm bg-surface-hi p-2 text-label text-fg-dim">
            <Info aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{item.error}</span>
          </p>
        )}

        {/* --------------------------- botonera --------------------------- */}
        {/*
          Rechazar a la IZQUIERDA y aprobar a la DERECHA, igual que las flechas que
          hacen lo mismo: el orden es la mitad del atajo. La jerarquia la da la
          variante y no la posicion — aprobar es `primary` y regenerar `secondary`,
          porque regenerar gasta cuota (§3 de la task).
        */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={onReject}
            icon={<ArrowsClockwise aria-hidden className="size-4" />}
            title="Rechaza TODAS las variantes y vuelve a generar la imagen. Gasta cuota · ←"
          >
            Rechazar y regenerar
          </Button>
          <Button
            variant="primary"
            disabled={busy || salieron === 0}
            onClick={onApprove}
            icon={<Check aria-hidden className="size-4" />}
            title="Aprueba la variante elegida y sigue con la próxima · →"
          >
            Aprobar
            {multi && selectedIndex ? (
              <span className="code tnum">v{selectedIndex}</span>
            ) : null}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={onSkip}
            icon={<SkipForward aria-hidden className="size-4" />}
            title="La deja para el final de la cola · S"
          >
            Saltar
          </Button>
        </div>

        {/*
          Los atajos, al lado de los botones que hacen lo mismo y no arriba en el
          encabezado: es una pantalla que se usa con una mano en el teclado, y la
          leyenda solo sirve si esta donde estas mirando.
        */}
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-label text-fg-dim">
          <li className="flex items-center gap-1.5">
            <Tecla>
              <ArrowRight aria-hidden className="size-3" />
            </Tecla>
            aprobar
          </li>
          <li className="flex items-center gap-1.5">
            <Tecla>
              <ArrowLeft aria-hidden className="size-3" />
            </Tecla>
            rechazar
          </li>
          <li className="flex items-center gap-1.5">
            <Tecla>S</Tecla> saltar
          </li>
          <li className="flex items-center gap-1.5">
            <Tecla>Z</Tecla> deshacer
          </li>
          {multi && (
            <li className="flex items-center gap-1.5">
              <Tecla>1</Tecla>
              <span aria-hidden>–</span>
              <Tecla>{salieron}</Tecla> elegir variante
            </li>
          )}
        </ul>
      </div>

      {/* ----------------------------- guion ----------------------------- */}
      <ScriptPanel
        item={item}
        modelos={modelos}
        tab={tab}
        onTab={onTab}
        busy={busy}
        onSaved={onSaved}
        onRegenerated={onRegenerated}
      />
    </div>
  );
}

/** Una tecla del atajo. `h-5` con `text-label`: nada por debajo de 12px (§4). */
function Tecla({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-sm bg-surface-hi px-1 font-mono text-label font-medium text-fg">
      {children}
    </kbd>
  );
}

/* --------------------------- panel del guion --------------------------- */

function ScriptPanel({
  item,
  modelos,
  tab,
  onTab,
  busy,
  onSaved,
  onRegenerated,
}: {
  item: BatchReviewItem;
  modelos: { id: string; label: string }[];
  tab: "guion" | "editar";
  onTab: (t: "guion" | "editar") => void;
  busy: boolean;
  onSaved: () => void;
  onRegenerated: (jobId: string) => void;
}) {
  const [prompt, setPrompt] = useState(item.prompt);
  const [dialogues, setDialogues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const jobIdRef = useRef(item.jobId);
  /**
   * Modelo con el que se va a regenerar. Arranca en el que genero lo que estas
   * viendo; si el job es viejo y no lo tiene guardado, cae al del proyecto.
   */
  const modeloActual = item.model ?? item.modelDefault;
  const [model, setModel] = useState(modeloActual);

  // Al cambiar de imagen, recargamos los campos editables (sin pisar lo que escribís
  // mientras estás en la misma card: el poll no toca este estado).
  useEffect(() => {
    if (jobIdRef.current !== item.jobId) {
      jobIdRef.current = item.jobId;
      setPrompt(item.prompt);
      setModel(item.model ?? item.modelDefault);
      setDialogues({});
      setSaved(false);
      setSaveError(null);
    }
  }, [item.jobId, item.prompt, item.model, item.modelDefault]);

  const dialogueOf = (clipId: string, original: string) =>
    dialogues[clipId] !== undefined ? dialogues[clipId] : original;

  const promptDirty = prompt.trim() !== item.prompt.trim();
  const modelDirty = model !== modeloActual;
  const dialoguesDirty = item.clips.some(
    (c) => dialogueOf(c.clipId, c.dialogo) !== c.dialogo
  );
  const dirty = promptDirty || modelDirty || dialoguesDirty;

  /** Guarda diálogos (en el job de video de cada clip) y el prompt de la imagen. */
  async function save(regenerate: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      for (const c of item.clips) {
        const value = dialogueOf(c.clipId, c.dialogo);
        if (value === c.dialogo) continue;
        if (!c.hasJob) continue; // FILMAR_REAL: no tiene job de video
        const res = await fetch(`/api/jobs/${c.videoJobId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dialogue: value, regenerate: false }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(
            data.error ?? `No se pudo guardar el diálogo de "${c.clipId}"`
          );
        }
      }

      if (promptDirty || modelDirty || regenerate) {
        const res = await fetch(`/api/jobs/${item.jobId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim(),
            /*
              El modelo va SOLO si lo cambiaste. Mandarlo siempre le fijaria un
              override a este job con el modelo del proyecto, y despues cambiar el
              modelo del proyecto no lo alcanzaria mas.
            */
            ...(modelDirty ? { model } : {}),
            regenerate,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "No se pudo guardar el prompt");
        }
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      if (regenerate) onRegenerated(item.jobId);
      else onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="flex h-fit flex-col rounded-lg bg-surface p-3">
      {/*
        Controlado por el state del deck y no por `defaultValue`: la pestaña vuelve a
        "guion" sola cuando cambia la imagen, y eso lo decide el deck.
      */}
      <Tabs
        value={tab}
        onValueChange={(v) => onTab(v as "guion" | "editar")}
        className="flex min-w-0 flex-col"
      >
        <TabsList>
          <TabsTrigger value="guion">
            Guión <span className="code tnum">({item.clips.length})</span>
          </TabsTrigger>
          <TabsTrigger value="editar" className="inline-flex items-center gap-1.5">
            Editar
            {dirty && (
              <>
                <span aria-hidden className="size-1.5 rounded-full bg-accent" />
                <span className="sr-only">con cambios sin guardar</span>
              </>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ─────────────────────────── leer ─────────────────────────── */}
        <TabsContent value="guion" className="pt-3">
          {item.clips.length === 0 ? (
            <p className="text-body text-fg-dim">
              Ningún clip usa esta imagen todavía.
            </p>
          ) : (
            /*
              Con altura acotada: hay imagenes que aparecen en 8 clips y la lista
              estiraba la pagina, que es justo lo que no queres cuando la referencia
              visual esta al costado y tenes que ir y venir.
            */
            <ul className="max-h-[26rem] space-y-2 overflow-y-auto">
              {item.clips.map((c) => (
                <li key={c.clipId} className="rounded-sm bg-bg p-2.5">
                  <div className="flex items-center justify-between gap-2 text-label text-fg-dim">
                    <span className="code tnum truncate" title={c.clipId}>
                      #{c.orden} · {c.clipId}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="code tnum">{c.duracionSeg}s</span>
                      {c.etiqueta === "FILMAR_REAL" && (
                        <Badge tone="attention">
                          <Camera aria-hidden className="size-3 shrink-0" />
                          a filmar
                        </Badge>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-body leading-relaxed text-fg">
                    {c.dialogo ? (
                      `“${c.dialogo}”`
                    ) : (
                      <span className="text-fg-dim">(sin diálogo · b-roll mudo)</span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {/*
            El prompt visual va COLAPSADO (§3 de la task): es un bloque en ingles de
            varias lineas que no se lee, compite con el guion, y lo que estas
            comparando contra la imagen es el guion. Sin `open` controlado a
            proposito: React no toca el atributo si no se lo pasamos, asi que el poll
            de 2s no le cierra el bloque al usuario.
          */}
          <details className="mt-2 rounded-sm bg-bg">
            <summary
              className={cn(
                "cursor-pointer select-none rounded-sm px-2 py-1.5 text-label text-fg-dim",
                "transition-colors hover:text-fg",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              )}
            >
              Prompt visual de la imagen
            </summary>
            <p className="code whitespace-pre-wrap px-2 pb-2 text-label leading-relaxed text-fg-dim">
              {item.prompt}
            </p>
          </details>
        </TabsContent>

        {/* ────────────────────────── editar ────────────────────────── */}
        <TabsContent value="editar" className="space-y-3 pt-3">
          <Textarea
            label="Prompt visual (inglés)"
            hint="Afecta la imagen: para que se aplique hay que regenerar."
            mono
            rows={5}
            spellCheck={false}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />

          {item.clips.map((c) => (
            <Textarea
              key={c.clipId}
              label={`Diálogo #${c.orden} · ${c.clipId} (${c.duracionSeg}s)`}
              hint={
                c.hasJob
                  ? undefined
                  : "Clip a filmar: no tiene job de video, así que no se edita desde acá."
              }
              rows={3}
              readOnly={!c.hasJob}
              className="read-only:opacity-60"
              value={dialogueOf(c.clipId, c.dialogo)}
              onChange={(e) =>
                setDialogues((prev) => ({ ...prev, [c.clipId]: e.target.value }))
              }
            />
          ))}

          <div aria-live="polite">
            {saveError && (
              <p
                role="alert"
                className={cn(
                  "flex items-start gap-2 rounded-sm p-2 text-label",
                  AVISO.danger
                )}
              >
                <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
                {saveError}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={saving}
              disabled={busy || !dirty}
              onClick={() => void save(false)}
              icon={<FloppyDisk aria-hidden className="size-3.5" />}
              title="Guarda en el plan sin volver a generar (el export de ffmpeg lee del plan)"
            >
              Guardar
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={saving}
              disabled={busy}
              onClick={() => void save(true)}
              icon={<ArrowsClockwise aria-hidden className="size-3.5" />}
              title="Guarda y vuelve a generar la imagen con el prompt nuevo. Gasta cuota."
            >
              Guardar y regenerar
            </Button>
          </div>

          {/*
            El modelo va ABAJO de los botones a pedido: no es lo que tocás siempre,
            pero cuando una imagen sale mal el prompt no es la unica variable. Cambiarlo
            solo escribe el override en ESTE job (el resto del proyecto sigue con el
            suyo), asi que se puede pasar una imagen problematica a Nano Banana Pro sin
            encarecer las otras 39.
          */}
          {modelos.length > 0 && (
            <div className="border-t border-divider pt-3">
              <Select
                label="Modelo para regenerar"
                value={model}
                onValueChange={setModel}
                options={modelos.map((m) => ({ value: m.id, label: m.label }))}
              />
              <p className="mt-1 text-label text-fg-dim">
                {modelDirty ? (
                  <>
                    Cambiado. Apretá{" "}
                    <b className="font-medium text-fg">Guardar y regenerar</b> para
                    generarla de nuevo con este modelo.
                  </>
                ) : (
                  <>Solo afecta a esta imagen, no al resto del proyecto.</>
                )}
              </p>
            </div>
          )}
          {/*
            El "✓ Guardado" va AFUERA del boton: el texto de un boton no cambia
            (§5.1), porque cambiarlo le mueve el ancho y salta la fila.
          */}
          <div aria-live="polite" className="min-h-4">
            {saved && (
              <p className="flex items-center gap-1.5 text-label text-ok">
                <Check aria-hidden className="size-3.5 shrink-0" />
                Guardado en el plan
              </p>
            )}
          </div>
          <p className="text-label text-fg-dim">
            Los diálogos se guardan en el plan y no regeneran nada: los videos todavía
            no se generaron. El prompt visual sí afecta la imagen.
          </p>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
