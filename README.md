# AUGC / VSL Pipeline

Aplicación web **local** para producir anuncios **UGC** y **VSLs largos** (Video Sales Letters
tipo *talking-head*) de punta a punta. Pegás un brief o un PlanJSON, opcionalmente subís las
fotos de los avatares, y la app genera **imágenes + videos** manteniendo la **misma cara** en
cada plano, con auto-aprobación y manejo robusto de cuota/red para dejarlo corriendo solo.

> Pensada para correr **localmente en tu PC**. No usa Supabase ni storage externo: el estado
> vive en `./data/db.json` y los archivos generados en `./output/`.

---

## Estado del proyecto (al día de hoy)

Lo que YA está mergeado en `main` (PRs #1–#16):

| Área | Qué hay | PR |
|---|---|---|
| Núcleo | selectores de modelo, aprobación por ítem, variantes de imagen, prompt copiable, mini-log, pausa/reanuda/cancela, storyboard + flujo agéntico | #1 |
| Modelos | catálogo verificado de Gemini/Nano Banana/Veo, selector de **resolución por video** | #2 |
| Voz/estilo | builder de prompt **UGC/selfie + acento rioplatense argentino** forzado en Veo | #3 |
| Edición | precarga del prompt actual + selector de modelo por ítem | #4 |
| Stitch | `final.mp4` **conserva audio y NO pierde calidad** (720p/1080p reales, CRF 18) + modal grande para editar prompt | #5 |
| Edición pro | editar campo por campo (prompt/diálogo/duración 4-6-8/resolución/modelo) + **Extender +7s** | #6 |
| Docs | README completo | #7 |
| Edición | botón "Editar" con **Guardar sin regenerar** y **Guardar y regenerar** | #8 |
| **VSL** | **avatares de referencia subidos** como fuente de identidad (image2image contra tu foto) | **#9** |
| **VSL** | PlanJSON completo del VSL "Agua de Arroz TURBO" + generador validado contra Zod + generación por lotes anti rate-limit + UI panel de avatares en ambos modos + Romina como `text2image` | **#10** |
| Resiliencia | manejo robusto de **429 / rate limit** y **errores de red** ("fetch failed", timeouts), variantes con **éxito parcial** | #11 |
| Pipeline | **auto-aprobación** (sin tener que aprobar nada) + **ventana de 3** rolling + reintento 429 a 45s | #12 |
| Fix | jobs colgados en "generando" se **autodestraban**, cache-busting para que el video se actualice tras regenerar | #13 |
| **Revisión** | nueva vista **🔧 Revisar / Arreglar** (liviana, no lagea) + **regenerar por lote** + fix definitivo del video stale al regenerar | **#14** |
| Revisión | "🔍 Revisar seleccionados" → storyboard con **prompt exacto + imagen input + JSON** | #15 |
| Revisión | **prompts editables** en revisión (Guardar / Guardar y regenerar) — los cambios quedan en el plan, así el export a ffmpeg los usa | #16 |

Todo verificado con `typecheck` y `build` (los testeás vos al usar la app).

---

## Quickstart

```bash
# 1. Instalar
npm install

# 2. Config
cp .env.example .env.local
# Por defecto PROVIDER_MODE=mock (placeholders, sin credenciales).
# Para usar Vertex AI real:
#   PROVIDER_MODE=vertex
#   GOOGLE_CLOUD_PROJECT=tu-project-id
#   GOOGLE_CLOUD_LOCATION=us-central1
#   gcloud auth application-default login

# 3. Levantar
npm run dev   # http://localhost:3000
```

Scripts (`package.json`):

| Script              | Qué hace                              |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Servidor Next.js en :3000             |
| `npm run build`     | Build de producción                   |
| `npm run start`     | Sirve el build de producción          |
| `npm run lint`      | ESLint                                |
| `npm run typecheck` | `tsc --noEmit`                        |

---

## Cómo se usa para un VSL largo (caso real "Agua de Arroz TURBO")

El ejemplo real ya viene en el repo (95 clips: 91 Natalia + 4 testimonio Romina).

### 1. Pegar el PlanJSON (recomendado para >20 clips)

Existe `vsl-natalia-plan.json` ya validado y `scripts/generate-vsl-plan.ts` para regenerarlo.

```bash
# (opcional) regenerar el plan validándolo contra el schema
npx tsx scripts/generate-vsl-plan.ts
# OK: plan valido. 95 clips, 24 imagenes, 1 avatares de referencia.
```

En la UI:
1. **Nuevo proyecto** → modo **"Pegar PlanJSON"** y pegás el contenido de `vsl-natalia-plan.json`.
2. En **"Avatares de referencia (VSL)"** subís **la foto real de Natalia** (la única
   referencia: Romina se genera de cero con `text2image`).
3. **Importante**: editá el `id` de la foto a **`natalia`** para que coincida con el plan.
   Vas a ver un indicador verde ✓ cuando el id matchee.
4. **Generar todo**.

### 2. Interpretar brief con IA (para briefs cortos / pruebas)

1. **Nuevo proyecto** → modo **"Interpretar brief con IA"**.
2. Subís 1+ fotos en **"Avatares de referencia (VSL)"** y a cada una le ponés un id (ej `natalia`).
3. Pegás el brief mencionando a cada persona por nombre.
4. **Interpretar con IA** → la IA arma el plan: cada persona es un `avatar` cuya **imagen base
   es `image2image` contra tu foto** y todos los planos siguientes mantienen identidad
   (`keep identity 100% consistent...`).
5. Revisás el PlanJSON → **Generar todo**.

> Para el VSL de 95 clips conviene pegar el JSON: la IA puede recortar cosas por límite de tokens.

### 3. Dejarlo generar toda la noche

Con la config default ya está optimizado para VSLs largos:

- **Auto-aprobación**: cada imagen/video se aprueba sola al terminar y desbloquea lo que depende.
  Ya no hay que ir aprobando uno por uno.
- **Ventana rolling de 3** (`PIPELINE_CONCURRENCY=3`): genera 3 a la vez; cuando uno termina,
  arranca el siguiente, sin esperar a aprobar el anterior.
- **429 / cuota**: backoff 45s y hasta 10 reintentos aparte (no quema los reintentos normales).
- **Errores de red** (`fetch failed`, timeouts): backoff exponencial + timeout 120s por request.
- **Auto-recuperación**: si un job queda colgado en "generando" (p.ej. reiniciaste el server),
  la cola lo resetea sola al volver a moverse.

A la mañana tenés todo listo (los que fallaron de forma persistente quedan marcados para regenerar).

### 4. Revisar y arreglar los que salieron mal

Con muchos clips la pipeline arranca directo en **🔧 Revisar / Arreglar** (no monta los 95
`<video>` → no lagea):

1. Pegás los números de los clips malos (ej `12, 45, 78`) → **Marcar**, o tildás a mano /
   **Marcar fallidos**.
2. **🔍 Revisar / editar seleccionados** → abre un **storyboard SOLO con esos** mostrando:
   - **Imagen de entrada** (frame inicial / referencias).
   - **Prompt visual editable** (textarea).
   - **Diálogo editable** (es-AR).
   - **Selector de duración** (4/6/8s).
   - **Prompt FINAL** que se ejecuta (recalculado al guardar) en un `<details>`.
   - **JSON entero** del clip / imagen en un `<details>`.
   - **Resultado actual** on-demand (▶ Ver).
3. Para cada uno:
   - **💾 Guardar** → persiste cambios en el plan **sin regenerar** (útil para ajustar texto/tiempo
     a mano y que se reflejen en el export a ffmpeg).
   - **↻ Guardar y regenerar** → guarda **y** regenera con lo editado.
   - **↻ Regenerar todos sin editar** → re-corre el lote tal cual quedó.
4. Cuando estás listo, **Resultado** → unir clips → `final.mp4` con ffmpeg (usa los valores
   actualizados del plan).

> El plan es la fuente de verdad del export, así que cualquier edición que hagas ahí impacta
> al `final.mp4`.

---

## Modos del proveedor

Controlado por `PROVIDER_MODE`:

- **`mock`** (default): genera PNG (gradientes) y MP4 placeholder **sin credenciales ni cuota**.
  Sirve para probar todo el pipeline (interpretación, aprobaciones, storyboard, revisión,
  extensión, stitch) sin gastar nada. Si subís fotos de referencia, el mock LLM genera un demo
  VSL con esos avatares.
- **`vertex`**: hace llamadas reales a Vertex AI (Gemini, Nano Banana, Veo).

### Autenticación (ADC, sin API keys)

```bash
# 1. ADC (una sola vez por máquina)
gcloud auth application-default login

# 2. .env.local
PROVIDER_MODE=vertex
GOOGLE_CLOUD_PROJECT=tu-project-id
GOOGLE_CLOUD_LOCATION=us-central1

# 3. habilitar Vertex AI
gcloud config set project tu-project-id
gcloud services enable aiplatform.googleapis.com
```

Necesitás **facturación habilitada** (Nano Banana y Veo son de pago). Toda llamada a los
modelos sale del **backend** (route handlers); la identidad nunca se expone al navegador.

---

## Catálogo de modelos

Centralizado en `src/lib/config.ts` (`MODEL_CATALOG`). Seleccionable en la UI por proyecto.

| Tipo | Opciones | Default |
|---|---|---|
| **Chat** | `gemini-3.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite` | `gemini-2.5-flash` |
| **Imagen** | `gemini-2.5-flash-image` (Nano Banana — **recomendado, +cuota, +barato**), `gemini-3.1-flash-image-preview` (Nano Banana 2 · probar), `gemini-3-pro-image-preview` (Nano Banana Pro 4K · **−cuota, +caro**) | `gemini-2.5-flash-image` |
| **Video** | `veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, `veo-3.1-lite-generate-001` (probar), `veo-3.1-lite-generate-001-preview` (probar) | `veo-3.1-generate-001` |

> ⚠️ Si te tira mucho 429: **NO te pases a Pro** (tiene menos cuota, lo empeora). Bajá
> `PIPELINE_CONCURRENCY` y `IMAGE_VARIANTS`, o subí el tier de cuota en Google Cloud.

---

## Funcionalidades clave

### VSL / avatares de referencia (#9, #10)
- `ProjectPlan.references[]` — fotos subidas que actúan como **fuente de identidad** de cada
  persona. `Image.ref_image_ids[]` permite combinar **2+ personas** en un mismo plano.
- Panel **"Avatares de referencia (VSL)"** en la home (en ambos modos: IA y Pegar PlanJSON).
- `id` de cada foto editable + indicador ✓ / • cuando el plan ya cargado pide ese id.
- El provider Nano Banana inyecta múltiples `inlineData` con instrucción de identidad para 1
  o N personas (`buildImageInstruction` en `src/lib/prompts.ts`).
- En el pipeline, si la referencia es una foto subida (no una imagen aprobada del proyecto),
  no hay dependencia → arranca al toque.

### Auto-aprobación + ventana rolling (#12)
- `PIPELINE_AUTO_APPROVE=true` (default): cada imagen/video se aprueba sola al terminar.
- `PIPELINE_CONCURRENCY=3`: 3 jobs en paralelo; cuando uno termina, arranca el siguiente.
- Para volver al modo manual: `PIPELINE_AUTO_APPROVE=false` (vuelve el botón "Aprobar lote").

### Resiliencia (#11, #13)
- **429 / rate limit**: backoff dedicado (respeta `Retry-After`, default 45s) con su propio
  budget de reintentos (default 10) — no quema los `maxAttempts` normales.
- **Errores de red** (`fetch failed`, `ECONNRESET`, timeouts): tratados como transitorios,
  backoff exponencial hasta 30s, también con budget aparte.
- **Timeout por request de imagen** (default 120s): si la conexión se cuelga, aborta y reintenta
  en vez de bloquear un slot.
- **Variantes con éxito parcial**: cada variante es 1 request individual; persiste cada éxito
  al toque. Si la 2ª falla, no perdés la 1ª (y el "resume" solo regenera las que faltan).
- **Auto-recuperación**: jobs colgados en "generating" pero que no están realmente corriendo
  (típico tras reiniciar el server) se resetean solos a `pending` cuando la cola se mueve.
- **Cache-busting**: las URLs llevan `?v=<updatedAt>` + `key={url}` en `<img>`/`<video>` para
  que al regenerar veas el nuevo (no el cacheado).
- Al regenerar, **se limpia `outputPath` también para videos** (antes el viejo quedaba pegado
  encima del que se generaba).

### Vista "Revisar / Arreglar" (#14, #15, #16)
- **Lista compacta** de clips (no monta `<video>`s → no lagea con 95 clips).
- Filtros: pegá números (`12, 45, 78`) → **Marcar**; **Marcar fallidos**; **Limpiar**.
- **Video on-demand** (botón "Ver" carga solo ese; `preload="none"`).
- **🔍 Revisar / editar seleccionados** abre el storyboard focalizado con:
  - imagen de entrada,
  - **prompt visual editable**,
  - **diálogo editable** (videos),
  - **selector de duración** 4/6/8s (videos),
  - **prompt FINAL ejecutado** (read-only, recalculable),
  - **JSON del clip/imagen**.
- Botones por tarjeta: **💾 Guardar** (al plan, sin regenerar) y **↻ Guardar y regenerar**.
- Botón global: **↻ Regenerar todos sin editar**.
- Si el proyecto tiene >24 clips, la pipeline **arranca directo en esta vista**.

### Edición campo por campo (#4, #6, #8)
- En cualquier tarjeta del storyboard: **prompt visual**, **diálogo**, **duración (4/6/8)**,
  **resolución (720p/1080p)** y **modelo**.
- "Guardar sin regenerar" / "Guardar y regenerar".

### Extender video +7s (#6)
- Toma un clip ya generado y le agrega 7s de continuación coherente; los concatena con ffmpeg
  (audio + alta calidad). Si no hay ffmpeg, queda solo la continuación.

### Stitch sin perder calidad (#5)
- `final.mp4` conserva **audio** (silencio sintético en clips mudos) y mantiene la **resolución
  real más alta** entre los clips (720×1280 / 1080×1920), escalado lanczos + CRF 18 + faststart.

### Voz / acento (#3)
- `buildVeoVideoPrompt` arma un prompt UGC/selfie y un bloque de **voz rioplatense argentina**
  forzado (voseo, "sh" para "ll"/"y", cadencia porteña). Los diálogos no se traducen.

### Modelos seleccionables (#1, #2, #11)
- Selectores Chat/Imagen/Video por proyecto + override por ítem.
- Selector de **resolución de video** por defecto y por clip.

---

## Dónde quedan los archivos

```
output/<project_id>/
├── images/
│   ├── _candidates/           # variantes generadas antes de aprobar (avatar1_base__v1.png, ...)
│   ├── avatar1_base.png       # imagen aprobada (canónica)
│   └── ...
├── references/                # fotos de avatares subidas (VSL): natalia.png, romina.png, ...
├── clips/
│   ├── 01_hook.mp4
│   ├── 02_reveal.mp4
│   └── ...
├── final.mp4                  # opcional, si corrés el stitch con ffmpeg
├── manifest.json              # plan + estado + rutas + references[]
└── pipeline.log               # log de eventos
```

Estado de proyectos/jobs en `./data/db.json`. La UI sirve los archivos vía
`/api/files/<projectId>/<path>` (con soporte HTTP Range).

---

## El PlanJSON

Definido en `src/lib/schema.ts` (Zod, validación cruzada). Forma resumida:

```jsonc
{
  "global": {
    "idioma_dialogo": "es-AR",
    "formato": "9:16",
    "reglas_realismo": "…",
    "negative_prompt": "…"
  },
  // VSL: fotos subidas que son fuente de identidad (opcional)
  "references": [
    { "id": "natalia", "label": "Lic. Natalia Reyes" }
  ],
  "assets": [
    {
      "id": "natalia",
      "tipo": "avatar",          // "avatar" | "broll"
      "images": [
        {
          "id": "natalia_medium",
          "modo": "image2image", // primera imagen puede ser image2image SI usa una reference subida
          "ref_image_id": "natalia",       // id de imagen previa O id de una reference
          "ref_image_ids": ["..."],        // OPCIONAL: combinar 2+ personas en un plano
          "prompt": "…(en inglés)…",
          "negative_prompt": "…"
        }
      ]
    }
  ],
  "clips": [
    {
      "id": "c1",
      "orden": 1,
      "asset_id": "natalia",
      "image_id": "natalia_medium",
      "video_prompt": "…(en inglés)…",
      "dialogo": "…(es-AR, no se traduce)…",
      "duracion_seg": 8,           // 4 | 6 | 8
      "etiqueta": "IA",            // "IA" | "FILMAR_REAL"
      "on_screen_text": "…",
      "resolucion": "720p"         // opcional: 720p | 1080p
    }
  ],
  "warnings": ["…"]
}
```

Reglas que valida el schema:
- Una imagen `image2image` debe tener `ref_image_id` (o `ref_image_ids`) que **exista** (como
  imagen del proyecto **o** como `reference` subida) y no se referencie a sí misma.
- La **primera imagen de un avatar** debe ser `text2image` **o** `image2image` cuyas referencias
  sean **todas** `references` subidas (caso VSL).
- Cada clip apunta a `asset_id` e `image_id` válidos; `orden` no se repite.
- `formato` siempre `9:16`; `duracion_seg` solo 4/6/8 (snap automático en backend).

---

## API HTTP

| Método y ruta | Qué hace |
|---|---|
| `GET /api/config` | Config no sensible (modelos, resoluciones, ffmpeg, etc.) |
| `POST /api/parse` | Brief → PlanJSON (Gemini) + estimación. Acepta `references[]` |
| `GET /api/projects` | Lista proyectos |
| `POST /api/projects` | Crea proyecto |
| `GET /api/projects/:id` | Proyecto + jobs + manifest + estimación |
| `PUT /api/projects/:id` | Actualiza plan / nombre / modelos / variantes / resolución |
| `DELETE /api/projects/:id` | Elimina proyecto y sus jobs |
| `POST /api/projects/:id/generate` | Construye jobs y arranca pipeline |
| `GET /api/projects/:id/jobs` | Estado en vivo (polling) |
| `POST /api/projects/:id/control` | `pause` / `resume` / `cancel` |
| `POST /api/projects/:id/upload` | Sube archivo de un clip `FILMAR_REAL` |
| `GET/POST /api/projects/:id/references` | Lista / sube **avatares de referencia (VSL)** |
| `POST /api/projects/:id/approve-batch` | Aprueba todo el lote actual (modo manual) |
| `POST /api/projects/:id/regenerate-batch` | Regenera **solo los jobs indicados** (`{jobIds}`/`{refIds}`) |
| `POST /api/projects/:id/stitch` | Une clips en `final.mp4` (ffmpeg) |
| `POST /api/jobs/:id/retry` | Regenera un job |
| `POST /api/jobs/:id/approve` | Aprueba un job (índice de variante en imágenes) |
| `POST /api/jobs/:id/prompt` | Cambia prompt/diálogo/duración/resolución/modelo (`regenerate?`) |
| `POST /api/jobs/:id/extend` | Extiende un video +7s |
| `GET /api/jobs/:id/preview` | **Prompt EXACTO** que se ejecuta + imagen input + JSON entero |
| `GET /api/files/<projectId>/<path>` | Sirve archivo local del proyecto |

---

## Estructura del proyecto

```
src/
├── app/
│   ├── layout.tsx                     # Layout raíz
│   ├── globals.css                    # Tailwind + utilidades
│   ├── page.tsx                       # "Nuevo proyecto" (brief / pegar JSON, modelos, plan,
│   │                                  #  + panel "Avatares de referencia (VSL)")
│   ├── project/[id]/
│   │   ├── pipeline/page.tsx          # Pipeline: storyboard / fix / flow + revisar+editar
│   │   └── result/page.tsx            # Resultado: timeline, upload manual, stitch
│   └── api/                           # Route handlers (ver tabla arriba)
│
├── components/
│   ├── ModelSelectorBar.tsx           # Barra superior: modelos + variantes + resolución
│   ├── JobCard.tsx                    # Tarjeta de job (preview, aprobar, regenerar, modal edit, extender)
│   ├── FlowGraph.tsx                  # Vista "flujo agéntico" por etapas
│   ├── LogPanel.tsx                   # Mini-log en vivo
│   ├── JsonEditor.tsx                 # Editor del PlanJSON con validación Zod
│   ├── CostEstimatePanel.tsx          # Estimación
│   ├── ProjectTabs.tsx                # Tabs Pipeline / Resultado
│   └── StatusBadge.tsx                # Badge de estado
│
├── store/useProjectStore.ts           # Zustand: config, plan, jobs, logs, references, acciones
│
└── lib/
    ├── config.ts                      # Config central + MODEL_CATALOG + helpers
    ├── schema.ts                      # Zod del PlanJSON (con references[] y ref_image_ids[])
    ├── types.ts                       # JobRecord, ProjectRecord, Manifest, ManifestReference, ...
    ├── prompts.ts                     # PARSER_SYSTEM_PROMPT + buildVeoVideoPrompt + buildImageInstruction
    │                                  # (usado por Vertex provider Y por el preview → idéntico)
    ├── db.ts                          # JSON local (proyectos, jobs, logs)
    ├── storage.ts                     # FS: rutas, manifest, slugify, anti-traversal, references
    ├── ffmpeg.ts                      # Stitch (audio + 720/1080p, CRF 18)
    ├── http.ts                        # Helpers de respuesta
    ├── sampleBrief.ts                 # Brief de ejemplo
    ├── jobs/
    │   ├── pipeline.ts                # buildJobs, runJobGeneration, approveJob, changePrompt,
    │   │                              # extendVideoJob, concatVideos, refreshManifest, estimateCost
    │   └── queue.ts                   # Cola: concurrencia, dependencias, AUTO-APPROVE, gate por lotes,
    │                                  # backoff 429 + red, auto-recuperación de jobs colgados
    └── providers/
        ├── types.ts                   # Interfaces + ProviderHttpError + RefImage
        ├── index.ts                   # Factory mock | vertex
        ├── mock.ts                    # demoPlan + vslDemoPlan + placeholders
        ├── placeholder.ts             # PNG/MP4 placeholder
        └── vertex/
            ├── auth.ts                # ADC vía google-auth-library
            ├── llm.ts                 # Gemini parseBrief (acepta references[])
            ├── image.ts               # Nano Banana (multi-ref + timeout + 429 tipado)
            └── video.ts               # Veo (LRO + polling + 429 tipado)

scripts/
└── generate-vsl-plan.ts               # Genera y valida el PlanJSON del VSL (95 clips)

vsl-natalia-plan.json                  # Plan completo del VSL "Agua de Arroz TURBO"
```

### Flujo de datos

```
Brief / PlanJSON pegado + (opcional) fotos de avatares
        │
        ▼
/api/parse  ──► PlanJSON validado (Zod)
        │
        ▼
/api/projects (POST)  ──►  db.json  +  output/<id>/
        │
        ▼
(VSL) /api/projects/:id/references  ──► output/<id>/references/<id>.png
        │
        ▼
/api/projects/:id/generate  ──► buildJobs() ──► cola (queue.ts)
        │
        ├─► Nano Banana: text2image / image2image  (con N referencias)
        │   guarda en images/_candidates/ y al aprobar copia a images/<id>.png
        │
        └─► Veo: imagen → video (con audio, LRO + polling)
            guarda en clips/NN_<clip>.mp4
        │
        ▼
auto-aprobación (si está activada) ─ desbloquea lo que depende
        │
        ▼
Revisión: 🔧 Revisar/Arreglar → 🔍 Revisar seleccionados → editar prompts → ↻ Guardar y regenerar
        │
        ▼
Resultado → stitch (ffmpeg) → final.mp4   (usa los textos/tiempos editados, persistidos en el plan)
```

---

## Variables de entorno

Ver `.env.example`. Las relevantes:

| Variable | Default | Descripción |
|---|---|---|
| `PROVIDER_MODE` | `mock` | `mock` o `vertex` |
| `GOOGLE_CLOUD_PROJECT` | — | Project ID (Vertex) |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Región Vertex |
| `LLM_MODEL` | `gemini-2.5-flash` | Chat |
| `IMAGE_MODEL` | `gemini-2.5-flash-image` | Nano Banana (recomendado) |
| `VIDEO_MODEL` | `veo-3.1-generate-001` | Veo |
| `IMAGE_VARIANTS` | `1` | Variantes por imagen (1–4) |
| `VIDEO_RESOLUTION` | `720p` | Resolución default |
| `OUTPUT_DIR` / `DATA_DIR` | `./output` / `./data` | Carpetas locales |
| `PIPELINE_CONCURRENCY` | `3` | Jobs en paralelo (ventana rolling) |
| `PIPELINE_AUTO_APPROVE` | `true` | Auto-aprueba cada job al terminar |
| `PIPELINE_APPROVAL_BATCH` | `5` | Lote para modo manual (`autoApprove=false`) |
| `PIPELINE_MAX_ATTEMPTS` | `3` | Reintentos por job (errores reales) |
| `PIPELINE_BACKOFF_MS` | `1500` | Backoff base (errores reales) |
| `PIPELINE_RATE_LIMIT_BACKOFF_MS` | `45000` | Backoff específico para 429 |
| `PIPELINE_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Reintentos extra para 429 + red (no consumen los normales) |
| `PIPELINE_NETWORK_BACKOFF_MS` | `4000` | Backoff base para errores de red |
| `PIPELINE_IMAGE_TIMEOUT_MS` | `120000` | Timeout por request de imagen |
| `VEO_POLL_INTERVAL_MS` | `10000` | Polling LRO Veo |
| `VEO_POLL_TIMEOUT_MS` | `600000` | Timeout LRO Veo |

### Recetas rápidas

**Para evitar 429 en imagen:**
```env
PIPELINE_CONCURRENCY=1
IMAGE_VARIANTS=1
```

**Para dejarlo toda la noche generando un VSL largo (default actual):**
```env
PIPELINE_CONCURRENCY=3
PIPELINE_AUTO_APPROVE=true
PIPELINE_RATE_LIMIT_BACKOFF_MS=45000
```

**Modo manual (con aprobación humana):**
```env
PIPELINE_AUTO_APPROVE=false
PIPELINE_APPROVAL_BATCH=5
```

---

## Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| 404 *"Publisher Model … was not found"* | Modelo no habilitado en tu proyecto | Usá uno del catálogo (p. ej. `gemini-2.5-flash`, `veo-3.1-generate-001`) o pisalo por env |
| Mucho 429 en imagen | Cuota por minuto del modelo | Bajá `PIPELINE_CONCURRENCY` y `IMAGE_VARIANTS`, **NO** te pases a Pro (tiene menos cuota), o subí el tier en Google Cloud |
| `fetch failed` reiteradas | Red intermitente / timeout | Ya hay reintentos automáticos con backoff. Si persiste, mirá el log; el timeout es 120s por request |
| Job colgado en `generating` | Tras reiniciar el server | Se autodestraba al moverse la cola; o tocás **Regenerar** (siempre activo) |
| Video muestra el viejo tras regenerar | Cache del browser | Ya hay cache-busting `?v=<updatedAt>` + `key={url}`. Si pasa, recargá con Ctrl+Shift+R |
| `final.mp4` sin audio / baja calidad | Falta ffmpeg | Instalá ffmpeg; el stitch ya conserva audio y resolución real |
| Falla la autenticación | ADC sin loguear | `gcloud auth application-default login` y revisá `GOOGLE_CLOUD_PROJECT` |
| Romina sale igual que Natalia | El plan tiene a Romina como `image2image` con foto subida | En el plan correcto, Romina es `text2image` (la inventa la IA, distinta de Natalia). Usá `vsl-natalia-plan.json` |

---

## Si abrís un chat nuevo (contexto para retomar)

Lo que conviene contarle al asistente:

- **Repo**: `drasticcurl/videogeneradorxd`. Workspace local en `/projects/sandbox/videogeneradorxd`.
- **Caso real activo**: VSL "Agua de Arroz TURBO", Lic. Natalia Reyes (foto real subida) +
  Romina (testimonio, generada por IA con `text2image`). Plan completo en
  `vsl-natalia-plan.json`. Generador en `scripts/generate-vsl-plan.ts`.
- **Estado**: PRs #1–#16 mergeados. La pipeline está optimizada para dejarla generando toda
  la noche con auto-aprobación + ventana de 3 + reintentos 429 a 45s + auto-recuperación de
  jobs colgados.
- **Vista pensada para iterar**: 🔧 Revisar / Arreglar → 🔍 Revisar / editar seleccionados.
  Permite editar `video_prompt`, `dialogo` y `duracion_seg`, **guardar al plan**, y regenerar.
  Lo que se guarda al plan se usa en el export a ffmpeg.
- **Convenciones**: español rioplatense (voseo) en chat y diálogos del VSL; código en inglés
  para los `prompt`s visuales. PRs con título corto + body en español. Hacer **un PR por
  feature/fix**; basarse siempre en `main` actualizado.
- **Limitación importante**: typecheck/build son lentos en este sandbox; el usuario suele
  pedir saltearlos y testear localmente.

---

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind CSS · Zustand · Zod · google-auth-library
(ADC) · ffmpeg (opcional). Almacenamiento local en filesystem + JSON.
