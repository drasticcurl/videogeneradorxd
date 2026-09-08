/**
 * Ownership — quien es dueño de que.
 *
 * ESTO NO ES AUTENTICACION. La autenticacion (quien sos) ya existe y funciona:
 * `src/lib/auth.ts` + `src/middleware.ts`, cookie `gen_session` firmada con HMAC. Este
 * modulo es AUTORIZACION (de que sos dueño), y va separado a proposito: mezclar las
 * dos en el mismo archivo hace que un bug en el filtro de proyectos pueda dejar la
 * app entera abierta. Por eso vive en un archivo NUEVO y no adentro de `auth.ts`
 * (que ademas esta en la lista de intocables de `tasks/_verificacion-endpoints.sh`).
 *
 * EL AGUJERO QUE ESTO CIERRA: `ProjectRecord` no tenia campo de dueño y ninguna de
 * las 25 route handlers comparaba la sesion contra el proyecto. Hay 4 caminos por los
 * que se veia lo ajeno:
 *   1. GET /api/projects devolvia TODOS los proyectos sin filtrar.
 *   2. /batch?ids=a,b,c — los ids viajan en la URL y /api/batch no chequeaba nada.
 *   3. GET /api/files/<projectId>/<path> servia cualquier archivo y NI CONSULTABA la DB.
 *   4. /api/jobs/<jobId>/* — los ids de job son derivados (`<projectId>:img:<imageId>`,
 *      `<projectId>:vid:<clipId>`, ver jobs/pipeline.ts:43-48), asi que un projectId
 *      habilitaba aprobar/regenerar/editar lo ajeno.
 *
 * Ver tasks/aislamiento-por-usuario/00-PLAN-AISLAMIENTO-USUARIO.md, §4, para el
 * contrato completo y el porque de cada regla.
 */
import { cookies } from "next/headers";
import { currentUser } from "./auth";
import { jobsDb, projectsDb } from "./db";
import { notFound, ok } from "./http";
import type { NextResponse } from "next/server";
import type { JobRecord } from "./types";

/** 401 `{ error }`, para el caso "sin sesion" — distinto de 404 (ver §4 del plan). */
function unauthenticated(): NextResponse {
  return ok(
    { error: "No autenticado. Volvé a entrar." },
    { status: 401 },
  ) as NextResponse;
}

/**
 * El usuario logueado, o `null` si no hay sesion valida.
 *
 * Envuelve `currentUser(cookies())` para que las 21 rutas que usan este modulo no
 * tengan que importar `next/headers` cada una. Es el UNICO lugar de este archivo que
 * lee la cookie: las demas funciones reciben el resultado de esta, directa o
 * indirectamente.
 */
export function sessionUser(): string | null {
  return currentUser(cookies());
}

/**
 * El dueño de un proyecto.
 *
 * Devuelve `null` en DOS casos: el proyecto no existe, o existe pero no tiene dueño
 * asignado (proyecto viejo sin migrar). Los dos casos son `null` a proposito: NINGUNO
 * de los dos tiene que habilitar a nadie. Si `null` significara "de todos", cualquier
 * proyecto creado por un camino que se olvide de setear el dueño quedaria visible para
 * todos, que es exactamente el bug que este modulo existe para cerrar (D2 del plan).
 */
export function ownerOf(projectId: string): string | null {
  return projectsDb.get(projectId)?.owner ?? null;
}

/** Resultado de un chequeo de dueño de proyecto. */
export type OwnerCheck =
  | { ok: true; user: string; projectId: string }
  | { ok: false; response: NextResponse };

/** Resultado de un chequeo de dueño de job. Trae el job ya resuelto. */
export type JobOwnerCheck =
  | { ok: true; user: string; projectId: string; job: JobRecord }
  | { ok: false; response: NextResponse };

/**
 * Chequea que el usuario logueado sea el dueño del proyecto.
 *
 *  - sin sesion valida     -> 401 `{ error }` (status real 401, no un 404 con otro
 *    texto). Es un caso distinto de "ajeno" y no se colapsan: si una sesion vencida
 *    diera 404, el usuario veria "el proyecto no existe" en TODOS sus proyectos a la
 *    vez y pensaria que perdio el trabajo. En la practica el middleware ya devuelve
 *    401 en /api/* sin cookie, asi que este caso solo se alcanza con una cookie
 *    valida cuyo usuario se sacó del `.env` despues de firmada.
 *  - inexistente O de otro -> el MISMO 404 `{ error: "Proyecto no encontrado" }`.
 *
 * Los dos casos (inexistente / ajeno) dan la misma respuesta a proposito (D4 del
 * plan): con ids UUID, la existencia es la unica informacion que un atacante no puede
 * adivinar, asi que es lo unico que hay que no filtrar. Un 403 confirmaria que el
 * proyecto existe.
 */
export function requireProjectOwner(projectId: string): OwnerCheck {
  const user = sessionUser();
  if (!user) {
    return { ok: false, response: unauthenticated() };
  }
  const owner = ownerOf(projectId);
  if (owner === null || owner !== user) {
    return { ok: false, response: notFound("Proyecto no encontrado") };
  }
  return { ok: true, user, projectId };
}

/**
 * Igual que `requireProjectOwner`, pero el id que llega es un jobId.
 *
 * El proyecto se resuelve con `jobsDb.get(jobId).projectId`, NUNCA parseando el
 * string del id. El formato es `<projectId>:img:<imageId>` /
 * `<projectId>:vid:<clipId>` (jobs/pipeline.ts:43-48), y `imageId`/`clipId` salen del
 * PlanJSON, que lo escribe el usuario: pueden contener `:`. Un `split(":")[0]` parece
 * andar con los datos de hoy y se rompe con un plan raro. La DB es la fuente de
 * verdad y ya trae el `projectId` resuelto.
 *
 * Job inexistente -> 404 `{ error: "Job no encontrado" }`, el MISMO mensaje que ya
 * devuelven hoy las 6 rutas de /api/jobs/[id]/*, asi que el diff observable para el
 * caso legitimo es cero.
 */
export function requireJobOwner(jobId: string): JobOwnerCheck {
  const user = sessionUser();
  if (!user) {
    return { ok: false, response: unauthenticated() };
  }
  const job = jobsDb.get(jobId);
  if (!job) {
    return { ok: false, response: notFound("Job no encontrado") };
  }
  const owner = ownerOf(job.projectId);
  if (owner === null || owner !== user) {
    return { ok: false, response: notFound("Job no encontrado") };
  }
  return { ok: true, user, projectId: job.projectId, job };
}

/**
 * Parte una lista de ids de proyecto en los que son del usuario logueado y los que
 * no. Un solo `sessionUser()` para toda la lista, no uno por id.
 *
 * `rejected` mezcla ajenos e inexistentes A PROPOSITO (D6 del plan): separarlos
 * permitiria distinguir "no existe" de "no es tuyo", que es lo que D4 no permite.
 * Sin sesion, TODO cae en `rejected` (no hay forma de saber que es "tuyo" sin
 * usuario) — en la practica no se alcanza este caso porque el middleware ya devuelve
 * 401 en /api/* antes de llegar aca.
 */
export function filterOwnedIds(
  ids: string[],
): { owned: string[]; rejected: string[] } {
  const user = sessionUser();
  if (!user) {
    return { owned: [], rejected: [...ids] };
  }
  const owned: string[] = [];
  const rejected: string[] = [];
  for (const id of ids) {
    if (ownerOf(id) === user) owned.push(id);
    else rejected.push(id);
  }
  return { owned, rejected };
}
