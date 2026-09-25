"use client";

/**
 * Diálogo "Cambiar la voz del video" (tasks/cambio-de-voz/02-DISENO.md §12.2).
 *
 * Se escribe contra el CONTRATO HTTP de §11 (GET /api/voces, POST/DELETE
 * /api/voces/favoritas, POST /api/projects/:id/voz) y solo importa TIPOS de
 * @/lib/types: nada de @/lib/voz, que trae node:fs y la config con la key (chequeo A7).
 *
 * ─── DECISIONES QUE PARECEN DETALLES ─────────────────────────────────────────
 *
 * 1. Las filas son `<input type="radio">` NATIVOS adentro de un `<label>`: las flechas
 *    del teclado recorren la lista sin escribir un solo handler. Los botones de
 *    Escuchar y Favorita van AL LADO del label y no adentro, para que un click en la
 *    estrella no elija la voz de paso.
 * 2. UN solo `<audio preload="none">` para todo el diálogo: tocar otra voz corta la
 *    anterior, y cerrar el diálogo la pausa. Con un <audio> por fila sonaban dos a la
 *    vez y la muestra seguía sonando con el diálogo cerrado.
 * 3. La búsqueda tiene debounce de 300 ms y descarta respuestas viejas por número de
 *    pedido: si la de "nat" llega después de la de "natalia", gana "natalia".
 * 4. Los botones de acción usan `loading` y NO cambian el texto (§5 del rediseño).
 */

import {
  CaretDown,
  CaretRight,
  PencilSimple,
  SpeakerHigh,
  Star,
  Stop,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Dialog, DialogContent, Input, Segmented, ToggleCard } from "@/components/ui";
import { cn } from "@/lib/cn";
import type {
  AjustesDeVoz,
  CreditosDeVoz,
  EstimacionDeVoz,
  RespuestaEstadoVoz,
  RespuestaVoces,
  VersionDeVoz,
  VozEnLista,
  VozFavorita,
} from "@/lib/types";

type Lista = "favoritas" | "mias" | "predeterminadas";

/** La voz elegida. Puede no estar en la lista visible (Reintentar arranca con una). */
interface Elegida {
  id: string;
  nombre: string;
  favorita: VozFavorita | null;
}

const AJUSTES_INICIALES: AjustesDeVoz = {
  estabilidad: 0.5,
  similitud: 0.75,
  estilo: 0,
  realceHablante: true,
};

