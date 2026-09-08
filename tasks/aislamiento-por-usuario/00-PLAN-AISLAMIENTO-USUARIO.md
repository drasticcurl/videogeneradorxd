# AISLAMIENTO POR USUARIO — cada uno ve solo sus proyectos

**Documento maestro del módulo. Todo agente lee este archivo completo antes de abrir su task.**

Hoy la app tiene varios usuarios (`PASSWORD_IVAN`, `PASSWORD_LUCHO`) y **todos ven los proyectos de
todos**. El login ya funciona: `currentUser(cookies())` sabe si sos `lucho` o `ivan`
(`src/app/layout.tsx:32`). Lo que falta no es autenticación, es **autorización**: `ProjectRecord`
(`src/lib/types.ts`) no tiene campo de dueño, y de las 25 route handlers **ninguna lee la sesión**
salvo `/api/login`. Todas confían en que el middleware ya dejó pasar a *alguien* válido.

Este módulo agrega un campo `owner` al proyecto y un chequeo de dueño en las 21 rutas que reciben,
directa o indirectamente, un id de proyecto. No agrega tablas, no agrega dependencias, no toca el
mecanismo de login.

**Este módulo cambia quién puede leer y borrar trabajo ya pagado, y se aplica sobre una app en
producción con ~12 proyectos reales adentro.** Todo lo que sigue está diseñado alrededor de esa
frase: la migración es aditiva, hace backup, es idempotente, y aborta antes de escribir si algo no
cuadra.

---

## 0. Qué se construye y qué no

**Se construye:**

1. Campo `owner?: string` en `ProjectRecord`.
2. `src/lib/ownership.ts` — el helper de autorización, con 5 exports (§4). Archivo nuevo.
3. Chequeo de dueño en **21 route handlers**, en cuatro grupos con helper distinto (§5).
4. `scripts/migrar-owner.mjs` — asigna dueño a los ~12 proyectos que ya existen.
5. Tres ajustes de UI: el cartel del lote deja de mentir, y abrir un proyecto ajeno por URL muestra
   un mensaje en vez de una pantalla rota (§5.4).

**No se construye**, y ningún agente lo agrega por su cuenta:

- **Usuario administrador que vea todo.** El usuario lo descartó explícitamente.
- **`db.json` u `output/` partidos por usuario.** Ver D1: mismo resultado, blast radius enorme.
- **Cuota o cola por usuario.** La cola sigue compartida (D9). Es una limitación conocida.
- **Compartir un proyecto entre dos usuarios.** No hay lista de invitados ni permisos parciales. Un
  proyecto tiene un dueño y nada más.
- **Historial de quién tocó qué.** No hay auditoría.
- **Cambiar el mecanismo de login.** `src/lib/auth.ts` y `src/middleware.ts` no se tocan (D5).
- **Tests automatizados nuevos.** El proyecto no tiene framework de tests y este módulo no lo
  agrega: sería una decisión de otro dominio. La verificación son los dos scripts de esta carpeta.

---

## 1. Decisiones cerradas

No hay nada que decidir. Si aparece algo que este documento no resuelve, se anota en §10 y **no se
decide en el código**.

**D1 — El dueño es un campo en `ProjectRecord`, no un `db.json` por usuario.** La alternativa era
`data/<usuario>/db.json` y `output/<usuario>/<projectId>/`, que da aislamiento por construcción. Se
descartó: `config.storage.dataDir` es constante de módulo, el path absoluto de salida está **grabado
en el campo `outputDir` de cada `ProjectRecord`** y además dentro de cada `manifest.json`. Partir los
directorios obliga a mover archivos en producción y reescribir esos dos campos en los 12 proyectos;
si uno queda mal, el proyecto pierde de vista imágenes y videos ya pagados, y el error no aparece
hasta que alguien abre esa pantalla. Mismo resultado, riesgo incomparable.

**D2 — `owner` es OPCIONAL en el tipo (`owner?: string`), y el filtro es `p.owner === usuario`.**
Si fuera obligatorio, `tsc` rompería en todos los lugares que construyen un `ProjectRecord` y habría
que arreglarlos en la misma task, que es exactamente la colisión que este plan evita. Siendo
opcional, el cambio es **aditivo**: el código viejo ignora el campo y el nuevo lo exige.
**Corolario deliberado: `undefined` no matchea con nadie.** Un `undefined` que significara "de
todos" dejaría el agujero abierto para cualquier proyecto creado por un camino que se olvide de
setear el dueño — que es justo el bug que este módulo existe para cerrar.

