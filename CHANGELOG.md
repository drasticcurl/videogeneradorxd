# Registro de cambios

Toda tanda de cambios se anota acá, arriba. Formato: fecha, qué cambió y **por qué** (el bug que
evita o el problema que resuelve). El detalle línea por línea vive en `git log`; esto es para
entender el estado sin leer 70 commits.

---

## 2026-09-20 (3) — "Prompt dual": los dos prompts vienen precargados como referencia editable

**Qué pasó:** los textareas de Prompt A / Prompt B del switch "Prompt dual" arrancaban vacíos con
solo un placeholder gris de ejemplo. Ahora, la primera vez que se activa el switch, se precargan con
un prompt de referencia REAL y editable — no un placeholder que desaparece al tipear, texto de
verdad que se puede dejar tal cual o modificar. `PROMPT_A_DEFAULT` es (casi textual) el prompt que
ya se usa en producción para la variación conservadora; `PROMPT_B_DEFAULT` es la contraparte de
libertad creativa pensada para el mismo caso.

- **No son obligatorios**: `toggleDual()` solo precarga si el campo está VACÍO (`actual || default`).
  Si el usuario ya escribió algo y apaga/prende el switch, lo suyo no se pisa.
- **Botón "Restaurar el sugerido"** debajo de cada textarea, visible solo cuando el contenido se
  desvió del default — para volver atrás sin borrar todo a mano.
- Verificado: `tsc --noEmit` sin errores. Smoke test HTTP de `/imagenes` en modo mock (200, sin
  errores de render).

---

## 2026-09-20 (2) — Generador masivo: switch "Prompt dual" (2 prompts × 2 modelos, 4 variantes fijas)

