"use client";
/**
 * REVISAR: unifica /batch/review (imagenes) y /batch/videos (clips) en una sola
 * pantalla con un segmented "Imágenes / Clips".
 *
 * ─── POR QUE UN COMPONENTE COMPARTIDO Y NO DOS PANTALLAS QUE SE REDIRIGEN ────
 *
 * El handoff dice "elegí lo que rompa menos". Redirigir entre rutas al tocar el
 * segmented remonta todo el arbol (se pierde el `lockRef`, el `resolved`/`skipped`
 * en memoria, el candado de guardado) y por un instante se ve la pantalla de carga
 * del otro Suspense. Montar el MISMO componente desde las dos rutas evita eso: el
 * modo es un state (`revMode`) que se sincroniza con `router.replace` (sin
 * recargar) al `?modo=` de la URL, así que cambiar de Imágenes a Clips es tan
 * liviano como cualquier otro cambio de estado de esta pantalla.
 *
 * Las dos rutas existentes siguen funcionando igual que antes: `/batch/review`
 * monta este componente con `modoInicial="img"` y `/batch/videos` con
 * `modoInicial="vid"`. Los bookmarks y el historial de cada una no cambian.
 *
 * ─── LOS 11 ENDPOINTS QUE VIVEN EN ESTE ARCHIVO (7 de imagenes + 4 de clips) ──
 *
 * Ninguno cambia de url, metodo ni payload respecto de `ReviewDeck.tsx` /
 * `VideoDeck.tsx`. Los dos "load" (uno por modo) son el MISMO GET /api/batch
 * (mismo snapshot sirve a los dos modos: no hay motivo para pedirlo dos veces).
 *
 *   Imagenes:
 *   1. `load`         GET  /api/batch?ids=…              -> BatchSnapshot. Poll 2s.
 *   2. `approveImg`    POST /api/jobs/:id/approve         { index }
 *   3. `rejectImg`     POST /api/jobs/:id/retry           sin body y sin headers
 *   4. `undoImg`       POST /api/jobs/:id/unapprove       sin body y sin headers
 *   5. `retryBrokenImg` POST /api/batch                   { ids, action: "retry-images" }
 *   6. `saveImg` (loop) POST /api/jobs/:videoJobId/prompt { dialogue, regenerate: false }
 *   7. `saveImg`        POST /api/jobs/:jobId/prompt      { prompt, model?, regenerate }
 *
 *   Clips:
 *   8. `actVid`         POST /api/jobs/:id/<approve|retry|unapprove>
 *                        body = "{}" solo en approve, si no sin body
 *   9. `approveAllVid`  POST /api/batch                   { ids, action: "approve-videos" }
 *  10. `saveVid`        POST /api/jobs/:videoJobId/prompt { prompt, dialogue, durationSec,
 *                        resolution, finalPrompt, regenerate }
 *
 * (El load de clips reusa el mismo endpoint 1 que imagenes: son 10 fetches
 * distintos en total, no 11 — el GET de /api/batch se cuenta una sola vez.)
 *
 * ─── LO QUE NO SE TOCA, DE LOS DOS ARCHIVOS ORIGINALES ───────────────────────
 *
 * 1. CANDADOS POR `ref`, no state, en los dos modos: una accion doble sobre el
 *    mismo job (click + tecla, o key repeat) generaria dos veces. Ver los `lockRef`
 *    de cada modo.
 * 2. `editando` (los campos que el usuario esta tipeando) vive SEPARADO de
 *    `prompts`/`item` (lo que vino del servidor): el poll de 2-3s reescribe el
 *    snapshot entero, y si los inputs leyeran directo de ahi, lo que estas
 *    escribiendo se perderia varias veces por segundo. Cada panel de edicion tiene
 *    su propio estado local sincronizado por `jobIdRef`/`clipRef`, igual que antes.
 * 3. El gate por lotes (aprobacion manual vs automatica) no lo maneja esta
 *    pantalla: ya viene resuelto en como `batch.ts` arma `review`/`timeline` (solo
 *    entran los jobs en el estado que corresponde). Esta pantalla no le agrega
 *    ninguna regla nueva.
 * 4. La confirmacion antes de regenerar UN CLIP (cuesta varios dolares) se
 *    conserva tal cual, con el mismo `jobId` CAPTURADO al abrir el dialogo y no
 *    leido de `current` al confirmar.
 *
 * Rediseño VISUAL + de layout: no cambia ni un endpoint, ni un payload, ni una
 * regla de negocio.
 */
import {
  ArrowLeft,
  ArrowUUpLeft,
  ArrowsClockwise,
  Camera,
  Check,
  CheckCircle,
  FloppyDisk,
  ImageSquare,
  Info,
  Play,
  SkipForward,
  Spinner,
  VideoCamera,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PantallaFija } from "@/components/Pantalla";