**D3 — El dueño sale SOLO de la cookie firmada. Nunca del body, nunca de la query.** El body es
texto que escribe el cliente: si `POST /api/projects` leyera `owner` de ahí, Ivan crearía proyectos a
nombre de Lucho, y un `PUT` le permitiría reasignarse uno ajeno. La cookie `gen_session` está firmada
con HMAC-SHA256 y `verifySessionToken` ya valida que el usuario siga existiendo en el `.env`.

**D4 — Lo ajeno devuelve 404, con el mismo cuerpo exacto que un id inexistente.** Un 403 confirma
que el proyecto existe. Los ids son UUID: la existencia es la única información que un atacante no
puede adivinar, así que es lo único que hay que no filtrar. Se usa `notFound()` de `@/lib/http`, que
ya devuelve `{ error }` con status 404 — el mismo cuerpo que devuelven hoy esas rutas cuando el id no
existe, así que **el diff de comportamiento observable es cero** para el caso legítimo.

**D5 — El helper va en `src/lib/ownership.ts`, archivo NUEVO, y no dentro de `src/lib/auth.ts`.**
Dos razones. Una: `auth.ts` está en la lista de intocables de `tasks/_verificacion-endpoints.sh:88`,
y agrandarlo obligaría a tocar esa línea base. Dos, la que importa: `auth.ts` es **autenticación**
(quién sos) y esto es **autorización** (de qué sos dueño). Mezclarlas hace que un bug en el filtro de
proyectos pueda dejar la app entera abierta. Archivo nuevo además significa cero colisión: T01 es el
único que lo escribe.

**D6 — `/api/batch` FILTRA los ids ajenos en vez de rechazar el request.** Los ids del lote viajan
en la URL (`/batch?ids=a,b,c`) y un tablero son varios proyectos a la vez. Si un solo id ajeno tirara
404 en todo el request, pegar una URL vieja con un id de más rompería el tablero completo en vez de
mostrar los 5 proyectos que sí son tuyos. Los ids rechazados se suman a **`missingIds`**, que ya
existe en `BatchSnapshot` (`src/lib/batch.ts`) y que `BatchBoard.tsx:596` ya renderiza. Ajenos e
inexistentes se mezclan en la misma lista **a propósito**: separarlos rompería D4.

**D7 — El cartel de `missingIds` pasa a ser neutro.** Hoy dice literalmente *"Estos proyectos ya no
existen (los borraste)"* (`BatchBoard.tsx:598`). Con ids ajenos adentro, eso es falso — y si dijera
"no son tuyos" filtraría la existencia y rompería D4. El texto nuevo no puede distinguir los dos
casos.

**D8 — Los jobs NO llevan `owner`.** El dueño de un job se resuelve por su proyecto. Duplicar el
dato abre la puerta a que las dos copias discrepen y a que un job quede accesible por una y no por la
otra. Además no hace falta: los ids de job son derivados
(`imageJobId = \`${projectId}:img:${imageId}\``, `src/lib/jobs/pipeline.ts:43-48`), y el job en la DB
ya trae `projectId`.

**D9 — La cola de jobs sigue compartida.** Decidido por el usuario. Consecuencia conocida y
aceptada: los 3 slots de `PIPELINE_CONCURRENCY` son para toda la app, así que si uno larga 95 clips
el otro espera. No se construye cuota por usuario.

**D10 — Sin usuario administrador.** Decidido por el usuario. Nadie ve todo, ni siquiera quien
administra la caja.

**D11 — La migración se corre ANTES de deployar el código nuevo, no después.** El campo es aditivo:
el código que está corriendo hoy **ignora** `owner`, así que migrar primero no cambia nada para nadie.
Si se deployara primero, habría una ventana en la que los 12 proyectos existentes quedan invisibles
para todos (por D2, `undefined` no matchea con nadie). Migrando primero, la ventana es cero.

**D12 — El script de migración ABORTA sin escribir si no encuentra los 4 proyectos de Ivan.** Los
nombres se transcribieron a mano de un mensaje. Un carácter distinto (un `0` por una `O`, un `_` de
más) hace que el match falle en silencio, ese proyecto de Ivan quede asignado a Lucho, y el script
imprima "12 migrados, OK". El error recién se descubriría cuando Ivan entra y no ve su trabajo.
Verificado: afirmación 6 de `_verificacion-migracion.mjs`.

---

## 2. Arquitectura

