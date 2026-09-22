"use client";

/**
 * "Nueva tanda": pantalla propia (ya no un formulario siempre visible en la
 * galería). Contenido con scroll, dos columnas, footer fijo con Generar/Cancelar.
 *
 * NO conoce la forma exacta de la respuesta del POST: solo arma el payload
 * (FormData si hay imagen base, JSON si no — MISMO criterio que el formulario
 * viejo, ver el comentario de `ImagenesBoard.generar`) y le devuelve el resultado a
 * quien la use vía `onGenerar`, que es quien realmente hace el fetch. Así el
 * endpoint/payload sigue viviendo en un solo lugar (`ImagenesBoard`) y esta pantalla
 * es puramente el formulario.
 */
import {
  ImageSquare,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  Input,
  Textarea,
  type SelectOption,
} from "@/components/ui";
import { BarraInferior } from "@/components/Pantalla";
import { cn } from "@/lib/cn";
import { IMAGE_ASPECT_RATIOS, IMAGE_SIZES, imageSizesFor } from "@/lib/formatos";

interface ResultadoGenerar {
  ok: boolean;
  error?: string;
}

/**
 * Como va a quedar el nombre del archivo. Misma transformación que `slugify` en el
 * server (`src/lib/storage.ts`), escrita acá porque ese módulo es de Node.
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

/** La forma del formato, dibujada a escala. Ver el comentario largo en el archivo viejo. */
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

const VARIANTES: readonly number[] = [1, 2, 3, 4];