import {
  Badge,
  Button,
  Confirmar,
  EmptyState,
  Kbd,
  Segmented,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/components/ui";
import type {
  BatchReviewItem,
  BatchSnapshot,
  BatchTimelineItem,
} from "@/lib/batch";
import { cn } from "@/lib/cn";
import { estadoDeJob, type Tone } from "@/lib/ui-tokens";

const POLL_MS = 2000;
/** Clip que graba una persona en vez de la IA. El string crudo no se le muestra al usuario. */
const FILMAR_REAL = "FILMAR_REAL";

/** Tono -> fondo y texto de un aviso de bloque. Ver P-14: no hay primitiva. */
const AVISO: Record<Tone, string> = {
  neutral: "bg-surface text-fg-dim",
  info: "bg-info/10 text-info",
  attention: "bg-accent/10 text-accent",
  ok: "bg-ok/10 text-ok",
  danger: "bg-danger/10 text-danger",
};

interface ClipItem extends BatchTimelineItem {
  projectId: string;
  projectName: string;
}

export function ReviewBoard({ modoInicial }: { modoInicial: "img" | "vid" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const idsParam = searchParams.get("ids") ?? "";
  const focusId = searchParams.get("focus");
  /**
   * El modo vive en `?modo=` ADEMAS de `?ids=`, tal como pide el handoff. Se lee de
   * la URL en cada render (no en un `useState` con `useEffect` de sincronizacion):
   * asi un link directo a `/batch/review?ids=...&modo=vid` (por ejemplo, el que
   * arma el tablero para "revisar clips") abre directo en modo clips sin parpadeo.
   */
  const modoUrl = searchParams.get("modo");
  const revMode: "img" | "vid" = modoUrl === "vid" ? "vid" : modoUrl === "img" ? "img" : modoInicial;

  const ids = useMemo(
    () =>
      idsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [idsParam]
  );

  /**
   * Cambia de modo actualizando SOLO `?modo=`, sin tocar `?ids=` ni `?focus=` ni
   * navegar a la otra ruta. `router.replace` (no `push`): pasar de Imagenes a Clips
   * y despues "atras" no tiene por que volver a Imagenes, es el mismo tipo de
   * cambio que elegir una pestaña.
   */
  function setModo(m: "img" | "vid") {
    const params = new URLSearchParams(searchParams.toString());
    params.set("modo", m);
    router.replace(`?${params.toString()}`);
  }

  const [snap, setSnap] = useState<BatchSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const backHref = `/batch?ids=${ids.join(",")}`;

  if (ids.length === 0) {
    return (
      <PantallaFija className="p-4">
        <EmptyState
          icon={<ImageSquare aria-hidden className="size-6" />}
          title="Falta el lote"
          body="Esta pantalla revisa las imágenes y los clips de los proyectos que armaste en el tablero. Armá uno, elegí los proyectos y volvé."
          action={{ label: "Armar un tablero", onClick: () => router.push("/batch") }}
        />
      </PantallaFija>
    );
  }

  return (
    <PantallaFija>
      <CabeceraRevisar
        revMode={revMode}
        onModo={setModo}
        snap={snap}
        backHref={backHref}
      />
      <div className="min-h-0 flex-1 overflow-hidden border-t border-divider">
        {revMode === "img" ? (
          <ModoImagenes snap={snap} error={error} ids={ids} focusId={focusId} load={load} backHref={backHref} />
        ) : (
          <ModoClips snap={snap} error={error} ids={ids} load={load} backHref={backHref} />
        )}
      </div>
    </PantallaFija>
  );
}

/* ══════════════════════════════ cabecera compartida ══════════════════════════════ */

/**
 * Header en una sola fila (pedido del handoff): volver, titulo segun el modo,
 * progreso "x/y aprobadas" y el segmented Imagenes/Clips a la derecha. La tira de
 * pastillas numeradas la pinta cada modo (varian en que cuentan), pero el layout de
 * la fila es unico para no duplicar el maquetado.
 */
function CabeceraRevisar({
  revMode,
  onModo,
  snap,
  backHref,
}: {
  revMode: "img" | "vid";
  onModo: (m: "img" | "vid") => void;
  snap: BatchSnapshot | null;
  backHref: string;
}) {
  const totalesImg = snap?.totals.images;
  const totalesVid = snap?.totals.videos;
  const totales = revMode === "img" ? totalesImg : totalesVid;

  return (
    <header className="flex flex-none flex-wrap items-center gap-3 px-4 py-3">
      <Button asChild variant="ghost" size="sm">
        <Link href={backHref} aria-label="Volver al tablero">
          <ArrowLeft aria-hidden className="size-4" />
        </Link>
      </Button>
      <h1 className="min-w-0 truncate text-title font-semibold text-fg">
        {revMode === "img" ? "Revisar imágenes" : "Revisar clips"}
      </h1>
      {totales && totales.total > 0 && (
        <span className="code tnum whitespace-nowrap text-body text-fg-dim">
          <b className="font-semibold text-fg">{totales.done}</b>/{totales.total}{" "}
          aprobadas
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        <Segmented
          value={revMode}
          onChange={onModo}
          etiqueta="Qué revisar"
          options={[
            { value: "img", label: "Imágenes" },
            { value: "vid", label: "Clips" },
          ]}
        />
      </div>
    </header>
  );
}

/**
 * Tira de pastillas numeradas de 28px, compartida por los dos modos: la actual en
 * accent, las aprobadas en ok/20. `onSeleccionar` es null para el modo imagenes (la
 * cola de revision es FIFO estricto y no se puede saltar a una posicion, ver la
 * nota grande en `ModoImagenes`); en clips si es navegable porque ahi la lista es
 * fija (todos los clips del lote, no una cola que se vacia).
 */
function TiraPastillas<
  T extends { key: string; orden: number; aprobado: boolean; titulo: string; grupo?: string },
>({
  items,
  actualKey,
  onSeleccionar,
}: {
  items: T[];
  actualKey: string | null;
  onSeleccionar: ((key: string) => void) | null;
}) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Progreso de la revisión" className="flex flex-wrap gap-1 px-4 py-2">
      {items.map((it, i) => {
        const actual = it.key === actualKey;
        /*
          SEPARADOR AL CAMBIAR DE PROYECTO. El número de la pastilla es el `orden`
          DENTRO de su proyecto, así que en un lote de varios se repiten: con dos
          proyectos la tira mostraba "1 2 3 4 5 1 2 3 4 5 6 …" y no había forma de
          saber, de un vistazo, dónde termina uno y empieza el otro. El nombre estaba
          sólo en el tooltip, o sea a un hover de distancia de cada pastilla.
        */
        const cambiaGrupo = i > 0 && it.grupo !== undefined && it.grupo !== items[i - 1].grupo;
        const clases = cn(
          "code tnum flex size-7 shrink-0 items-center justify-center rounded-sm text-label font-medium",
          "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          actual
            ? "bg-accent text-on-accent"
            : it.aprobado
              ? "bg-ok/20 text-ok"
              : "bg-surface-hi text-fg-dim"
        );
        const pastilla = onSeleccionar ? (
          <button
            key={it.key}
            type="button"
            onClick={() => onSeleccionar(it.key)}
            aria-current={actual ? "true" : undefined}
            title={it.titulo}
            className={cn(clases, "hover:bg-surface-hi/80")}
          >
            {it.orden}
          </button>
        ) : (
          <span key={it.key} aria-current={actual ? "true" : undefined} title={it.titulo} className={clases}>
            {it.orden}
          </span>
        );
        if (!cambiaGrupo) return pastilla;
        return (
          <Fragment key={`g-${it.key}`}>
            <span
              aria-hidden
              title={it.grupo}
              className="mx-1 h-7 w-px shrink-0 self-center bg-border"
            />
            {pastilla}
          </Fragment>
        );
      })}
    </nav>
  );
}

/* ══════════════════════════════ modo imágenes ══════════════════════════════ */
/*
  Todo lo que sigue en esta seccion es la logica de `ReviewDeck.tsx`, con el mismo
  comportamiento: candado por ref, cola FIFO con `resolved`/`skipped`, deshacer,
  editar prompt/dialogo, y el aviso neutro de "1 de 2 variantes" (nunca rojo, porque
  `snap.review` son siempre jobs `awaiting_approval`).
*/

function ModoImagenes({
  snap,
  error,
  ids,
  focusId,
  load,
  backHref,
}: {
  snap: BatchSnapshot | null;
  error: string | null;
  ids: string[];
  focusId: string | null;
  load: () => Promise<void>;
  backHref: string;
}) {
  const router = useRouter();
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lockRef = useRef(false);
  const [resolved, setResolved] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [lastApproved, setLastApproved] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [tab, setTab] = useState<"guion" | "editar">("guion");

  useEffect(() => {
    if (!snap) return;
    const stillThere = new Set(snap.review.map((r) => r.jobId));
    setResolved((prev) => prev.filter((id) => stillThere.has(id)));
  }, [snap]);

  const queue = useMemo(() => {
    const review = snap?.review ?? [];
    const pendientes = review.filter((r) => !resolved.includes(r.jobId));
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

  const currentJobId = current?.jobId ?? null;
  useEffect(() => {
    setSelectedIndex(current?.variants[0]?.index ?? null);
    setTab("guion");
  }, [currentJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolve = useCallback((jobId: string) => {
    setResolved((prev) => (prev.includes(jobId) ? prev : [...prev, jobId]));
    setSkipped((prev) => prev.filter((id) => id !== jobId));
  }, []);

  /** ENDPOINT 2 — POST /api/jobs/:id/approve { index } */
  const approve = useCallback(async () => {
    if (!current || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setLocalError(null);
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
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [current, selectedIndex, resolve, load]);

  /** ENDPOINT 3 — POST /api/jobs/:id/retry, sin body */
  const reject = useCallback(async () => {
    if (!current || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setLocalError(null);
    const jobId = current.jobId;
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "No se pudo regenerar");
      }
      resolve(jobId);
      setLastApproved(null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [current, resolve, load]);

  /** ENDPOINT 4 — POST /api/jobs/:id/unapprove, sin body */
  const undo = useCallback(async () => {
    if (!lastApproved || lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch(`/api/jobs/${lastApproved}/unapprove`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo deshacer");
      setResolved((prev) => prev.filter((id) => id !== lastApproved));
      setLastApproved(null);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
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

  /** ENDPOINT 5 — POST /api/batch { ids, action: "retry-images" } */
  const retryBroken = useCallback(async () => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: "retry-images" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo reintentar");
      if (data.batch) void load();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [ids, load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      // Ni con el foco en una pestaña: Radix usa las flechas para navegar entre
      // pestañas, y sin esta guarda "→" pasaria de "Guión" a "Editar" Y aprobaria.
      if (el?.getAttribute("role") === "tab") return;
      if (e.repeat) return;
      if (e.key === "ArrowRight" || e.key === "a" || e.key === "A") {
        /*
          `A` ADEMAS de `→`, que es lo que pide el handoff ("A o → aprueba").
          Faltaba, y la inconsistencia dolía justamente acá: es la MISMA pantalla que
          la de clips, se cambia de modo con el segmented, y en clips `A` aprueba. O
          sea que el mismo teclado hacía dos cosas distintas según el modo, sin nada
          que lo anunciara. El badge del botón sigue mostrando `→` (el handoff lo pide
          así para imágenes), pero las dos teclas funcionan.
        */
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

  const totals = snap?.totals.images;
  const stuck = totals?.stuck ?? 0;
  const generating = (totals?.generating ?? 0) - stuck;
  const pending = totals?.pending ?? 0;
  const broken = (totals?.failed ?? 0) + stuck;
  const enCola = queue.length - skippedPending;
  const pedidasPorProyecto = new Map((snap?.projects ?? []).map((p) => [p.id, p.imageVariants]));

  // La tira de pastillas de imagenes es SOLO informativa (no navegable): es una
  // cola FIFO que se va vaciando a medida que aprobas/rechazas, no una lista fija
  // como los clips. Saltar a la pastilla "5" no tiene sentido si la 5 ya se resolvio
  // y desaparecio de la cola. Se pintan las resueltas (aprobadas O regeneradas) en
  // ok/20 y la actual en accent, en el orden FIFO real.
  const pastillas = (snap?.review ?? []).map((r, i) => ({
    key: r.jobId,
    orden: i + 1,
    aprobado: resolved.includes(r.jobId) && r.jobId !== current?.jobId,
    titulo: `${r.projectName} · ${r.imageId}`,
    grupo: r.projectName,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TiraPastillas items={pastillas} actualKey={current?.jobId ?? null} onSeleccionar={null} />

      <div aria-live="polite" className="flex-none px-4">
        {(error || localError) && (
          <p role="alert" className={cn("mb-2 flex items-start gap-2 rounded-lg px-3 py-2 text-body", AVISO.danger)}>
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error || localError}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {!current ? (
          <ColaVaciaImagenes
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
          <TarjetaImagen
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
    </div>
  );
}

function ColaVaciaImagenes({
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
  if (broken > 0 && generating === 0) {
    return (
      <div role="status" className={cn("flex flex-col items-start gap-3 rounded-lg p-5", AVISO.attention)}>
        <p className="flex items-start gap-2 text-title font-semibold">
          <WarningCircle aria-hidden className="mt-0.5 size-5 shrink-0" />
          La cola se trabó
        </p>
        <p className="max-w-prose text-body text-fg-dim">
          Hay <b className="code tnum font-semibold text-fg">{broken}</b> imágenes con
          error o colgadas en “generando”, y ninguna corriendo. Reintentarlas les da
          presupuesto de reintentos nuevo y la cola arranca de vuelta.
        </p>
        <Button variant="primary" loading={busy} onClick={onRetryBroken} icon={<ArrowsClockwise aria-hidden className="size-4" />}>
          Reintentar las <span className="tnum">{broken}</span> rotas
        </Button>
      </div>
    );
  }
  if (allDone) {
    return (
      <div role="status" className={cn("flex flex-col items-start gap-3 rounded-lg p-5", AVISO.ok)}>
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
      <div role="status" aria-live="polite" className="flex flex-col items-start gap-3 rounded-lg bg-surface p-5">
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
          <Button size="sm" loading={busy} onClick={onRetryBroken} icon={<ArrowsClockwise aria-hidden className="size-3.5" />}>
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

/**
 * Tarjeta de UNA imagen a revisar. Layout nuevo del handoff: grid
 * `minmax(0,1fr) | minmax(300px,380px)` a alto completo con container query para el
 * medio, en vez del grid de 2 columnas con scroll de pagina que tenia antes.
 */
function TarjetaImagen({
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
  modelos: { id: string; label: string }[];
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
  const estado = estadoDeJob("awaiting_approval");
  const mostrarConteo = pedidas > 1 && salieron > 0;
  const faltanVariantes = mostrarConteo && salieron < pedidas;

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
      {/* ---------------------------- lo generado ---------------------------- */}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-3">
          <p className="truncate text-body font-medium text-fg" title={item.projectName}>
            {item.projectName}
          </p>
          <code className="code truncate text-label text-fg-dim" title={item.imageId}>
            {item.imageId}
          </code>
          <Badge tone={estado.tone} punto animado={estado.animado}>
            {estado.label}
          </Badge>
          <Badge tone={item.modo === "image2image" ? "info" : "neutral"}>{item.modo}</Badge>
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
        </div>

        {item.refs.length > 0 && (
          <section className="rounded-lg bg-surface p-3">
            <h2 className="text-label font-medium text-fg-dim">
              {item.refs.length === 1 ? "Viene de esta referencia" : `Viene de estas ${item.refs.length} referencias`}
              : tiene que ser la misma cara
            </h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {item.refs.map((r) => (
                <li key={r.id} className="w-20 shrink-0">
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
                  <p className="mt-1 flex items-center gap-1 text-label text-fg-dim" title={r.label}>
                    {r.kind === "reference" ? (
                      <Camera aria-hidden className="size-3.5 shrink-0" />
                    ) : (
                      <ImageSquare aria-hidden className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate">{r.label}</span>
                  </p>
                  {r.pending && <Badge tone="attention">sin aprobar</Badge>}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/*
          El medio al ALTO COMPLETO con container queries: `cq-size` (definida en
          globals.css) hace que el contenedor mida su alto real, y cada item pide
          `height: min(100cqh, ...)` con aspect-ratio 9/16 para no desbordar ni
          angostarse de mas con 2+ variantes.
        */}
        {salieron > 0 ? (
          <div className="cq-size min-h-0 flex-1">
            <div
              role="group"
              aria-label={`Variantes de ${item.imageId}`}
              className="flex h-full items-center justify-center gap-2"
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
                    title={multi ? `Elegir la variante ${v.index} · tecla ${v.index}` : "La única variante que salió"}
                    style={{
                      height: `min(100cqh, calc((100cqw - ${(salieron - 1) * 8}px) / ${salieron} * 1.7778))`,
                    }}
                    className={cn(
                      "relative aspect-[9/16] overflow-hidden rounded-lg border-2 transition-colors",
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
                      className="h-full w-full bg-bg object-cover"
                    />
                    {active && (
                      <span className="absolute bottom-2 right-2 flex size-[22px] items-center justify-center rounded-full bg-accent text-on-accent">
                        <Check aria-hidden className="size-3.5" />
                      </span>
                    )}
                    {multi && (
                      <span
                        className={cn(
                          "absolute left-2 top-2 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5",
                          "code tnum text-label font-semibold",
                          active ? "bg-accent text-on-accent" : "bg-bg/80 text-fg"
                        )}
                      >
                        v{v.index}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <p className={cn("flex max-w-prose items-start gap-2 rounded-lg p-3 text-body", AVISO.attention)}>
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            No hay ningún archivo generado para mostrar. Rechazá para volver a generarla.
          </p>
        )}

        {item.error && (
          <p className="flex max-w-prose items-start gap-2 rounded-sm bg-surface-hi p-2 text-label text-fg-dim">
            <Info aria-hidden className="mt-px size-3.5 shrink-0" />
            <span>{item.error}</span>
          </p>
        )}

        {/* --------------------------- botonera con Kbd --------------------------- */}
        <div className="flex flex-none flex-wrap items-center gap-2 pb-3 pt-1">
          <Button
            variant="danger"
            disabled={busy}
            onClick={onReject}
            icon={<ArrowsClockwise aria-hidden className="size-4" />}
            title="Rechaza TODAS las variantes y vuelve a generar la imagen. Gasta cuota · ←"
          >
            Rechazar las dos <Kbd>←</Kbd>
          </Button>
          <Button
            variant="primary"
            disabled={busy || salieron === 0}
            onClick={onApprove}
            icon={<Check aria-hidden className="size-4" />}
            title="Aprueba la variante elegida y sigue con la próxima · →"
          >
            Aprobar y seguir <Kbd sobreAccent>→</Kbd>
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onSkip} icon={<SkipForward aria-hidden className="size-4" />} title="La deja para el final de la cola · S">
            Saltar <Kbd>S</Kbd>
          </Button>
        </div>
      </div>

      {/* ----------------------------- panel derecho ----------------------------- */}
      <PanelImagen item={item} modelos={modelos} tab={tab} onTab={onTab} busy={busy} onSaved={onSaved} onRegenerated={onRegenerated} />
    </div>
  );
}

/* --------------------------- panel derecho: imagen --------------------------- */

function PanelImagen({
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
  /**
   * `editando` es SOLO lo que el usuario esta tipeando, separado de `item`/`prompts`
   * (lo que vino del servidor). El poll de 2s pisa `item` entero; si estos campos
   * leyeran de ahi en cada render, lo que estas escribiendo se perderia dos veces
   * por segundo. `jobIdRef` es el unico punto donde se resetea a proposito: al
   * cambiar de imagen.
   */
  const [prompt, setPrompt] = useState(item.prompt);
  const [dialogues, setDialogues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const jobIdRef = useRef(item.jobId);
  const modeloActual = item.model ?? item.modelDefault;
  const [model, setModel] = useState(modeloActual);

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
  const dialoguesDirty = item.clips.some((c) => dialogueOf(c.clipId, c.dialogo) !== c.dialogo);
  const dirty = promptDirty || modelDirty || dialoguesDirty;

  /** ENDPOINTS 6 y 7 — dialogo por clip y prompt/modelo de la imagen. */
  async function save(regenerate: boolean) {
    setSaving(true);
    setSaveError(null);
    try {
      for (const c of item.clips) {
        const value = dialogueOf(c.clipId, c.dialogo);
        if (value === c.dialogo) continue;
        if (!c.hasJob) continue;
        const res = await fetch(`/api/jobs/${c.videoJobId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dialogue: value, regenerate: false }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `No se pudo guardar el diálogo de "${c.clipId}"`);
        }
      }

      if (promptDirty || modelDirty || regenerate) {
        const res = await fetch(`/api/jobs/${item.jobId}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim(),
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
    <aside className="flex min-h-0 flex-col overflow-y-auto bg-surface p-3">
      <Tabs value={tab} onValueChange={(v) => onTab(v as "guion" | "editar")} className="flex min-w-0 flex-col">
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

        <TabsContent value="guion" className="pt-3">
          {item.clips.length === 0 ? (
            <p className="text-body text-fg-dim">Ningún clip usa esta imagen todavía.</p>
          ) : (
            <ul className="space-y-2">
              {item.clips.map((c) => (
                <li key={c.clipId} className="rounded-sm bg-bg p-2.5">
                  <div className="flex items-center justify-between gap-2 text-label text-fg-dim">
                    <span className="code tnum truncate" title={c.clipId}>
                      #{c.orden} · {c.clipId}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="code tnum">{c.duracionSeg}s</span>
                      {c.etiqueta === FILMAR_REAL && (
                        <Badge tone="attention">
                          <Camera aria-hidden className="size-3 shrink-0" />
                          a filmar
                        </Badge>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-body leading-relaxed text-fg">
                    {c.dialogo ? `“${c.dialogo}”` : <span className="text-fg-dim">(sin diálogo · b-roll mudo)</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}
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
            <p className="code whitespace-pre-wrap px-2 pb-2 text-label leading-relaxed text-fg-dim">{item.prompt}</p>
          </details>
        </TabsContent>

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
              hint={c.hasJob ? undefined : "Clip a filmar: no tiene job de video, así que no se edita desde acá."}
              rows={3}
              readOnly={!c.hasJob}
              className="read-only:opacity-60"
              value={dialogueOf(c.clipId, c.dialogo)}
              onChange={(e) => setDialogues((prev) => ({ ...prev, [c.clipId]: e.target.value }))}
            />
          ))}

          <div aria-live="polite">
            {saveError && (
              <p role="alert" className={cn("flex items-start gap-2 rounded-sm p-2 text-label", AVISO.danger)}>
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
                    Cambiado. Apretá <b className="font-medium text-fg">Guardar y regenerar</b> para generarla de nuevo con este modelo.
                  </>
                ) : (
                  <>Solo afecta a esta imagen, no al resto del proyecto.</>
                )}
              </p>
            </div>
          )}
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

/* ══════════════════════════════ modo clips ══════════════════════════════ */
/*
  Logica de `VideoDeck.tsx`: candado por ref, confirmacion antes de regenerar (con
  el jobId CAPTURADO al abrir), un solo <video> montado con preload="none".
*/

function ModoClips({
  snap,
  error,
  ids,
  load,
  backHref,
}: {
  snap: BatchSnapshot | null;
  error: string | null;
  ids: string[];
  load: () => Promise<void>;
  backHref: string;
}) {
  const router = useRouter();
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [regen, setRegen] = useState<{
    jobId: string;
    clip: string;
    proyecto: string;
    segundos: number;
    resolucion: string;
    avanzar: boolean;
  } | null>(null);
  const positioned = useRef(false);
  const lockRef = useRef(false);

  const items: ClipItem[] = useMemo(() => {
    const out: ClipItem[] = [];
    for (const p of snap?.projects ?? []) {
      for (const t of p.timeline) {
        out.push({ ...t, projectId: p.id, projectName: p.name });
      }
    }
    return out;
  }, [snap]);

  const awaiting = items.filter((i) => i.status === "awaiting_approval");

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

  /** ENDPOINT 8 — POST /api/jobs/:id/<approve|retry|unapprove> */
  const act = useCallback(
    async (kind: "approve" | "retry" | "unapprove", opts?: { advance?: boolean; jobId?: string }) => {
      const jobId = opts?.jobId ?? current?.videoJobId;
      if (!jobId || lockRef.current) return;
      lockRef.current = true;
      setBusy(true);
      setLocalError(null);
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
        setLocalError(err instanceof Error ? err.message : String(err));
      } finally {
        lockRef.current = false;
        setBusy(false);
        void load();
      }
    },
    [current, go, load]
  );

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

  /** ENDPOINT 9 — POST /api/batch { ids, action: "approve-videos" } */
  const approveAll = useCallback(async () => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action: "approve-videos" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "No se pudo aprobar");
      if (data.batch) void load();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      lockRef.current = false;
      setBusy(false);
      void load();
    }
  }, [ids, load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (regen) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
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
        pedirRegen(true);
      } else if (e.key === "s" || e.key === "S") {
        go(1);
      } else if (e.key === "z" || e.key === "Z") {
        void act("unapprove");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, act, pedirRegen, regen]);

  const totals = snap?.totals.videos;

  // Tira de pastillas NAVEGABLE (a diferencia de imagenes): la lista de clips es
  // fija (todo el lote), no una cola FIFO que se vacia, asi que saltar a cualquier
  // posicion tiene sentido siempre.
  const pastillas = items.map((it, i) => ({
    key: `${it.projectId}:${it.clipId}`,
    orden: it.orden,
    aprobado: it.status === "done",
    titulo: `${it.projectName} · ${it.label} · ${estadoDeJob(it.status).label}`,
    grupo: it.projectName,
    _i: i,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TiraPastillas
        items={pastillas}
        actualKey={current ? `${current.projectId}:${current.clipId}` : null}
        onSeleccionar={(key) => {
          const idx = pastillas.findIndex((p) => p.key === key);
          if (idx >= 0) setCursor(idx);
        }}
      />

      <div aria-live="polite" className="flex-none px-4">
        {(error || localError) && (
          <p role="alert" className={cn("mb-2 flex items-start gap-2 rounded-lg px-3 py-2 text-body", AVISO.danger)}>
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {error || localError}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {!current ? (
          <EmptyState
            icon={<VideoCamera aria-hidden className="size-6" />}
            title="Todavía no hay clips"
            body="Ninguno de los proyectos del lote llegó a la fase de videos. Volvé al tablero y arrancá la generación."
            action={{ label: "Ir al tablero", onClick: () => router.push(backHref) }}
          />
        ) : (
          <TarjetaClip
            item={current}
            anterior={items[indice - 1] ?? null}
            siguiente={items[indice + 1] ?? null}
            busy={busy}
            resolutions={snap?.resolutions ?? ["720p", "1080p"]}
            awaitingCount={awaiting.length}
            onApproveAll={() => void approveAll()}
            onApprove={() => void act("approve", { advance: true })}
            onUnapprove={() => void act("unapprove")}
            onSkip={() => go(1)}
            onRegen={() => pedirRegen(false)}
            onSaved={() => void load()}
          />
        )}
      </div>

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

/**
 * Tarjeta de UN clip. Layout del handoff: 9:16 al alto completo con container
 * query (mismo mecanismo que las imagenes, `cq-size` + `min(100cqh, ...)`) y un
 * boton de play adentro en vez de arranque automatico.
 */
function TarjetaClip({
  item,
  anterior,
  siguiente,
  busy,
  resolutions,
  awaitingCount,
  onApproveAll,
  onApprove,
  onUnapprove,
  onSkip,
  onRegen,
  onSaved,
}: {
  item: ClipItem;
  anterior: ClipItem | null;
  siguiente: ClipItem | null;
  busy: boolean;
  resolutions: string[];
  awaitingCount: number;
  onApproveAll: () => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onSkip: () => void;
  onRegen: () => void;
  onSaved: () => void;
}) {
  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center gap-2 pt-3">
          <Badge tone="neutral">{item.projectName}</Badge>
          <code className="code text-body text-fg">{item.label}</code>
          <Badge tone={estadoDeJob(item.status).tone} punto animado={estadoDeJob(item.status).animado}>
            {estadoDeJob(item.status).label}
          </Badge>
          <Badge tone="neutral" className="tnum">
            {item.duracionSeg}s
          </Badge>
          <Badge tone="neutral" className="tnum">
            {item.resolucion}
          </Badge>
          {item.etiqueta === FILMAR_REAL && (
            <Badge tone="attention">
              <VideoCamera aria-hidden className="size-3 shrink-0" />
              Filmás vos
            </Badge>
          )}
          {awaitingCount > 0 && (
            <Button variant="secondary" size="sm" className="ml-auto" onClick={onApproveAll} title="Aprueba todos los clips que están esperando. No genera nada.">
              <CheckCircle aria-hidden className="size-3.5" />
              Aprobar todos <span className="code tnum">{awaitingCount}</span>
            </Button>
          )}
        </div>

        <div className="cq-size min-h-0 flex-1">
          <div className="flex h-full items-center justify-center">
            <VistaDelClip item={item} />
          </div>
        </div>

        {item.error && (
          <p className="flex items-start gap-2 rounded-sm bg-accent/10 px-2.5 py-2 text-label text-accent">
            <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
            {item.error}
          </p>
        )}

        <div className="flex flex-none flex-wrap items-center gap-2 pb-3 pt-1">
          {item.videoJobId && (
            <Button
              variant="danger"
              onClick={onRegen}
              disabled={busy}
              title="Vuelve a generar este clip con el mismo prompt. Pide confirmación · R"
              icon={<ArrowsClockwise aria-hidden className="size-4" />}
            >
              Regenerar <Kbd>R</Kbd>
            </Button>
          )}
          {item.status === "awaiting_approval" && (
            <Button variant="primary" onClick={onApprove} loading={busy} title="Aprueba este clip y pasa al siguiente · A" icon={<Check aria-hidden className="size-4" />}>
              Aprobar y seguir <Kbd sobreAccent>A</Kbd>
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={onSkip}
            disabled={busy}
            title="Pasa al siguiente clip sin decidir · S"
            icon={<SkipForward aria-hidden className="size-4" />}
          >
            Saltar <Kbd>S</Kbd>
          </Button>
          {item.status === "done" && (
            <Button
              variant="ghost"
              onClick={onUnapprove}
              loading={busy}
              title="Lo saca de aprobado y lo deja para volver a decidir. No regenera nada · Z"
              icon={<ArrowUUpLeft aria-hidden className="size-4" />}
            >
              Deshacer <Kbd>Z</Kbd>
            </Button>
          )}
        </div>
      </div>

      <PanelClip item={item} anterior={anterior} siguiente={siguiente} busy={busy} resolutions={resolutions} onSaved={onSaved} />
    </div>
  );
}

/**
 * El video del clip actual. `preload="none"`: el elemento se remonta con `key` al
 * cambiar de clip, y sin esto arrowear por 95 clips bajaria 95 videos completos.
 * Con esto no baja NI UN BYTE hasta que el usuario le da play.
 */
function VistaDelClip({ item }: { item: ClipItem }) {
  const caja = "relative flex aspect-[9/16] max-h-full items-center justify-center rounded-lg bg-bg";

  if (item.videoUrl) {
    return (
      <div className={cn(caja, "overflow-hidden")}>
        <video
          key={item.videoUrl}
          src={item.videoUrl}
          poster={item.imageUrl ?? undefined}
          controls
          preload="none"
          playsInline
          aria-label={`Clip ${item.label}`}
          className="h-full w-full object-contain"
        />
      </div>
    );
  }

  if (item.imageUrl) {
    return (
      <div className={cn(caja, "overflow-hidden")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={item.imageUrl}
          src={item.imageUrl}
          alt={`Frame inicial del clip ${item.label}`}
          className="h-full w-full object-cover opacity-60"
        />
        <span className="absolute inline-flex size-14 items-center justify-center rounded-full bg-bg/70 text-fg">
          <Play aria-hidden className="size-6" />
        </span>
      </div>
    );
  }

  return (
    <div className={cn(caja, "flex-col gap-2 px-4 text-center text-label text-fg-dim")}>
      {item.etiqueta === FILMAR_REAL ? (
        <>
          <VideoCamera aria-hidden className="size-6" />
          Este lo filmás vos. Se sube desde la pantalla de resultado.
        </>
      ) : (
        <>
          <Info aria-hidden className="size-6" />
          Sin archivo todavía.
        </>
      )}
    </div>
  );
}

/* --------------------------- panel derecho: clip --------------------------- */

function PanelClip({
  item,
  anterior,
  siguiente,
  busy,
  resolutions,
  onSaved,
}: {
  item: ClipItem;
  anterior: ClipItem | null;
  siguiente: ClipItem | null;
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
  const [confirmarRegen, setConfirmarRegen] = useState(false);
  const clipRef = useRef(`${item.projectId}:${item.clipId}`);
  const timerSaved = useRef<ReturnType<typeof setTimeout> | null>(null);
  const guardandoRef = useRef(false);

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
      setConfirmarRegen(false);
    }
  }, [item]);

  useEffect(() => () => {
    if (timerSaved.current) clearTimeout(timerSaved.current);
  }, []);

  const dirty =
    dialogo !== item.dialogo ||
    videoPrompt.trim() !== item.videoPrompt.trim() ||
    finalPrompt.trim() !== item.finalPrompt.trim() ||
    duracion !== item.duracionSeg ||
    resolucion !== item.resolucion;

  /** ENDPOINT 10 — POST /api/jobs/:id/prompt, con `regenerate` CUESTA PLATA. */
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
          finalPrompt,
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
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto bg-surface p-3">
      <Tabs value={tab} onValueChange={(v) => setTab(v as "guion" | "editar")}>
        <TabsList>
          <TabsTrigger value="guion">Guión</TabsTrigger>
          <TabsTrigger value="editar" className="inline-flex items-center gap-1.5">
            Editar
            {dirty && <span aria-label="con cambios sin guardar" className="size-1.5 shrink-0 rounded-full bg-accent" />}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="guion" className="flex flex-col gap-3">
          {/*
            Pedido del handoff: se ve el clip anterior, el actual (resaltado) y el
            siguiente, no solo el actual — asi se chequea la continuidad del guion
            sin ir y venir con las flechas. `anterior`/`siguiente` son de solo
            lectura (no tienen edicion: para eso esta "Editar", que sigue siendo
            del clip ACTUAL nada mas).
          */}
          <ol className="space-y-2">
            {anterior && (
              <li className="opacity-60">
                <ClipDeGuion clip={anterior} />
              </li>
            )}
            <li className="rounded-sm bg-bg p-2.5 ring-1 ring-accent/40">
              <p className="font-mono text-label tnum text-fg-dim">
                clip #{item.orden} · {item.duracionSeg}s · {item.resolucion}
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-body leading-relaxed text-fg">
                {item.dialogo ? `“${item.dialogo}”` : <span className="text-fg-dim">(sin diálogo · b-roll mudo)</span>}
              </p>
            </li>
            {siguiente && (
              <li className="opacity-60">
                <ClipDeGuion clip={siguiente} />
              </li>
            )}
          </ol>

          <Desplegable titulo="Prompt visual">{item.videoPrompt}</Desplegable>

          {item.finalPrompt && (
            <Desplegable titulo="Prompt FINAL manual (override activo)" destacado>
              {item.finalPrompt}
            </Desplegable>
          )}
        </TabsContent>

        <TabsContent value="editar" className="flex flex-col gap-3">
          <Textarea label="Diálogo (es-AR, no se traduce)" value={dialogo} onChange={(e) => setDialogo(e.target.value)} className="h-24" />

          <Textarea label="Prompt visual (inglés)" value={videoPrompt} onChange={(e) => setVideoPrompt(e.target.value)} spellCheck={false} mono className="h-28" />

          <div className="flex gap-2">
            <Select
              label="Duración"
              value={String(duracion)}
              onValueChange={(v) => setDuracion(Number(v))}
              options={[4, 6, 8].map((d) => ({ value: String(d), label: `${d}s` }))}
            />
            <Select label="Resolución" value={resolucion} onValueChange={setResolucion} options={resolutions.map((r) => ({ value: r, label: r }))} />
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
            <p role="alert" className="flex items-start gap-2 rounded-sm bg-danger/10 px-2.5 py-2 text-label text-danger">
              <WarningCircle aria-hidden className="mt-px size-3.5 shrink-0" />
              {saveError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void save(false)}
              loading={saving}
              disabled={busy || !dirty || !item.videoJobId}
              title="Guarda en el plan sin regenerar el clip. No cuesta nada."
              icon={saved ? <Check aria-hidden className="size-3.5" /> : <FloppyDisk aria-hidden className="size-3.5" />}
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
            Regenerar cuesta plata y consume cuota de Veo. El clip vuelve a la cola y respeta el ritmo de 4 por minuto.
          </p>
        </TabsContent>
      </Tabs>

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
    </aside>
  );
}

/** Clip anterior o siguiente, en la pestaña Guión: solo lectura, sin la ficha completa. */
function ClipDeGuion({ clip }: { clip: ClipItem }) {
  return (
    <div className="rounded-sm bg-bg p-2.5">
      <p className="font-mono text-label tnum text-fg-dim">
        clip #{clip.orden} · {clip.duracionSeg}s
      </p>
      <p className="mt-1 whitespace-pre-wrap text-body leading-relaxed text-fg-dim">
        {clip.dialogo ? `“${clip.dialogo}”` : "(sin diálogo · b-roll mudo)"}
      </p>
    </div>
  );
}

function Desplegable({
  titulo,
  destacado,
  children,
}: {
  titulo: string;
  destacado?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className={cn("rounded-sm bg-bg p-2.5", destacado && "bg-accent/5 ring-1 ring-accent/30")}>
      <summary
        className={cn(
          "cursor-pointer rounded-sm text-label font-medium",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          destacado ? "text-accent" : "text-fg-dim"
        )}
      >
        {titulo}
      </summary>
      <p className="mt-2 whitespace-pre-wrap font-mono text-label leading-relaxed text-fg-dim">{children}</p>
    </details>
  );
}
