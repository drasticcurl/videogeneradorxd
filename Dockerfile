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

# ---------- Combined Cloud Run runtime ----------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

# ffmpeg package includes ffprobe and the runtime filters/codecs used by the
# editor; libass9 provides subtitle rendering support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates python3 ffmpeg libass9 bash \
    && rm -rf /var/lib/apt/lists/*

COPY --from=python-deps /opt/venv /opt/venv
COPY --from=next-builder /app/.next/standalone ./
COPY --from=next-builder /app/.next/static ./.next/static
COPY editor ./editor
COPY scripts/start-combined.sh ./scripts/start-combined.sh
RUN chmod 0755 ./scripts/start-combined.sh \
    && mkdir -p /shared /shared/editor-workdir

EXPOSE 8080
CMD ["/app/scripts/start-combined.sh"]