```
                    cookie gen_session (firmada, HMAC-SHA256)
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
     src/middleware.ts                        src/lib/auth.ts
     AUTENTICACION (Edge)                     AUTENTICACION (Node)
     "¿sos alguien válido?"                   currentUser(cookies())
     401 en /api/*, redirect en páginas       verifySessionToken()
              │                                       │
              │  ── NO SE TOCAN EN ESTE MODULO ──     │
              └───────────────────┬───────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │   src/lib/ownership.ts      │  ← ARCHIVO NUEVO (T01)
                    │   AUTORIZACION              │
                    │                             │
                    │   sessionUser()             │
                    │   ownerOf(projectId)        │
                    │   requireProjectOwner(id)   │
                    │   requireJobOwner(jobId)    │
                    │   filterOwnedIds(ids)       │
                    └──────────────┬──────────────┘
                                   │ lee (no escribe)
                                   ▼
                            src/lib/db.ts
                            projectsDb.get() / .list()
                            jobsDb.get()
                                   │
    ┌──────────────┬───────────────┼───────────────┬──────────────┐
    ▼              ▼               ▼               ▼              ▼
 11 rutas       6 rutas        projects/       files/         batch/
 projects/[id]  jobs/[id]      route.ts        [...path]      route.ts
                               imagenes/
 requireProject requireJob     sessionUser     requireProject filterOwnedIds
 Owner          Owner          (filtra+setea)  Owner          (filtra)
   T02 · T03      T04            T05             T06            T06
```

La decisión estructural: **el helper resuelve la sesión por su cuenta**, leyendo `cookies()` de
`next/headers` adentro. La alternativa era que cada ruta le pasara el usuario como argumento, y se
descartó porque 21 call sites pueden olvidarse de hacerlo y el helper no tendría forma de notarlo —
un `requireProjectOwner(id, undefined)` que "pasa" es un agujero silencioso. Con el helper leyendo la
cookie, el call site es de dos líneas y no hay nada que olvidarse.

Verificado que `cookies()` funciona dentro de un route handler: `src/app/api/login/route.ts:11,88`
ya lo usa para setear la sesión.

---

## 3. El dato: `owner` y la migración

### El campo

Una sola línea en `src/lib/types.ts`, dentro de `ProjectRecord`:

```ts
/**
 * Usuario dueño del proyecto (el nombre de `PASSWORD_<NOMBRE>`, en minúsculas).
 *
 * OPCIONAL a proposito: hace que el cambio sea aditivo y que los proyectos que ya
 * existian no rompan el tipo. `undefined` NO significa "de todos": el filtro es
 * `p.owner === usuario`, asi que un proyecto sin dueño queda invisible para todos
 * hasta que corra `scripts/migrar-owner.mjs`. Ver D2 del plan.
 */
owner?: string;
```

### La migración

El script canónico **ya está escrito y ya se ejecutó** contra una base scratch:
`tasks/aislamiento-por-usuario/_migracion-owner.mjs`. T01 lo copia tal cual a
`scripts/migrar-owner.mjs`. **No lo tipees de nuevo ni lo "mejores".**

El mapeo lo dio el usuario: todos a `lucho`, menos estos cuatro que son de `ivan`, por nombre exacto:

```
AA_rendicion_meresigne_duena52_v02
AA_rendicion_meresigne_duena52_v01
AA_alquiler_marcodepuerta_duena31_v01
AA_manerastontas_multivoz_v01
```

Lo que el script garantiza, todo verificado (`_verificacion-migracion.mjs`, 7/7 en verde):

| # | Garantía | Por qué importa |
|---|---|---|
| 1 | `--dry-run` no escribe ni hace backup | ver el mapeo antes de tocar producción |
| 2 | los 4 a `ivan` por nombre exacto, el resto a `lucho` | es el mapeo del usuario |
| 3 | no cambia la cantidad de proyectos, jobs ni logs | el usuario dijo "no los quiero perder" |
| 4 | conserva `stage`, `imageSize`, `autoApprove`, `imageAspectRatio` | una migración que reconstruye el objeto campo por campo los pierde, y el proyecto cambia de calidad o vuelve a correr videos sin que nadie lo pida |
| 5 | idempotente: la 2ª corrida dice "0 cambios" | si un deploy falla a mitad, el operador la corre de nuevo sin saber si terminó |
| 6 | si falta un nombre de Ivan: **aborta, exit 1, no escribe** | D12 |
| 7 | si hay nombres duplicados: **aborta, exit 1, no escribe** | con dos proyectos del mismo nombre no se puede saber cuál es el de Ivan |

Además: backup a `db.json.bak-<timestamp>` antes de escribir, y escritura atómica (tmp + rename),
igual que `src/lib/db.ts`.

**Lo que NO se pudo verificar, y es el riesgo real del módulo:** los 12 proyectos y los 4 nombres
**no existen en este checkout**. No hay `./data` ni `./output` en local, y no se toca producción para
leerlos. O sea que **nadie comprobó todavía que esos 4 nombres coincidan carácter por carácter con
los de `db.json`**. Por eso existe la garantía 6: el script aborta y muestra los nombres reales de la
DB al lado para comparar a ojo. Ver P-01 en §10.

