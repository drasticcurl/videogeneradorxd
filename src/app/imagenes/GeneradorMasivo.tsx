"use client";

/**
 * Generador masivo de variaciones: subís N fotos + UN prompt, y crea N proyectos de
 * imagenes (uno por foto, image2image contra ella) que corren SECUENCIAL — uno
 * termina, arranca el siguiente — alternando Nano Banana Pro/Flash por proyecto.
 *
 * Backend: `POST /api/imagenes/masivo` (ver ese archivo para el detalle de las dos
 * mitigaciones anti rate-limit). Esta pantalla es solo el formulario + el progreso
 * agregado de la tanda; no duplica la revision de variantes, cada proyecto se revisa
 * en la pestaña "Generar" de siempre (mismo `/imagenes?id=<id>`) o desde `/batch`.
 *
 * ─── POR QUE NO REUSA <ImagenesBoard> PARA MOSTRAR RESULTADOS ────────────────
 *
 * `ImagenesBoard` esta armado alrededor de UN proyecto abierto (`?id=`) con su hilo de
 * chat iterativo. Una tanda masiva son VARIOS proyectos a la vez, y lo que hace falta
 * ver aca es el PROGRESO AGREGADO (cuantos van, cual esta corriendo, cual fallo), no
 * las variantes de cada uno. Por eso esta pantalla solo linkea a cada proyecto
 * (`/imagenes?id=<id>`) para revisarlo en la pestaña "Generar", que ya sabe mostrar
 * las variantes de un proyecto.
 *
 * ─── POLLING: SOLO MIENTRAS HAYA UNA TANDA EN CURSO EN ESTA PESTAÑA ──────────
 * Mismo patron que ImagenesBoard: intervalo en un ref, se apaga solo cuando no queda
 * nada en curso. No hace polling si el usuario no lanzo ninguna tanda desde que abrio
 * la pagina (evita pegarle a /api/projects sin necesidad la primera vez que se entra).
 */

