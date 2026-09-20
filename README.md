# Generador — UGC, VSLs e imágenes con Vertex AI

Herramienta interna para producir **anuncios UGC**, **VSLs largos** (talking-head) e **imágenes
sueltas** de punta a punta. Pegás un brief o un PlanJSON, opcionalmente subís las fotos de los
avatares, y la app genera **imágenes + videos** manteniendo la **misma cara** en cada plano, con
manejo de cuota, rate limit y reintentos para poder dejarla corriendo sola.

Corre en un **subdominio público con login por usuario**. Todo el estado vive en el filesystem:
`db.json` para proyectos/jobs/logs y una carpeta por proyecto para los archivos generados. No usa
base de datos ni storage externo.

> **Genera gasto real.** Veo y Nano Banana son de pago. Por eso la app está cerrada con
> password-gate y por eso el pipeline tiene topes de concurrencia y de arranques por minuto.

---

## Limitación conocida: los proyectos no están aislados por usuario

Hoy hay varios usuarios (`PASSWORD_IVAN`, `PASSWORD_LUCHO`) y **todos ven los proyectos de todos**.
`ProjectRecord` no tiene campo de dueño y ninguna route handler compara la sesión contra el
proyecto: el middleware sólo verifica que quien pide sea *alguien* válido.

Hay cuatro caminos por los que se ve lo ajeno, no uno:

| Camino | Por qué |
|---|---|
| `GET /api/projects` | devuelve **todos** los proyectos sin filtrar (`src/app/api/projects/route.ts:16`) |
| `/batch?ids=a,b,c` | los ids del lote viajan en la URL; `/api/batch` los arma sin chequear nada |
| `GET /api/files/<projectId>/<path>` | sirve cualquier archivo de cualquier proyecto y **ni consulta la DB** (`src/app/api/files/[...path]/route.ts:47`) |
| `POST /api/jobs/<jobId>/*` | los ids de job son derivados: `<projectId>:img:<imageId>` y `<projectId>:vid:<clipId>` (`src/lib/jobs/pipeline.ts:43-48`), así que un projectId habilita aprobar, regenerar y editar prompts ajenos |

El aislamiento por usuario está planificado en `tasks/aislamiento-por-usuario/`. Ver `CHANGELOG.md`.

---

## Quickstart local

```bash
npm install

cp .env.example .env.local
# Por defecto PROVIDER_MODE=mock: placeholders, sin credenciales ni cuota.
# Para Vertex AI real:
#   PROVIDER_MODE=vertex
#   GOOGLE_CLOUD_PROJECT=tu-project-id
#   GOOGLE_CLOUD_LOCATION=global      # global, NO una región (ver abajo)
#   gcloud auth application-default login

npm run dev   # http://localhost:3000
```

En local podés dejar `AUTH_SECRET` y los `PASSWORD_*` vacíos: la app queda cerrada (el login
rechaza todo, a propósito), así que si querés entrar poné al menos uno.

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor Next.js en :3000 |
| `npm run build` | Build de producción (`output: 'standalone'`) |
| `npm run start` | Sirve el build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |

Stack: Next.js 14.2 (App Router) · React 18.3 · TypeScript 5.6 · Tailwind 3.4 · Zustand 4.5 ·
Zod 3.23 · google-auth-library (ADC) · ffmpeg/ffprobe/zip por `spawn`.

---

## Login y usuarios

No hay tabla de usuarios ni registro: **cada usuario es una variable de entorno**.

```env
AUTH_SECRET=<openssl rand -hex 32>
PASSWORD_IVAN=<40 chars>
PASSWORD_LUCHO=<40 chars>
AUTH_SESSION_HOURS=72
NEXT_PUBLIC_SITE_URL=https://generador.hilvanapp.online
```

`authUsers()` (`src/lib/config.ts`) recorre `process.env`, toma toda clave que empiece con
`PASSWORD_` y usa el resto del nombre en minúsculas como usuario. Agregar o sacar gente es tocar el
`.env` y reiniciar, sin recompilar. **Sacar la var revoca el acceso al instante**, aunque la cookie
siga firmada y sin vencer.

Cómo funciona la sesión:

- Cookie `gen_session` = `<usuario>.<timestamp>.<hmac>`, HMAC-SHA256 con `AUTH_SECRET`. No contiene
  la password y no se puede forjar sin el secret.
- El secret es una var **aparte** de las passwords: firmando con la password propia, rotar una
  obligaría a probar N claves para verificar una cookie.
- Comparación timing-safe del HMAC y de la password. Si el usuario no existe se compara contra un
  dummy del mismo largo, así el tiempo de respuesta no delata qué usuarios existen.
