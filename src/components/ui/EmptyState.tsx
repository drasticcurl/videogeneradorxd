/**
 * Estado vacio. CONTRATO CONGELADO (§5 del plan).
 *
 * La app tenia varias listas que quedaban EN BLANCO cuando no habia datos, y no se
 * distinguia de "todavia esta cargando" ni de "algo se rompio". Un vacio siempre
 * dice que pasa y que hacer al respecto.
 */

import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  title: string;
  body: string;
  /** El texto va en el boton; la accion la maneja el llamador. */
  action?: { label: string; onClick: () => void };
  icon?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border border-dashed border-divider px-5 py-8",
        className,
      )}
    >
      {icon && <span className="mb-1 text-fg-dim">{icon}</span>}
      <p className="text-title font-semibold text-fg">{title}</p>
      <p className="max-w-prose text-body text-fg-dim">{body}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={
            "mt-3 inline-flex h-9 items-center rounded-md border border-border px-3.5 " +
            "text-body font-medium text-fg transition-colors hover:bg-surface-hi " +
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          }
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
