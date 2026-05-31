# AUGC Pipeline

Aplicación web **local** que automatiza la producción de anuncios **UGC** para un funnel de quiz.
Pegás un brief largo en lenguaje natural y la app:

1. **Interpreta** el brief con Gemini (Vertex AI) y devuelve un **PlanJSON** estructurado y validado
   (avatares, imágenes a generar, clips, orden, diálogo, duración y si cada clip es `IA` o
   `FILMAR_REAL`). Lo revisás y editás antes de generar.
2. Ejecuta un **pipeline en cadena**:
   - genera primero las imágenes `text2image` (Imagen),
   - luego las `image2image` usando como referencia la imagen ya generada (consistencia de cara
     del avatar),
   - por cada clip `IA` espera a que su imagen esté lista y genera el video con **Veo**
     (imagen → video),
   - los clips `FILMAR_REAL` quedan como placeholders para que subas el archivo a mano.
3. **Guarda todo en el disco local**, dentro de `./output/<project_id>/` (`images/`, `clips/`,
   `manifest.json`). Opcionalmente une todo en `final.mp4` con ffmpeg.

Todo es **asíncrono**, con estado en vivo por job (`pending → generating → done | failed`),
reintentos con backoff y posibilidad de **regenerar una sola imagen o un solo clip** sin rehacer
el resto.

> La app está pensada para correr **localmente en tu PC**. No usa Supabase ni storage externo: el
> estado vive en `./data/db.json` y los archivos generados en `./output/`.

---

## Requisitos

- **Node.js 18.18+** (recomendado 20 o 22).
- **Google Cloud SDK (`gcloud`)** solo si vas a usar Vertex AI real.
- **ffmpeg** (opcional) para unir los clips en un `final.mp4`. Si no está instalado, ese paso se
  saltea automáticamente.

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

### Probar de punta a punta SIN credenciales (modo mock)

Con `PROVIDER_MODE=mock` (valor por defecto) podés probar **todo el pipeline** sin gastar cuota:

1. Abrí `http://localhost:3000`.
2. Click en **“Cargar ejemplo”** y después en **“Interpretar con IA”**.
3. Revisá/editá el PlanJSON y apretá **“Generar todo”**.
4. Mirá el progreso en **Pipeline** y los archivos en `./output/<project_id>/`.

El mock genera imágenes PNG reales (gradientes) y clips MP4 placeholder (usa ffmpeg si está
disponible para que el preview sea un video real).

---

## Usar Vertex AI real (ADC, sin API keys)

La app **no usa API keys**. Se autentica con **Application Default Credentials (ADC)**:

```bash
# 1. Loguearte con ADC (una sola vez por máquina)
gcloud auth application-default login

# 2. En .env.local
PROVIDER_MODE=vertex
GOOGLE_CLOUD_PROJECT=tu-proyecto-gcp
GOOGLE_CLOUD_LOCATION=us-central1
```

Toda llamada a los modelos sale del **backend** (Route Handlers), nunca del cliente. La identidad
nunca se expone al navegador.

Asegurate de tener habilitada la API de Vertex AI en tu proyecto y permisos para usar Imagen, Veo
y Gemini.

---

## Formato del brief de entrada

Texto libre, en español. Podés usar marcas `[visual]` / `[audio]` o prosa. Conviene incluir:

- **Avatares**: descripción del personaje y sus **estados** (ej. “después: la misma cara pero más
  desinflada, vestido bordó, espejo”). La primera imagen del avatar es `text2image`; los estados
  siguientes son `image2image` referenciando la imagen base (misma identidad).
- **B-roll**: planos de apoyo (objetos, detalles).
- **Clips en orden** (hook, reveal, escepticismo, mecanismo, warning, CTA…) con el **diálogo exacto**
  en español rioplatense (vos), la **duración** y si es `IA` o `FILMAR_REAL`.

Mirá [`sample-brief.txt`](./sample-brief.txt) y el plan que debería producir en
[`sample-plan.json`](./sample-plan.json).

---

## Dónde quedan los archivos generados

```
output/
└── <project_id>/
    ├── images/
    │   ├── avatar1_base.png
    │   ├── avatar1_desinflada.png
    │   └── broll_vaso_base.png
    ├── clips/
    │   ├── 01_hook.mp4
    │   ├── 02_reveal.mp4
    │   └── ...
    ├── final.mp4          # opcional, si corrés el stitch con ffmpeg
    └── manifest.json      # plan completo + estado + rutas de cada archivo
```

El estado de proyectos y jobs se guarda en `./data/db.json`. Las imágenes y videos se
previsualizan en la UI sirviéndolos desde esos archivos locales (`/api/files/...`).

---

## Cambiar de modelo o de proveedor

Todos los nombres de modelo están **centralizados** en
[`src/lib/config.ts`](./src/lib/config.ts) y son configurables por variable de entorno:

| Variable           | Default                    | Uso                                   |
| ------------------ | -------------------------- | ------------------------------------- |
| `PROVIDER_MODE`    | `mock`                     | `mock` o `vertex`                     |
| `LLM_MODEL`        | `gemini-2.5-flash`         | interpretar el brief                  |
| `IMAGE_MODEL`      | `imagen-4.0-generate-001`  | text2image                            |
| `IMAGE_EDIT_MODEL` | `gemini-2.5-flash-image`   | image2image / edición con referencia  |
| `VIDEO_MODEL`      | `veo-3.0-generate-001`     | imagen → video (Veo)                  |

Para agregar otro proveedor, implementá las interfaces de
[`src/lib/providers/types.ts`](./src/lib/providers/types.ts) y registralo en
[`src/lib/providers/index.ts`](./src/lib/providers/index.ts). El resto de la app no cambia.

---

## Arquitectura

```
src/
├── app/
│   ├── page.tsx                      # Nuevo proyecto (brief + plan editable + generar)
│   ├── project/[id]/pipeline/        # estado en vivo de los jobs
│   ├── project/[id]/result/          # timeline, subida manual, stitch, carpeta
│   └── api/                          # route handlers (backend)
│       ├── parse/                    # brief -> PlanJSON
│       ├── projects/                 # CRUD + generate + jobs + upload + stitch
│       ├── jobs/[id]/retry/          # regenerar 1 job
│       └── files/[...path]/          # sirve archivos locales
├── lib/
│   ├── config.ts                     # config + nombres de modelo (centralizado)
│   ├── schema.ts                     # esquemas Zod del plan + validación cruzada
│   ├── prompts.ts                    # system prompt + responseSchema del parser
│   ├── db.ts                         # estado local en JSON (./data/db.json)
│   ├── storage.ts                    # archivos + manifest (./output/<id>/)
│   ├── ffmpeg.ts                     # stitch opcional
│   ├── jobs/{pipeline,queue}.ts      # build/run de jobs + cola con reintentos
│   └── providers/                    # interfaces + mock + adaptadores Vertex
└── store/useProjectStore.ts          # estado del cliente (Zustand)
```

### Notas no funcionales

- **Idempotencia**: regenerar un job no rehace el resto; los jobs ya `done` se preservan.
- **Rate limits / LRO**: el adaptador de Veo hace polling del Long-Running Operation.
- **Seguridad**: credenciales/identidad solo en el backend (ADC). Nada sensible en el cliente.
- **Tipado estricto** en TypeScript y validación con Zod en backend y cliente.

> Algunos nombres de modelo y shapes de request pueden cambiar con el tiempo. Verificá los IDs
> vigentes en la [documentación oficial de Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/docs)
> y ajustá las variables de entorno si hace falta. Buscá los `// TODO: confirmar` en el código.