- Rate limit por IP: 5 intentos cada 15 min, in-memory (válido porque corre **una sola** instancia).
- **Falla cerrado**: sin `AUTH_SECRET` o sin ninguna `PASSWORD_*`, no entra nadie. Nunca "se abre
  porque faltó config".

Tres archivos, y la separación entre ellos importa:

| Archivo | Rol |
|---|---|
| `src/lib/auth.ts` | la implementación real (`node:crypto`). Server-only |
| `src/middleware.ts` | el guard. Corre en **Edge**, así que reimplementa el verify con Web Crypto: `node:crypto` y `node:path` no existen ahí. Mismo formato de token y mismo TTL |
| `src/app/api/login/route.ts` | `POST` valida y setea la cookie; `DELETE` cierra sesión |

El middleware protege todo con `matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]`. Las
únicas rutas abiertas son `/login` y `/api/login` — si estuvieran detrás del guard no se podría
entrar nunca. A las rutas `/api/*` les contesta **401**, no un redirect: un 307 haría que el `fetch`
de la UI parsee el HTML del login como JSON y el error real quedaría tapado por un
"Unexpected token <".

Lo que el middleware **no** puede chequear es que el usuario siga existiendo en el `.env`: eso
necesita enumerar `process.env`, que no es confiable en Edge. Lo verifica `src/lib/auth.ts` en el
server, que es donde la revocación tiene que valer.

---

## Las tres superficies de trabajo

### `/` — Nuevo proyecto (video)

Pegás un brief para que lo interprete la IA, o pegás un PlanJSON directo. Elegís modelos, variantes
por imagen, resolución y si el proyecto auto-aprueba. Abajo lista los **proyectos de video**
(los que tienen clips).

Para un VSL: subís las fotos de los avatares en **"Avatares de referencia"** y les ponés el `id`
que el plan espera (hay indicador ✓ cuando matchea). Esas fotos son la fuente de identidad:
la primera imagen de cada persona es `image2image` contra la foto real, y los planos siguientes
mantienen la cara.

### `/imagenes` — Imágenes sueltas

Un prompt por proyecto, con formato (aspect ratio) y calidad (1K/2K/4K) elegibles, y las variantes
como forma de pedir varias. Los proyectos de esta pantalla **no tienen clips**, y de ahí se derivan:
`GET /api/projects` marca `soloImagenes: p.plan.clips.length === 0`, y cada pantalla filtra por eso
para no mezclar tandas de imágenes con VSLs.

Antes esta pantalla partía el texto pegado en un prompt **por línea**. Se sacó: un prompt real tiene
varias líneas (encuadre, luz, estilo, negativos), así que partir por línea convertía un prompt en
cinco prompts cortados al medio.

