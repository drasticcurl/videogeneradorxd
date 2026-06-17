---
inclusion: always
---

# Contexto del proyecto videogeneradorxd

Este steering carga siempre: le da al asistente el **estado** y el **mapa de arquitectura**
para ubicarse rápido y **no tener que leer todo el proyecto** ante cada pedido.

## Qué es

App **Next.js 14 (App Router)** que genera anuncios UGC y **VSLs largos** (talking-head). Pegás
un brief o un PlanJSON, opcionalmente subís fotos de avatares (VSL), y genera **imágenes +
videos** con **Vertex AI** (Gemini, Nano Banana, Veo) manteniendo la **misma cara** por plano.
Corre **local** (`npm run dev`) o en **Cloud Run** (ver `DEPLOY.md`). Estado en `DATA_DIR`
(`db.json`) y archivos en `OUTPUT_DIR` (`./output` local o bucket montado en la nube).

---

## Arquitectura (patrón + mapa de módulos)

Patrón: **arquitectura en capas + ports & adapters** para los proveedores de IA.
Capas (de afuera hacia adentro): Presentación → Servicios/aplicación → Dominio → Infraestructura.
Los handlers de API son **finos**: validan y delegan en `src/lib`.

### Mapa — dónde vive cada cosa

| Capa | Path | Responsabilidad |
|---|---|---|
| Presentación (UI) | `src/app/page.tsx`, `src/app/project/[id]/pipeline/page.tsx`, `.../result/page.tsx`, `src/app/transcribe/page.tsx` | páginas; la de `pipeline` es la grande (3 vistas + storyboard editable) |
| Presentación (API) | `src/app/api/**/route.ts` | handlers finos (ver tabla de endpoints) |
| Estado UI | `src/store/useProjectStore.ts` | Zustand: config, plan, jobs, llamadas al backend |
| Componentes | `src/components/*` | `JobCard` (tarjeta+editor, grande), `ModelSelectorBar`, `FlowGraph`, `LogPanel`, `JsonEditor`, etc. |
| Servicios (app) | `src/lib/jobs/pipeline/` | **carpeta fragmentada** con barrel `index.ts` (ver abajo) |
| Servicios (app) | `src/lib/jobs/queue.ts` | cola en memoria (singleton `globalThis`): concurrencia, backoff 429/red, auto-aprobación, auto-recuperación |
| Dominio | `src/lib/schema.ts` | Zod del PlanJSON (`references[]`, `ref_image_ids[]`, validación cruzada) + `validatePlan` |
| Dominio | `src/lib/types.ts` | `JobRecord`, `ProjectRecord`, `Manifest`, `LogEntry`, etc. |
| Dominio | `src/lib/prompts.ts` | `PARSER_SYSTEM_PROMPT`, `buildVeoVideoPrompt` (UGC + acento argentino), `buildImageInstruction` (compartida con provider → preview == ejecutado) |
| Ports & adapters | `src/lib/providers/types.ts` | **puertos** (interfaces `ImageProvider`/`VideoProvider`/`LlmProvider` + tipos de IO) |
| Ports & adapters | `src/lib/providers/index.ts` | factory: elige adapter según `PROVIDER_MODE` |
| Adapter real | `src/lib/providers/vertex/*` | `auth` (ADC), `llm`, `image`, `video`, `models` (listado dinámico) |
| Adapter mock | `src/lib/providers/mock.ts`, `placeholder.ts` | placeholders sin credenciales |
| Infra | `src/lib/storage.ts` | filesystem por proyecto (paths via `OUTPUT_DIR`); `buildManifest`/`writeManifest` |
| Infra | `src/lib/db.ts` | "DB" JSON (`DATA_DIR/db.json`), singleton, escritura con fallback FUSE |
| Infra | `src/lib/config.ts` | `MODEL_CATALOG`, defaults, env, `vertexBaseUrl`, `resolveModel` |
| Infra | `src/lib/http.ts` | helpers de respuesta (`ok`/`badRequest`/`notFound`/`serverError`) |
| Deploy | `Dockerfile`, `cloudbuild.yaml`, `.dockerignore`, `.gcloudignore`, `DEPLOY.md` | Cloud Run + bucket montado |

### `src/lib/jobs/pipeline/` (fragmentado — barrel mantiene `@/lib/jobs/pipeline`)

- `shared.ts` — `imageJobId`/`videoJobId`, `findImage`, `imageRefIds`, `guessImageMime`, `logEvent`, `refreshManifest`.
- `build.ts` — `buildJobs` (crea/re-crea jobs desde el plan, idempotente).
- `generate.ts` — `runJobGeneration` + `runImageGeneration`/`runVideoGeneration` (ejecuta contra el provider).
- `edit.ts` — `approveJob`, `changePrompt`, `extendVideoJob`.
- `cost.ts` — `estimateCost`.
- `index.ts` — barrel: re-exporta la API pública (lo que importan `queue.ts` y los routes).

### Endpoints (`src/app/api`)