export default function NuevaTanda({
  modelos,
  modeloDefault,
  enviando,
  onGenerar,
  onCancelar,
}: {
  modelos: ReadonlyArray<SelectOption<string>>;
  modeloDefault: string;
  enviando: boolean;
  onGenerar: (
    payload: FormData | Record<string, unknown>,
  ) => Promise<ResultadoGenerar>;
  onCancelar: () => void;
}) {
  const [nombre, setNombre] = useState("");
  const [texto, setTexto] = useState("");
  const [variantes, setVariantes] = useState(2);
  const [modelo, setModelo] = useState(modeloDefault);
  const [formato, setFormato] = useState("9:16");
  const [calidad, setCalidad] = useState("1K");
  const [negativo, setNegativo] = useState("");
  const [imagenBase, setImagenBase] = useState<File | null>(null);
  const [imagenBasePreview, setImagenBasePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imagenBaseInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

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
    Preview de la imagen base con `URL.createObjectURL`, revocada en cleanup: sin el
    `revokeObjectURL` cada archivo elegido queda vivo en memoria hasta que se cierra la
    pestaña.
  */
  useEffect(() => {
    if (!imagenBase) {
      setImagenBasePreview(null);
      return;
    }
    const url = URL.createObjectURL(imagenBase);
    setImagenBasePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imagenBase]);

  function elegirImagenBase(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setImagenBase(file);
  }

  function quitarImagenBase() {
    setImagenBase(null);
    if (imagenBaseInputRef.current) imagenBaseInputRef.current.value = "";
  }

  const tienePrompt = texto.trim().length > 0;
  const puedeGenerar = tienePrompt && nombre.trim().length > 0;

  async function generar(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!puedeGenerar) return;

    // Con imagen base: FormData (multipart). Sin ella: JSON. Idéntico al formulario
    // viejo — el server decide el parser por Content-Type (/api/imagenes/route.ts).
    const payload = imagenBase
      ? (() => {
          const fd = new FormData();
          fd.set("nombre", nombre);
          fd.set("prompt", texto);
          fd.set("variantes", String(variantes));
          fd.set("model", modelo);
          fd.set("aspectRatio", formato);
          fd.set("imageSize", calidad);
          if (negativo.trim()) fd.set("negativePrompt", negativo);
          fd.set("imagenBase", imagenBase);
          return fd;
        })()
      : {
          nombre,
          prompt: texto,
          variantes,
          model: modelo,
          aspectRatio: formato,
          imageSize: calidad,
          negativePrompt: negativo,
        };

    const resultado = await onGenerar(payload);
    if (!resultado.ok) {
      setError(resultado.error ?? "Error al generar");
    }
  }

  const elegidoFormato = IMAGE_ASPECT_RATIOS.find((f) => f.id === formato);

  return (
    <main className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/*
          `id` en el form + `form={id}` en el boton de la barra inferior (que vive
          AFUERA de este <form>, en el footer fijo): asi el submit real dispara
          `onSubmit` sin necesidad de un handler duplicado en el boton. Sin esto,
          el boton de "Generar" del footer quedaria sin conectar al form de arriba.
        */}
        <form
          id="form-nueva-tanda"
          onSubmit={generar}
          className="mx-auto flex max-w-[1080px] flex-col gap-5 p-6"
        >
          <header>
            <h1 className="text-display font-semibold text-fg">Nueva tanda</h1>
            <p className="mt-1 max-w-prose text-body text-fg-dim">
              Un prompt, con las variantes que quieras. El archivo se nombra con el
              nombre del proyecto.
            </p>
          </header>

          <div
            className="grid gap-6"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}
          >
            {/* ─── Izquierda ─────────────────────────────────────────────── */}
            <div className="flex flex-col gap-4">
              <div>
                <Input
                  id="nombre"
                  label="Nombre del proyecto"
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  required
                  placeholder="crema manos"
                  autoComplete="off"
                  aria-describedby="nombre-archivo"
                />
                <p id="nombre-archivo" className="mt-1 text-label text-fg-dim">
                  Sale como <span className="code text-fg">{slugPreview(nombre)}.png</span>
                </p>
              </div>

              <div>
                <span className="mb-1 block text-label font-medium text-fg-dim">
                  Modelo
                </span>
                <div className="flex flex-col gap-1">
                  {modelos.map((m) => {
                    const activo = m.value === modelo;
                    return (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => setModelo(m.value)}
                        className={cn(
                          "flex h-8 items-center justify-between gap-2 rounded-sm border px-2.5 text-left text-body transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                          activo
                            ? "border-accent bg-accent/10 text-fg"
                            : "border-border bg-bg text-fg hover:bg-surface-hi",
                        )}
                      >
                        <span>{m.label}</span>
                        {m.hint && (
                          <span className="text-label text-fg-dim">{m.hint}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <Textarea
                ref={promptRef}
                id="prompt-nueva-tanda"
                label="Prompt"
                hint="Podés usar varios renglones: todo es parte del mismo prompt."
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                required
                rows={9}
                mono
                spellCheck={false}
                placeholder={
                  "A woman applying hand cream, close up on dry hands.\nNatural window light, shallow depth of field.\nPhotorealistic, documentary style."
                }
              />

              <div>
                <span className="mb-1 block text-label font-medium text-fg-dim">
                  Imagen base (opcional)
                </span>
                {imagenBasePreview ? (
                  <div className="flex items-center gap-3 rounded-md border border-divider bg-surface p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={imagenBasePreview}
                      alt="Vista previa de la imagen base"
                      className="size-16 shrink-0 rounded-sm object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body text-fg" title={imagenBase?.name}>
                        {imagenBase?.name}
                      </p>
                      <p className="text-label text-fg-dim">
                        La primera generación va a ser image2image contra esta imagen.
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={quitarImagenBase}
                      icon={<X aria-hidden className="size-3.5" />}
                    >
                      Quitar
                    </Button>
                  </div>
                ) : (
                  <label
                    className={cn(
                      "flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed",
                      "border-divider bg-surface px-3 py-4 text-body text-fg-dim transition-colors",
                      "hover:border-border hover:text-fg",
                    )}
                  >
                    <ImageSquare aria-hidden className="size-4" />
                    Subir una imagen para partir de ella
                    <input
                      ref={imagenBaseInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={elegirImagenBase}
                      className="sr-only"
                    />
                  </label>
                )}
                <p className="mt-1 text-label text-fg-dim">
                  Sin imagen, se genera desde cero con el prompt (text2image).
                </p>
              </div>
            </div>

            {/* ─── Derecha: card surface ─────────────────────────────────── */}
            <div className="flex flex-col gap-4 rounded-lg bg-surface p-4">
              <div>
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-label font-medium text-fg-dim">Formato</span>
                  <span className="text-label text-fg-dim">{elegidoFormato?.uso}</span>
                </div>
                <div
                  role="radiogroup"
                  aria-label="Formato de la imagen"
                  className="flex flex-wrap gap-1.5"
                >
                  {IMAGE_ASPECT_RATIOS.map((f) => {
                    const activo = formato === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        role="radio"
                        aria-checked={activo}
                        title={f.uso ? `${f.id} · ${f.uso}` : f.id}
                        onClick={() => setFormato(f.id)}
                        className={cn(
                          "flex size-[52px] flex-col items-center justify-center gap-1 rounded-md",
                          "border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                          activo
                            ? "border-accent bg-accent text-on-accent"
                            : "border-divider bg-bg text-fg-dim hover:text-fg",
                        )}
                      >
                        <Forma w={f.w} h={f.h} />
                        <span className="code text-label">{f.id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <span className="mb-1 block text-label font-medium text-fg-dim">
                  Calidad
                </span>
                <div className="flex gap-1.5">
                  {IMAGE_SIZES.map((s) => {
                    const habilitada = calidadesPermitidas.includes(
                      s as (typeof calidadesPermitidas)[number],
                    );
                    const activo = calidad === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        disabled={!habilitada}
                        title={habilitada ? undefined : "El modelo elegido no soporta esta calidad"}
                        onClick={() => setCalidad(s)}
                        className={cn(
                          "h-9 min-w-[3.25rem] rounded-md border px-3 text-body transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed",
                          !habilitada && "opacity-40",
                          activo
                            ? "border-accent bg-accent font-medium text-on-accent"
                            : "border-divider bg-bg text-fg-dim hover:text-fg",
                        )}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 text-label text-fg-dim">
                  {calidadesPermitidas.length < IMAGE_SIZES.length ? (
                    <>Este modelo solo genera en 1K. Cambiá de modelo para 2K o 4K.</>
                  ) : (
                    <>4K tarda bastante más y pesa ~15 MB por imagen.</>
                  )}
                </p>
              </div>

              <div>
                <span className="mb-1 block text-label font-medium text-fg-dim">
                  Variantes
                </span>
                <div className="flex gap-1.5">
                  {VARIANTES.map((n) => {
                    const activo = variantes === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setVariantes(n)}
                        className={cn(
                          "code h-9 w-10 rounded-md border transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                          activo
                            ? "border-accent bg-accent font-medium text-on-accent"
                            : "border-divider bg-bg text-fg-dim hover:text-fg",
                        )}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </div>

              <Input
                id="negativo"
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
                {error}
              </p>
            )}
          </div>
        </form>
      </div>

      <BarraInferior>
        <Button
          type="submit"
          form="form-nueva-tanda"
          variant="primary"
          loading={enviando}
          disabled={!puedeGenerar}
          icon={<Sparkle aria-hidden className="size-4" />}
        >
          Generar
        </Button>
        {tienePrompt && (
          <p className="code text-label text-fg-dim">
            <span className="text-fg">{variantes}</span>{" "}
            {variantes === 1 ? "imagen" : "imágenes"} · <span className="text-fg">{formato}</span>{" "}
            · <span className="text-fg">{calidad}</span>
          </p>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" onClick={onCancelar}>
          Cancelar
        </Button>
      </BarraInferior>
    </main>
  );
}