**Pestaña "Generador masivo"**: subís N fotos + un solo prompt genérico ("hacé una variación de
este creativo, no cambies mucho") y crea N proyectos de imágenes — uno por foto, `image2image`
contra cada una, mismo mecanismo que la imagen base de la pestaña "Generar". Pensado para el caso
de generar muchos creativos de golpe sin pegar contra la cuota por minuto de un solo modelo: alterna
`gemini-3-pro-image` (Pro) y `gemini-3.1-flash-image` (Flash) por proyecto, y los corre **secuencial**
(el proyecto N+1 no arranca hasta que el N termina), no en paralelo. Ver `POST /api/imagenes/masivo`
y `src/lib/jobs/masivo.ts`.

### `/batch` — Tablero de varios proyectos a la vez

Es la pantalla para producir en volumen. Los ids del lote viajan en la URL (`/batch?ids=a,b,c`);
no hay `localStorage` en toda la app. Tres vistas:

| Vista | Para qué |
|---|---|
| `/batch` | tablero con el progreso por proyecto: conteos de imágenes y videos, miniatura, jobs colgados |
| `/batch/review` | revisión tipo tinder de las imágenes que esperan aprobación, en orden FIFO, con las referencias y los clips que las usan |
| `/batch/videos` | línea de tiempo de clips: ver, aprobar, editar prompt/diálogo/duración, regenerar |

Todo sale de `buildBatchSnapshot()` (`src/lib/batch.ts`), que calcula desde la DB + el plan y no
toca proveedores.

**Fases (`stage`)**: un proyecto puede estar en `images` o `videos`. En `images` la cola corre
**sólo** jobs de imagen, aunque su imagen ya esté aprobada — si no, aprobar una imagen disparaba su
video al toque. Sirve para revisar todo antes de gastar en Veo. `undefined` = sin fase, corre todo.

### `/project/[id]/pipeline` y `/project/[id]/result`

La vista por proyecto individual: storyboard con las tarjetas de cada job, y la pantalla de
resultado con la línea de tiempo, la subida manual de clips `FILMAR_REAL`, el stitch y la descarga.

---

## Modos del proveedor

- **`mock`** (default): PNG con gradientes y MP4 placeholder, **sin credenciales ni cuota**. Sirve
  para probar el pipeline entero (interpretación, aprobaciones, storyboard, revisión, extensión,
  stitch) sin gastar. Si subís fotos de referencia, el mock LLM arma un demo VSL con esos avatares.
- **`vertex`**: llamadas reales. La identidad se resuelve por **ADC**, nunca por API key, y toda
  llamada sale del backend: el navegador nunca ve credenciales.

### `GOOGLE_CLOUD_LOCATION` va en `global`, no en una región

No es un detalle de performance: es lo que hace que exista la mitad del catálogo. Verificado con
requests reales el 2026-08-27 — toda la familia **Gemini 3.x** devuelve **404** en `us-central1`,
`us-east5` y `europe-west4`, y responde OK en `global`. Veo también funciona ahí (ciclo completo del
LRO verificado). Si alguien lo vuelve a poner en una región, todos los jobs empiezan a fallar con
404. `vertexBaseUrl()` ya resuelve el host distinto que necesita `global`
(`aiplatform.googleapis.com`, sin prefijo).

De paso, Google recomienda `global` para reducir los 429: rutea a la región con más capacidad libre.

---

## Catálogo de modelos

En `src/lib/config.ts` (`MODEL_CATALOG`). Todos verificados con request real en `global`
(2026-08-27). Seleccionables por proyecto en la UI y por ítem.

| Tipo | Opciones | Default |
|---|---|---|
| **Chat** | `gemini-3.6-flash` (⚡), `gemini-3.7-flash` (🧠) | `gemini-3.6-flash` |
| **Imagen** | `gemini-3.1-flash-image` (⚡ Nano Banana 2, ~1.1 MB), `gemini-3-pro-image` (🧠 Nano Banana Pro, ~1.3 MB), `gemini-3.1-flash-lite-image` (🪙 Lite, ~56 KB) | `gemini-3.1-flash-image` |
| **Video** | `veo-3.1-lite-generate-001` (🪙), `veo-3.1-fast-generate-001` (⚡), `veo-3.1-generate-001` (🧠) | `veo-3.1-lite-generate-001` |

3.7 Flash es más nuevo pero más lento e irregular (1.6-5.2s contra 1.4-1.7s parejo de 3.6 en el
mismo prompt trivial), y parseando un brief largo eso se acumula. Por eso 3.6 es el default.

Veo 3.1 es la línea más nueva que existe: `veo-3.2` y `veo-4.0` dan 404.

**Al editar el catálogo**: `resolveModel()` cae al default cuando el id pedido no está en la lista,
así que sacar un modelo sin mover el default correspondiente deja la app generando con un modelo que
la UI no muestra.

---

## Pipeline: cómo se comporta la cola

`src/lib/jobs/queue.ts`. Vive **en memoria del proceso**, y de ahí sale casi todo lo demás.

- **Concurrencia** (`PIPELINE_CONCURRENCY`, default 3 en código, el `.env.example` trae 2): ventana
  rolling. Cuando uno termina arranca el siguiente, sin esperar a aprobar el anterior.
- **Auto-aprobación** (`PIPELINE_AUTO_APPROVE=true` por default, y override por proyecto en
  `ProjectRecord.autoApprove`): cada job se aprueba solo al terminar y desbloquea lo que depende.
  Con `false` cada job queda en `awaiting_approval`.
- **Lotes de aprobación** en modo manual, y son **dos números distintos a propósito**:
  imágenes `0` (sin límite, porque son baratas y el flujo es generar la tanda, revisarla en bloque y
  aprobarla — con un límite de 5, importar 4 planes generaba 20 de 32 y se frenaba), videos `5`
  (porque cada clip de Veo son varios USD y un tablero de 95 clips no puede comprometer todo el
  gasto de una).
- **Rate limit de video**: ventana deslizante, máximo 4 arranques por minuto
  (`PIPELINE_VIDEO_RATE_MAX` / `PIPELINE_VIDEO_RATE_WINDOW_MS`). Es aparte de la concurrencia: la
  concurrencia limita cuántos corren a la vez, esto cuántos se **largan** por minuto, que es lo que
  mide la cuota.
- **429 / rate limit**: backoff dedicado de 45s (respeta `Retry-After`) con presupuesto propio de
  10 reintentos, que no queman los `maxAttempts` normales.
- **Errores de red** (`fetch failed`, `ECONNRESET`, timeouts): transitorios, backoff exponencial
  hasta 30s, también con presupuesto aparte. Timeout de 120s por request de imagen.
- **Pausa entre variantes de una imagen** (`PIPELINE_IMAGE_VARIANT_GAP_MS`, 2500ms): no es
  cosmética. Verificado el 2026-08-28, `gemini-3.1-flash-image` contesta 429 a los ~200ms si se le
  manda la segunda variante pegada a la primera; sin la pausa, pedir 2 variantes devolvía 1.
- **Variantes con éxito parcial**: cada variante es una request, y cada éxito se persiste al toque.
  Si la segunda falla no perdés la primera, y el reintento genera sólo las que faltan.
- **Auto-recuperación**: los jobs que quedaron en `generating` pero no están corriendo de verdad
  (típico tras reiniciar el proceso) se resetean a `pending` cuando la cola se mueve. `batch.ts` los
  cuenta aparte como `stuck`.
- **Cache-busting**: las URLs llevan `?v=<updatedAt>` y los `<img>`/`<video>` llevan `key={url}`,
  para que al regenerar veas el nuevo y no el cacheado.

---

## Dónde quedan los archivos

```
<OUTPUT_DIR>/<project_id>/
├── images/
│   ├── _candidates/               # variantes antes de aprobar (avatar1_base__v1.png, …)
│   └── avatar1_base.png           # imagen aprobada (canónica)
├── references/                    # fotos de avatares subidas (VSL)
├── clips/
│   ├── 01_hook.mp4
│   └── …
├── <nombre-del-proyecto>.mp4      # el video unido, si corriste el stitch
├── manifest.json                  # plan + estado + rutas + references[]
└── pipeline.log
```

El video unido se llama **como el proyecto**, no `final.mp4`: con `final.mp4` cinco proyectos
bajaban cinco archivos con el mismo nombre y el browser los guardaba como `final-1.mp4`,
`final-2.mp4`. Se sigue leyendo `final.mp4` para no perder de vista los que se unieron antes del
cambio.

Estado de proyectos/jobs/logs en `<DATA_DIR>/db.json`, con escritura atómica (tmp + rename) y
singleton por `globalThis` para sobrevivir al HMR. La UI sirve los archivos por
`/api/files/<projectId>/<path>`, con soporte de HTTP Range para el seek de video.

---

## El PlanJSON

Definido en `src/lib/schema.ts` (Zod, con validación cruzada). Forma resumida:

```jsonc
{
  "global": {
    "idioma_dialogo": "es-AR",
    "formato": "9:16",
    "reglas_realismo": "…",
    "negative_prompt": "…"
  },
  // VSL: fotos subidas que son fuente de identidad (opcional)
  "references": [{ "id": "natalia", "label": "Lic. Natalia Reyes" }],
  "assets": [
    {
      "id": "natalia",
      "tipo": "avatar",                  // "avatar" | "broll"
      "images": [
        {
          "id": "natalia_medium",
          "modo": "image2image",         // primera imagen puede serlo SI usa una reference subida
          "ref_image_id": "natalia",     // id de imagen previa O de una reference
          "ref_image_ids": ["…"],        // OPCIONAL: combinar 2+ personas en un plano
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
      "final_prompt": "",                // override del prompt final a Veo ("" = armado automático)
      "dialogo": "…(es-AR, no se traduce)…",
      "duracion_seg": 8,                 // 4 | 6 | 8
      "etiqueta": "IA",                  // "IA" | "FILMAR_REAL"
      "on_screen_text": "…",
      "resolucion": "720p"               // opcional: 720p | 1080p
    }
  ],
  "warnings": ["…"]
}
```

Reglas que valida el schema:

- Una imagen `image2image` necesita `ref_image_id` (o `ref_image_ids`) que **exista** — como imagen
  del proyecto **o** como `reference` subida — y no puede referenciarse a sí misma.
- La **primera imagen de un avatar** debe ser `text2image`, **o** `image2image` cuyas referencias
  sean **todas** `references` subidas (el caso VSL).
- Cada clip apunta a un `asset_id` e `image_id` válidos, y `orden` no se repite.
- `formato` siempre `9:16`; `duracion_seg` sólo 4/6/8 (con snap automático en el backend).

**El plan es la fuente de verdad del export.** El stitch a ffmpeg lee del plan, no de los jobs, así
que cualquier edición de prompt, diálogo o duración tiene que persistir en el plan vía
`changePrompt` para que impacte en el `.mp4` final.

---

## API HTTP

32 handlers en 26 archivos. Todas pasan por el middleware: sin cookie válida devuelven 401
(`/api/*`) y las páginas redirigen a `/login`.

| Método y ruta | Qué hace |
|---|---|
| `POST` `/api/login` | valida usuario + password y setea la cookie |
| `DELETE` `/api/login` | cierra la sesión |
| `GET` `/api/config` | config no sensible (modelos, resoluciones, formatos, paths) |
| `POST` `/api/parse` | brief → PlanJSON (Gemini) + estimación. Acepta `references[]` |
| `GET` `/api/projects` | lista **todos** los proyectos (resumen + `soloImagenes`) |
| `POST` `/api/projects` | crea proyecto a partir de `{ name?, brief, plan, models?, … }` |
| `GET` `/api/projects/:id` | proyecto + jobs + manifest + estimación |
| `PUT` `/api/projects/:id` | actualiza plan / nombre / modelos / variantes / resolución |
| `DELETE` `/api/projects/:id` | elimina el proyecto, sus jobs y su carpeta en disco |
| `GET` `/api/projects/:id/jobs` | estado en vivo (polling) |
| `POST` `/api/projects/:id/generate` | construye los jobs y arranca la cola |
| `POST` `/api/projects/:id/control` | `pause` / `resume` / `cancel` |
| `POST` `/api/projects/:id/stage` | cambia la fase (`images` → `videos`) |
| `POST` `/api/projects/:id/approve-batch` | aprueba el lote actual (modo manual) |
| `POST` `/api/projects/:id/regenerate-batch` | regenera sólo los jobs indicados (`{jobIds}`/`{refIds}`) |
| `POST` `/api/projects/:id/upload` | sube el archivo de un clip `FILMAR_REAL` |
| `GET` `/api/projects/:id/references` | lista los avatares de referencia |
| `POST` `/api/projects/:id/references` | sube un avatar de referencia |
| `POST` `/api/projects/:id/stitch` | une los clips con ffmpeg |
| `GET` `/api/projects/:id/download` | baja el proyecto (zip, o el archivo suelto) |
| `GET` `/api/batch?ids=a,b,c` | snapshot del lote |
| `POST` `/api/batch` | acciones sobre el lote |
| `POST` `/api/imagenes` | crea un proyecto de sólo imágenes |
| `POST` `/api/imagenes/masivo` | generador masivo: N fotos + 1 prompt → N proyectos de imágenes, alternando modelo Pro/Flash, corridos SECUENCIAL (uno a la vez) |
| `POST` `/api/jobs/:id/approve` | aprueba un job (con índice de variante en imágenes) |
| `POST` `/api/jobs/:id/unapprove` | vuelve un job aprobado a `awaiting_approval` |
| `POST` `/api/jobs/:id/retry` | regenera un job |
| `POST` `/api/jobs/:id/prompt` | cambia prompt / diálogo / duración / resolución / modelo (`regenerate?`) |
| `POST` `/api/jobs/:id/extend` | extiende un video +7s |
| `GET` `/api/jobs/:id/preview` | el prompt **exacto** que se ejecuta + imagen input + JSON |
| `GET` `/api/prompt-template` | la plantilla del prompt de video (`?download=1` para bajarla) |
| `GET` `/api/files/<projectId>/<path>` | sirve un archivo del proyecto (Range, `?dl=1`, `?name=`) |

---

## Estructura del proyecto

```
src/
├── middleware.ts                      # guard de auth (Edge) + headers de seguridad
├── app/
│   ├── layout.tsx                     # Server Component: currentUser(cookies()) + nav
│   ├── SessionBar.tsx / NavLinks.tsx  # usuario y navegación (Client)
│   ├── page.tsx                       # "Nuevo proyecto" (video)
│   ├── login/                         # page.tsx (Server) + LoginForm.tsx (Client)
│   ├── imagenes/                      # page.tsx + ImagenesBoard.tsx
│   ├── batch/                         # BatchBoard + review/ReviewDeck + videos/VideoDeck
│   ├── project/[id]/                  # pipeline/ y result/
│   └── api/                           # las 25 route handlers
│
├── components/
│   ├── ui/                            # las 10 primitivas (Button, Input, Select, Badge, …)
│   ├── JobCard.tsx                    # tarjeta de job
│   ├── ModelSelectorBar.tsx           # modelos + variantes + resolución
│   ├── FlowGraph.tsx / LogPanel.tsx / JsonEditor.tsx / CostEstimatePanel.tsx
│   └── ProjectTabs.tsx / StatusBadge.tsx / Visor.tsx
│
├── store/useProjectStore.ts           # Zustand (sin persist: vive en memoria)
│
└── lib/
    ├── config.ts                      # config central + MODEL_CATALOG + authUsers()
    ├── auth.ts                        # HMAC, timing-safe, rate limit, currentUser()
    ├── schema.ts                      # Zod del PlanJSON
    ├── types.ts                       # JobRecord, ProjectRecord, Manifest, …
    ├── formatos.ts                    # aspect ratios y calidades (módulo puro, va al cliente)
    ├── prompts.ts                     # PARSER_SYSTEM_PROMPT, buildVeoVideoPrompt, buildImageInstruction
    ├── promptTemplate{,.server}.ts    # la plantilla de prompts/veo-video-prompt.md
    ├── db.ts                          # db.json (proyectos, jobs, logs)
    ├── storage.ts                     # rutas, manifest, slugify, anti-traversal
    ├── batch.ts                       # buildBatchSnapshot (tablero, review, timeline)
    ├── imagenes.ts                    # helpers de la pantalla de imágenes
    ├── ffmpeg.ts                      # stitch (audio + resolución real, CRF 18)
    ├── jobs/
    │   ├── pipeline.ts                # buildJobs, run*Generation, approve, changePrompt, extend
    │   └── queue.ts                   # concurrencia, dependencias, auto-approve, backoff, recuperación
    └── providers/
        ├── index.ts                   # factory mock | vertex
        ├── mock.ts / placeholder.ts   # demo plans y placeholders
        └── vertex/                    # auth (ADC), llm, image, video

deploy/
├── deploy.sh                          # build + activación de una release
├── ecosystem.config.js                # PM2 (1 instancia, fork)
└── Caddyfile.generador                # reverse proxy

tasks/                                 # planes de implementación (ver "Convención de tasks")
prompts/veo-video-prompt.md            # plantilla editable en runtime
scripts/generate-vsl-plan.ts           # genera y valida un PlanJSON de VSL
```

### Flujo de datos

```
Brief / PlanJSON pegado + (opcional) fotos de avatares
        │
        ▼
/api/parse ──► PlanJSON validado (Zod)
        │
        ▼
POST /api/projects ──► db.json + <OUTPUT_DIR>/<id>/
        │
        ├─► (VSL) POST /api/projects/:id/references ──► references/<id>.png
        │
        ▼
POST /api/projects/:id/generate ──► buildJobs() ──► cola (queue.ts)
        │
        ├─► Nano Banana: text2image / image2image (con N referencias)
        │   images/_candidates/ y al aprobar copia a images/<id>.png
        │
        └─► Veo: imagen → video (audio, LRO + polling)
            clips/NN_<clip>.mp4
        │
        ▼
aprobación (auto o manual) ─ desbloquea lo que depende
        │
        ▼
/batch/review y /batch/videos ──► editar prompts ──► persiste en el PLAN
        │
        ▼
POST /api/projects/:id/stitch (ffmpeg) ──► <nombre-del-proyecto>.mp4
```

---

## Variables de entorno

Ver `.env.example`. Las que importan:

| Variable | Default | Descripción |
|---|---|---|
| `PROVIDER_MODE` | `mock` | `mock` o `vertex` |
| `GOOGLE_CLOUD_PROJECT` | — | Project ID (requerido en `vertex`) |
| `GOOGLE_CLOUD_LOCATION` | `global` | **`global`, no una región** |
| `LLM_MODEL` | `gemini-3.6-flash` | Chat |
| `IMAGE_MODEL` | `gemini-3.1-flash-image` | Nano Banana 2 |
| `VIDEO_MODEL` | `veo-3.1-lite-generate-001` | Veo |
| `VIDEO_RESOLUTION` | `720p` | Resolución default |
| `IMAGE_VARIANTS` | `1` | Variantes por imagen (1-4) |
| `OUTPUT_DIR` / `DATA_DIR` | `./output` / `./data` | **En producción tienen que ser absolutos** |
| `PIPELINE_CONCURRENCY` | `3` | Jobs en paralelo |
| `PIPELINE_AUTO_APPROVE` | `true` | Auto-aprueba cada job al terminar |
| `PIPELINE_APPROVAL_BATCH_IMAGES` | `0` | Lote manual de imágenes (0 = sin límite) |
| `PIPELINE_APPROVAL_BATCH_VIDEOS` | `5` | Lote manual de videos |
| `PIPELINE_MAX_ATTEMPTS` | `3` | Reintentos por job (errores reales) |
| `PIPELINE_BACKOFF_MS` | `1500` | Backoff base |
| `PIPELINE_RATE_LIMIT_BACKOFF_MS` | `45000` | Backoff específico para 429 |
| `PIPELINE_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Reintentos extra para 429 + red |
| `PIPELINE_NETWORK_BACKOFF_MS` | `4000` | Backoff base de red |
| `PIPELINE_IMAGE_TIMEOUT_MS` | `120000` | Timeout por request de imagen |
| `PIPELINE_IMAGE_VARIANT_GAP_MS` | `2500` | Pausa entre variantes (evita 429) |
| `PIPELINE_VIDEO_RATE_MAX` | `4` | Arranques de video por ventana |
| `PIPELINE_VIDEO_RATE_WINDOW_MS` | `60000` | La ventana |
| `PIPELINE_VIDEO_REQUEUE_MAX` | `5` | Reencolados de un video fallido |
| `VEO_POLL_INTERVAL_MS` | `10000` | Polling del LRO de Veo |
| `VEO_POLL_TIMEOUT_MS` | `600000` | Timeout del LRO |
| `PIPELINE_MAX_LOG` | `500` | Entradas de log por proyecto |
| `AUTH_SECRET` | — | **Obligatorio.** Firma las cookies. Sin esto no entra nadie |
| `PASSWORD_<NOMBRE>` | — | **Al menos una.** Un usuario por variable |
| `AUTH_SESSION_HOURS` | `72` | Vida de la sesión |
| `NEXT_PUBLIC_SITE_URL` | — | URL canónica para el redirect al login |

### Recetas

**Para evitar 429 en imagen:**
```env
PIPELINE_CONCURRENCY=1
IMAGE_VARIANTS=1
PIPELINE_IMAGE_VARIANT_GAP_MS=4000
```

**Para dejarlo generando un VSL largo:**
```env
PIPELINE_CONCURRENCY=3
PIPELINE_AUTO_APPROVE=true
PIPELINE_RATE_LIMIT_BACKOFF_MS=45000
```

**Modo manual, revisando de a poco:**
```env
PIPELINE_AUTO_APPROVE=false
PIPELINE_APPROVAL_BATCH_IMAGES=0
PIPELINE_APPROVAL_BATCH_VIDEOS=5
```

---

## Deploy

Vive en `generador.hilvanapp.online`. Caddy (detrás de Cloudflare) → PM2 → Next standalone en
`127.0.0.1:3006`.

```bash
sudo -u deploy bash /srv/generador/repo/deploy/deploy.sh
```

Layout en el server:

```
/srv/generador/
├── repo/                       # clon de git (main)
├── shared/
│   ├── .env.production         # secretos (chmod 600)
│   └── adc.json                # credenciales de Vertex (chmod 600)
├── storage/{data,output}       # ESTADO PERSISTENTE, afuera de las releases
├── releases/<timestamp>/       # se conservan las últimas 5
└── current -> <release>/.next/standalone
```

**`storage/` está afuera del árbol de releases y no es gusto.** `config.ts` resuelve `DATA_DIR` y
`OUTPUT_DIR` con `resolveFromCwd()`: si son relativos se resuelven contra el cwd, que es
`/srv/generador/current`, o sea **adentro** de la release. Cada deploy crea una release nueva y la
poda borra las viejas: los proyectos, imágenes y videos desaparecerían en el deploy siguiente sin
un solo error. El paso 3c de `deploy.sh` aborta si esos paths no son absolutos o si apuntan adentro
del árbol de releases.

Lo que el script garantiza:

- **Un deploy a la vez** (`flock`). Dos simultáneos se pisan el `git reset` del repo compartido.
- **Se re-ejecuta a sí mismo** si el commit cambió `deploy.sh`. Bash lee el script por offset de
  bytes: si el archivo cambia de tamaño a mitad de ejecución, sigue leyendo desde la posición vieja
  y ejecuta líneas cortadas. Pasó en el primer deploy.
- **Guards antes del build**, para no dejar una release a medias: `AUTH_SECRET` presente, al menos
  una `PASSWORD_*`, `NEXT_PUBLIC_SITE_URL` presente, `DATA_DIR`/`OUTPUT_DIR` absolutos y
  escribibles, credenciales de Vertex legibles y JSON válido, y `ffmpeg`/`ffprobe` instalados
  (`zip` es warning: sólo rompe la descarga en zip).
- **`npm ci --include=dev` es obligatorio**: el guard hace `source` del `.env.production`, que setea
  `NODE_ENV=production`, y con eso `npm ci` saltea las devDependencies — donde viven `typescript`,
  `tailwind` y `postcss`. Sin el flag el typecheck muere con `tsc: not found`.
- **Completa el standalone a mano**: Next no copia `.next/static`, `public/`, `.env.production` ni
  `prompts/` adentro de `.next/standalone`. Sin eso la app sale sin CSS.
- **Swap atómico** con `mv -T` (un solo `rename(2)`). `ln -sfn` hace unlink + symlink, y en esa
  ventana `current` no existe.
- **Health check + rollback**: si `/login` no devuelve 200 en 40s, vuelve solo a la release anterior.
  Se chequea `/login` y no `/`, porque `/` redirige con 307 sin cookie.

**Una sola instancia** (`instances: 1`, `exec_mode: 'fork'`), y no es negociable: la cola de jobs
vive en memoria del proceso, así que con 2+ se rompe el polling de progreso y hay escrituras
concurrentes sobre `db.json`. El rate limit de login también es in-memory: con N instancias el
límite efectivo se multiplica por N.

**Un reload reinicia el proceso y los jobs en vuelo se pierden** (los archivos ya escritos quedan;
el progreso no). No deployees con una generación corriendo.

---

## Convención de tasks

Los cambios grandes se planifican en `tasks/<modulo>/` antes de escribir código, con:

- `00-PLAN-<MODULO>.md` — documento maestro: decisiones cerradas (cada una con el bug que evita),
  contratos congelados, tabla de ownership de archivos, olas de paralelismo, preguntas abiertas.
- `TNN-<nombre>.md` — una task por agente, con los archivos que puede tocar y su verificación.
- `PROMPT-CLAUDE-CODE.md` — los prompts listos para pegar.
- `_verificacion-*.{sh,mjs}` — afirmaciones ejecutables con la salida esperada al lado.

Los que ya están:

| Carpeta | Qué |
|---|---|
| `tasks/` (raíz) | rediseño de UI: `00-PLAN-REDISENO-UI.md` + T01-T12, ya cerrado |
| `tasks/aislamiento-por-usuario/` | aislar los proyectos por usuario (pendiente) |

`tasks/_verificacion-endpoints.sh` es una **línea base**: verifica que ninguna pantalla haya perdido
un `fetch` a un endpoint. Si movés un fetch a propósito, actualizá la `LINEA_BASE` en el mismo
commit y explicá por qué. Nunca la toques "para que pase".

---

## Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| 404 *"Publisher Model … was not found"* | `GOOGLE_CLOUD_LOCATION` en una región | Ponelo en `global`. Los modelos 3.x no existen en regiones |
| No entra nadie, ni con la password bien | falta `AUTH_SECRET` o toda `PASSWORD_*` | Falla cerrado a propósito. `deploy.sh` lo aborta antes del build |
| El login redirige a `127.0.0.1:3006` | falta `NEXT_PUBLIC_SITE_URL` | Setealo con la URL pública |
| `Unexpected token <` en un fetch de la UI | sesión vencida | El middleware ya contesta 401 en `/api/*`; volvé a entrar |
| Mucho 429 en imagen | cuota por minuto del modelo | Bajá `PIPELINE_CONCURRENCY` e `IMAGE_VARIANTS`, subí `PIPELINE_IMAGE_VARIANT_GAP_MS` |
| Pedí 2 variantes y vino 1 | 429 entre variantes | Subí `PIPELINE_IMAGE_VARIANT_GAP_MS`. Las que faltan se generan al reintentar |
| Job colgado en `generating` | se reinició el proceso | Se autodestraba al moverse la cola; `/batch` los muestra como `stuck` |
| Video viejo tras regenerar | cache del browser | Ya hay `?v=<updatedAt>` + `key={url}`. Si pasa, Ctrl+Shift+R |
| La descarga en zip falla | falta el binario `zip` | `apt-get install -y zip`. `deploy.sh` avisa |
| `final.mp4` sin audio o de mala calidad | falta ffmpeg | `apt-get install -y ffmpeg`. `deploy.sh` lo aborta |
| Se perdieron proyectos tras un deploy | `DATA_DIR`/`OUTPUT_DIR` relativos | Tienen que ser absolutos y afuera de `releases/`. El guard 3c lo aborta |
| Falla la autenticación de Vertex | ADC sin configurar | `gcloud auth application-default login`, o `GOOGLE_APPLICATION_CREDENTIALS` en el server |

---

## Convenciones

- **Idioma**: español rioplatense (voseo) en chat, comentarios, UI y diálogos del VSL. Los
  **prompts visuales van en inglés**. Los diálogos no se traducen.
- **Formato**: vertical 9:16 fijo. Duración de clip sólo 4/6/8s.
- **Comentarios**: explican *por qué*, y cuando documentan una decisión traen el bug que evita.
  Los comentarios largos de este repo son deliberados: casi todos son un bug que ya pasó.
- **PRs**: uno por feature/fix, desde `main` actualizado. Título corto, body en español con
  "Qué hace" / "Cambios" / "Tested" / "Notas".
