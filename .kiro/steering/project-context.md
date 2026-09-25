---
inclusion: always
---

# Contexto del proyecto videogeneradorxd

Este steering carga automáticamente: dale al asistente **el estado actual** sin tener que repetirlo.
Si algo de acá contradice al código, **gana el código** — y actualizá este archivo en el mismo commit.

## Qué es

App **Next.js 14 desplegada en producción** que genera anuncios UGC, **VSLs largos** (talking-head)
e **imágenes sueltas**. Pegás un brief o un PlanJSON, opcionalmente subís fotos de avatares (VSL), y
genera imágenes + videos con **Vertex AI** (Gemini, Nano Banana, Veo) manteniendo la **misma cara**
en cada plano.

**No es una app local.** Vive en `generador.hilvanapp.online` con **login por usuario**, detrás de
Caddy → PM2 → Next standalone en `127.0.0.1:3006`. Estado en `<DATA_DIR>/db.json` y archivos en
`<OUTPUT_DIR>/<project_id>/`. En el server esos paths son `/srv/generador/storage/{data,output}`.

**Genera gasto real**: Veo y Nano Banana son de pago. Todo el diseño del pipeline (topes de
concurrencia, rate limit, backoff) sale de ahí.

## Auth — cada usuario es una variable de entorno

- Un usuario por `PASSWORD_<NOMBRE>`; `authUsers()` (`src/lib/config.ts`) los enumera de
  `process.env` y normaliza el nombre a minúsculas. Hoy: **`ivan` y `lucho`**.
- Cookie `gen_session` = `<usuario>.<ts>.<hmac>`, HMAC-SHA256 con `AUTH_SECRET`.
- `src/lib/auth.ts` es la implementación real (`node:crypto`, server-only).
  `src/middleware.ts` **reimplementa el verify con Web Crypto** porque corre en Edge, donde no
  existen `node:crypto` ni `node:path`. Mismo formato de token, mismo TTL.
- **Falla cerrado**: sin `AUTH_SECRET` o sin ninguna `PASSWORD_*` no entra nadie.
- El middleware contesta **401 en `/api/*`** (no un redirect: un 307 hace que el `fetch` parsee el
  HTML del login como JSON y el error real queda tapado por "Unexpected token <").

## Aislamiento por usuario: hecho

Implementado en `e66bd83`: `ProjectRecord.owner` + `src/lib/ownership.ts` (`requireProjectOwner`,
`requireJobOwner`, `sessionUser`). Toda ruta nueva bajo `projects/[id]/` usa `requireProjectOwner`, y
el usuario sale **siempre** de la cookie, nunca del body. El plan está en
`tasks/aislamiento-por-usuario/`.

## Modelos — Gemini 3.x, y `GOOGLE_CLOUD_LOCATION=global`

`MODEL_CATALOG` en `src/lib/config.ts`. Defaults: chat `gemini-3.6-flash`, imagen
`gemini-3.1-flash-image` (Nano Banana 2), video `veo-3.1-lite-generate-001`.

**`global`, NO una región.** Toda la familia Gemini 3.x da **404** en `us-central1`, `us-east5` y
`europe-west4`. Si alguien lo pone en una región, todos los jobs fallan con 404. Veo 3.1 es la línea
más nueva: `veo-3.2` y `veo-4.0` dan 404.

Ante 429 en imagen: bajar `PIPELINE_CONCURRENCY` e `IMAGE_VARIANTS` y subir
`PIPELINE_IMAGE_VARIANT_GAP_MS`. **NO sugerir pasar a Nano Banana Pro: tiene menos cuota.**

## Convenciones a respetar

- **Idioma**: español rioplatense (voseo) en chat, comentarios y UI. **Prompts visuales en inglés.**
  Diálogos NO se traducen.
- **Formato**: vertical 9:16 fijo. Duración de clip sólo 4/6/8s (snap automático en backend).
- **Comentarios**: explican *por qué*. Cuando documentan una decisión, traen **el bug que evita**.
  Los comentarios largos de este repo son deliberados; no los "limpies".
- **Tests/build**: typecheck y build son lentos. **NUNCA correr `typecheck` ni `build` salvo que el
  usuario lo pida explícitamente.** Verificar con `grep`/lectura.
- **Cambios chicos y enfocados**, commits descriptivos en español. Nunca borrar funcionalidad
  existente sin avisar.
- **PRs**: uno por feature/fix, desde `main` actualizado. Título corto, body en español con
  "Qué hace" / "Cambios" / "Tested" / "Notas".
- **Registro de cambios**: toda tanda de cambios se anota en `CHANGELOG.md`.

## Planificación: la convención de `tasks/`

Los cambios grandes se planifican antes de escribir código, en `tasks/<modulo>/`:
`00-PLAN-<MODULO>.md` (decisiones cerradas, contratos congelados, ownership de archivos, olas),
`TNN-<nombre>.md` (una por agente), `PROMPT-CLAUDE-CODE.md`, y `_verificacion-*.{sh,mjs}`.