/** Segundos -> "20s" o "11m 20s". */
function durTexto(seg: number): string {
  const s = Math.round(seg);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

const numero = (n: number) => n.toLocaleString("es-AR");
const usd = (n: number) => n.toFixed(2).replace(".", ",");

/** Las etiquetas que importan para elegir, en el orden en que se leen. */
function etiquetasDe(v: VozEnLista): string {
  const e = v.etiquetas ?? {};
  const orden = ["accent", "acento", "gender", "genero", "age", "edad", "use_case", "language"];
  const vistos = orden.map((k) => e[k]).filter(Boolean);
  return vistos.length > 0 ? vistos.join(" · ") : (v.categoria ?? "");
}

const mismosAjustes = (a: AjustesDeVoz | null, b: AjustesDeVoz | null) =>
  JSON.stringify(a) === JSON.stringify(b);

export function CambiarVozDialog(props: {
  abierto: boolean;
  onCambio: (v: boolean) => void;
  proyectoId: string;
  estado: RespuestaEstadoVoz;              // estimaciones, filmados, proveedor, unido
  preseleccion?: VersionDeVoz | null;      // "Reintentar" / "Rehacer": arranca con esas opciones
  onIniciada: (v: VersionDeVoz) => void;   // la pagina refresca y empieza el polling
}): JSX.Element {
  const { abierto, onCambio, proyectoId, estado, preseleccion, onIniciada } = props;

  const [lista, setLista] = useState<Lista>("favoritas");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [voces, setVoces] = useState<VozEnLista[]>([]);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [creditos, setCreditos] = useState<CreditosDeVoz | null>(null);
  const [cargando, setCargando] = useState(false);
  const [errorLista, setErrorLista] = useState<string | null>(null);

  const [elegida, setElegida] = useState<Elegida | null>(null);
  const [ajustes, setAjustes] = useState<AjustesDeVoz | null>(null);
  const [verAjustes, setVerAjustes] = useState(false);
  const [quitarRuido, setQuitarRuido] = useState(true);
  const [incluirFilmados, setIncluirFilmados] = useState(false);

  const [enviando, setEnviando] = useState<"probar" | "convertir" | null>(null);
  const [errorPost, setErrorPost] = useState<string | null>(null);
  const [guardandoFav, setGuardandoFav] = useState(false);
  const [editando, setEditando] = useState<{ voiceId: string; alias: string } | null>(null);

  const audio = useRef<HTMLAudioElement | null>(null);
  const [sonando, setSonando] = useState<string | null>(null);
  const pedido = useRef(0);
  /** Solo la PRIMERA carga decide si arrancar en Favoritas o en Mis voces. */
  const primeraCarga = useRef(true);

  /* ─── al abrir: estado inicial (o el de Reintentar / Rehacer) ─── */
  useEffect(() => {
    if (!abierto) {
      audio.current?.pause();
      setSonando(null);
      return;
    }
    primeraCarga.current = true;
    setLista("favoritas");
    setQ("");
    setQDebounced("");
    setErrorPost(null);
    setEditando(null);
    if (preseleccion) {
      setElegida({ id: preseleccion.voz.id, nombre: preseleccion.voz.nombre, favorita: null });
      setAjustes(preseleccion.ajustes);
      setVerAjustes(preseleccion.ajustes !== null);
      setQuitarRuido(preseleccion.quitarRuido);
      setIncluirFilmados(preseleccion.incluirFilmados);
    } else {
      setElegida(null);
      setAjustes(null);
      setVerAjustes(false);
      setQuitarRuido(true);
      setIncluirFilmados(false);
    }
  }, [abierto, preseleccion]);

  /* ─── debounce de la búsqueda ─── */
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const cargar = useCallback(
    async (cursor: string | null) => {
      const n = ++pedido.current;
      setCargando(true);
      setErrorLista(null);
      try {
        const sp = new URLSearchParams({ lista });
        // En Favoritas se filtra del lado del cliente: son pocas y ya están todas.
        if (lista !== "favoritas" && qDebounced) sp.set("q", qDebounced);
        if (cursor) sp.set("cursor", cursor);
        const res = await fetch(`/api/voces?${sp.toString()}`);
        const data = (await res.json().catch(() => null)) as (RespuestaVoces & { error?: string }) | null;
        if (n !== pedido.current) return; // llegó tarde: hay un pedido más nuevo
        if (!res.ok || !data || !Array.isArray(data.voces)) {
          throw new Error(data?.error ?? "No se pudo cargar la lista de voces.");
        }
        if (primeraCarga.current && lista === "favoritas" && data.voces.length === 0) {
          primeraCarga.current = false;
          setLista("mias");
          return;
        }
        primeraCarga.current = false;
        setVoces((prev) => (cursor ? [...prev, ...data.voces] : data.voces));
        setSiguiente(data.siguiente);
        setCreditos(data.creditos);
      } catch (err) {
        if (n !== pedido.current) return;
        setErrorLista(err instanceof Error ? err.message : "No se pudo cargar la lista de voces.");
      } finally {
        if (n === pedido.current) setCargando(false);
      }
    },
    [lista, qDebounced],
  );

  useEffect(() => {
    if (!abierto) return;
    void cargar(null);
  }, [abierto, cargar]);

  const visibles =
    lista === "favoritas" && q.trim()
      ? voces.filter((v) =>
          `${v.favorita?.alias ?? ""} ${v.nombre} ${v.descripcion ?? ""} ${Object.values(v.etiquetas ?? {}).join(" ")}`
            .toLowerCase()
            .includes(q.trim().toLowerCase()),
        )
      : voces;

  /* ─── escuchar ─── */
  function escuchar(v: VozEnLista) {
    const a = audio.current;
    if (!a || !v.previewUrl) return;
    if (sonando === v.id) {
      a.pause();
      setSonando(null);
      return;
    }
    a.pause();
    a.src = v.previewUrl;
    setSonando(v.id);
    a.play().catch(() => setSonando(null));
  }

  function elegir(v: VozEnLista) {
    setElegida({ id: v.id, nombre: v.nombre, favorita: v.favorita });
    // Arranca con los ajustes de la favorita (R3.3); si no tiene, los de la voz.
    setAjustes(v.favorita?.ajustes ?? null);
    setVerAjustes(Boolean(v.favorita?.ajustes));
  }

  /* ─── favoritas ─── */
  function reemplazarFavorita(voiceId: string, fav: VozFavorita | null) {
    setVoces((prev) => {
      if (lista === "favoritas" && !fav) return prev.filter((v) => v.id !== voiceId);
      return prev.map((v) => (v.id === voiceId ? { ...v, favorita: fav, nombre: v.disponible ? v.nombre : (fav?.alias ?? v.nombre) } : v));
    });
    setElegida((e) => (e && e.id === voiceId ? { ...e, favorita: fav } : e));
  }

  async function alternarFavorita(v: VozEnLista) {
    setErrorLista(null);
    try {
      const res = v.favorita
        ? await fetch(`/api/voces/favoritas?voiceId=${encodeURIComponent(v.id)}`, { method: "DELETE" })
        : await fetch("/api/voces/favoritas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ voiceId: v.id, alias: v.nombre.slice(0, 60) }),
          });
      const data = (await res.json().catch(() => null)) as { favoritas?: VozFavorita[]; error?: string } | null;
      if (!res.ok || !data?.favoritas) throw new Error(data?.error ?? "No se pudo guardar la favorita.");
      reemplazarFavorita(v.id, data.favoritas.find((f) => f.voiceId === v.id) ?? null);
    } catch (err) {
      setErrorLista(err instanceof Error ? err.message : "No se pudo guardar la favorita.");
    }
  }

  async function guardarFavorita(voiceId: string, cuerpo: { alias?: string; ajustes?: AjustesDeVoz | null }) {
    setGuardandoFav(true);
    setErrorLista(null);
    try {
      const res = await fetch("/api/voces/favoritas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceId, ...cuerpo }),
      });
      const data = (await res.json().catch(() => null)) as { favoritas?: VozFavorita[]; error?: string } | null;
      if (!res.ok || !data?.favoritas) throw new Error(data?.error ?? "No se pudo guardar la favorita.");
      reemplazarFavorita(voiceId, data.favoritas.find((f) => f.voiceId === voiceId) ?? null);
      return true;
    } catch (err) {
      setErrorLista(err instanceof Error ? err.message : "No se pudo guardar la favorita.");
      return false;
    } finally {
      setGuardandoFav(false);
    }
  }

  /* ─── iniciar ─── */
  async function iniciar(accion: "probar" | "convertir") {
    if (!elegida) return;
    setEnviando(accion);
    setErrorPost(null);
    try {
      const nombre = (elegida.favorita?.alias || elegida.nombre).slice(0, 80);
      const res = await fetch(`/api/projects/${proyectoId}/voz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accion,
          voz: { id: elegida.id, nombre },
          ajustes,
          quitarRuido,
          incluirFilmados,
        }),
      });
      const data = (await res.json().catch(() => null)) as { version?: VersionDeVoz; error?: string } | null;
      if (res.status === 503) throw new Error(estado.motivoNoDisponible ?? data?.error ?? "El cambio de voz no está configurado.");
      if (!res.ok || !data?.version) throw new Error(data?.error ?? "No se pudo iniciar el cambio de voz.");
      onIniciada(data.version);
      onCambio(false);
    } catch (err) {
      // El error queda adentro del diálogo, que sigue abierto: la elección no se pierde.
      setErrorPost(err instanceof Error ? err.message : "No se pudo iniciar el cambio de voz.");
    } finally {
      setEnviando(null);
    }
  }

  const est: EstimacionDeVoz | null = estado.estimacion
    ? incluirFilmados && estado.estimacion.conFilmados
      ? estado.estimacion.conFilmados
      : estado.estimacion.sinFilmados
    : null;
  const puede = Boolean(elegida) && estado.disponible && enviando === null;
  const ajustesCambiados =
    elegida?.favorita != null && !mismosAjustes(ajustes, elegida.favorita.ajustes ?? null);
  const a = ajustes ?? AJUSTES_INICIALES;

  return (
    <Dialog open={abierto} onOpenChange={onCambio}>
      <DialogContent
        title="Cambiar la voz del video"
        description="Todo el diálogo pasa a la voz que elijas. El video no se toca y el original queda como está."
        className="w-[min(42rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] overflow-y-auto"
      >
        {/* Un solo reproductor de muestras para todo el diálogo. */}
        <audio ref={audio} preload="none" onEnded={() => setSonando(null)} className="hidden" />

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Segmented<Lista>
              value={lista}
              onChange={(v) => {
                primeraCarga.current = false;
                setVoces([]);
                setSiguiente(null);
                setLista(v);
              }}
              etiqueta="Lista de voces"
              options={[
                { value: "favoritas", label: "Favoritas" },
                { value: "mias", label: "Mis voces" },
                { value: "predeterminadas", label: "Predeterminadas" },
              ]}
            />
            <div className="min-w-[12rem] flex-1">
              <Input
                label="Buscar voz"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Nombre, acento, descripción…"
                maxLength={100}
              />
            </div>
          </div>

          {errorLista && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-sm bg-danger/10 px-3 py-2 text-body text-danger">
              <WarningCircle aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">{errorLista}</span>
              <Button size="sm" variant="ghost" onClick={() => void cargar(null)}>
                Reintentar
              </Button>
            </div>
          )}

          <div className="max-h-[45vh] overflow-y-auto rounded-md border border-divider" aria-busy={cargando || undefined}>
            {visibles.length === 0 && !cargando ? (
              <p className="px-3 py-4 text-body text-fg-dim">
                {lista === "favoritas"
                  ? "Todavía no marcaste ninguna favorita. Tocá la estrella de una voz para guardarla acá."
                  : "No hay voces que coincidan."}
              </p>
            ) : (
              <ul className="divide-y divide-divider">
                {visibles.map((v) => {
                  const nombre = v.favorita?.alias || v.nombre;
                  const esElegida = elegida?.id === v.id;
                  const editandoEsta = editando?.voiceId === v.id;
                  return (
                    <li key={v.id} className={cn("flex flex-col gap-2 px-3 py-2", esElegida && "bg-surface-hi")}>
                      <div className="flex items-center gap-2">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                          <input
                            type="radio"
                            name="voz"
                            value={v.id}
                            checked={esElegida}
                            disabled={!v.disponible}
                            onChange={() => elegir(v)}
                            className="size-4 shrink-0 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-fg">{nombre}</span>
                            <span className="block truncate text-label text-fg-dim">
                              {v.disponible ? etiquetasDe(v) : v.descripcion}
                            </span>
                          </span>
                        </label>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => escuchar(v)}
                          disabled={!v.previewUrl}
                          title={v.previewUrl ? undefined : "Sin muestra"}
                          aria-label={v.previewUrl ? (sonando === v.id ? `Parar la muestra de ${nombre}` : `Escuchar ${nombre}`) : "Sin muestra"}
                          icon={sonando === v.id ? <Stop aria-hidden className="size-3.5" /> : <SpeakerHigh aria-hidden className="size-3.5" />}
                        >
                          {v.previewUrl ? "Escuchar" : "Sin muestra"}
                        </Button>
                        {lista === "favoritas" && v.favorita && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditando(editandoEsta ? null : { voiceId: v.id, alias: v.favorita!.alias })}
                            aria-expanded={editandoEsta}
                            icon={<PencilSimple aria-hidden className="size-3.5" />}
                          >
                            Editar
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void alternarFavorita(v)}
                          aria-pressed={Boolean(v.favorita)}
                          aria-label={v.favorita ? `Quitar ${nombre} de favoritas` : `Marcar ${nombre} como favorita`}
                          title={v.favorita ? "Quitar de favoritas" : "Marcar como favorita"}
                          icon={
                            <Star
                              aria-hidden
                              weight={v.favorita ? "fill" : "regular"}
                              className={cn("size-4", v.favorita && "text-accent")}
                            />
                          }
                        />
                      </div>
                      {editandoEsta && editando && (
                        <form
                          className="flex items-end gap-2 pl-7"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void guardarFavorita(v.id, { alias: editando.alias }).then((ok) => ok && setEditando(null));
                          }}
                        >
                          <div className="flex-1">
                            <Input
                              label="Alias"
                              value={editando.alias}
                              maxLength={60}
                              onChange={(e) => setEditando({ voiceId: v.id, alias: e.target.value })}
                            />
                          </div>
                          <Button type="submit" size="md" loading={guardandoFav} disabled={!editando.alias.trim()}>
                            Guardar
                          </Button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {siguiente && lista !== "favoritas" && (
              <div className="border-t border-divider p-2">
                <Button size="sm" variant="ghost" loading={cargando} onClick={() => void cargar(siguiente)}>
                  Cargar más
                </Button>
              </div>
            )}
          </div>

          {elegida && !visibles.some((v) => v.id === elegida.id) && (
            <p className="text-label text-fg-dim">
              Voz elegida: <span className="text-fg">{elegida.favorita?.alias || elegida.nombre}</span>
            </p>
          )}

          {/* ─── ajustes ─── */}
          <div className="rounded-md border border-divider">
            <button
              type="button"
              onClick={() => setVerAjustes((x) => !x)}
              aria-expanded={verAjustes}
              aria-controls="ajustes-voz"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-body font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {verAjustes ? <CaretDown aria-hidden className="size-3.5" /> : <CaretRight aria-hidden className="size-3.5" />}
              Ajustes de la voz
              <span className="text-label font-normal text-fg-dim">
                {ajustes ? "personalizados" : "los que la voz tiene guardados"}
              </span>
            </button>
            {/*
              `hidden` como atributo Y como clase: el atributo solo no alcanza, porque el
              `flex` de la clase le gana al display:none del navegador y el panel se veia
              abierto con la flecha cerrada. Se deja montado para que el aria-controls
              apunte a algo que existe.
            */}
            <div
              id="ajustes-voz"
              hidden={!verAjustes}
              className={cn("flex flex-col gap-3 border-t border-divider px-3 py-3", !verAjustes && "hidden")}
            >
              {(
                [
                  ["estabilidad", "Estabilidad"],
                  ["similitud", "Similitud"],
                  ["estilo", "Estilo"],
                ] as const
              ).map(([k, label]) => (
                <div key={k} className="flex items-center gap-3">
                  <label htmlFor={`ajuste-${k}`} className="w-24 text-label text-fg-dim">
                    {label}
                  </label>
                  <input
                    id={`ajuste-${k}`}
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={a[k]}
                    onChange={(e) => setAjustes({ ...a, [k]: Number(e.target.value) })}
                    className="flex-1 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  />
                  <span className="w-10 text-right font-mono text-label tnum text-fg">{a[k].toFixed(2)}</span>
                </div>
              ))}
              <label className="flex items-center gap-2 text-body text-fg">
                <input
                  type="checkbox"
                  checked={a.realceHablante}
                  onChange={(e) => setAjustes({ ...a, realceHablante: e.target.checked })}
                  className="size-4 accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                Realce del hablante
              </label>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setAjustes(null)} disabled={ajustes === null}>
                  Usar los de la voz
                </Button>
                {ajustesCambiados && elegida && (
                  <Button
                    size="sm"
                    loading={guardandoFav}
                    onClick={() => void guardarFavorita(elegida.id, { alias: elegida.favorita!.alias, ajustes })}
                  >
                    Guardar ajustes en la favorita
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* ─── opciones ─── */}
          <div className="grid gap-2 sm:grid-cols-2">
            <ToggleCard
              activo={quitarRuido}
              onChange={setQuitarRuido}
              title="Quitar ruido de fondo"
              descripcion="Mejor conversión; se pierde el sonido ambiente de los clips que se convierten."
            />
            {estado.filmadosConDialogo > 0 && (
              <ToggleCard
                activo={incluirFilmados}
                onChange={setIncluirFilmados}
                title={`Incluir clips filmados (${estado.filmadosConDialogo})`}
                descripcion={
                  incluirFilmados
                    ? "La voz de los clips filmados también se cambia."
                    : "Los clips filmados conservan la voz real de quien grabó."
                }
              />
            )}
          </div>

          {/* ─── costo ─── */}
          <div className="text-body text-fg-dim">
            {est ? (
              <p>
                Se convierten <span className="font-mono tnum text-fg">{durTexto(est.segundos)}</span> de audio en{" "}
                <span className="font-mono tnum text-fg">{est.tramos}</span> {est.tramos === 1 ? "tramo" : "tramos"} · ~
                <span className="font-mono tnum text-fg">{numero(est.creditos)}</span> créditos (~US${usd(est.usd)})
              </p>
            ) : (
              <p>Sin estimación: el video unido no está listo para cambiar la voz.</p>
            )}
            {estado.proveedor === "mock" ? (
              <p>Modo mock: no gasta créditos.</p>
            ) : creditos ? (
              <p>
                Te quedan <span className="font-mono tnum text-fg">{numero(Math.max(0, creditos.limite - creditos.usados))}</span> créditos
              </p>
            ) : null}
          </div>

          {!estado.disponible && estado.motivoNoDisponible && (
            <p className="flex items-start gap-2 rounded-sm bg-danger/10 px-3 py-2 text-body text-danger">
              <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {estado.motivoNoDisponible}
            </p>
          )}
          <div aria-live="polite">
            {errorPost && (
              <p role="alert" className="flex items-start gap-2 rounded-sm bg-danger/10 px-3 py-2 text-body text-danger">
                <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
                {errorPost}
              </p>
            )}
          </div>

          <div className="flex flex-wrap justify-end gap-2 border-t border-divider pt-3">
            <Button variant="secondary" loading={enviando === "probar"} disabled={!puede} onClick={() => void iniciar("probar")}>
              Probar 20 s
            </Button>
            <Button variant="primary" loading={enviando === "convertir"} disabled={!puede} onClick={() => void iniciar("convertir")}>
              Cambiar la voz de todo el video
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