---

## 4. CONTRATO CONGELADO — `src/lib/ownership.ts`

**Lo declara T01, completo. Nadie más lo modifica.** Seis tasks se escriben contra estas firmas al
mismo tiempo; cambiar una rompe las otras cinco.

```ts
import type { NextResponse } from "next/server";
import type { JobRecord } from "./types";

/**
 * El usuario logueado, o `null` si no hay sesión válida.
 * Envuelve `currentUser(cookies())` para que las rutas no importen `next/headers`.
 */
export function sessionUser(): string | null;

/**
 * El dueño de un proyecto: `null` si el proyecto no existe O si no tiene dueño
 * asignado (proyecto viejo sin migrar). Los dos casos son `null` a propósito:
 * ninguno de los dos habilita a nadie (D2).
 */
export function ownerOf(projectId: string): string | null;

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
 *  - sin sesión válida        -> 401 `{ error }`
 *  - inexistente O de otro    -> 404 `{ error: "Proyecto no encontrado" }`  (D4)
 */
export function requireProjectOwner(projectId: string): OwnerCheck;

/**
 * Igual, pero el id que llega es un jobId. El proyecto se resuelve por
 * `jobsDb.get(jobId).projectId`, NO parseando el string (ver regla 4 abajo).
 *  - job inexistente -> 404 `{ error: "Job no encontrado" }`, el MISMO mensaje
 *    que devuelven hoy esas rutas, así el diff observable es cero.
 */
export function requireJobOwner(jobId: string): JobOwnerCheck;

/**
 * Parte una lista de ids en los que son del usuario y los que no.
 * `rejected` mezcla ajenos e inexistentes a propósito: distinguirlos rompe D4.
 */
export function filterOwnedIds(ids: string[]): { owned: string[]; rejected: string[] };
```

### Reglas de implementación — no son negociables

1. **El helper lee la sesión por su cuenta**, con `cookies()` de `next/headers`. No recibe el usuario
   como parámetro. *El bug que evita:* un call site que se olvida de pasarlo produce un chequeo que
   pasa siempre, y no hay forma de detectarlo desde adentro del helper.

2. **El 404 se arma con `notFound()` de `@/lib/http`.** *El bug que evita:* las pantallas muestran
   `data.error` (`ReviewDeck.tsx:186`, `BatchBoard.tsx:170`, `page.tsx:234`, y ocho más). Un body con
   otra forma deja el cartel de error vacío y el usuario ve "algo falló" sin texto.

3. **El 401 y el 404 son casos distintos y no se colapsan.** Sin sesión es 401 (la sesión venció,
   hay que volver a entrar); ajeno es 404. *El bug que evita:* si una sesión vencida diera 404, el
   usuario vería "el proyecto no existe" en TODOS sus proyectos a la vez y pensaría que perdió el
   trabajo. El middleware ya devuelve 401 en `/api/*` sin cookie, así que este caso es raro — pero
   pasa si la cookie es válida y el usuario se sacó del `.env`.

4. **`requireJobOwner` resuelve el proyecto con `jobsDb.get(jobId).projectId`, NUNCA cortando el
   string.** *El bug que evita:* el formato es `<projectId>:img:<imageId>`, y `imageId` sale del plan,
   que lo escribe el usuario — puede contener `:`. Un split ingenuo por `:` o un `split(":")[0]`
   parecen andar con los datos de hoy y se rompen con un plan raro. La DB es la fuente de verdad y
   además ya trae el `projectId`. Las 6 rutas de job **ya hacen ese `jobsDb.get()` hoy** (verificado
   en `approve/route.ts:19` y `preview/route.ts:37`), así que el helper reemplaza esa línea, no la
   duplica.

5. **`ownerOf` compara en minúsculas.** El nombre del usuario viene del token, que ya lo normaliza
   (`signSessionToken` hace `user.toLowerCase()`), y la migración escribe en minúsculas. Comparar sin
   normalizar funcionaría hoy y se rompería el día que alguien escriba `owner: "Lucho"` a mano.

6. **`ownership.ts` LEE de `db.ts`, no escribe.** No hace `upsert` ni `update` de nada. *El bug que
   evita:* un helper de autorización que escribe puede persistir estado en un camino de solo lectura
   y disparar un `save()` de `db.json` en cada `GET /api/files/...`, que son cientos por pantalla.

---

## 5. CONTRATO CONGELADO — el patrón de call site, por grupo

Son cuatro patrones y **ninguno se improvisa**. El objetivo es que el diff de cada ruta sean 2 o 3
líneas y que `_verificacion-aislamiento.sh` los pueda contar.

