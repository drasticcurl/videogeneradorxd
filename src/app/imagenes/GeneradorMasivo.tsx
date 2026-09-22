"use client";

/**
 * Pestaña "Masivo" de /imagenes: sidebar con las tandas masivas de esta sesión +
 * el formulario ("Nueva tanda masiva", abierto por defecto si no hay ninguna en
 * curso) o el progreso de la tanda seleccionada.
 *
 * Generador masivo de variaciones: subís N fotos + UN prompt, y crea N proyectos de
 * imagenes (uno por foto, image2image contra ella) que corren SECUENCIAL — uno
 * termina, arranca el siguiente — alternando Nano Banana Pro/Flash por proyecto.
 *
 * Backend: `POST /api/imagenes/masivo` (ver ese archivo para el detalle de las dos
 * mitigaciones anti rate-limit). Esta pantalla es solo el formulario + el progreso
 * agregado de la tanda; no duplica la revision de variantes, cada proyecto se revisa
 * en la pestaña "Generar" de siempre (mismo `/imagenes?id=<id>`).
 *
 * ─── POR QUE NO REUSA <ImagenesBoard> PARA MOSTRAR RESULTADOS ────────────────
 *
 * `ImagenesBoard` esta armado alrededor de UN proyecto abierto (`?id=`) con su hilo de
 * chat iterativo. Una tanda masiva son VARIOS proyectos a la vez, y lo que hace falta
 * ver aca es el PROGRESO AGREGADO (cuantos van, cual esta corriendo, cual fallo), no
 * las variantes de cada uno. Por eso esta pantalla solo linkea a cada proyecto
 * (`/imagenes?id=<id>`) para revisarlo en la pestaña "Generar".
 *
 * ─── POLLING: SOLO MIENTRAS HAYA UNA TANDA EN CURSO EN ESTA PESTAÑA ──────────
 * Mismo patron que ImagenesBoard: intervalo en un ref, se apaga solo cuando no queda
 * nada en curso. No hace polling si el usuario no lanzo ninguna tanda desde que abrio
 * la pagina.
 *
 * Rediseño VISUAL (handoff `design_handoff_rediseno_augc`): no cambia ni un
 * endpoint, ni un payload, ni una regla. El form pasa a ser pantalla propia con
 * scroll y dos columnas; el progreso de una tanda usa el sidebar para elegir CUAL
 * tanda de la sesión se esta mirando, en vez de listarlas todas apiladas.
 */

import {
  Sparkle,
  Trash,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Badge,
  Button,
  Input,
  Progreso,
  Select,
  Textarea,
  ToggleCard,
  type SelectOption,
} from "@/components/ui";
import { BarraInferior } from "@/components/Pantalla";
import { cn } from "@/lib/cn";
import { IMAGE_ASPECT_RATIOS, IMAGE_SIZES } from "@/lib/formatos";
import { estadoDeProyecto } from "@/lib/ui-tokens";

import { CabeceraSidebar, type Tab } from "./ImagenesTabs";

const VARIANTES: ReadonlyArray<SelectOption<string>> = [1, 2, 3, 4].map((n) => ({
  value: String(n),
  label: String(n),
}));

const FORMATOS: ReadonlyArray<SelectOption<string>> = IMAGE_ASPECT_RATIOS.map((f) => ({
  value: f.id,
  label: f.id,
  hint: f.uso,
}));

const CALIDADES: ReadonlyArray<SelectOption<string>> = IMAGE_SIZES.map((s) => ({
  value: s,
  label: s,
}));

/** Los dos modelos fijos que alterna el backend. Solo informativo en esta pantalla. */
const MODELOS_TANDA = "Nano Banana Pro y Flash, alternados";

/**
 * Prompts de referencia para "Prompt dual": se precargan en los textareas la
 * PRIMERA vez que se activa el switch (si el campo todavía está vacío), como punto
 * de partida editable — no son obligatorios ni se vuelven a pisar si el usuario ya
 * escribió otra cosa y desactiva/reactiva el switch.
 */