import {
  Image as ImageIcon,
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
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Textarea,
  type SelectOption,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { IMAGE_ASPECT_RATIOS, IMAGE_SIZES } from "@/lib/formatos";
import { estadoDeProyecto } from "@/lib/ui-tokens";

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

export default function GeneradorMasivo() {
  const [nombreBase, setNombreBase] = useState("");
  const [prompt, setPrompt] = useState("");
  /**
   * "Prompt dual": en vez de un prompt con N variantes del mismo modelo, dos prompts
   * fijos en 4 variantes cruzadas con los dos modelos (ver el comentario de
   * `/api/imagenes/masivo`, sección "PROMPT DUAL"). `promptA` es la variación
   * conservadora, `promptB` la libre. Con el switch activo, `variantes` se ignora
   * (el selector queda deshabilitado en vez de escondido: así se ve el "4" fijo y no
   * parece que la app se olvidó de mostrarlo).
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

  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Las tandas lanzadas DESDE ESTA PESTAÑA (no persiste entre reloads: agrupar las
  // tandas viejas se puede reconstruir mas adelante desde /api/projects agrupando por
  // `batch.batchId` si hiciera falta; para "generar y ver que pasa" alcanza con esto).
  const [tandas, setTandas] = useState<BatchResumen[]>([]);

  /*
    Preview de cada foto con URL.createObjectURL, revocadas en cleanup: mismo motivo
    que la imagen base de ImagenesBoard (sin revoke, cada archivo elegido queda vivo
    en memoria hasta cerrar la pestaña).
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

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={generar}>
        <Card className="flex flex-col gap-4">
          <CardHeader className="mb-0">
            <div>
              <CardTitle>Generador masivo de variaciones</CardTitle>
              <CardDescription>
                Subí varias fotos y un solo prompt: crea un proyecto por foto y los
                corre de a uno (no en paralelo), alternando {MODELOS_TANDA} para no
                pegar contra la cuota por minuto de un solo modelo.
              </CardDescription>
            </div>
          </CardHeader>

          <Input
            id="nombre-base-masivo"
            label="Nombre de la tanda"
            value={nombreBase}
            onChange={(e) => setNombreBase(e.target.value)}
            required
            placeholder="alma-gemela"
            autoComplete="off"
            hint="Cada proyecto se va a llamar así + un número (alma-gemela 1, alma-gemela 2, …)."
          />

          {/*
            Switch "Prompt dual". Mismo patron que el de auto-aprobacion de la home
            (checkbox nativo + accent-accent): no hay un componente Switch en el
            sistema de diseño, y agregar uno para un solo uso no se justifica.
          */}
          <Card flush>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg p-3.5 focus-within:ring-2 focus-within:ring-accent">
              <input
                type="checkbox"
                checked={dual}
                onChange={(e) => setDual(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-accent"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-fg">Prompt dual</span>
                <span className="mt-0.5 block max-w-prose text-label text-fg-dim">
                  {dual ? (
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
                  )}
                </span>
              </span>
            </label>
          </Card>

          {dual ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Textarea
                id="prompt-a-masivo"
                label="Prompt A — variación casi igual"
                hint="Conservador: mantiene la composición, cambia poco."
                value={promptA}
                onChange={(e) => setPromptA(e.target.value)}
                required
                rows={6}
                mono
                spellCheck={false}
                placeholder={
                  "Me haces una variación de este creativo.\nNo hace falta que cambies mucho, este ya funcionó."
                }
              />
              <Textarea
                id="prompt-b-masivo"
                label="Prompt B — libertad creativa"
                hint="Usa la foto solo como referencia y le da más libertad al modelo."
                value={promptB}
                onChange={(e) => setPromptB(e.target.value)}
                required
                rows={6}
                mono
                spellCheck={false}
                placeholder={
                  'Usá esta foto como referencia de la persona/producto y armá un ad nuevo.\nEs para vender una oferta de "dibujá tu alma gemela", orientado a mujeres.\nTenés libertad para cambiar composición, fondo y estilo.'
                }
              />
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

          {/* Dropzone multi-archivo */}
          <div>
            <span className="mb-1 block text-label font-medium text-fg-dim">
              Fotos a variar
            </span>
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
                <div className="flex items-center justify-between">
                  <p className="font-mono text-label tnum text-fg-dim">
                    {fotos.length} {fotos.length === 1 ? "foto" : "fotos"}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={limpiarFotos}
                    icon={<Trash aria-hidden className="size-3.5" />}
                  >
                    Vaciar
                  </Button>
                </div>
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

          <div className="grid gap-4 sm:grid-cols-3">
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
          </div>

          <Input
            id="negativo-masivo"
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
              disabled={!puedeEnviar}
              icon={<Sparkle aria-hidden className="size-4" />}
            >
              Generar la tanda
            </Button>
            {resumenCosto && (
              <p className="font-mono text-label tnum text-fg-dim">{resumenCosto}</p>
            )}
          </div>
        </Card>
      </form>

      {/* ─── Tandas lanzadas en esta pestaña ────────────────────────────────── */}
      {tandas.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="border-t border-divider pt-5 text-title font-semibold text-fg">
            Tandas de esta sesión
          </h2>
          <div className="flex flex-col gap-3">
            {tandas.map((t) => {
              const terminadas = t.proyectos.filter(
                (p) => !STATUS_EN_CURSO.has(p.status),
              ).length;
              return (
                <Card key={t.batchId} className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-body font-medium text-fg">
                      {t.proyectos[0]?.name.replace(/\s\d+$/, "") ?? "Tanda"}
                    </p>
                    <p className="font-mono text-label tnum text-fg-dim">
                      {terminadas}/{t.total} listas · corre de a una
                    </p>
                  </div>
                  <ul className="flex flex-col gap-1.5">
                    {t.proyectos.map((p) => {
                      const estado = estadoDeProyecto(p.status);
                      return (
                        <li
                          key={p.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-divider bg-surface px-2.5 py-1.5"
                        >
                          <Link
                            href={`/imagenes?id=${encodeURIComponent(p.id)}`}
                            className="flex min-w-0 items-center gap-2 text-body text-fg hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                          >
                            <ImageIcon aria-hidden className="size-4 shrink-0 text-fg-dim" />
                            <span className="truncate">{p.name}</span>
                          </Link>
                          <Badge tone={estado.tone} punto animado={estado.animado}>
                            {estado.label}
                          </Badge>
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