### 5.1 Las 11 rutas de `/api/projects/[id]/**` → T02 y T03

El id del proyecto es `params.id`. El guard va **como primera línea del `try`**, antes de leer el
body y antes de cualquier `projectsDb.get()`.

```ts
const guard = requireProjectOwner(params.id);
if (!guard.ok) return guard.response;
```

Después, el código que ya estaba. Si la ruta hacía `const project = projectsDb.get(params.id); if
(!project) return notFound(...)`, **ese bloque se conserva**: el guard ya garantiza que existe, pero
borrarlo cambia el tipo de `project` a `ProjectRecord | undefined` en el resto de la función y
obliga a tocar más líneas de las necesarias.

**Va antes de leer el body a propósito.** Si fuera después, un `POST` ajeno con un body inválido
devolvería 400 en vez de 404, y ese 400 confirma que el proyecto existe (rompe D4).

### 5.2 Las 6 rutas de `/api/jobs/[id]/**` → T04

Acá el guard **reemplaza** el lookup que ya existe:

```ts
// antes:
const job = jobsDb.get(params.id);
if (!job) return notFound("Job no encontrado");

// después:
const guard = requireJobOwner(params.id);
if (!guard.ok) return guard.response;
const job = guard.job;
```

`guard.job` es el mismo `JobRecord` que devolvía `jobsDb.get()`. No hay segunda consulta.

### 5.3 Creación y listado → T05

Dos rutas, dos cosas distintas:

- **`GET /api/projects`**: filtra. `projectsDb.list()` sigue devolviendo todo (es `db.ts`, intocable);
  el filtro va en la ruta, antes del `.map()` que arma el resumen. Sin sesión → 401.
- **`POST /api/projects` y `POST /api/imagenes`**: setean `owner: <usuario de la sesión>` en el
  `ProjectRecord` que construyen. Sin sesión → 401, **sin crear nada**. Y **nunca** leen `owner` del
  body (D3): si el body lo trae, se ignora en silencio.

### 5.4 Los dos caminos donde el id viene de afuera → T06

- **`GET /api/files/<projectId>/<path>`**: el projectId es `segments[0]`. El guard va **después** de
  la validación de largo (`segments.length < 2` → 400) y **antes** de `safeResolve()`. Hoy esta ruta
  **ni consulta la DB**: es el agujero por el que se ven todas las imágenes y videos ajenos sabiendo
  solo un projectId. Devuelve `404` texto plano igual que hoy (esta ruta no usa los helpers de
  `@/lib/http` porque sirve bytes, no JSON) — **no** cambies eso a JSON: los `<img>` y `<video>` de
  la UI esperan bytes o un status, no un body parseable.
- **`/api/batch` (GET y POST)**: filtra con `filterOwnedIds` y los rechazados van a `missingIds`:

```ts
const { owned, rejected } = filterOwnedIds(ids);
const snap = buildBatchSnapshot(owned);
return ok({ ...snap, missingIds: [...snap.missingIds, ...rejected] });
```

`src/lib/batch.ts` **no se toca**: `buildBatchSnapshot` recibe la lista ya filtrada y no necesita
saber de usuarios. En el `POST`, además, el loop de acciones itera sobre `owned`, no sobre los ids del
body.

### 5.5 UI → T07

Tres archivos, tres cambios chicos:

| Archivo | Qué |
|---|---|
| `src/app/batch/BatchBoard.tsx:596-604` | el texto de `missingIds` se vuelve neutro (D7). No puede decir "los borraste" ni "no son tuyos" |
| `src/app/project/[id]/pipeline/page.tsx` | abrir un proyecto ajeno por URL tiene que mostrar el mensaje del 404, no una pantalla a medio cargar |
| `src/app/project/[id]/result/page.tsx` | idem |

**No se tocan** `src/app/page.tsx` ni `src/app/imagenes/ImagenesBoard.tsx`: los dos ya filtran del
lado del cliente y **los dos ya tienen `EmptyState`** (`page.tsx:1046`, `ImagenesBoard.tsx:880`), así
que un usuario con cero proyectos ya ve un estado vacío decente. Verificado.

---

## 6. Dependencias y olas de paralelismo

```
  OLA 1                    OLA 2  (6 agentes en paralelo)              OLA 3
 ┌──────┐          ┌──────┬──────┬──────┬──────┬──────┬──────┐       ┌──────┐
 │ T01  │ ───────► │ T02  │ T03  │ T04  │ T05  │ T06  │ T07  │ ────► │ T08  │
 │ sola │          │ 6 ar │ 5 ar │ 6 ar │ 2 ar │ 2 ar │ 3 ar │       │ prod │
 └──────┘          └──────┴──────┴──────┴──────┴──────┴──────┘       └──────┘
 contrato +         las 21 rutas + la UI                              migración
 tipo + script                                                        deploy + QA
```

