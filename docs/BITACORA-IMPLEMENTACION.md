# Bitácora de implementación

Registro por tarea de trabajo de implementación multi-paso: qué se hizo, qué se decidió sin
especificación explícita (y por qué), y qué falta verificar. Entradas en orden cronológico; no se
edita una entrada vieja, se agrega una nueva si hay que corregir algo.

---

## 2026-09-21 — Tablero `/batch`: arrancar proyectos de a UNO (no en paralelo)

**Pedido:** el usuario reportó que con 30 proyectos en un tablero, al apretar "seguir", todos
fallaron por 429 en cascada tras agotar los reintintos. Pidió que el tablero genere de a un
proyecto a la vez, igual que ya hace el generador masivo de imágenes.

**Estado:** hecha. Sin build/typecheck corridos (prohibido salvo pedido explícito). Verificada por
lectura completa del flujo (`queue.ts`, `masivo.ts`, `batch/route.ts`, `imagenes/masivo/route.ts`) y
`grep` de todos los usos de `enqueueProject` en `src/` para confirmar que no quedó otro punto con el
mismo bug.

### Causa raíz confirmada

`POST /api/batch` (`start-images`/`start-videos`) hacía `enqueueProject(project.id)` en un loop
sobre los N proyectos del tablero. La concurrencia de la cola (`PIPELINE_CONCURRENCY`, default 3) es
GLOBAL y no distingue de qué proyecto es cada job: con 30 proyectos, cada slot que se libera lo toma
el job pending de CUALQUIER proyecto, así que la cola sostiene 3 requests simultáneas contra el
mismo modelo sin pausa mientras haya trabajo pendiente en cualquiera de los 30. Eso agota el
presupuesto de 10 reintentos de rate limit (aparte de los intentos normales del job) y el job queda
`failed`. El comentario original del código decía "arrancar 5 proyectos juntos genera el mismo rate
de requests que arrancar uno" — es la asunción incorrecta que causó el bug: la concurrencia nominal
es la misma, pero la cantidad de trabajo disponible para llenarla escala con N proyectos, y eso es lo
que golpea la cuota real.

### Diseño elegido: reusar `startBatch`/`notifyProjectFinished` de `jobs/masivo.ts`

El generador masivo (`/imagenes`, pestaña "Generador masivo") ya resolvía exactamente este problema
con un mecanismo secuencial genérico (`startBatch(batchId, projectIds, enqueueProject)` encola solo
el primero; `notifyProjectFinished` engancha en `queue.ts`/`finalizeProjects` y encola el siguiente
cuando el anterior termina). Se decidió reusar ese mismo módulo en `/api/batch` en vez de escribir
una cola secuencial nueva, para no duplicar la lógica de cursor/estado por batch.