`tasks/_verificacion-endpoints.sh` es una **línea base**: verifica que ninguna pantalla perdió un
`fetch`. Si movés un fetch a propósito, actualizá `LINEA_BASE` en el mismo commit. Nunca la toques
"para que pase".

## Archivos importantes para orientarse

- `src/lib/config.ts` — `MODEL_CATALOG`, defaults, env vars del pipeline, `authUsers()`.
- `src/lib/auth.ts` + `src/middleware.ts` — auth (leer los dos juntos: uno es Node, otro Edge).
- `src/lib/types.ts` — `ProjectRecord`, `JobRecord`, `Manifest`.
- `src/lib/db.ts` — `db.json` (escritura atómica tmp+rename, singleton por `globalThis`).
- `src/lib/schema.ts` — Zod del PlanJSON (`references[]`, `ref_image_ids[]`, validación cruzada).
- `src/lib/prompts.ts` — `PARSER_SYSTEM_PROMPT`, `buildVeoVideoPrompt`, `buildImageInstruction`
  (compartida con el provider, así el preview es idéntico a lo ejecutado).
- `src/lib/jobs/queue.ts` — concurrencia, auto-aprobación, gate por lotes, backoff 429+red,
  auto-recuperación de jobs colgados. Al final de `finalizeProjects()` llama a
  `notifyProjectFinished` (jobs/masivo.ts) para el generador masivo — no tocar sin leer ese modulo.
- `src/lib/jobs/pipeline.ts` — `buildJobs`, `run*Generation`, `approveJob`, `changePrompt`, `extend`.
  `runImageGeneration` lee `job.meta.variantPlan` (tipo `VariantPlanEntry[]`, types.ts) para el
  "prompt dual" del generador masivo: si esta presente, cada variante usa SU prompt/modelo en vez
  de los fijos del job. Se valida la forma en runtime (una entrada mal formada cae al comportamiento
  normal para esa variante, nunca revienta el job).
- `src/lib/jobs/masivo.ts` — tandas SECUENCIALES del generador masivo (`/imagenes`, pestaña
  "Generador masivo"): `startBatch`/`notifyProjectFinished`. No importa `queue.ts` a propósito
  (recibe `enqueueProject` como parámetro) para no crear un ciclo de import.
- `src/lib/batch.ts` — `buildBatchSnapshot` (tablero, review FIFO, timeline de clips).
- `deploy/deploy.sh` — build + activación, con todos los guards. Leerlo antes de tocar deploy.
- `src/lib/voz/` — **cambio de voz** (ElevenLabs Voice Changer sobre el video unido). `tramos.ts`
  es PURO (solo `import type`, lo prueban B15-B19 con node), `audio.ts` son los 7 pasos de ffmpeg
  (cortes por muestra a 48 kHz, video con `-c:v copy`), `corrida.ts` la cola y el ciclo de vida.
  `corrida.ts` NO importa `voz/index.ts`: el proveedor llega por parámetro. `elevenlabs.ts` es el
  único archivo que escribe `xi-api-key`; la key solo la lee `config.elevenLabsKeyFor()`.
  `src/lib/unido.ts` compara la receta del stitch (`ProjectRecord.recetaUnido`) con los clips en
  disco. Diseño y contratos en `tasks/cambio-de-voz/`; verificación: `_verificacion-voz.sh` y
  `_verificacion-voz-mock.mjs`. Variables clave: `VOICE_PROVIDER` (default `mock`) y
  `ELEVENLABS_API_KEY`.

## Pistas para no romper nada

- **Una sola instancia de PM2**, no negociable: la cola vive en memoria del proceso y `db.json` se
  escribe sin locks entre procesos. Con 2+ se rompe el polling y hay escrituras concurrentes. La
  cola del **cambio de voz** también vive en memoria (una conversión a la vez en toda la app), así
  que la regla vale doble. No deployar con una conversión de voz corriendo: se marca fallida.
- **`DATA_DIR`/`OUTPUT_DIR` absolutos y afuera de `releases/`.** Si quedan relativos se resuelven
  contra el cwd (`/srv/generador/current`, dentro de la release) y el próximo deploy los borra sin
  un solo error. El guard 3c de `deploy.sh` aborta.
- **Un reload pierde los jobs en vuelo** (los archivos quedan, el progreso no). No deployar con una
  generación corriendo.
- Cambio en el schema del plan → actualizar `validatePlan`, los tipos de `Manifest`, el parser
  system prompt y el `responseSchema` de Vertex.
- Cambio en cómo se arma un prompt → hacerlo en `prompts.buildImageInstruction` o
  `buildVeoVideoPrompt`, así el provider y `/api/jobs/:id/preview` quedan alineados.
- En la cola, si el job termina OK y `autoApprove` está activo, hay que llamar `approveJob`
  (no dejarlo en `awaiting_approval`).
- **El export a ffmpeg lee del PLAN, no de los jobs**: cualquier edición debe persistir en el plan
  vía `changePrompt`.