**Qué pasó:** el generador masivo (ver la entrada de más abajo) generaba las N variantes de una foto
con un solo prompt y el modelo del proyecto. El pedido: poder probar **dos prompts** por foto — uno
conservador ("variación casi igual, no cambies mucho") y otro con libertad creativa ("usá esta foto
de referencia y armá el ad") — cruzados con los dos modelos, en vez de 4 variantes idénticas del
mismo prompt/modelo. Mapeo fijo, sin opción de elegir otro:

```
v1 = prompt A + Flash     v2 = prompt B + Flash
v3 = prompt A + Pro       v4 = prompt B + Pro
```

Esto tocó una asunción de fondo del pipeline de imagen: `runImageGeneration` asumía que **todas**
las variantes de un job comparten el mismo prompt y el mismo modelo (solo cambiaba el request, no
sus parámetros). Se cambió eso puntualmente, de forma aditiva:

- **`Candidate` (types.ts)** gana `model?` y `promptLabel?` — qué modelo/prompt generó ESA variante
  puntual. Quedan `undefined` (no se serializan) fuera del modo dual: en el caso normal las 4
  variantes comparten prompt/modelo (ya expuesto en `JobRecord.model`), así que no hay nada nuevo
  que mostrar y no se duplica información.
- **`VariantPlanEntry` (types.ts, nuevo tipo)** — contrato de `job.meta.variantPlan`: un array
  `{prompt, model, label?}[]` 1-based, por índice de variante. Vive en `meta` (no como campo propio
  de `JobRecord`) porque es un caso de uso específico de una sola pantalla.
- **`runImageGeneration` (jobs/pipeline.ts)** — si `job.meta.variantPlan` está presente (validado en
  runtime: una forma que no calza se descarta en silencio y esa variante cae al comportamiento de
  siempre, nunca revienta el job por esto), cada variante `i` usa `planParaVariante(i)` en vez de
  `img.prompt` / `model` fijos. El resto de la función es exactamente el mismo camino: una request
  por variante, pausa entre ellas, reintentos con backoff ante 429, persistencia incremental. Los
  tres puntos donde se guardaba `model` a nivel de job se ajustaron para reflejar el modelo de la
  variante correspondiente en vez de un valor que, con plan dual, ya no describe al job entero.
- **`POST /api/imagenes/masivo`** — nuevo flag `dual` (string "true"/"false", FormData no tiene
  booleanos) + `promptA`/`promptB` en vez de `prompt`. Con `dual=true` se fuerza `variantes: 4`
  **en el backend** (no solo deshabilitado en la UI: un cliente que mande otra cosa no se puede
  saltar la regla), el plan del proyecto usa `promptA` como "el prompt" de siempre (se ve así en
  manifest/UI), y tras `buildJobs` se le escribe `meta.variantPlan` al job de imagen recién creado.
- **UI (`GeneradorMasivo.tsx`)** — switch "Prompt dual" (mismo patrón que el de auto-aprobación de
  la home): activado, cambia el formulario a dos textareas (Prompt A / Prompt B) y deja el selector
  de variantes deshabilitado mostrando "4" fijo. **`ImagenesBoard.tsx`** (donde se revisan las 4
  variantes) muestra un badge nuevo en la esquina inferior izquierda de cada miniatura ("A · Flash",
  "B · Pro"...) cuando `candidates[].promptLabel` viene poblado — invisible en el caso normal.
- **Verificado**: `tsc --noEmit` sin errores. Probado en modo mock con 1 foto: `GET
  /api/projects/:id/jobs` confirma `candidates[0..3]` con exactamente `{A,Flash}, {B,Flash}, {A,Pro},
  {B,Pro}` en ese orden, y `pipeline.log` confirma los mismos prompts/modelos en cada request real
  (con la pausa entre variantes intacta). Validado que `dual=true` sin `promptB` da 400 con mensaje
  claro. Confirmado que el modo normal (`dual=false`) no cambió: mismos candidatos sin
  `model`/`promptLabel` (ausentes del JSON, no `null`). `tasks/_verificacion-endpoints.sh` →
  `SIN REGRESIONES`.

---

## 2026-09-20 — `/imagenes`: generador masivo de variaciones (N fotos + 1 prompt, secuencial)

**Qué pasó:** generar muchos creativos de golpe (subir 10 fotos, un prompt genérico tipo "hacé una
variación de este creativo, no cambies mucho") pegaba contra la cuota por minuto de un solo modelo
de imagen y terminaba en 429 en cascada — los jobs agotaban los `PIPELINE_RATE_LIMIT_MAX_ATTEMPTS`
(10) reintentos y quedaban `failed`. Nueva pestaña "Generador masivo" en `/imagenes` que resuelve
esto con dos mitigaciones, ninguna alcanza sola:

1. **Alterna modelo por proyecto**: par → `gemini-3-pro-image` (Nano Banana Pro), impar →
   `gemini-3.1-flash-image` (Flash). Dos proyectos corriendo cerca en el tiempo pegan contra cuotas
   *distintas*, así no se suman contra el mismo límite.
2. **Corre SECUENCIAL entre proyectos**, no en paralelo: el proyecto N+1 no se encola hasta que el N
   llega a un status terminal (`done`/`partial`/`failed`). Dentro de cada proyecto individual las
   variantes siguen corriendo en paralelo como siempre (eso no cambió); lo que se evita es que los
   N proyectos de la tanda arranquen todos juntos y multipliquen la carga por N.

No se creó un pipeline nuevo: cada foto se convierte en un proyecto de sólo-imágenes independiente
(mismo mecanismo que `/api/imagenes` con imagen base — `image2image` contra la foto subida), así que
reutiliza la cola, los reintentos, el rate limit y el auto-approve que ya existían.

- **`src/lib/jobs/masivo.ts` (nuevo)** — estado de tandas secuenciales en `globalThis` (mismo patrón
  que `queue.ts`, sobrevive al HMR). `startBatch(batchId, projectIds, enqueueProject)` encola sólo el
  primer proyecto; los demás quedan `draft` con sus jobs ya armados. `notifyProjectFinished(projectId,
  enqueueProject)` se llama desde `queue.ts` cada vez que un proyecto termina y, si es el que está al
  frente de una tanda activa, encola el siguiente. `enqueueProject` se **recibe como parámetro** en
  vez de importarse: `masivo.ts` no importa `queue.ts`, así evita el ciclo de import que se daría si
  lo hiciera (`queue.ts` ya necesita llamar a este módulo desde `finalizeProjects`).
- **`queue.ts`**: un solo hook nuevo, al final de `finalizeProjects()`, justo después de persistir el
  status terminal del proyecto — `notifyProjectFinished(projectId, enqueueProject)`. Para un proyecto
  que no pertenece a ninguna tanda (el 100% de los casos hasta ahora) es un lookup O(1) que no hace
  nada; no se tocó ninguna otra lógica de la cola (concurrencia, backoff, rate limit de video, gate
  por lotes siguen exactamente igual).
- **`POST /api/imagenes/masivo` (nuevo)** — multipart: N archivos (`fotos`, repetido) + `prompt` +
  `nombreBase` + `variantes`/`aspectRatio`/`imageSize`/`negativePrompt` opcionales. Crea los N
  `ProjectRecord` primero (si algo falla a mitad de camino, no queda una tanda mitad creada mitad
  corriendo) y recién después llama a `startBatch`. `autoApprove: true` a propósito — al revés que
  `/api/imagenes`, que lo fuerza a `false` porque su UI es para elegir variante a mano: acá el punto
  es no sentarse a aprobar cada una de N fotos, cada job pasa a `done` solo al terminar.
- **`ProjectRecord.batch?: { batchId, position, total }` (`types.ts`)** — persistido en el proyecto
  (no sólo en la memoria de `masivo.ts`) para que la UI pueda seguir agrupando visualmente los N
  proyectos de una corrida después de un reinicio, aunque la cola en memoria (y con ella, el
  autoavance secuencial) se pierda como el resto de la cola. Expuesto en `GET /api/projects`.
- **UI**: `/imagenes` pasa a tener dos pestañas (`ImagenesTabs.tsx`, Radix `Tabs` no controlado,
  `defaultValue` — a diferencia de `ProjectTabs` no sincroniza con la URL porque las dos pestañas
  viven en la misma ruta y no chocan con el `?id=` que ya usa `ImagenesBoard`). "Generar" es
  `ImagenesBoard` sin cambios. "Generador masivo" es `GeneradorMasivo.tsx` (nuevo): dropzone
  multi-archivo con drag&drop, un prompt único, nombre de tanda, variantes/formato/calidad, y la
  lista de tandas lanzadas en la sesión con el estado de cada proyecto (poll a `/api/projects`
  filtrando por `batch.batchId`, mismo patrón de polling con apagado automático que `ImagenesBoard`)
  y link a cada uno (`/imagenes?id=<id>`, se revisa en la pestaña "Generar" de siempre — esta
  pantalla no duplica la grilla de variantes).
- **Verificado**: `tsc --noEmit` sin errores. `tasks/_verificacion-endpoints.sh` →
  `SIN REGRESIONES` (no se tocó ningún fetch existente). Probado en modo mock con 3 fotos: los 3
  proyectos se crean (`alma-gemela 1/2/3`), alternan modelo (Pro/Flash/Pro) y el `pipeline.log`
  confirma que corren secuencial (el proyecto N+1 arranca milisegundos después de que el N se
  aprueba, nunca antes). Validado que sin fotos o sin prompt devuelve 400 con mensaje claro.
  `npm run lint` no tiene `eslint.config.*` en este repo (pide setup interactivo de Next 14); no se
  configuró, queda igual que antes de este cambio.

---

## 2026-09-19 — `/imagenes`: imagen base subida (image2image) y chat iterativo con historial

**Qué pasó:** `/imagenes` sólo podía generar desde cero (text2image) y "Variar" reemplazaba la
imagen existente sin dejar rastro de los pasos anteriores. Ahora se puede (1) arrancar subiendo una
foto propia como base, y (2) encadenar modificaciones sucesivas (v1 → v2 → v3...) viendo **todas**
las imágenes de la cadena, no solo la última.

No se tocó el schema del plan ni el pipeline: las dos piezas que hacían falta ya existían para el
caso VSL (`references[]` subidas + `image2image` con `ref_image_id` apuntando a otra `Image` del
proyecto). Este cambio expone ese mismo mecanismo desde la pantalla de imágenes sueltas.

- **`POST /api/imagenes` acepta multipart** (`src/app/api/imagenes/route.ts`). Si el body es
  `multipart/form-data` con un campo `imagenBase` (File), el archivo se guarda como `reference`
  (mismo camino que usan los avatares VSL) y la primera `Image` del plan nace `image2image` contra
  ella en vez de `text2image`. Sin archivo, sigue exactamente igual que antes (JSON). El
  Content-Type decide qué parser usar *antes* de leer el body (`req.json()` revienta con multipart).
- **`POST /api/projects/:id/images` (nuevo)** — agrega un turno de chat: crea una `Image` NUEVA
  (`image2image`, `ref_image_id = fromImageId`) en vez de editar la existente, para que cada paso
  quede visible y no se pierda al "variar". Exige que `fromImageId` esté aprobada (`status: done` +
  `outputPath`) antes de aceptar el turno — si no, `runImageGeneration` fallaría con un error menos
  claro más adelante en la cola. El id nuevo es `<base>_v<n>` (sin anidar sufijos si `fromImageId`
  ya era un turno). `buildJobs` detecta la dependencia sola (mismo código que ya usan las imágenes
  VSL encadenadas): no hay lógica de dependencias nueva.
- **`buildChatHistory` (`src/lib/imagenes.ts`)** — sigue `ref_image_id` hacia atrás desde una imagen
  hasta la raíz de la cadena, con tope de 200 iteraciones contra un plan con ciclos. La respuesta del
  endpoint nuevo la incluye (`history`) para que el cliente pueda verificar contra lo que ya armó
  solo con el manifest.
- **`ImagenesBoard.tsx`**: input de archivo opcional ("Imagen base") con preview; al enviar con
  archivo usa `FormData`, sin archivo sigue con JSON. Los resultados se agrupan por **hilo** (cadena
  completa de una imagen, siguiendo `ref_image_id` del manifest en el cliente) en vez de una grilla
  plana: cada hilo se ve como una fila v1 → v2 → v3 con un chat debajo, habilitado sólo cuando la
  última imagen de la cadena está aprobada.
- **Verificado sin build/typecheck** (prohibido correrlos salvo pedido explícito): lectura completa
  de los archivos tocados + `tasks/_verificacion-endpoints.sh` → `SIN REGRESIONES` (el fetch nuevo
  cae bajo el prefijo `/api/projects/` que la línea base ya esperaba) + `tasks/_verificacion-
  inventario.sh` → sin cambios en los archivos intocables (`pipeline.ts`, `queue.ts`, `schema.ts`,
  `storage.ts`, `db.ts`, etc.).

---

## 2026-09-08 — Aislamiento por usuario: implementado, migrado y deployado

**Qué pasó:** las 8 tasks del plan se ejecutaron completas. `owner?: string` en
`ProjectRecord`, el helper `src/lib/ownership.ts` (5 funciones: `sessionUser`,
`ownerOf`, `requireProjectOwner`, `requireJobOwner`, `filterOwnedIds`), guard de
dueño en las 21 rutas que recibían un projectId o jobId, y el cartel de `/batch`
dejó de decir "los borraste" (ahora es neutro: mezcla ajenos con inexistentes a
propósito, para no confirmar qué proyecto existe).

**La migración corrigió el supuesto inicial del plan.** Se creía que había ~12
proyectos; en producción había **29** (119 jobs, 22 logs). Los 4 nombres de Ivan
(`AA_rendicion_meresigne_duena52_v01/v02`, `AA_alquiler_marcodepuerta_duena31_v01`,
`AA_manerastontas_multivoz_v01`) coincidieron **exacto** contra la DB real — la
pregunta abierta P-01 del plan queda resuelta: sin typos, sin duplicados, los 4 son
de tipo `video` (no colisiona con "las imágenes van todas a Lucho", P-03 resuelta).
Migración: **4 a `ivan`, 25 a `lucho`**, 0 pérdidas (29→29 proyectos, 119→119 jobs,
22→22 logs, 29→29 carpetas en `output/`), idempotente (segunda corrida: "0
asignados, 29 ya tenían dueño"), con backup propio
(`db.json.bak-2026-09-08T20-53-24-950Z`) más uno manual.

**Deploy**: commit `e66bd83` en `main`, corrido con `deploy/deploy.sh` en el
server. `typecheck ok`, `build ok`, health check `/login → 200`, `api/config`
responde 401 (guard de auth activo). P-02 del plan queda resuelta: el deploy se
corrió vía el alias SSH `funnel-vps` (usuario `deploy`, sin sudo).

**Verificado en producción** (no solo local): sin cookie, `/api/files/<cualquier
id>/manifest.json` da 401 (el middleware ya bloquea antes de llegar al guard de
dueño). **Pendiente**: el QA completo de las 9 filas con las dos cuentas reales
(`ivan`/`lucho`) — no se corrió porque este proceso no tiene las passwords; queda
para confirmar a mano que cada uno ve solo lo suyo.

---



**Qué pasó:** el `README.md` y `.kiro/steering/project-context.md` describían un estado de junio
(app local, sin auth, sin deploy, modelos `gemini-2.5-*`). El código real ya tenía login por usuario,
infraestructura de deploy completa y el catálogo Gemini 3.x desde fines de agosto. Un asistente que
leía el steering arrancaba con supuestos falsos.

- **`README.md` reescrito contra el código.** Ahora documenta: login por usuario
  (`PASSWORD_<NOMBRE>` + cookie HMAC), las tres superficies de trabajo (`/`, `/imagenes`, `/batch`
  con sus tres vistas), el catálogo real de modelos, `GOOGLE_CLOUD_LOCATION=global` y por qué,
  el comportamiento completo de la cola, los **31 handlers HTTP en 25 archivos**, la tabla completa
  de variables de entorno, y el deploy real (`/srv/generador`, PM2 con una sola instancia, Caddy,
  los guards de `deploy.sh`).
- **`.kiro/steering/project-context.md` reescrito.** Mismo contenido en versión corta, más las
  pistas para no romper nada (una sola instancia de PM2, `DATA_DIR`/`OUTPUT_DIR` absolutos, el export
  lee del plan y no de los jobs).
- **`CHANGELOG.md` nuevo** (este archivo).
- **Limitación conocida documentada en los dos**: los proyectos **no** están aislados por usuario, y
  son cuatro caminos por los que se ve lo ajeno, no uno.

**Planificado, sin implementar todavía:** `tasks/aislamiento-por-usuario/` — 13 archivos, 8 tasks en
3 olas (T01 sola → T02-T07 en paralelo → T08 sola).

Decisiones de alcance tomadas con el usuario: campo `owner` en `ProjectRecord` + chequeo de dueño en
**21 rutas**, y **no** partir `db.json`/`output/` por usuario (los paths absolutos están grabados en
cada `ProjectRecord` y en cada `manifest.json`, y habría que mover archivos en producción para el
mismo resultado). Lo ajeno devuelve **404 y no 403**, para no confirmar que un proyecto existe. Sin
usuario administrador. La cola de jobs sigue compartida.

Migración de los ~12 proyectos existentes: todos a `lucho` menos cuatro, que son de `ivan`. El script
(`_migracion-owner.mjs`) hace backup, es idempotente, conserva los campos opcionales del proyecto, y
**aborta sin escribir** si no encuentra alguno de los 4 nombres — porque se transcribieron a mano y un
match silencioso le daría a Lucho un proyecto de Ivan. Verificado contra una base scratch: **7/7 en
verde**. Punto de partida del módulo medido: `verde 7 · pendiente 24 · fallo 0`.

Lo que **no** se pudo verificar y queda anotado como P-01 del plan: que esos 4 nombres coincidan
carácter por carácter con los de `db.json` en producción. En este checkout no existe `./data`, y no se
lee producción para averiguarlo.

---

## 2026-08-27 → 2026-08-29 — Producción: auth, deploy y rediseño de UI

La tanda que convirtió la app local en una herramienta desplegada.

- **Login por usuario** (`feat(auth)`): un usuario por `PASSWORD_<NOMBRE>`, cookie
  `gen_session` firmada con HMAC-SHA256, comparación timing-safe, rate limit por IP (5 cada 15 min),
  y **falla cerrado** — sin `AUTH_SECRET` o sin ninguna password no entra nadie. El middleware
  reimplementa el verify con Web Crypto porque corre en Edge.
  - `fix(login)`: la password **correcta** daba error del server. `router.push("/")` dentro de un
    `router.refresh()` caía en el `redirect("/")` de `/login` y Next lo reportaba como error de
    render. Se cambió por `window.location.assign("/")`.
- **Deploy en la VPS** (`chore(deploy)`): releases por timestamp, PM2 con **una sola instancia**
  (la cola vive en memoria), Caddy detrás de Cloudflare, swap atómico con `mv -T`, health check
  contra `/login` y rollback automático.
  - `fix(deploy)`: `npm ci --include=dev` es obligatorio. El guard hace `source` del
    `.env.production`, que setea `NODE_ENV=production`, y con eso `npm ci` saltea las
    devDependencies — donde vive `tsc`.
  - `chore(deploy)`: `deploy.sh` se re-ejecuta si el commit lo modificó. Bash lee el script por
    offset de bytes; si cambia de tamaño a mitad de ejecución, ejecuta líneas cortadas. Pasó.
- **Modelos a Gemini 3.x y `location=global`** (`feat(modelos)`): toda la familia 3.x da 404 en
  las regiones y sólo existe en `global`. Se agregó 3.7 Flash al selector (3.6 sigue de default: es
  más rápido y más parejo).
- **Pantalla de sólo imágenes** (`feat(imagenes)`): un prompt por proyecto con formato y calidad
  elegibles. Antes partía el texto por línea, lo que convertía un prompt de cinco líneas en cinco
  prompts cortados al medio.
- **Tablero de lotes** (`feat(batch)`): `/batch`, `/batch/review` (revisión FIFO tipo tinder) y
  `/batch/videos` (línea de tiempo de clips), más las fases `images`/`videos` para revisar todo
  antes de gastar en Veo.
- **Rediseño de UI en 12 tasks paralelizables** (`tasks/00-PLAN-REDISENO-UI.md`, T01-T12): tokens,
  tipografía Geist y 10 primitivas en `src/components/ui/`, y las 8 pantallas migradas encima.
- **Arreglos de cuota y cola**:
  - `fix(imagenes)`: pedir 2 variantes devolvía 1 **en silencio**. `gemini-3.1-flash-image` contesta
    429 a los ~200ms si se le manda la segunda pegada a la primera. De ahí salió
    `PIPELINE_IMAGE_VARIANT_GAP_MS` (2500ms).
  - `fix(cola)`: un reintento por 429 quedaba huérfano si otro job esperaba aprobación.
  - `fix(cola)`: los jobs que quedaron en `generating` tras un reinicio se retoman solos.
- **Stitch y descarga**:
  - `feat(stitch)`: el video unido se llama como el proyecto, no `final.mp4` — cinco proyectos
    bajaban cinco archivos con el mismo nombre.
  - `perf(stitch)`: preset `medium` en vez de `slow` (39% más rápido, misma imagen) y respetar el
    fps de los clips en vez de forzar 30.
  - `fix(download)`: la descarga en zip fallaba en la VPS porque `zip` no viene en Ubuntu Server.
    `deploy.sh` ahora avisa.

---

## 2026-05-31 → 2026-07-05 — El pipeline (PRs #1 a #26)

La construcción del núcleo, antes de que la app saliera a internet.

- **VSL con avatares de referencia** (#9, #10): fotos subidas como fuente de identidad. La primera
  imagen de cada persona es `image2image` contra la foto real; los planos siguientes mantienen la
  cara. Con validación cruzada en el schema para que una imagen no se referencie a sí misma.
- **Resiliencia del pipeline** (#11, #12, #13): manejo de 429 con backoff dedicado de 45s y
  presupuesto de reintentos propio, variantes con éxito parcial (cada éxito se persiste al toque),
  auto-aprobación con ventana de concurrencia, y destrabado de jobs colgados en `generando`.
- **Revisión y edición** (#14, #15, #16, #19): vista de revisión liviana, regeneración por lote,
  el prompt **exacto** que se ejecuta con la imagen de input y el JSON, prompts editables, y
  override del prompt final que se le manda a Veo por clip.
- **Auto-approve por proyecto** (#21): VSL largo conviene en automático; un video normal, manual.
- **Plantilla de prompt externalizada** (#23): `prompts/veo-video-prompt.md`, editable en runtime sin
  recompilar.
- **Panel de JSON de videos** (#26).