| Task | Depende de | Se puede correr junto con |
|---|---|---|
| T01 | — | **nada, va sola** |
| T02 | T01 | T03, T04, T05, T06, T07 |
| T03 | T01 | T02, T04, T05, T06, T07 |
| T04 | T01 | T02, T03, T05, T06, T07 |
| T05 | T01 | T02, T03, T04, T06, T07 |
| T06 | T01 | T02, T03, T04, T05, T07 |
| T07 | T01 | T02, T03, T04, T05, T06 |
| T08 | T02, T03, T04, T05, T06, T07 | **nada, va sola y última** |

**T01 va sola y primero** porque declara `ownership.ts`, que las seis tasks de la ola 2 importan. No
es una preferencia: sin ese archivo, las seis fallan el `tsc` en la primera línea.

**Las seis de la ola 2 pueden correr juntas porque tocan conjuntos de archivos disjuntos** (§7) y
porque las seis consumen el **contrato** de §4, no la implementación de la otra. T07 (UI) no importa
`ownership.ts` en absoluto: es código de cliente y solo cambia textos y estados de error.

**T07 puede correr en la ola 2 aunque su efecto solo se vea con el backend listo.** Su verificación
está acotada a lo que sí puede comprobar sola: que el texto cambió, que no filtra existencia, y que
la línea base de endpoints sigue verde. La prueba de punta a punta es de T08.

**T08 va sola y última** porque corre la migración sobre datos reales y el deploy. Necesita las seis
anteriores en verde: migrar con el filtro a medio implementar deja proyectos con dueño que igual se
ven de más, y no hay forma de saber cuáles faltaban.

**El límite son las dependencias, no la cantidad de agentes.** Acá dio 6 en paralelo porque las 21
rutas no se conocen entre sí. No hay lugar para un séptimo: los archivos que quedan son los de la
lista de intocables.

**Si preferís ir de a uno:** T01 → T05 → T02 → T03 → T04 → T06 → T07 → T08. Ese orden deja las rutas
de creación (T05) temprano, así los proyectos nuevos nacen con dueño desde el principio, y **T08
siempre al final** porque es la única que escribe en producción.

### Compuerta entre olas

**Una task que bloquea a otras no está terminada hasta que su verificación pasa.** La ola 2 no
arranca hasta que T01 corre su §Verificación completa y da lo que dice. La ola 3 no arranca hasta que
`_verificacion-aislamiento.sh` dice **AISLAMIENTO COMPLETO**.

**Si T01 falla, se para el proyecto.** Las seis tasks siguientes importan de ahí; un contrato distinto
al de §4 obliga a rehacer las seis.

---

## 7. Ownership de archivos — regla anti-colisión

**Cada task solo escribe los archivos de su fila.** Si necesita algo de un archivo ajeno, lo lee pero
no lo escribe. Si cree que necesita escribirlo, va a §10.

| Task | Archivos que puede crear o modificar |
|---|---|
| **T01** | `src/lib/types.ts`, `src/lib/ownership.ts` (nuevo), `scripts/migrar-owner.mjs` (nuevo) |
| **T02** | `src/app/api/projects/[id]/route.ts`, `.../[id]/jobs/route.ts`, `.../[id]/control/route.ts`, `.../[id]/stage/route.ts`, `.../[id]/approve-batch/route.ts`, `.../[id]/regenerate-batch/route.ts` |
| **T03** | `src/app/api/projects/[id]/generate/route.ts`, `.../[id]/upload/route.ts`, `.../[id]/references/route.ts`, `.../[id]/stitch/route.ts`, `.../[id]/download/route.ts` |
| **T04** | `src/app/api/jobs/[id]/approve/route.ts`, `.../unapprove/route.ts`, `.../retry/route.ts`, `.../prompt/route.ts`, `.../extend/route.ts`, `.../preview/route.ts` |
| **T05** | `src/app/api/projects/route.ts`, `src/app/api/imagenes/route.ts` |
| **T06** | `src/app/api/files/[...path]/route.ts`, `src/app/api/batch/route.ts` |
| **T07** | `src/app/batch/BatchBoard.tsx`, `src/app/project/[id]/pipeline/page.tsx`, `src/app/project/[id]/result/page.tsx` |
| **T08** | `CHANGELOG.md`, y §10 de este plan. **Ningún archivo de `src/`.** |

**No hay excepciones ni stubs.** Ninguna task necesita un archivo que otra de su misma ola vaya a
escribir: las seis de la ola 2 importan `ownership.ts`, que ya existe cuando arrancan porque lo
escribió T01.

