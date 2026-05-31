# AUGC Pipeline

Aplicación web **local** para producir anuncios **UGC** (user-generated content) para un funnel de
quiz, de punta a punta y con control humano en cada paso. Pegás un brief en lenguaje natural y la
app:

1. **Interpreta** el brief con Gemini (Vertex AI) → genera un **PlanJSON** estructurado y validado.
2. Ejecuta un **pipeline en cadena** con aprobación humana:
   - genera las imágenes base (`text2image`),
   - genera las imágenes derivadas (`image2image`) manteniendo la cara del avatar consistente,
   - genera los videos con **Veo** (imagen → video, con audio y acento rioplatense),
   - los clips marcados para filmar quedan como placeholders para subir a mano.
3. **Guarda todo en tu disco local** dentro de `./output/<project_id>/` (imágenes, clips,
   `manifest.json`, `pipeline.log`).
4. Opcionalmente **une** los clips en un único `final.mp4` con ffmpeg.

Todo es **asíncrono**, con estado en vivo por job (`pending → generating → awaiting_approval →
done | failed`), reintentos con backoff, **aprobación de cada ítem**, regeneración campo por campo,
y extensión de videos.

> Pensada para correr **localmente en tu PC**. No usa Supabase ni storage externo: el estado vive
> en `./data/db.json` y los archivos generados en `./output/`.

---

## Índice

