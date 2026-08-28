"use client";
/**
 * Editor JSON con validacion en vivo contra el esquema Zod del plan.
 * Muestra errores de sintaxis y de esquema a medida que se edita.
 *
 * ─── QUE CAMBIO Y QUE NO ─────────────────────────────────────────────────────
 *
 * La logica de parseo y validacion es IDENTICA a la de antes, linea por linea: el
 * `useState` con el JSON serializado, el `touched` que evita pisar lo que el usuario
 * esta escribiendo, el `useMemo` que parsea y valida, y el `useEffect` que avisa para
 * arriba cuando el plan es valido. Este archivo es un `<textarea>` con validacion y
 * eso no se toca.
 *
 * Lo que cambia es la presentacion: el textarea es el `Textarea` de T01, asi gana
 * label real, `aria-invalid` y el error anunciado con `aria-live` cuando el JSON deja
 * de ser valido. Antes el error era un parrafo rojo que un lector de pantalla no
 * anunciaba nunca.
 *
 * La clase `.code` se conserva por nombre: esta definida en `globals.css` y T01 la
 * mantuvo justamente porque este componente la usa.
 */
import { useEffect, useMemo, useState } from "react";

import { Badge, Textarea } from "@/components/ui";
import { validatePlan, type ProjectPlan } from "@/lib/schema";

interface Props {
  value: ProjectPlan;
  onValidChange: (plan: ProjectPlan) => void;
}

export function JsonEditor({ value, onValidChange }: Props) {
  const [text, setText] = useState<string>(() => JSON.stringify(value, null, 2));
  const [touched, setTouched] = useState(false);

  // Si el plan externo cambia (ej. reinterpretar) y el usuario no esta editando, refrescamos.
  useEffect(() => {
    if (!touched) {
      setText(JSON.stringify(value, null, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const result = useMemo(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return {
        kind: "syntax" as const,
        message: e instanceof Error ? e.message : "JSON invalido",
      };
    }
    const v = validatePlan(parsed);
    if (v.ok) return { kind: "ok" as const, plan: v.plan };
    return { kind: "schema" as const, errors: v.errors };
  }, [text]);

  useEffect(() => {
    if (result.kind === "ok") onValidChange(result.plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  /*
    El `error` del Textarea es un string y los errores de esquema son una lista. Va el
    resumen adentro del campo (que es lo que pinta el borde y lo que se anuncia) y el
    detalle campo por campo abajo, que es lo que el usuario necesita para arreglarlo.
  */
  const error =
    result.kind === "syntax"
      ? `Error de sintaxis JSON: ${result.message}`
      : result.kind === "schema"
        ? `${result.errors.length} ${
            result.errors.length === 1 ? "campo no cumple" : "campos no cumplen"
          } el esquema del plan`
        : undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        {/*
          El label del Textarea va oculto (queda para el lector de pantalla, atado
          por htmlFor) porque el titulo visible tiene que compartir la fila con el
          estado de validacion.
        */}
        <span className="text-label font-medium text-fg-dim">
          PlanJSON (editable, validación en vivo)
        </span>
        {result.kind === "ok" ? (
          <Badge tone="ok" punto>
            Válido
          </Badge>
        ) : (
          <Badge tone="danger" punto>
            Revisar
          </Badge>
        )}
      </div>

      <Textarea
        label="PlanJSON (editable, validación en vivo)"
        labelOculto
        mono
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setTouched(true);
          setText(e.target.value);
        }}
        error={error}
        className="code h-96 leading-relaxed"
      />

      {result.kind === "schema" && (
        <ul className="space-y-1 rounded-sm bg-danger/10 p-2 text-label text-danger">
          {result.errors.map((e, i) => (
            <li key={i}>
              <code className="code text-fg">{e.path || "(raíz)"}</code>: {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
