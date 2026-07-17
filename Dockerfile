# syntax=docker/dockerfile:1

# ---------- Node dependencies ----------
FROM node:20-bookworm-slim AS node-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- Next.js standalone build ----------
FROM node:20-bookworm-slim AS next-builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Build identity baked into the client bundle. NEXT_PUBLIC_* vars are inlined by
# Next.js at build time, so they travel into the standalone output and are shown
# by the version banner / GET /api/version.
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
# Manual deployment identifier baked once via env, space-separated from the
# image tag by getAppVersion(). Shown beside the `AUGC Pipeline` title and echoed
# by GET /api/version for the same build (spec `unir-step-hang`, Property 3).
ARG APP_IDENTIFIER="v0.9124 mango xD"
ENV NEXT_PUBLIC_APP_IDENTIFIER=$APP_IDENTIFIER
COPY --from=node-deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_BUILD_TIME is set inline for this build step only so the exact
# build moment is inlined alongside NEXT_PUBLIC_APP_VERSION.
RUN NEXT_PUBLIC_BUILD_TIME="$(date -u +%Y%m%d-%H%M%SZ)" npm run build

# ---------- Python virtual environment ----------
FROM node:20-bookworm-slim AS python-deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY editor/requirements.txt /tmp/editor-requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/editor-requirements.txt

# ---------- Pre-baked faster-whisper model (offline runtime) ----------
# El paso TRANSCRIBIR carga un modelo faster-whisper. En runtime, faster-whisper
# intenta resolver/descargar el modelo desde HuggingFace, lo que en Cloud Run
# falla con `429 Too Many Requests` (rate limit del Hub) y puede colgar la
# ejecución. Para evitarlo, el modelo se HORNEA en la imagen en build-time y el
# runtime corre 100% offline (ver la etapa `runner`).
#
# Se reutiliza el venv de `python-deps` (ya tiene faster-whisper y huggingface_hub)
# para descargar el repo `Systran/faster-whisper-small` a un directorio fijo.
# Si la descarga falla, el build FALLA aquí (te enterás en build-time, no en
# runtime).
FROM python-deps AS whisper-model
ARG WHISPER_MODEL=small
RUN /opt/venv/bin/python -c "from faster_whisper.utils import download_model; download_model('${WHISPER_MODEL}', output_dir='/opt/models/faster-whisper/${WHISPER_MODEL}')"

# ---------- Combined Cloud Run runtime ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
# HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE fuerzan a huggingface_hub a NO tocar la
# red (nunca consulta el Hub en runtime). VSE_WHISPER_MODEL_DIR apunta al
# directorio del modelo horneado para que la transcripción lo resuelva local
# (ver `editor/app/config.py::WHISPER_MODEL_DIR` y
# `editor/app/engine/transcribe.py::_modelo_factory_por_defecto`).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    VSE_WHISPER_MODEL_DIR=/opt/models/faster-whisper

# ffmpeg package includes ffprobe and the runtime filters/codecs used by the
# editor; libass9 provides subtitle rendering support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates python3 ffmpeg libass9 bash \
    && rm -rf /var/lib/apt/lists/*

COPY --from=python-deps /opt/venv /opt/venv
# Modelo faster-whisper horneado (transcripción offline en runtime).
COPY --from=whisper-model /opt/models /opt/models
COPY --from=next-builder /app/.next/standalone ./
COPY --from=next-builder /app/.next/static ./.next/static
COPY editor ./editor
COPY scripts/start-combined.sh ./scripts/start-combined.sh
RUN chmod 0755 ./scripts/start-combined.sh \
    && mkdir -p /shared /shared/editor-workdir

EXPOSE 8080
CMD ["/app/scripts/start-combined.sh"]