**Decisión no especificada explícitamente — por qué `finalizeProjects` necesitó un cambio propio:**
`notifyProjectFinished` originalmente solo se llamaba cuando un proyecto llegaba a un status
TERMINAL (`done`/`partial`/`failed`). Eso alcanza para el generador masivo porque fuerza
`autoApprove: true` en sus proyectos. Pero `/api/batch` (`start-images`/`start-videos`) deja
`autoApprove: false` por default (modo manual, a propósito, para que el usuario revise antes de
gastar en Veo) — en ese modo un proyecto NUNCA llega solo a un status terminal, se frena en
`review`/`awaiting_approval` esperando aprobación humana indefinidamente. Sin tocar nada más, el
proyecto 2..N del tablero jamás habría arrancado. Se agregó el mismo llamado a
`notifyProjectFinished` en la rama de `finalizeProjects` donde el proyecto se desactiva por no tener
más trabajo runnable y quedar todo en `awaiting_approval` (justo donde ya existía el guard de "no
desactivar si hay un reintento con backoff programado"). El criterio: "ya no le va a pedir más nada a
la cola por sí mismo" es la señal correcta para dejar pasar al siguiente proyecto de la tanda, sea
que terminó de verdad o esté esperando revisión (que el usuario puede hacer en paralelo mientras el
siguiente proyecto genera sus imágenes/videos).

El guard existente de `notifyProjectFinished` (`if (idx !== batch.cursor) return`) ya cubre, sin
tocarlo, el caso de que un mismo proyecto dispare el hook más de una vez (por ejemplo un proyecto de
video con `PIPELINE_APPROVAL_BATCH_VIDEOS=5` que cae en la rama `awaiting` varias veces a medida que
se aprueban lotes de 5 clips): solo la primera llamada avanza el cursor, las siguientes son no-op.

### Archivos modificados

- `src/app/api/batch/route.ts` — el loop de `start-images`/`start-videos` ya no llama
  `enqueueProject` por proyecto; acumula los ids en `toStart[]` (arma plan/jobs de todos primero,
  igual que antes) y llama `startBatch(randomUUID(), toStart, enqueueProject)` una sola vez al final.
  Import nuevo: `randomUUID` de `node:crypto`, `startBatch` de `@/lib/jobs/masivo`.
- `src/lib/jobs/queue.ts` — en `finalizeProjects()`, rama `awaiting_approval`: se agregó
  `notifyProjectFinished(projectId, enqueueProject)` dentro del `if (!conReintentoProgramado)` que ya
  desactivaba el proyecto. Import nuevo: ninguno (`notifyProjectFinished` ya estaba importado para la
  rama terminal).
- `src/app/batch/BatchBoard.tsx` — el `title` (tooltip) del botón "Comenzar imágenes" decía "Encola
  todos los proyectos en fase imágenes", desactualizado con el comportamiento nuevo. Cambiado a
  "Arranca los proyectos en fase imágenes de a uno, para no saturar la cuota".
- `CHANGELOG.md` — entrada agregada arriba, mismo formato que las entradas anteriores.

### Qué falta para verificación completa

- No se corrió `npm run typecheck` ni `npm run build` (prohibido por steering salvo pedido
  explícito). Los cambios son pequeños y localizados; recomendable correr `typecheck` antes de
  deployar a producción, dado que tocan la cola de jobs.
- No se probó en runtime (mock o vertex) un tablero real con N>1 proyectos en modo manual para
  confirmar que el segundo proyecto arranca solo tras que el primero queda en `awaiting_approval`.
  Sería la verificación más directa: crear 2-3 proyectos de imágenes, ponerlos en un tablero,
  apretar "Comenzar imágenes", y confirmar en los logs que el proyecto 2 no empieza a generar hasta
  que el 1 termina sus jobs (aunque queden sin aprobar).
- No se revisó el caso `start-videos` con `autoApproveVideos: true` en profundidad más allá de
  confirmar que cae en la rama terminal existente (ya cubierta por el mecanismo sin cambios).

---

## 2026-09-19 — `/imagenes`: imagen base subida (image2image) + chat iterativo con historial

**Pedido:** agregar a `/imagenes` la posibilidad de (1) subir una imagen propia como base para
generar (image2image en vez de text2image), y (2) un chat iterativo que encadene modificaciones
sucesivas sobre la última imagen aprobada, mostrando **todo** el historial (imagen 1 → prompt →
imagen 2 → prompt → imagen 3...), no solo la última.

**Estado:** hecha. Sin build/typecheck corridos (prohibido salvo pedido explícito). Verificada por
lectura completa de cada archivo tocado/creado más los scripts de verificación existentes del repo
(ver abajo).

### Diseño elegido

El plan (`ProjectPlan`, `src/lib/schema.ts`) ya soportaba el 90% de esto sin cambios: una `Image`
puede ser `image2image` con `ref_image_id` apuntando a otra `Image` del mismo proyecto (mecanismo
que ya usa el flujo VSL para encadenar planos con la misma identidad), o a una `reference` subida
por el usuario (mecanismo que ya usan los avatares). Se decidió **reusar ambos tal cual**, sin
tocar el schema ni el pipeline (`buildJobs`, `runImageGeneration`, `approveJob`), por dos motivos:
evitar duplicar las reglas de validación cruzada que ya vive en `validatePlan`, y porque el steering
del proyecto marca `pipeline.ts`, `queue.ts` y `schema.ts` como archivos con verificación de "no
tocar" en `tasks/_verificacion-inventario.sh`.


**Imagen base subida → se modela como `reference`, no como un concepto nuevo.** Mismo camino que
`POST /api/projects/:id/references` (VSL): se guarda el archivo en `references/<id>.<ext>`, se
agrega a `plan.references[]`, y la primera `Image` del asset queda `image2image` con
`ref_image_id` apuntando a esa reference. Decisión propia: el id de la reference es
`<assetId>_base` (no expuesto al usuario, sólo interno) — no hay especificación de nombre en el
pedido, y este evita colisión con el `imageId` real del proyecto.

**Cada turno del chat → una `Image` NUEVA, no un edit de la existente.** Se evaluó reusar
`changePrompt` + `regenerate` (ya existía), pero ESE camino reemplaza el job/archivo existente: es
lo opuesto a "ver el historial completo". Se optó por un endpoint nuevo,
`POST /api/projects/:id/images`, que agrega una `Image` con `ref_image_id = fromImageId` al mismo
asset. Decisión propia sobre el id: `<base>_v<n>`, donde `base` es `fromImageId` con el sufijo
`_v\d+` quitado (para no anidar `_v2_v3` si se sigue el chat varias veces) y `n` es el primer
entero ≥2 no usado en ese asset (v1 es la imagen original, sin sufijo, creada por
`imageIdPara` en `/api/imagenes`). No hay uuid: el nombre de archivo resultante
(`images/<slug>_v2.png`) queda legible, siguiendo la misma convención de nombres del resto del
proyecto.

**Historial en el cliente, no un GET nuevo.** El manifest (`buildManifest` en `storage.ts`) ya
expone `ref_image_id` por imagen (`ManifestImage`), así que `ImagenesBoard.tsx` arma el árbol de
cadenas (`hilos`, memoizado) enteramente del lado del cliente a partir de lo que ya trae
`GET /api/projects/:id/jobs`. Se agregó además `buildChatHistory` en `src/lib/imagenes.ts` (server)
como helper de respaldo: la usa el endpoint nuevo para devolver la cadena ya ordenada en la
respuesta de POST, útil como chequeo cruzado contra lo que el cliente calculó solo, y por si en el
futuro hace falta un GET de solo lectura del historial (no se creó ese GET: no había necesidad
concreta todavía, y hubiera sido una ruta sin consumidor).

**Validación de que la imagen base del turno esté aprobada.** El endpoint nuevo rechaza (400) un
`fromImageId` que no tenga `status: "done"` + `outputPath`, ANTES de tocar el plan. Sin este check,
el turno se crearía igual y fallaría más tarde, dentro de la cola, con un mensaje menos claro
(`runImageGeneration` ya tiene ese guard para el caso VSL: "La imagen de referencia todavía no está
aprobada"). Decisión: duplicar el check en el borde de la API para dar un 400 legible al usuario en
vez de un job que nace y muere.

### Archivos tocados

- `src/lib/imagenes.ts` — agregado `chatTurnImageId`, `ChatTurn`, `buildChatHistory`.
- `src/app/api/imagenes/route.ts` — acepta multipart/form-data con campo `imagenBase` opcional.
  Sin ese campo, comportamiento idéntico al anterior (mismo JSON, misma validación).
- `src/app/api/projects/[id]/images/route.ts` (nuevo) — `POST` que agrega un turno de chat.
- `src/app/imagenes/ImagenesBoard.tsx` — input de archivo + preview (con
  `URL.createObjectURL`/`revokeObjectURL`), estado y UI del chat (`hilos`, `HiloChat`,
  `enviarTurnoChat`), el render de resultados pasa de iterar `jobs` planos a iterar `hilos`.

### Qué falta para verificación 100%

- **No se corrió `npm run build` ni `npm run typecheck`** (prohibido por el steering salvo pedido
  explícito del usuario). Se verificó por lectura cuidadosa de tipos/imports/JSX balanceado en cada
  archivo, y corriendo los dos scripts de verificación existentes del repo:
  - `bash tasks/_verificacion-endpoints.sh` → `SIN REGRESIONES` (el fetch nuevo a
    `/api/projects/${id}/images` cae bajo el prefijo `/api/projects/` que la línea base de
    `ImagenesBoard.tsx` ya esperaba, así que no hizo falta tocar `LINEA_BASE`).
  - `bash tasks/_verificacion-inventario.sh` → los archivos intocables
    (`pipeline.ts`, `queue.ts`, `schema.ts`, `storage.ts`, `db.ts`, `auth.ts`, `middleware.ts`,
    providers de Vertex) siguen presentes y no fueron tocados.
- **No se probó en runtime** (no se levantó el server ni se generó una imagen real, mock o vertex).
  Falta: correr `npm run dev`, subir una imagen base, confirmar que la primera generación sale
  image2image (revisar `pipeline.log` o el prompt exacto vía `GET /api/jobs/:id/preview`), aprobar,
  mandar un turno de chat, confirmar que aparece v2 encadenada y que el historial se ve completo.
- **Efecto secundario conocido y aceptado**: `variantes` en el turno de chat es un campo de
  `ProjectRecord.imageVariants` (por PROYECTO, no por imagen — así está diseñado en todo el resto
  del pipeline, no es algo nuevo de este cambio). Si se pide un número de variantes distinto en un
  turno, ese valor queda como default también para futuros turnos y se refleja en el campo
  `variants` mostrado de imágenes ya aprobadas (no las regenera, sólo cambia el número que se les
  muestra). Documentado en el comentario del endpoint.

### Bloqueadores

Ninguno. No se necesitó ninguna decisión de negocio pendiente ni dependencia externa no disponible.
