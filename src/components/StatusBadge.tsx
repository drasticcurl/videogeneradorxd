"use client";

/**
 * Badge de estado. Lo usan jobs, proyectos y clips del manifest.
 *
 * ─── ESTE ARCHIVO ERA UNA DE LAS 4 COPIAS DIVERGENTES ────────────────────────
 *
 * Antes tenia su propio `switch` de 11 estados con los colores escritos a mano
 * (indigo, fuchsia, orange, slate...), y era la razon concreta de que el estado "hay
 * que elegir variante" saliera indigo aca y ambar en el pipeline: dos mapeos
 * distintos para el mismo estado, en dos archivos distintos.
 *
 * Los nombres crudos de los estados no se escriben en este archivo justamente para
 * que `grep` pueda probar que el unico que los conoce es `ui-tokens`.
 *
 * Ahora el label y el tono salen de `ui-tokens` y la traduccion de tono a clases la
 * hace `Badge`. Este componente NO decide ni un color ni un label: solo elige a que
 * funcion de `ui-tokens` le pregunta, porque recibe estados de dos dominios.
 */

import { Badge } from "@/components/ui";
import type { JobStatus } from "@/lib/types";
import { estadoDeJob, estadoDeProyecto, type EstadoVisual } from "@/lib/ui-tokens";

/**
 * CONTRATO: la union es exactamente la que ya recibia. Siete lugares le pasan cosas
 * de tres dominios distintos y por eso es mas ancha que `JobStatus`:
 *   - `job.status`     (JobCard, VideoDeck)          -> JobStatus
 *   - `project.status` (home, batch, pipeline, result) -> ProjectStatus
 *   - `clip.status`    (result)                       -> JobStatus | "placeholder"
 * No angostarla: el typecheck de las pantallas depende de esto.
 */
type Status =
  | JobStatus
  | "placeholder"
  | "draft"
  | "running"
  | "review"
  | "partial"
  | "paused";

/**
 * Los estados que son de PROYECTO y no de job. Se preguntan a `estadoDeProyecto`,
 * que es el unico que sabe que `review` significa "el pipeline te esta esperando" y
 * no "terminado".
 *
 * `done` y `failed` existen en los dos dominios y las dos funciones de `ui-tokens`
 * los mapean igual, asi que no hay ambiguedad: caen en `estadoDeJob` y da lo mismo.
 */
const DE_PROYECTO = new Set<string>(["draft", "running", "review", "paused"]);

/**
 * Los dos unicos estados que `ui-tokens` todavia no mapea.
 *
 * Ver P-05 en §10 del plan: el lugar donde tienen que vivir es `ui-tokens.ts`, que
 * es de T01, y T02 no puede escribirlo (§8). Sin esta tabla la UI imprimiria
 * "placeholder" y "partial" crudos en la cara del usuario, que es justo lo que §6
 * prohibe. Los dos tonos salen de la escala funcional: no hay ni un color aca.
 *
 * NO agregar entradas nuevas: si aparece otro estado, va a `ui-tokens`.
 */
const SIN_MAPEO: Record<string, EstadoVisual> = {
  // Clip que graba una persona, no la IA. Requiere al usuario -> attention (D6).
  placeholder: { tone: "attention", label: "A filmar", animado: false },
  // Proyecto que cerro con parte de los jobs fallados. Tambien requiere decision.
  partial: { tone: "attention", label: "Incompleto", animado: false },
};

export function StatusBadge({ status }: { status: Status }) {
  const estado: EstadoVisual =
    SIN_MAPEO[status] ??
    (DE_PROYECTO.has(status) ? estadoDeProyecto(status) : estadoDeJob(status));

  return (
    <Badge tone={estado.tone} punto animado={estado.animado}>
      {estado.label}
    </Badge>
  );
}
