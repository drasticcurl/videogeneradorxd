/**
 * Las 10 primitivas del sistema de diseño.
 *
 * Se importan siempre desde acá (`@/components/ui`), no del archivo suelto: así
 * cambiar la implementación de una no obliga a tocar los imports de las 8 pantallas.
 *
 * CONTRATO CONGELADO: §5 del plan de rediseño. Once tasks se escribieron contra
 * estas firmas en paralelo. No cambiarlas sin actualizar el plan primero.
 */

export { Badge, type BadgeProps } from "./Badge";
export { Button, type ButtonProps } from "./Button";
export {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  type CardProps,
} from "./Card";
export {
  Confirmar,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
} from "./Dialog";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { Input, Textarea, type InputProps, type TextareaProps } from "./Field";
export { Select, type SelectOption, type SelectProps } from "./Select";
export { Skeleton, SkeletonGrid } from "./Skeleton";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";
