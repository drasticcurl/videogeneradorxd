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
- **Modelo de transcripción (whisper) horneado / offline**: el modelo faster-whisper `small`
  (`Systran/faster-whisper-small`) se **pre-descarga en build-time** dentro de la imagen
  (`/opt/models/faster-whisper/small`). En runtime se corre **100% offline**
  (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `VSE_WHISPER_MODEL_DIR=/opt/models/faster-whisper`),
  de modo que el paso TRANSCRIBIR **nunca** consulta HuggingFace. Esto evita el fallo por rate
  limit `429 Too Many Requests` del Hub (y los cuelgues sin salida a internet) que aparecía al
  activar subtítulos en Cloud Run. Si se cambia el modelo en ajustes a **otro no horneado**,
  habría que hornear también ese modelo en el Dockerfile (o quitar el modo offline y proveer un
  `HF_TOKEN` con acceso al Hub). Si la descarga falla en el build, el build falla (te enterás en
  build-time, no en runtime).

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

La imagen se etiqueta con `_TAG` (por defecto `latest`), así que un `gcloud builds submit`
manual funciona sin depender de ningún valor de trigger. Ese mismo `_TAG` se pasa al build de
Docker como `--build-arg APP_VERSION=${_TAG}`, de modo que la versión queda horneada en la
imagen (ver más abajo, "Banner de versión"). Para fijar una etiqueta específica,
agregá `_TAG` a las substitutions:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=_BUCKET=$BUCKET,_REGION=$REGION,_SERVICE=$SERVICE,_REPO=$REPO,_IMAGE=$IMAGE,_VERTEX_LOCATION=$REGION,_TAG=v1.2.3
```

Para CI/CD: creá un **trigger de Cloud Build** apuntando a `cloudbuild.yaml` (Cloud Build →
Triggers → Connect repository). Cada push buildea y deploya (podés mapear `_TAG` al SHA del
commit desde la configuración del trigger).

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
| `VSE_SILENCE_AUTO_APPLY` | *(sin setear)* | auto-aplica los silencios detectados sin pausar por edición manual. Truthy (`1`/`true`/`yes`) → siempre auto-aplica; falsy explícito → siempre pausa. Si NO se setea, usa `EDIT_MODE` como default (en `cloud` auto-aplica, en `local` pausa). Evita el cuelgue indefinido al 25 % cuando "cortar silencios" está activado en Cloud Run |
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

## 6b. Banner de versión (saber si un deploy realmente subió)

Cada build hornea una identidad en la imagen y la muestra en un chip pequeño fijo en la esquina
inferior derecha (`versión · build`), visible en todas las páginas. Así se ve al instante si una
revisión nueva quedó activa sin mirar logs de `gcloud`.

- `_TAG` alimenta `APP_VERSION` (`--build-arg APP_VERSION=${_TAG}` en `cloudbuild.yaml`), que se
  expone al cliente como `NEXT_PUBLIC_APP_VERSION` (Next.js inyecta las `NEXT_PUBLIC_*` en build).
- El momento del build se hornea como `NEXT_PUBLIC_BUILD_TIME` durante `npm run build`.
- Chequeo rápido por curl: `GET /api/version` devuelve `{ version, buildTime }`.

---

## 6c. Verificación post-deploy del plano de control (obligatoria)

Un deploy puede reportarse OK y, aun así, dejar activa una revisión que **no**
coincide con lo esperado (imagen vieja, CPU con throttling, o `min/max` != 1).
Eso es exactamente la **categoría D** del diagnóstico de `unir-step-hang`: "una
revisión antigua o una configuración distinta de la esperada". Por eso la
verificación se hace **desde el plano de control** (Cloud Run), nunca infiriéndola
desde dentro del contenedor.

- **Opción C (Cloud Build):** el paso `verify-control-plane` de `cloudbuild.yaml`
  corre automáticamente después del deploy. Ejecuta `gcloud run services describe`
  para resolver la revisión que sirve tráfico y comprueba, sobre esa revisión:
  **CPU always allocated** (`run.googleapis.com/cpu-throttling == false`, es decir
  `--no-cpu-throttling`), la **etiqueta de imagen** esperada (`${_TAG}`) y
  `min == max == 1`. Si algo no coincide, el paso **hace fallar el deploy** (sale
  con código != 0), de modo que una revisión vieja/errónea nunca pasa en silencio.

- **Opciones A y B (deploy manual / desde GitHub):** ejecutá esta misma
  comprobación a mano tras el deploy. Falla (sale != 0) si algo no coincide:

  ```bash
  SERVICE=videogeneradorxd
  REGION=us-central1
  EXPECTED_IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/cloud-run-source-deploy/videogeneradorxd/videogeneradorxd:latest"  # ajustá el _TAG

  REV="$(gcloud run services describe "$SERVICE" --region "$REGION" --platform managed \
        --format='value(status.traffic[0].revisionName)')"
  [ -n "$REV" ] || REV="$(gcloud run services describe "$SERVICE" --region "$REGION" --platform managed \
        --format='value(status.latestReadyRevisionName)')"
  echo "Revisión activa: $REV"

  CPU="$(gcloud run revisions describe "$REV" --region "$REGION" --platform managed \
        --format="value(metadata.annotations['run.googleapis.com/cpu-throttling'])")"
  MIN="$(gcloud run revisions describe "$REV" --region "$REGION" --platform managed \
        --format="value(metadata.annotations['autoscaling.knative.dev/minScale'])")"
  MAX="$(gcloud run revisions describe "$REV" --region "$REGION" --platform managed \
        --format="value(metadata.annotations['autoscaling.knative.dev/maxScale'])")"
  IMG="$(gcloud run revisions describe "$REV" --region "$REGION" --platform managed \
        --format='value(spec.containers[0].image)')"

  FAIL=0
  [ "$CPU" = "false" ] || { echo "FAIL: CPU no always-allocated (cpu-throttling='$CPU')"; FAIL=1; }
  [ "$MIN" = "1" ]     || { echo "FAIL: minScale='$MIN' (esperado 1)"; FAIL=1; }
  [ "$MAX" = "1" ]     || { echo "FAIL: maxScale='$MAX' (esperado 1)"; FAIL=1; }
  [ "$IMG" = "$EXPECTED_IMAGE" ] || { echo "FAIL: imagen '$IMG' != esperada '$EXPECTED_IMAGE'"; FAIL=1; }
  [ "$FAIL" -eq 0 ] && echo "OK: CPU always allocated, min=max=1, imagen coincide." || exit 1
  ```

  Complementá con el chequeo de identidad del build (§6b): el header muestra
  `v0.9123 banana xD` y `GET /api/version` devuelve el mismo identificador para
  esa misma revisión.

## 7. Notas / límites

- **Una sola instancia**: la cola de jobs vive en memoria. No escalar a >1 sin externalizar
  cola y storage (ver nota de arquitectura en `.kiro/steering/project-context.md`).
- **GCS FUSE** no es un filesystem POSIX 100%: `rename`/`append` son más lentos. `db.ts` ya
  tiene un fallback de escritura para eso. Para un solo usuario anda bien.
- **Transcripción (faster-whisper)** y el pipeline ffmpeg sí corren en la imagen combinada;
  dimensioná CPU/memoria para la carga del editor.
