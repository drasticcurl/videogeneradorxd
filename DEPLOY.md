# Deploy a Google Cloud (Cloud Run)

Esta app puede correr **localmente** (`npm run dev`) o desplegarse en **Cloud Run** como
app web usable desde el navegador, con **deploy automático desde GitHub** (estilo Vercel).

Resumen del diseño en la nube:

- **Cómputo**: Cloud Run, **1 instancia siempre encendida** (`min=max=1`, CPU always-on)
  porque la cola de jobs vive en memoria del proceso.
- **Almacenamiento**: un **bucket de Cloud Storage montado como disco** (Cloud Storage FUSE).
  `OUTPUT_DIR` y `DATA_DIR` apuntan al volumen montado → imágenes, clips, `manifest.json` y la
  "DB" JSON persisten en el bucket sin cambiar código.
- **Auth a Vertex AI**: automática vía la **service account** del servicio (ADC). No hace falta
  `gcloud auth ... login` ni claves JSON.
- **ffmpeg**: NO corre en la nube. El video final lo armás vos en tu PC con el **ZIP** que
  descarga la app (botón "Descargar proyecto (ZIP)" → `stitch.sh` / `stitch.bat`).

---

## 1. Requisitos previos (una sola vez)

```bash
# Proyecto y facturación activos. Variables de ejemplo:
export PROJECT_ID=tu-project-id
export REGION=us-central1
export BUCKET=tu-bucket-augc          # globalmente único
export REPO=augc                      # repo de Artifact Registry
export SERVICE=augc-pipeline

gcloud config set project "$PROJECT_ID"

# APIs necesarias
gcloud services enable \
  aiplatform.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com

# Bucket de storage (mismo region que Vertex)
gcloud storage buckets create "gs://$BUCKET" --location="$REGION"

# Repo de imágenes Docker
gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION"
```

### Permisos de la service account (IAM)

Cloud Run usa una service account de runtime (por defecto la *Compute Engine default SA*).
Dale acceso a Vertex AI y al bucket:

```bash
# SA por defecto de Compute (o creá una dedicada y usala con --service-account en el deploy)
export SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

# Llamar a Vertex AI (Gemini / Veo / Imagen)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="roles/aiplatform.user"

# Leer/escribir el bucket montado
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"
```

---

## 2. Deploy

### Opción A — Deploy automático desde GitHub (recomendado, estilo Vercel)

1. En la consola: **Cloud Run → Create service → "Continuously deploy from a repository"**.
2. Conectá tu repo de GitHub y elegí la rama (ej. `main`). Build type: **Dockerfile** (ya está
   en la raíz). Cada `push` a esa rama buildea y deploya una nueva revisión.
3. En **Container, Networking, Security** del servicio configurá (una sola vez; se conserva):
   - **Min/Max instances**: 1 / 1
   - **CPU allocation**: *CPU is always allocated* (no throttling)
   - **Memory**: 2 GiB · **CPU**: 1 · **Request timeout**: 3600
   - **Volumes**: agregá un volumen tipo *Cloud Storage bucket* (`$BUCKET`) montado en `/mnt/gcs`.
   - **Variables de entorno** (ver tabla abajo).

### Opción B — Una línea con gcloud (incluye el mount)

```bash
gcloud run deploy "$SERVICE" \
  --source . \
  --region="$REGION" \
  --min-instances=1 --max-instances=1 \
  --cpu=1 --memory=2Gi --no-cpu-throttling --timeout=3600 \
  --set-env-vars=PROVIDER_MODE=vertex,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$REGION,OUTPUT_DIR=/mnt/gcs/output,DATA_DIR=/mnt/gcs/data \
  --add-volume=name=gcsvol,type=cloud-storage,bucket=$BUCKET \
  --add-volume-mount=volume=gcsvol,mount-path=/mnt/gcs \
  --allow-unauthenticated
```

### Opción C — Cloud Build (`cloudbuild.yaml`)

Hay un `cloudbuild.yaml` parametrizado en la raíz (build → push a Artifact Registry → deploy).

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_BUCKET=$BUCKET,_REGION=$REGION,_SERVICE=$SERVICE,_REPO=$REPO,_VERTEX_LOCATION=$REGION
```

Para CI/CD: creá un **trigger de Cloud Build** apuntando a `cloudbuild.yaml` (Cloud Build →
Triggers → Connect repository). Cada push buildea y deploya.

---

## 3. Variables de entorno

| Variable | Valor en Cloud Run | Para qué |
|---|---|---|
| `PROVIDER_MODE` | `vertex` | usar Vertex AI real (no mock) |
| `GOOGLE_CLOUD_PROJECT` | tu project id | proyecto de Vertex |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | region de Vertex |
| `OUTPUT_DIR` | `/mnt/gcs/output` | carpeta de salida = subpath del bucket montado |
| `DATA_DIR` | `/mnt/gcs/data` | estado (db.json) = subpath del bucket montado |
| `PIPELINE_AUTO_APPROVE` | `true`/`false` | aprobar jobs solos (opcional) |

(Los modelos por defecto y demás knobs siguen en `.env.example`.)

---

## 4. Control de acceso ⚠️ (importante por costo)

La app **dispara generaciones que cuestan dinero** (Veo/Gemini). El `cloudbuild.yaml` y la
Opción B usan `--allow-unauthenticated`, lo que deja la app **pública en internet**.

Para una app **privada** (recomendado):

- Deploy con `--no-allow-unauthenticated`, y entrá vía:
  ```bash
  gcloud run services proxy "$SERVICE" --region="$REGION"   # túnel local autenticado
  ```
- O poné **IAP / Load Balancer** delante para restringir por identidad de Google.

Si la dejás pública, al menos sumá auth a nivel app o un secreto en una env var.

---

## 5. Uso

1. Abrí la URL del servicio. Generás como siempre (brief → plan → imágenes → videos).
2. Cuando termina, **Resultado → "Descargar proyecto (ZIP)"**.
3. En tu PC, descomprimí y corré `bash stitch.sh` (Linux/Mac) o `stitch.bat` (Windows) para
   armar `final.mp4` con tu ffmpeg local.

---

## 6. Costo (referencia)

- **Cloud Run** 1 instancia chica mayormente idle: ~US$10–40/mes.
- **Cloud Build**: 2.500 build-minutes/mes gratis.
- **US$300** de crédito inicial para cuentas nuevas.
- El costo dominante es **Vertex AI** (Veo/Gemini/Imagen) por generación, independiente del hosting.

---

## 7. Notas / límites

- **Una sola instancia**: la cola de jobs vive en memoria. No escalar a >1 sin externalizar
  cola y storage (ver nota de arquitectura en `.kiro/steering/project-context.md`).
- **GCS FUSE** no es un filesystem POSIX 100%: `rename`/`append` son más lentos. `db.ts` ya
  tiene un fallback de escritura para eso. Para un solo usuario anda bien.
- **Transcripción (Whisper)** no corre en la nube (necesita binarios locales). Es una feature
  aparte y opcional; no afecta el pipeline de generación.