El caso que **parece** colisión y no lo es: T02 y T03 escriben archivos distintos dentro de
`src/app/api/projects/[id]/`. Son 6 y 5 archivos disjuntos, ninguno compartido. Fijate en la fila
antes de abrir un archivo de ese directorio.

**Archivos que NADIE toca**, y romper esto rompe producción:

```
src/lib/auth.ts                      autenticacion. Este modulo es autorizacion (D5)
src/middleware.ts                    idem, y corre en Edge
src/lib/db.ts                        el filtro va en las rutas, no en la capa de datos
src/lib/batch.ts                     buildBatchSnapshot recibe la lista ya filtrada (§5.4)
src/lib/jobs/queue.ts                la cola sigue compartida (D9)
src/lib/jobs/pipeline.ts             los ids de job no cambian de formato (D8)
src/lib/config.ts                    authUsers() ya hace lo que hace falta
src/lib/schema.ts                    el PlanJSON no cambia
src/lib/storage.ts                   los paths en disco no cambian (D1)
src/lib/http.ts                      notFound() ya existe y ya sirve
src/app/page.tsx                     ya filtra client-side y ya tiene EmptyState
src/app/imagenes/ImagenesBoard.tsx   idem
src/app/batch/review/ReviewDeck.tsx  no necesita cambios: el server ya filtra
src/app/batch/videos/VideoDeck.tsx   idem
src/app/api/login/route.ts           publica a proposito
src/app/api/config/route.ts          no recibe projectId
src/app/api/parse/route.ts           no recibe projectId
src/app/api/prompt-template/route.ts no recibe projectId
tasks/_verificacion-endpoints.sh     es la LINEA BASE. Nunca se toca "para que pase"
```

**Los archivos de estado no son archivos del repo y no tienen dueño en esta tabla.** `db.json`,
`data/db.json`, `manifest.json` y todo lo de `output/` se crean en runtime y están en `.gitignore`
(por eso no existen en este checkout). Cuando una task los menciona, es para leerlos o para explicar
qué pasa con ellos, **no** para editarlos desde el repo. El único que los modifica es T08, y lo hace
en producción, con `scripts/migrar-owner.mjs` y su backup.

**Sobre los 6 agentes de la ola 2:** la recomendación habitual es 3 o 4, porque más agentes a la vez
es más difícil de revisar. Acá van 6 **porque el usuario pidió el máximo paralelismo posible** y porque
las seis cumplen las dos condiciones que lo hacen seguro: conjuntos de archivos **disjuntos** (§7) y
**una verificación propia por task** que no depende de las otras cinco. Si preferís revisar de a poco,
el orden serial está en §6 y no cambia nada del diseño.

---

## 8. Criterios de aceptación globales

1. `npx tsc --noEmit` pasa sin salida y `npm run build` compila.
2. `bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh` dice **AISLAMIENTO COMPLETO**
   (verde 31, pendiente 0, fallo 0). Antes de empezar da **verde 7, pendiente 24, fallo 0**.
3. `node tasks/aislamiento-por-usuario/_verificacion-migracion.mjs` sigue en **TODO EN VERDE (7/7)**.
4. `bash tasks/_verificacion-endpoints.sh` sigue en **SIN REGRESIONES**. Este módulo no mueve ningún
   `fetch`: si esa línea base se rompe, alguien tocó una pantalla más de lo necesario.
5. **Nada de lo que ya funcionaba cambió**, con los números concretos a comparar antes y después de
   la migración en producción:
   - cantidad de proyectos en `db.json`: **igual** (el usuario dijo ~12; el número exacto lo imprime
     el script antes de escribir).
   - cantidad de jobs y de logs: **igual**.
   - cantidad de subdirectorios en `OUTPUT_DIR`: **igual**. La migración no toca el disco.
6. Con las dos cuentas, en producción: cada uno ve **solo** sus proyectos en `/` y en `/imagenes`; un
   `projectId` ajeno pegado en `/batch?ids=` aparece en el cartel de no disponibles y **no** muestra
   miniaturas; `/api/files/<projectId ajeno>/manifest.json` devuelve 404; y un `jobId` ajeno en
   `/api/jobs/<id>/approve` devuelve 404.
7. Los proyectos de Ivan son exactamente los 4 de §3 y los ve **solo** Ivan.

---

## 9. Runbook de producción (lo ejecuta T08)

El deploy corre **en el server**, no desde una máquina de desarrollo:
`deploy.sh` hace `git fetch origin main` + `git reset --hard origin/main`, así que **el código tiene
que estar pusheado a `main` antes**. Ver P-02 en §10.

