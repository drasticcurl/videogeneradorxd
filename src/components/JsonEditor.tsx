"use client";
/**
 * Editor JSON con validacion en vivo contra el esquema Zod del plan.
 * Muestra errores de sintaxis y de esquema a medida que se edita.
 */
import { useEffect, useMemo, useState } from "react";
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-400">
          PlanJSON (editable, validacion en vivo)
        </span>
        {result.kind === "ok" ? (
          <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300">
            ✓ valido
          </span>
        ) : (
          <span className="rounded bg-red-500/20 px-2 py-0.5 text-xs text-red-300">
            ✗ revisar
          </span>
        )}
      </div>
      <textarea
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setTouched(true);
          setText(e.target.value);
        }}
        className="code h-96 w-full resize-y rounded-lg border border-slate-700 bg-ink p-3 text-xs leading-relaxed text-slate-100 focus:border-accent focus:outline-none"
      />
      {result.kind === "syntax" && (
        <p className="rounded bg-red-500/10 p-2 text-xs text-red-300">
          Error de sintaxis JSON: {result.message}
        </p>
      )}
      {result.kind === "schema" && (
        <ul className="space-y-1 rounded bg-red-500/10 p-2 text-xs text-red-300">
          {result.errors.map((e, i) => (
            <li key={i}>
              <code className="text-red-200">{e.path || "(raiz)"}</code>: {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