const PROMPT_A_DEFAULT =
  'Me haces una variación de este creativo.\n' +
  'Es un creativo ad para vender una oferta de "dibujá tu alma gemela".\n' +
  "Va orientado a mujeres.\n" +
  "No hace falta que cambies mucho, este ya funcionó.";
const PROMPT_B_DEFAULT =
  "Usá esta foto solo como referencia de la persona/producto, no la copies tal cual.\n" +
  'Armá un ad nuevo para vender una oferta de "dibujá tu alma gemela", orientado a mujeres.\n' +
  "Tenés libertad para cambiar composición, fondo, pose y estilo — el objetivo es un\n" +
  "creativo distinto que siga vendiendo la misma oferta.";

interface ProyectoTanda {
  id: string;
  name: string;
  status: string;
  position: number;
}

interface BatchResumen {
  batchId: string;
  total: number;
  proyectos: ProyectoTanda[];
}

const POLL_MS = 4000;
const STATUS_EN_CURSO = new Set(["draft", "running", "review"]);

export default function GeneradorMasivo({
  tab,
  onCambiarTab,
}: {
  tab: Tab;
  onCambiarTab: (t: Tab) => void;
}) {
  const [nombreBase, setNombreBase] = useState("");
  const [prompt, setPrompt] = useState("");
  /**
   * "Prompt dual": en vez de un prompt con N variantes del mismo modelo, dos prompts
   * fijos en 4 variantes cruzadas con los dos modelos (ver el comentario de
   * `/api/imagenes/masivo`, sección "PROMPT DUAL"). `promptA` es la variación
   * conservadora, `promptB` la libre. Con el switch activo, `variantes` se ignora.
   */
  const [dual, setDual] = useState(false);
  const [promptA, setPromptA] = useState("");
  const [promptB, setPromptB] = useState("");
  const [variantes, setVariantes] = useState(2);
  const [formato, setFormato] = useState("9:16");
  const [calidad, setCalidad] = useState("1K");
  const [negativo, setNegativo] = useState("");
  const [fotos, setFotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Activa/desactiva "Prompt dual". Al ACTIVAR (no al desactivar), si algún campo
   * está vacío se precarga con el default de referencia. Si el campo ya tiene texto,
   * se deja tal cual: activar el switch no pisa nada.
   */
  function toggleDual(activar: boolean) {
    setDual(activar);
    if (activar) {
      setPromptA((actual) => actual || PROMPT_A_DEFAULT);
      setPromptB((actual) => actual || PROMPT_B_DEFAULT);
    }
  }

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Las tandas lanzadas DESDE ESTA PESTAÑA (no persiste entre reloads).
  const [tandas, setTandas] = useState<BatchResumen[]>([]);
  /**
   * Tanda seleccionada en el sidebar, para ver su progreso. `null` = mostrar el
   * formulario. Al lanzar una tanda nueva, pasa a apuntar a esa automáticamente
   * (mismo comportamiento de "recién generado pasa a ser lo que se mira" que tiene
   * la pestaña Generar con `?id=`).
   */
  const [tandaAbierta, setTandaAbierta] = useState<string | null>(null);

  /*
    Preview de cada foto con URL.createObjectURL, revocadas en cleanup.
  */
  useEffect(() => {
    const urls = fotos.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => {
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [fotos]);

  function agregarFotos(nuevas: FileList | null) {
    if (!nuevas || nuevas.length === 0) return;
    setFotos((prev) => [...prev, ...Array.from(nuevas)]);
  }

  function quitarFoto(index: number) {
    setFotos((prev) => prev.filter((_, i) => i !== index));
  }

  function limpiarFotos() {
    setFotos([]);
    if (inputRef.current) inputRef.current.value = "";
  }

  const [arrastrando, setArrastrando] = useState(false);

  // ─── Polling de las tandas en curso ─────────────────────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refrescarUnaTanda = useCallback(async (batchId: string) => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        projects?: Array<{
          id: string;
          name: string;
          status: string;
          batch?: { batchId: string; position: number; total: number };
        }>;
      };
      const deLaTanda = (data.projects ?? []).filter((p) => p.batch?.batchId === batchId);
      if (deLaTanda.length === 0) return;
      setTandas((prev) =>
        prev.map((t) =>
          t.batchId !== batchId
            ? t
            : {
                ...t,
                proyectos: deLaTanda
                  .map((p) => ({
                    id: p.id,
                    name: p.name,
                    status: p.status,
                    position: p.batch?.position ?? 0,
                  }))
                  .sort((a, b) => a.position - b.position),
              },
        ),
      );
    } catch {
      // Fallo de red puntual: el proximo tick reintenta solo.
    }
  }, []);

  const hayTandaEnCurso = tandas.some((t) =>
    t.proyectos.some((p) => STATUS_EN_CURSO.has(p.status)),
  );

  useEffect(() => {
    if (!hayTandaEnCurso) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      for (const t of tandas) void refrescarUnaTanda(t.batchId);
    }, POLL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hayTandaEnCurso, tandas.length]);

  const tienePrompt = dual
    ? promptA.trim().length > 0 && promptB.trim().length > 0
    : prompt.trim().length > 0;
  const puedeEnviar = tienePrompt && nombreBase.trim().length > 0 && fotos.length > 0;

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const fd = new FormData();
      fd.set("nombreBase", nombreBase);
      fd.set("dual", String(dual));
      if (dual) {
        fd.set("promptA", promptA);
        fd.set("promptB", promptB);
      } else {
        fd.set("prompt", prompt);
        fd.set("variantes", String(variantes));
      }
      fd.set("aspectRatio", formato);
      fd.set("imageSize", calidad);
      if (negativo.trim()) fd.set("negativePrompt", negativo);
      for (const foto of fotos) fd.append("fotos", foto);

      const res = await fetch("/api/imagenes/masivo", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as {
        batchId?: string;
        projects?: Array<{ id: string; name: string; status: string }>;
        error?: string;
      };
      if (!res.ok || !data.batchId || !data.projects) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }

      setTandas((prev) => [
        {
          batchId: data.batchId!,
          total: data.projects!.length,
          proyectos: data.projects!.map((p, i) => ({
            id: p.id,
            name: p.name,
            status: p.status,
            position: i,
          })),
        },
        ...prev,
      ]);
      setTandaAbierta(data.batchId!);
      setPrompt("");
      setPromptA("");
      setPromptB("");
      setNombreBase("");
      limpiarFotos();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red");
    } finally {
      setEnviando(false);
    }
  }

  const resumenCosto = useMemo(() => {
    if (fotos.length === 0) return null;
    const variantesEfectivas = dual ? 4 : variantes;
    const totalImagenes = fotos.length * variantesEfectivas;
    return `${fotos.length} ${fotos.length === 1 ? "foto" : "fotos"} × ${variantesEfectivas} ${
      variantesEfectivas === 1 ? "variante" : "variantes"
    } = ${totalImagenes} imágenes · ${formato} · ${calidad}${
      dual ? " · 2 prompts × 2 modelos" : ""
    }`;
  }, [fotos.length, variantes, dual, formato, calidad]);

  const tandaSeleccionada = tandas.find((t) => t.batchId === tandaAbierta) ?? null;

  return (
    <>
      {/* ─── Sidebar: segmented + Nueva tanda masiva + tandas de la sesión ─── */}
      <aside className="flex min-h-0 flex-col border-r border-divider">
        <CabeceraSidebar
          tab={tab}
          onCambiarTab={onCambiarTab}
          onNuevaTanda={() => setTandaAbierta(null)}
          labelNueva="Nueva tanda masiva"
        />
        <div className="px-4 pb-2">
          <span className="text-label font-medium text-fg-dim">
            Tandas de esta sesión{" "}
            {tandas.length > 0 && (
              <span className="code tnum font-normal">{tandas.length}</span>
            )}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {tandas.length === 0 ? (
            <p className="px-2 text-label text-fg-dim">
              Las tandas que lances en esta pestaña van a quedar acá mientras esta
              pestaña esté abierta.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {tandas.map((t) => {
                const terminadas = t.proyectos.filter(
                  (p) => !STATUS_EN_CURSO.has(p.status),
                ).length;
                const activa = t.batchId === tandaAbierta;
                const nombre = t.proyectos[0]?.name.replace(/\s\d+$/, "") ?? "Tanda";
                return (
                  <li key={t.batchId}>
                    <button
                      type="button"
                      onClick={() => setTandaAbierta(t.batchId)}
                      aria-current={activa ? "true" : undefined}
                      className={cn(
                        "flex w-full flex-col gap-1.5 rounded-md border p-2.5 text-left transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                        activa
                          ? "border-accent bg-accent/10"
                          : "border-transparent hover:bg-surface",
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-body font-medium text-fg">
                          {nombre}
                        </span>
                        <span className="code tnum shrink-0 text-label text-fg-dim">
                          {terminadas}/{t.total}
                        </span>
                      </span>
                      <Progreso hechos={terminadas} total={t.total} tono="ok" alto={3} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* ─── Main: form de "Nueva tanda masiva", o el progreso de la elegida ── */}
      {tandaSeleccionada ? (
        <ProgresoTanda tanda={tandaSeleccionada} />
      ) : (
        <main className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <form
              id="form-masivo"
              onSubmit={generar}
              className="mx-auto flex max-w-[1080px] flex-col gap-5 p-6"
            >
              <header>
                <h1 className="text-display font-semibold text-fg">Generador masivo</h1>
                <p className="mt-1 max-w-prose text-body text-fg-dim">
                  Subí varias fotos y un solo prompt: crea un proyecto por foto y los
                  corre de a uno (no en paralelo), alternando {MODELOS_TANDA}.
                </p>
              </header>

              <div
                className="grid gap-6"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}
              >
                {/* ─── Izquierda ───────────────────────────────────────────── */}
                <div className="flex flex-col gap-4">
                  {/* Dropzone multi-archivo */}
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-label font-medium text-fg-dim">
                        Fotos a variar
                      </span>
                      {fotos.length > 0 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={limpiarFotos}
                          icon={<Trash aria-hidden className="size-3.5" />}
                        >
                          Vaciar
                        </Button>
                      )}
                    </div>
                    <label
                      onDragOver={(e) => {
                        e.preventDefault();
                        setArrastrando(true);
                      }}
                      onDragLeave={() => setArrastrando(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setArrastrando(false);
                        agregarFotos(e.dataTransfer.files);
                      }}
                      className={cn(
                        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed",
                        "px-3 py-6 text-body text-fg-dim transition-colors",
                        arrastrando
                          ? "border-accent bg-accent/5 text-fg"
                          : "border-divider bg-surface hover:border-border",
                      )}
                    >
                      <UploadSimple aria-hidden className="size-5" />
                      Arrastrá las fotos, o hacé click para elegirlas
                      <span className="text-label">
                        PNG, JPG o WEBP · podés elegir varias a la vez
                      </span>
                      <input
                        ref={inputRef}
                        type="file"
                        multiple
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(e) => {
                          agregarFotos(e.target.files);
                          e.target.value = "";
                        }}
                        className="sr-only"
                      />
                    </label>

                    {fotos.length > 0 && (
                      <div className="mt-2 flex flex-col gap-2">
                        <p className="code tnum text-label text-fg-dim">
                          {fotos.length} {fotos.length === 1 ? "foto" : "fotos"}
                        </p>
                        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                          {fotos.map((foto, i) => (
                            <li key={`${foto.name}-${i}`} className="relative">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={previews[i]}
                                alt={foto.name}
                                className="aspect-square w-full rounded-md border border-divider object-cover"
                              />
                              <button
                                type="button"
                                onClick={() => quitarFoto(i)}
                                aria-label={`Quitar ${foto.name}`}
                                title="Quitar"
                                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-danger text-on-accent shadow-sm hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              >
                                <Trash aria-hidden className="size-3" />
                              </button>
                              <span className="mt-0.5 block truncate text-center text-label text-fg-dim">
                                {i + 1}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <Input
                    id="nombre-base-masivo"
                    label="Nombre de la tanda"
                    value={nombreBase}
                    onChange={(e) => setNombreBase(e.target.value)}
                    required
                    placeholder="alma-gemela"
                    autoComplete="off"
                    hint={`Cada proyecto se llama así + un número (${
                      nombreBase.trim() || "alma-gemela"
                    } 1, ${nombreBase.trim() || "alma-gemela"} 2, …).`}
                  />

                  <ToggleCard
                    activo={dual}
                    onChange={toggleDual}
                    title="Prompt dual"
                    descripcion={
                      dual ? (
                        <>
                          4 variantes fijas por foto: <b className="font-medium text-fg">A</b>{" "}
                          (variación casi igual) y <b className="font-medium text-fg">B</b>{" "}
                          (libertad para armar el ad), cada una con Flash y con Pro.
                        </>
                      ) : (
                        <>
                          Probá dos prompts distintos por foto — uno conservador y otro con
                          más libertad creativa — cruzados con los dos modelos.
                        </>
                      )
                    }
                  />

                  {dual ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="flex flex-col gap-1">
                        <Textarea
                          id="prompt-a-masivo"
                          label="Prompt A — variación casi igual"
                          hint="Conservador: mantiene la composición, cambia poco."
                          value={promptA}
                          onChange={(e) => setPromptA(e.target.value)}
                          required
                          rows={7}
                          mono
                          spellCheck={false}
                        />
                        {promptA !== PROMPT_A_DEFAULT && (
                          <button
                            type="button"
                            onClick={() => setPromptA(PROMPT_A_DEFAULT)}
                            className="self-start text-label text-fg-dim underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            Restaurar el sugerido
                          </button>
                        )}
                      </div>
                      <div className="flex flex-col gap-1">
                        <Textarea
                          id="prompt-b-masivo"
                          label="Prompt B — libertad creativa"
                          hint="Usa la foto solo como referencia y le da más libertad al modelo."
                          value={promptB}
                          onChange={(e) => setPromptB(e.target.value)}
                          required
                          rows={7}
                          mono
                          spellCheck={false}
                        />
                        {promptB !== PROMPT_B_DEFAULT && (
                          <button
                            type="button"
                            onClick={() => setPromptB(PROMPT_B_DEFAULT)}
                            className="self-start text-label text-fg-dim underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            Restaurar el sugerido
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <Textarea
                      id="prompt-masivo"
                      label="Prompt (el mismo para todas)"
                      hint="Se aplica igual a cada foto. Podés usar varios renglones."
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      required
                      rows={6}
                      mono
                      spellCheck={false}
                      placeholder={
                        'Me haces una variación de este creativo.\nEs un ad para vender una oferta de "dibujá tu alma gemela".\nVa orientado a mujeres.\nNo hace falta que cambies mucho, este ya funcionó.'
                      }
                    />
                  )}
                </div>

                {/* ─── Derecha: card surface ───────────────────────────────── */}
                <div className="flex flex-col gap-4 rounded-lg bg-surface p-4">
                  <Select
                    label="Formato"
                    value={formato}
                    onValueChange={setFormato}
                    options={FORMATOS}
                  />
                  <Select
                    label="Calidad"
                    value={calidad}
                    onValueChange={setCalidad}
                    options={CALIDADES}
                  />
                  {dual ? (
                    // Deshabilitado y no escondido: se ve el "4" fijo en vez de que
                    // parezca que la pantalla se olvidó de mostrar el selector.
                    <Select
                      label="Variantes por foto"
                      value="4"
                      onValueChange={() => {}}
                      options={[{ value: "4", label: "4 (fijo con prompt dual)" }]}
                      disabled
                    />
                  ) : (
                    <Select
                      label="Variantes por foto"
                      value={String(variantes)}
                      onValueChange={(v) => setVariantes(Number(v))}
                      options={VARIANTES}
                    />
                  )}
                  <Input
                    id="negativo-masivo"
                    label="Negative prompt (opcional)"
                    value={negativo}
                    onChange={(e) => setNegativo(e.target.value)}
                    placeholder="text, watermark, extra fingers"
                    autoComplete="off"
                  />
                </div>
              </div>

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
            </form>
          </div>

          <BarraInferior>
            <Button
              type="submit"
              form="form-masivo"
              variant="primary"
              loading={enviando}
              disabled={!puedeEnviar}
              icon={<Sparkle aria-hidden className="size-4" />}
            >
              Generar la tanda
            </Button>
            {resumenCosto && <p className="code text-label text-fg-dim">{resumenCosto}</p>}
          </BarraInferior>
        </main>
      )}
    </>
  );
}

/**
 * Progreso de una tanda: header mono + barra de 4px, grilla de cards por proyecto.
 * Click en una card abre `/imagenes?id=` en la pestaña Generar — es un <Link>
 * normal, no cambia de pestaña por JS: al navegar, `ImagenesTabs` vuelve a montar
 * con `tab` en su default ("generar"), que es exactamente donde tiene que aparecer.
 */
function ProgresoTanda({ tanda }: { tanda: BatchResumen }) {
  const terminadas = tanda.proyectos.filter((p) => !STATUS_EN_CURSO.has(p.status)).length;
  const nombre = tanda.proyectos[0]?.name.replace(/\s\d+$/, "") ?? "Tanda";

  return (
    <main className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-4 p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="code text-display font-semibold text-fg">{nombre}</h1>
              <p className="code text-label text-fg-dim">
                {terminadas}/{tanda.total} listas · corre de a una · 9:16
              </p>
            </div>
          </div>
          <Progreso
            hechos={terminadas}
            total={tanda.total}
            tono="ok"
            alto={4}
            etiqueta={`Progreso de ${nombre}`}
          />
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
          >
            {tanda.proyectos.map((p) => {
              const estado = estadoDeProyecto(p.status);
              return (
                <Link
                  key={p.id}
                  href={`/imagenes?id=${encodeURIComponent(p.id)}`}
                  className={cn(
                    "flex flex-col gap-2 rounded-lg border border-divider bg-surface p-2 transition-colors",
                    "hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  )}
                >
                  <div className="grid grid-cols-2 gap-1">
                    <span
                      aria-hidden
                      className="aspect-[9/16] rounded-sm bg-surface-hi"
                      style={{ opacity: STATUS_EN_CURSO.has(p.status) ? 0.3 : 1 }}
                    />
                    <span
                      aria-hidden
                      className="aspect-[9/16] rounded-sm bg-surface-hi"
                      style={{ opacity: STATUS_EN_CURSO.has(p.status) ? 0.3 : 1 }}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 px-0.5 pb-0.5">
                    <span className="code min-w-0 truncate text-label text-fg">
                      {p.name}
                    </span>
                    <Badge tone={estado.tone} punto animado={estado.animado} className="shrink-0">
                      {estado.label}
                    </Badge>
                  </div>
                </Link>
              );
            })}
          </div>
          <p className="text-label text-fg-dim">
            Corre de a una. Tocá una tanda para revisar sus variantes en Generar.
          </p>
        </div>
      </div>
    </main>
  );
}
