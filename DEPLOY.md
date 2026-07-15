# Deploy a Google Cloud (Cloud Run)

Esta app puede correr **localmente** (`npm run dev`) o desplegarse en **Cloud Run** como
app web usable desde el navegador, con **deploy automático desde GitHub** (estilo Vercel).

Resumen del diseño en la nube:

- **Cómputo**: Cloud Run, **1 instancia siempre encendida** (`min=max=1`, CPU always-on)
  porque la cola de jobs vive en memoria del proceso.
- **Runtime combinado**: una sola imagen/contenedor ejecuta Next.js como ingress en `$PORT`
  y FastAPI internamente en `127.0.0.1:8000`. El editor nunca tiene ingress propio.
- **Almacenamiento**: el bucket existente de Cloud Storage se monta con Cloud Storage FUSE.
  `OUTPUT_DIR`, `DATA_DIR` y `VSE_OUTPUT` apuntan al volumen; `/shared` es scratch local del
  contenedor para el intercambio entre ambos procesos.
- **Auth a Vertex AI**: automática vía la **service account** del servicio (ADC). No hace falta
  `gcloud auth ... login` ni claves JSON.
- **Editor de video**: ffmpeg, ffprobe, libass, auto-editor y faster-whisper están incluidos en
  la imagen combinada. El ingress de Next.js se inicia solo después de que `/salud` confirme
  que FastAPI y sus dependencias están listos, con un plazo máximo de 60 segundos.

---

## 1. Requisitos previos (una sola vez)

```bash
# Proyecto y facturación activos. Variables de ejemplo:
export PROJECT_ID=tu-project-id
export REGION=us-central1
export BUCKET=augc-bucket-2725       # bucket existente
export REPO=cloud-run-source-deploy  # repo de Artifact Registry existente
export IMAGE=videogeneradorxd/videogeneradorxd
export SERVICE=videogeneradorxd

gcloud config set project "$PROJECT_ID"

# APIs necesarias
gcloud services enable \
  aiplatform.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com

# Este deploy reutiliza el bucket existente indicado por BUCKET; no crea otro.
# Repo de imágenes Docker (solo si todavía no existe)
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
   - **Memory**: 8 GiB · **CPU**: 4 · **Request timeout**: 3600
   - **Volumes**: agregá un volumen tipo *Cloud Storage bucket* (`$BUCKET`) montado en `/mnt/gcs`.
   - **Variables de entorno** (ver tabla abajo).
   - El arranque combinado da a FastAPI **como máximo 60 segundos** para responder `/salud`;
     si FastAPI termina antes o vence el plazo, la revisión falla sin iniciar Next.js.
   - Next.js escucha el puerto de ingress `8080`; FastAPI queda solo en `127.0.0.1:8000`.

### Opción B — Una línea con gcloud (incluye el mount)

```bash
gcloud run deploy "$SERVICE" \
  --source . \
  --region="$REGION" \
  --min-instances=1 --max-instances=1 \
  --cpu=4 --memory=8Gi --no-cpu-throttling --timeout=3600 \
  --set-env-vars=PROVIDER_MODE=vertex,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$REGION,OUTPUT_DIR=/mnt/gcs/output,DATA_DIR=/mnt/gcs/data,EDIT_MODE=cloud,VSE_STORAGE_BACKEND=volume,SHARED_VOLUME_PATH=/shared,VSE_WORKDIR=/shared/editor-workdir,VSE_OUTPUT=/mnt/gcs/output/edit-output,EDITOR_BASE_URL=http://127.0.0.1:8000 \
  --add-volume=name=gcsvol,type=cloud-storage,bucket=$BUCKET \
  --add-volume-mount=volume=gcsvol,mount-path=/mnt/gcs \
  --allow-unauthenticated
```

### Opción C — Cloud Build (`cloudbuild.yaml`)

Hay un `cloudbuild.yaml` parametrizado en la raíz (build → push a Artifact Registry → deploy).

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_BUCKET=$BUCKET,_REGION=$REGION,_SERVICE=$SERVICE,_REPO=$REPO,_IMAGE=$IMAGE,_VERTEX_LOCATION=$REGION
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
| `EDIT_MODE` | `cloud` | selecciona el adapter de volumen compartido |
| `VSE_STORAGE_BACKEND` | `volume` | materializa inputs del editor desde `/shared` |
| `SHARED_VOLUME_PATH` | `/shared` | scratch entre Next.js y FastAPI dentro del contenedor |
| `VSE_WORKDIR` | `/shared/editor-workdir` | temporales del pipeline de edición |
| `VSE_OUTPUT` | `/mnt/gcs/output/edit-output` | copia durable producida por FastAPI (`edit-output/<editJobId>/final.mp4`) |
| `EDITOR_BASE_URL` | `http://127.0.0.1:8000` | editor interno, sin ingress público |
| `PIPELINE_AUTO_APPROVE` | `true`/`false` | aprobar jobs solos (opcional) |
| `APP_PASSWORD` | tu contraseña | activa el login de la app (ver §4) |
| `APP_AUTH_SECRET` | hex aleatorio largo | firma de la sesión (ver §4) |

> `APP_PASSWORD`/`APP_AUTH_SECRET` son secretos: seteálos en el servicio (Cloud Run → Variables
> & Secrets) o vía Secret Manager, **no** los pongas en `cloudbuild.yaml`.

(Los modelos por defecto y demás knobs siguen en `.env.example`.)

---

## 4. Control de acceso ⚠️ (importante por costo)

La app **dispara generaciones que cuestan dinero** (Veo/Gemini). Recomendado: dejá Cloud Run
accesible (`--allow-unauthenticated`, para poder entrar desde el navegador) pero activá el
**login de la app** para que no la use un intruso.

### Login de la app (recomendado)

Seteá estas dos env vars en el servicio (si falta una, el login queda desactivado):

```bash
# secret aleatorio largo:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Valor |
|---|---|
| `APP_PASSWORD` | la contraseña de acceso |
| `APP_AUTH_SECRET` | hex aleatorio largo (firma de la sesión) |

Con eso, **toda** ruta/API exige una sesión válida (cookie firmada HMAC, HttpOnly+Secure):
sin login, las páginas redirigen a `/login` y las APIs devuelven 401 (nadie puede disparar
generaciones). Logout en `/api/auth/logout`.

### Alternativa: cerrar a nivel infra

Si preferís ni exponerla: deploy con `--no-allow-unauthenticated` y entrá con un túnel
autenticado, o poné IAP / Load Balancer delante:

```bash
gcloud run services proxy "$SERVICE" --region="$REGION"   # túnel local autenticado
```

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
- **Transcripción (faster-whisper)** y el pipeline ffmpeg sí corren en la imagen combinada;
  dimensioná CPU/memoria para la carga del editor.