- [Requisitos](#requisitos)
- [Puesta en marcha](#puesta-en-marcha)
- [Modo mock vs Vertex AI real](#modo-mock-vs-vertex-ai-real)
- [Autenticación (ADC, sin API keys)](#autenticación-adc-sin-api-keys)
- [Modelos disponibles](#modelos-disponibles)
- [Flujo de uso](#flujo-de-uso-en-la-app)
- [Dónde quedan los archivos](#dónde-quedan-los-archivos)
- [Estructura del proyecto (qué hace cada parte)](#estructura-del-proyecto-qué-hace-cada-parte)
- [El PlanJSON (esquema)](#el-planjson-esquema)
- [API HTTP (route handlers)](#api-http-route-handlers)
- [Funcionalidades clave](#funcionalidades-clave)
- [Variables de entorno](#variables-de-entorno)
- [Solución de problemas](#solución-de-problemas)

---

## Requisitos

- **Node.js 18.18+** (recomendado 20 o 22).
- **Google Cloud SDK (`gcloud`)** solo si vas a usar Vertex AI real.
- **ffmpeg** (opcional) para unir clips en `final.mp4` y para extender/concatenar videos. Si no
  está instalado, esos pasos se saltean o degradan con gracia.

---

## Puesta en marcha

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env.local
# (por defecto PROVIDER_MODE=mock, no necesitás credenciales)

# 3. Levantar en desarrollo
npm run dev
# abrir http://localhost:3000
```

Scripts disponibles (en `package.json`):

| Script              | Qué hace                                  |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Servidor de desarrollo (Next.js)          |
| `npm run build`     | Build de producción                       |
| `npm run start`     | Sirve el build de producción              |
| `npm run lint`      | ESLint                                    |
| `npm run typecheck` | Chequeo de tipos con `tsc --noEmit`       |

---

## Modo mock vs Vertex AI real

La app tiene dos modos, controlados por `PROVIDER_MODE`:

- **`mock`** (default): genera imágenes PNG reales (gradientes) y clips MP4 placeholder **sin
  credenciales ni cuota**. Sirve para probar TODO el pipeline (interpretación, aprobaciones,
  storyboard, extensión, stitch) sin gastar nada.
- **`vertex`**: hace llamadas reales a Vertex AI (Gemini, Nano Banana, Veo).

---

## Autenticación (ADC, sin API keys)

La app **no usa API keys**. Se autentica con **Application Default Credentials (ADC)**:

```bash
# 1. Loguear ADC (una sola vez por máquina)
gcloud auth application-default login

# 2. En .env.local
PROVIDER_MODE=vertex
GOOGLE_CLOUD_PROJECT=tu-project-id
GOOGLE_CLOUD_LOCATION=us-central1
```

Antes de generar, asegurate de:

```bash
gcloud config set project tu-project-id
gcloud services enable aiplatform.googleapis.com   # habilita Vertex AI
```

Y de tener **facturación habilitada** en el proyecto (Nano Banana y Veo son de pago).

Toda llamada a los modelos sale del **backend** (route handlers), nunca del cliente. La identidad
nunca se expone al navegador.

---

## Modelos disponibles

Los modelos están centralizados en `src/lib/config.ts` (`MODEL_CATALOG`) y son seleccionables
desde la UI **por proyecto**, además de configurables por env. Catálogo actual:

| Tipo       | Opciones                                                                                  | Default                  |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| **Chat**   | `gemini-3.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`         | `gemini-2.5-flash`       |
| **Imagen** | `gemini-2.5-flash-image` (Nano Banana — hace text2image **e** image2image)                | `gemini-2.5-flash-image` |
| **Video**  | `veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, + variantes `lite` (para "probar")   | `veo-3.1-generate-001`   |

> El mismo modelo de imagen (Nano Banana) genera la imagen base y las derivadas manteniendo la
> identidad de la cara. Las variantes `lite` de Veo pueden no estar habilitadas en tu proyecto; si
> dan 404, usá `veo-3.1-generate-001` o `veo-3.1-fast-generate-001`.

---

## Flujo de uso en la app

1. **Pantalla inicial (`/`)** — Elegís modelos (Chat/Imagen/Video), cantidad de variantes por
   imagen y resolución de video por defecto. Tenés dos formas de armar el plan:
   - **Interpretar brief con IA**: pegás el brief y la IA arma el PlanJSON.
   - **Pegar PlanJSON**: pegás un JSON ya armado (con el botón "Copiar prompt para tu IA" obtenés
     un prompt listo para ChatGPT/Gemini que devuelve exactamente el formato esperado).
2. Revisás/editás el PlanJSON (validación en vivo) y apretás **Generar todo**.
3. **Pipeline (`/project/[id]/pipeline`)** — Ves el progreso en vivo en dos vistas:
   - **Storyboard**: imágenes base → derivadas → clips en orden (filmstrip).
   - **Flujo agéntico**: grafo por etapas con estado de cada nodo.
   - Cada imagen/video pide **aprobación**. Por tarjeta podés: **Aprobar**, **Regenerar**,
     **Cambiar prompt** (editás prompt, diálogo, duración 4/6/8, resolución y modelo) y, en videos,
     **Extender +7s**.
   - Abajo: **mini-log** en vivo y controles **Pausar / Reanudar / Cancelar**.
4. **Resultado (`/project/[id]/result`)** — Timeline ordenada, subida manual de clips
   `FILMAR_REAL`, botón para unir todo en `final.mp4`, y la ruta local de la carpeta de salida.

---

## Dónde quedan los archivos

```
output/
└── <project_id>/
    ├── images/
    │   ├── _candidates/         # variantes generadas antes de aprobar (avatar1_base__v1.png, ...)
    │   ├── avatar1_base.png     # imagen aprobada (canónica)
    │   └── ...
    ├── clips/
    │   ├── 01_hook.mp4
    │   ├── 02_reveal.mp4
    │   └── ...
    ├── final.mp4                # opcional, si corrés el stitch con ffmpeg
    ├── manifest.json            # plan completo + estado + rutas de cada archivo
    └── pipeline.log             # log de eventos del pipeline
```

El estado de proyectos y jobs se guarda en `./data/db.json`. La UI previsualiza las imágenes y
videos sirviéndolos desde esos archivos locales vía `/api/files/...`.

---

## Estructura del proyecto (qué hace cada parte)

```
src/
├── app/                         # Next.js App Router (UI + API)
│   ├── layout.tsx               # Layout raíz (header, estilos globales)
│   ├── globals.css              # Estilos Tailwind + utilidades
│   ├── page.tsx                 # Pantalla "Nuevo proyecto" (brief, modelos, plan editable)
│   ├── project/[id]/
│   │   ├── pipeline/page.tsx    # Pantalla "Pipeline": estado en vivo, aprobación, storyboard/flujo
│   │   └── result/page.tsx      # Pantalla "Resultado": timeline, upload manual, stitch, carpeta
│   └── api/                     # Route handlers (backend, corren en Node)
│       ├── config/route.ts          # GET config no sensible (modelos, resoluciones, ffmpeg, etc.)
│       ├── parse/route.ts           # POST brief → PlanJSON (Gemini) + estimación de costo
│       ├── files/[...path]/route.ts # GET sirve archivos locales (imágenes/clips) con soporte Range
│       ├── projects/route.ts        # GET lista / POST crea proyecto
│       ├── projects/[id]/route.ts        # GET / PUT (plan, modelos, variantes, resolución) / DELETE
│       ├── projects/[id]/generate/route.ts # POST arma jobs y arranca el pipeline
│       ├── projects/[id]/jobs/route.ts     # GET estado en vivo de jobs + manifest + logs
│       ├── projects/[id]/control/route.ts  # POST pause | resume | cancel
│       ├── projects/[id]/upload/route.ts   # POST sube archivo de un clip FILMAR_REAL
│       ├── projects/[id]/stitch/route.ts   # POST une clips en final.mp4 (ffmpeg)
│       └── jobs/[id]/
│           ├── retry/route.ts    # POST regenera un job (imagen/video)
│           ├── approve/route.ts  # POST aprueba un job (elige variante en imágenes)
│           ├── prompt/route.ts   # POST cambia prompt/diálogo/duración/resolución/modelo y regenera
│           └── extend/route.ts   # POST extiende un video +7s (background)
│
├── components/                  # Componentes de UI (React, client)
│   ├── ModelSelectorBar.tsx     # Barra superior: selectores Chat/Imagen/Video + variantes + resolución
│   ├── JobCard.tsx              # Tarjeta de job: preview, aprobar/regenerar, modal de edición, extender
│   ├── FlowGraph.tsx           # Vista "flujo agéntico": grafo por etapas con estado de cada nodo
│   ├── LogPanel.tsx            # Mini-log en vivo (info/éxito/aviso/error con timestamp)
│   ├── JsonEditor.tsx          # Editor del PlanJSON con validación Zod en vivo
│   ├── CostEstimatePanel.tsx   # Panel de estimación (cantidad de imágenes/videos/segundos/costo)
│   ├── ProjectTabs.tsx         # Tabs Pipeline / Resultado
│   └── StatusBadge.tsx         # Badge de estado (pendiente, generando, aprobar, listo, etc.)
│
├── store/
│   └── useProjectStore.ts       # Estado global del cliente (Zustand): config, plan, jobs, logs,
│                                # y todas las acciones que llaman a la API
│
└── lib/                         # Lógica de dominio (backend)
    ├── config.ts                # Config central: modelos, resoluciones, duraciones, env, helpers
    ├── schema.ts                # Esquemas Zod del PlanJSON + validación cruzada (refs, orden, etc.)
    ├── types.ts                 # Tipos de dominio (JobRecord, ProjectRecord, Manifest, LogEntry...)
    ├── prompts.ts               # System prompt del parser + responseSchema + builder de prompt de Veo
    │                            #   (estilo UGC/selfie + acento rioplatense argentino)
    ├── db.ts                    # "Base de datos" local en JSON (proyectos, jobs, logs)
    ├── storage.ts               # Filesystem: rutas, guardar/leer bytes, manifest, slugify, anti-traversal
    ├── ffmpeg.ts                # Stitch opcional: une clips en final.mp4 conservando audio y calidad
    ├── http.ts                  # Helpers de respuesta (ok / badRequest / notFound / serverError)
    ├── sampleBrief.ts           # Brief de ejemplo para el botón "Cargar ejemplo"
    ├── jobs/
    │   ├── pipeline.ts          # Construye jobs, ejecuta generación, aprobación, cambio de campos,
    │   │                        #   extensión de video y concatenación; logging; estimación de costo
    │   └── queue.ts             # Cola en memoria: concurrencia, dependencias, reintentos+backoff,
    │                            #   pausa/reanuda/cancela, estados del proyecto
    └── providers/               # Proveedores de IA detrás de interfaces intercambiables
        ├── types.ts             # Interfaces LlmProvider / ImageProvider / VideoProvider
        ├── index.ts             # Factory: elige mock o vertex según PROVIDER_MODE
        ├── mock.ts              # Implementación mock (placeholders, sin credenciales)
        ├── placeholder.ts       # Genera PNG/MP4 placeholder + detección de ffmpeg + dimensiones
        └── vertex/
            ├── auth.ts          # Token ADC vía google-auth-library (sin API keys)
            ├── llm.ts           # Gemini: parseBrief → PlanJSON (JSON estructurado con responseSchema)
            ├── image.ts         # Nano Banana: text2image e image2image (consistencia de cara)
            └── video.ts         # Veo: imagen→video y extend (LRO con polling), descarga de GCS
```

### Cómo se conectan las piezas (flujo de datos)

```
Brief → /api/parse → (LlmProvider.parseBrief) → PlanJSON (validado con Zod)
                                                     │
Crear proyecto → /api/projects (POST) → db.json + carpeta output/ + manifest.json
                                                     │
Generar → /api/projects/:id/generate → buildJobs() → cola (queue.ts)
                                                     │
            ┌────────────────────────────────────────┴───────────────────────────┐
            ▼                                                                      ▼
   ImageProvider.generate (Nano Banana)                         VideoProvider.generate (Veo)
   guarda en images/_candidates/                                guarda en clips/NN_<clip>.mp4
            │                                                                      │
            └──────► estado awaiting_approval ──► usuario Aprueba/Regenera/Edita ──┘
                                                     │
                          (al aprobar imagen) se desbloquea el siguiente paso de la cadena
                                                     │
                              Resultado → stitch opcional (ffmpeg) → final.mp4
```

---

## El PlanJSON (esquema)

Definido y validado en `src/lib/schema.ts` (Zod). Forma resumida:

```jsonc
{
  "global": {
    "idioma_dialogo": "es-AR",     // registro "vos" (rioplatense)
    "formato": "9:16",             // vertical (fijo por ahora)
    "reglas_realismo": "…",        // estilo/realismo aplicado a todo
    "negative_prompt": "…"         // negative prompt global (en inglés)
  },
  "assets": [
    {
      "id": "avatar1",
      "tipo": "avatar",            // "avatar" | "broll"
      "images": [
        {
          "id": "avatar1_base",
          "modo": "text2image",    // la PRIMERA imagen del avatar es text2image
          "prompt": "…(en inglés)…",
          "negative_prompt": "…"
        },
        {
          "id": "avatar1_desinflada",
          "modo": "image2image",   // estados posteriores: image2image
          "ref_image_id": "avatar1_base",   // referencia a una imagen previa
          "prompt": "…keep identity 100% consistent with the reference…"
        }
      ]
    }
  ],
  "clips": [
    {
      "id": "hook",
      "orden": 1,
      "asset_id": "avatar1",
      "image_id": "avatar1_base",  // frame inicial del video
      "video_prompt": "…(en inglés, cámara/acción)…",
      "dialogo": "…(es-AR, lo que dice la persona)…",
      "duracion_seg": 8,           // 4, 6 u 8
      "etiqueta": "IA",            // "IA" | "FILMAR_REAL"
      "on_screen_text": "…",       // opcional
      "resolucion": "720p"         // opcional: 720p | 1080p (override del default)
    }
  ],
  "warnings": ["…supuestos del parser…"]
}
```

Reglas de consistencia que valida el esquema: la primera imagen de cada avatar es `text2image`;
las `image2image` deben referenciar una imagen existente; cada clip referencia `asset_id` e
`image_id` válidos; el `orden` no se repite. Si falta info, el parser rellena defaults y lo anota
en `warnings`.

---

## API HTTP (route handlers)

| Método y ruta                          | Qué hace                                                     |
| -------------------------------------- | ------------------------------------------------------------ |
| `GET /api/config`                      | Config no sensible para la UI (modelos, resoluciones, ffmpeg)|
| `POST /api/parse`                      | Brief → PlanJSON (Gemini) + estimación                       |
| `GET /api/projects`                    | Lista de proyectos                                           |
| `POST /api/projects`                   | Crea proyecto (nombre, brief, plan, modelos, variantes, res.)|
| `GET /api/projects/:id`                | Proyecto + jobs + manifest + estimación                      |
| `PUT /api/projects/:id`                | Actualiza plan / nombre / modelos / variantes / resolución   |
| `DELETE /api/projects/:id`             | Elimina proyecto y sus jobs                                  |
| `POST /api/projects/:id/generate`      | Construye jobs y arranca el pipeline                         |
| `GET /api/projects/:id/jobs`           | Estado en vivo de jobs + manifest + logs (para polling)      |
| `POST /api/projects/:id/control`       | `pause` / `resume` / `cancel`                                |
| `POST /api/projects/:id/upload`        | Sube el archivo de un clip `FILMAR_REAL`                     |
| `POST /api/projects/:id/stitch`        | Une los clips en `final.mp4` (ffmpeg)                        |
| `POST /api/jobs/:id/retry`             | Regenera un job (imagen/video)                               |
| `POST /api/jobs/:id/approve`           | Aprueba un job (con índice de variante en imágenes)          |
| `POST /api/jobs/:id/prompt`            | Cambia prompt/diálogo/duración/resolución/modelo y regenera  |
| `POST /api/jobs/:id/extend`            | Extiende un video +7s (corre en background)                  |
| `GET /api/files/<projectId>/<path>`    | Sirve un archivo local de la carpeta del proyecto            |

---

## Funcionalidades clave

- **Selección de modelo por proyecto** (Chat / Imagen / Video) desde la barra superior, y override
  de modelo por ítem al regenerar.
- **Variantes por imagen (1–4)**: se generan N candidatas y elegís la mejor antes de aprobar.
- **Aprobación de cada ítem**: nada avanza hasta que aprobás; lo aprobado queda **lockeado** (no se
  pisa al reintentar/reanudar).
- **Edición campo por campo al regenerar**: prompt visual, diálogo, **duración (4/6/8)**, resolución
  y modelo, en un modal grande que muestra el prompt completo.
- **Extender video +7s**: toma un clip ya generado y le agrega 7s de continuación coherente, y los
  concatena (ffmpeg, con audio y alta calidad).
- **Acento rioplatense argentino** forzado en los diálogos de Veo (estilo UGC/selfie), vía
  `buildVeoVideoPrompt` en `src/lib/prompts.ts`.
- **Pausar / Reanudar / Cancelar** el pipeline; reintentos con **backoff exponencial**.
- **Mini-log en vivo** + `pipeline.log` en disco.
- **Stitch opcional** que conserva audio y **no pierde calidad** (usa la resolución real 720p/1080p,
  escalado lanczos y CRF 18; agrega silencio a los clips mudos para que la unión no falle).
- **Almacenamiento 100% local** (filesystem + JSON), sin servicios externos.

---

## Variables de entorno

Ver `.env.example`. Las principales:

| Variable                | Default                  | Descripción                                       |
| ----------------------- | ------------------------ | ------------------------------------------------- |
| `PROVIDER_MODE`         | `mock`                   | `mock` o `vertex`                                 |
| `GOOGLE_CLOUD_PROJECT`  | —                        | Project ID (solo `vertex`)                        |
| `GOOGLE_CLOUD_LOCATION` | `us-central1`            | Región de Vertex AI                               |
| `LLM_MODEL`             | `gemini-2.5-flash`       | Modelo de chat por defecto                        |
| `IMAGE_MODEL`           | `gemini-2.5-flash-image` | Modelo de imagen por defecto (Nano Banana)        |
| `VIDEO_MODEL`           | `veo-3.1-generate-001`   | Modelo de video por defecto (Veo)                 |
| `IMAGE_VARIANTS`        | `1`                      | Variantes por imagen (1–4)                        |
| `VIDEO_RESOLUTION`      | `720p`                   | Resolución de video por defecto                   |
| `OUTPUT_DIR`            | `./output`               | Carpeta de salidas                                |
| `DATA_DIR`              | `./data`                 | Estado (db.json)                                  |
| `PIPELINE_CONCURRENCY`  | `2`                      | Jobs en paralelo                                  |
| `PIPELINE_MAX_ATTEMPTS` | `3`                      | Reintentos por job                                |
| `VEO_POLL_INTERVAL_MS`  | `10000`                  | Intervalo de polling del LRO de Veo               |
| `VEO_POLL_TIMEOUT_MS`   | `600000`                 | Timeout del LRO de Veo                            |

---

## Solución de problemas

- **404 "Publisher Model ... was not found"**: el modelo elegido no está habilitado en tu proyecto.
  Elegí uno del catálogo disponible (p. ej. `gemini-2.5-flash`, `veo-3.1-generate-001`) o pisalo por
  env. Los `veo-3.1-lite-*` están marcados "(probar)" porque pueden no estar disponibles.
- **Falla la autenticación**: corré `gcloud auth application-default login` y verificá
  `GOOGLE_CLOUD_PROJECT`. Para probar sin credenciales usá `PROVIDER_MODE=mock`.
- **El `final.mp4` no se genera / sin audio / baja calidad**: necesitás **ffmpeg** instalado. El
  stitch ya conserva audio y usa la resolución real; sin ffmpeg, ese paso se saltea.
- **Un job queda en `failed`**: abrí el **mini-log** en la pantalla Pipeline; muestra el error
  exacto de la API. Podés **Regenerar** o **Cambiar prompt** ese ítem sin rehacer el resto.
- **Extender video falla**: el shape del campo de video base para Veo está marcado con
  `// TODO: confirmar` en `src/lib/providers/vertex/video.ts`; si la API lo espera distinto, el
  mini-log lo indica y se ajusta ahí.

---

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind CSS · Zustand (estado) · Zod (validación) ·
google-auth-library (ADC) · ffmpeg (opcional). Almacenamiento local en filesystem + JSON.