```bash
# 0. El código ya está en main y las 7 tasks anteriores en verde.

# 1. BACKUP a mano, además del que hace el script. Cuesta un segundo.
sudo -u deploy cp /srv/generador/storage/data/db.json \
                  /srv/generador/storage/data/db.json.manual-$(date +%Y%m%d%H%M%S)

# 2. Ver el mapeo SIN escribir nada. Leé la tabla completa antes de seguir:
#    que los 4 de Ivan aparezcan, y que el resto sea lo que esperás.
sudo -u deploy node /srv/generador/repo/scripts/migrar-owner.mjs \
     --db /srv/generador/storage/data/db.json --dry-run

# 3. Migrar. Si aborta por un nombre que no encontró, NO uses --permitir-faltantes
#    sin antes comparar el nombre real que imprime contra la lista.
sudo -u deploy node /srv/generador/repo/scripts/migrar-owner.mjs \
     --db /srv/generador/storage/data/db.json

# 4. Deployar. La migración va ANTES a propósito (D11): el código viejo ignora
#    `owner`, así que entre el paso 3 y el 5 nadie ve nada raro.
sudo -u deploy bash /srv/generador/repo/deploy/deploy.sh

# 5. QA con las dos cuentas (criterio 6 de §8).
```

**Para revertir:** `cp` del backup encima de `db.json` y `pm2 reload generador-3006`. El campo
`owner` de más no molesta al código viejo: lo ignora.

**No deployar con una generación corriendo.** El reload reinicia el proceso y los jobs en vuelo se
pierden (los archivos ya escritos quedan; el progreso no).

---

## 10. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el
código**. Si bloquea, la task se detiene y no sigue con suposiciones.

### P-01 — Los 4 nombres de Ivan no se pudieron verificar contra la DB real
- **Task:** T08
- **Sección del plan:** §3
- **Archivo:** `scripts/migrar-owner.mjs`
- **Qué falta:** confirmar que los cuatro nombres coinciden **carácter por carácter** con los de
  `db.json` en producción. En este checkout no existe `./data` ni `./output`, y no se lee producción.
- **Bloquea:** no, pero **puede detener el paso 3 del runbook**.
- **Qué se implementa mientras tanto:** el script aborta sin escribir e imprime todos los nombres de
  la DB al lado, para comparar a ojo (garantía 6, verificada). El operador confirma en el `--dry-run`.

### P-02 — Quién ejecuta el deploy, y desde dónde
- **Task:** T08
- **Sección del plan:** §9
- **Qué falta:** el usuario pidió que el deploy lo corra el asistente al final. Pero `deploy.sh` corre
  **en el server** como usuario `deploy` y hace `git reset --hard origin/main`, así que hacen falta
  dos cosas que este plan no puede resolver solo: **(a)** que los cambios estén commiteados y
  pusheados a `main`, y **(b)** acceso al server (host de ssh) — que no está verificado desde esta
  máquina.
- **Bloquea:** sí, el paso 4 del runbook.
- **Qué se implementa mientras tanto:** T08 deja todo listo y **para** antes del paso 4, con los
  comandos escritos, para que el usuario confirme el push a `main` y cómo se llega al server.

### P-03 — Si alguno de los 4 proyectos de Ivan resulta ser de "solo imágenes"
- **Task:** T08
- **Sección del plan:** §3
- **Qué falta:** el usuario dijo dos cosas que pueden chocar: *"las imágenes, todas a lucho"* y
  *"esos 4 son de Ivan"*. Si alguno de los 4 tiene `plan.clips.length === 0`, las dos reglas se
  contradicen. Por los nombres (`rendicion`, `alquiler`, `multivoz`) parecen de video, pero no se
  verificó.
- **Bloquea:** no.
- **Qué se implementa mientras tanto:** **gana la lista explícita** (es más específica), y el script
  imprime un `AVISO:` fuerte con los nombres si detecta el caso. Está implementado y es visible en el
  `--dry-run`, así que el operador lo ve antes de escribir.

### P-04 — Un usuario borrado del `.env` deja proyectos inaccesibles
- **Task:** ninguna
- **Sección del plan:** D2
- **Qué falta:** nada por ahora. El usuario dijo que no va a pasar.
- **Bloquea:** no.
- **Qué se implementa mientras tanto:** los proyectos quedan **invisibles, no borrados**, y
  `scripts/migrar-owner.mjs --default-owner <otro>` sirve para reasignarlos. Ningún archivo se toca.

### P-05 — La cola compartida puede hacer esperar a uno por el otro
- **Task:** ninguna
- **Sección del plan:** D9
- **Qué falta:** decidido por el usuario: se deja compartida por ahora. Queda anotado como
  limitación conocida, no como bug.
- **Bloquea:** no.
