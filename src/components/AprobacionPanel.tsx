"use client";

/**
 * "Aprobación": cuantos clips de video se generan sin aprobar antes de frenar, en los
 * proyectos con aprobacion manual. Es de cada usuario y afecta solo a SUS proyectos.
 * Pestaña de ConfiguracionDialog.
 *
 * Se escribe contra el contrato HTTP de /api/preferencias y solo importa TIPOS de
 * @/lib/types: nada de @/lib/preferencias, que trae node:fs.
 *
 * El boton usa `loading` y NO cambia el texto (§5 del rediseño).
 */

import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { Button, Input } from "@/components/ui";
import type { PreferenciasDeUsuario } from "@/lib/types";

const RUTA = "/api/preferencias";

/** Mismo tope que LOTE_VIDEOS_MAX (src/lib/preferencias.ts). El server valida igual. */
const MAX = 50;

type Resultado = { tono: "ok" | "error"; texto: string };

async function llamar(metodo: "GET" | "PUT", body?: unknown): Promise<PreferenciasDeUsuario> {
  const res = await fetch(RUTA, {
    method: metodo,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const datos = (await res.json().catch(() => null)) as
    | { preferencias?: PreferenciasDeUsuario; error?: string }
    | null;
  if (!res.ok || !datos?.preferencias) {
    throw new Error(
      datos?.error ??
        (res.status === 401 ? "Tu sesión venció. Volvé a entrar." : `El servidor contestó ${res.status}.`),
    );
  }
  return datos.preferencias;
}

/** "de a 5" / "sin límite", para las frases. */
function comoLote(n: number): string {
  return n === 0 ? "sin límite" : `de a ${n}`;
}

export default function AprobacionPanel() {
  const [prefs, setPrefs] = useState<PreferenciasDeUsuario | null>(null);
  const [valor, setValor] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  useEffect(() => {
    llamar("GET")
      .then((p) => {
        setPrefs(p);
        setValor(String(p.loteVideos));
      })
      .catch((err) => setResultado({ tono: "error", texto: err instanceof Error ? err.message : String(err) }));
  }, []);

  const n = Number(valor);
  const valido = valor.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= MAX;
  const cambia = prefs !== null && valido && n !== prefs.loteVideos;

  async function guardar(loteVideos: number | null) {
    setGuardando(true);
    setResultado(null);
    try {
      const p = await llamar("PUT", { loteVideos });
      setPrefs(p);
      setValor(String(p.loteVideos));
      setResultado({
        tono: "ok",
        texto:
          loteVideos === null
            ? `Listo: volviste al default, ${comoLote(p.loteVideos)}.`
            : `Listo: tus proyectos generan clips ${comoLote(p.loteVideos)} antes de pedir aprobación.`,
      });
    } catch (err) {
      setResultado({ tono: "error", texto: err instanceof Error ? err.message : String(err) });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-fg-dim">
        En los proyectos con <span className="text-fg">aprobación manual</span>, la app genera hasta este número
        de clips de video y se frena hasta que los apruebes. Es lo máximo que se gasta en Veo sin que mires el
        resultado.
      </p>

      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (cambia) void guardar(n);
        }}
      >
        <Input
          label="Clips antes de pedir aprobación"
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX}
          step={1}
          value={valor}
          disabled={prefs === null}
          onChange={(e) => {
            setValor(e.target.value);
            setResultado(null);
          }}
          error={valor.trim() !== "" && !valido ? `Tiene que ser un número entero entre 0 y ${MAX}.` : undefined}
          hint={
            prefs
              ? `0 = sin límite. Si no elegís uno, rige el default: ${comoLote(prefs.loteVideosDefault)}.`
              : undefined
          }
        />

        {valido && n === 0 && (
          <p className="flex items-start gap-2 rounded-sm bg-accent/10 px-3 py-2 text-body text-accent">
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            Sin límite, un proyecto genera todos sus clips de una sin frenar: uno de 95 clips gasta los 95.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-label text-fg-dim">
            {prefs &&
              (prefs.loteVideosPropio
                ? `Ahora: ${comoLote(prefs.loteVideos)} (elegido por vos).`
                : `Ahora: ${comoLote(prefs.loteVideos)} (el default).`)}
          </p>
          <div className="flex gap-2">
            {prefs?.loteVideosPropio && (
              <Button type="button" variant="ghost" onClick={() => void guardar(null)} disabled={guardando}>
                Volver al default
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              loading={guardando}
              disabled={!cambia}
              icon={<CheckCircle aria-hidden className="size-4" />}
            >
              Guardar
            </Button>
          </div>
        </div>
      </form>

      <div aria-live="polite" className="empty:-mt-4">
        {resultado?.tono === "ok" && (
          <p role="status" className="flex items-start gap-2 rounded-sm bg-ok/10 px-3 py-2 text-body text-ok">
            <CheckCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {resultado.texto}
          </p>
        )}
        {resultado?.tono === "error" && (
          <p role="alert" className="flex items-start gap-2 rounded-sm bg-danger/10 px-3 py-2 text-body text-danger">
            <WarningCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
            {resultado.texto}
          </p>
        )}
      </div>

      <ul className="flex list-disc flex-col gap-1 border-t border-divider pl-5 pt-3 text-label text-fg-dim">
        <li>Es tuyo: cambia solo tus proyectos, no los de los demás.</li>
        <li>Con aprobación automática no hay freno: cada clip se aprueba solo al terminar.</li>
        <li>
          Si un proyecto ya está frenado esperando que apruebes, el número nuevo se usa cuando apruebes un clip o lo
          reanudes: guardar no arranca nada solo.
        </li>
        <li>Las imágenes no se frenan: se generan todas y se revisan en bloque.</li>
      </ul>
    </div>
  );
}
