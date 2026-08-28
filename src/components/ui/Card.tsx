/**
 * Tarjeta y panel. CONTRATO CONGELADO (§5 del plan).
 *
 * SIN BORDE Y SIN SOMBRA A LA VEZ, solo superficie y padding. Una tarjeta con borde
 * mas sombra sobre fondo oscuro es el look generico por excelencia: la separacion la
 * da el cambio de superficie (bg -> surface), que sobre oscuro alcanza y sobra.
 */

import { cn } from "@/lib/cn";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Sin padding, para cuando la tarjeta arranca con una imagen a sangre. */
  flush?: boolean;
}

export function Card({ className, flush, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg bg-surface",
        !flush && "p-4",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mb-3 flex items-start justify-between gap-3", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2 className={cn("text-title font-semibold text-fg", className)} {...props}>
      {children}
    </h2>
  );
}

/** Texto de apoyo del encabezado. Va en `fg-dim`, que es el piso legible. */
export function CardDescription({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("text-body text-fg-dim", className)} {...props}>
      {children}
    </p>
  );
}