| Método/ruta | Hace |
|---|---|
| `GET /api/config` | config no sensible + catálogo estático para la UI |
| `GET /api/models` | **modelos dinámicos** de Vertex (cache 1h, `?refresh=1`, fallback a `MODEL_CATALOG`) |
| `POST /api/parse` | brief → PlanJSON (LLM) |
| `GET/POST /api/projects` · `GET/PUT /api/projects/[id]` | CRUD de proyectos |
| `POST /api/projects/[id]/generate` | encola los jobs |
| `GET /api/projects/[id]/download` | **ZIP** del proyecto + `stitch.sh`/`stitch.bat` (stitch LOCAL) |
| `POST /api/projects/[id]/{control,approve-batch,regenerate-batch,references,upload}` | acciones de pipeline |
| `POST /api/jobs/[id]/{approve,retry,prompt,extend}` · `GET .../preview` | acciones por job |
| `GET /api/files/[...path]` | sirve archivos del `OUTPUT_DIR` |

### Flujo de datos (mental model)

brief → `/api/parse` → PlanJSON (Zod) → crear proyecto (`db`) → `buildJobs` → `queue` corre
`runJobGeneration` (provider → `storage`) → `approveJob` → `refreshManifest` → UI lee
`/api/projects/[id]/jobs` → **Descargar ZIP** → stitch local con ffmpeg.

---

## Migración a Google Cloud (rama `feat/gcloud-migration`, NO mergeada a `main`)

Opción elegida: **bucket montado como disco** (Cloud Storage FUSE), no SDK. Cero refactor de storage.

- **F1** storage compatible con bucket montado (`db.ts` con fallback de escritura FUSE; `.env.example`).
- **F2** ffmpeg/stitch **fuera del servidor** → `GET /api/projects/[id]/download` (ZIP en streaming con
  `archiver` + scripts de stitch). `extendVideoJob` guarda la extensión como segmento `__extK.mp4`.
  Eliminados `src/lib/ffmpeg.ts` y el endpoint `/stitch`.
- **F3** modelos dinámicos (`/api/models` + `vertex/models.ts`; store `refreshModels`; UI selector con fuente y "otro ID…").
- **F4** `next.config` `output: "standalone"`, `Dockerfile` (sin ffmpeg), `cloudbuild.yaml`, `DEPLOY.md`.

**Restricciones de la nube**: 1 sola instancia (`min=max=1`, CPU always-on) porque la cola vive
en memoria. Auth Vertex por service account (ADC, sin keys). Para escalar a >1 hay que externalizar
cola + storage (no hecho a propósito).

---

## Caso real activo

VSL "Agua de Arroz TURBO" — **Lic. Natalia Reyes** (foto real, único `reference`) + **Romina**
(testimonio `text2image`). 95 clips. Plan en `vsl-natalia-plan.json`; generador en
`scripts/generate-vsl-plan.ts`.

---

## Convenciones a respetar

- **Idioma**: español rioplatense ("vos") en chat y diálogos del VSL. Prompts visuales en inglés.
  Diálogos NO se traducen.
- **Modelos default**: chat `gemini-2.5-flash`, imagen `gemini-2.5-flash-image` (Nano Banana),
  video `veo-3.1-generate-001`. Ante 429 NO sugerir Pro (tiene menos cuota).
- **Formato** 9:16 fijo. **Duración** solo 4/6/8s (snap en backend).
- **Git/PRs**: commits y push **siempre por `execute_bash`** para git local; para push/PR usar la
  herramienta de GitHub disponible (power `github`). Branch desde la base correcta. Mensajes y PRs
  en español, secciones "Qué hace / Cambios / Tested / Notas".
- **Preferencia del usuario (drasticcurl)**: una **rama + PR nuevo por cada cambio** (merge incremental).
  Excepción explícita: la migración a Cloud vive toda en `feat/gcloud-migration` (rama de larga vida,
  `main` intacto) por pedido del usuario.
- **Tests/build**: son lentos en el sandbox. Por defecto el usuario los corre localmente; correr
  `typecheck`/`build` solo si lo pide. (Para la migración los corrió el asistente porque el usuario
  lo pidió explícitamente.)

## Pistas para no romper nada

- Cambios al schema del plan: actualizar `validatePlan`, tipos de `Manifest`, `PARSER_SYSTEM_PROMPT`
  y el `responseSchema` de Vertex.
- Cómo se arma el prompt: tocar `prompts.buildImageInstruction` / `buildVeoVideoPrompt` (así provider
  y `/api/jobs/:id/preview` quedan alineados).
- En la cola, si el job termina OK y `autoApprove` está activo, llamar `approveJob` (no dejar
  `awaiting_approval`).
- Agregar funciones al pipeline: ponerlas en el módulo correcto de `src/lib/jobs/pipeline/` y
  re-exportarlas en `index.ts` si las usan `queue.ts` o un route.
- Storage: NO hardcodear rutas; todo sale de `OUTPUT_DIR`/`DATA_DIR` (así el bucket montado funciona).
