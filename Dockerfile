# syntax=docker/dockerfile:1
# ============================================================================
# Imagen de produccion para Cloud Run (Next.js standalone, SIN ffmpeg).
# El stitch del video final lo hace el usuario en su PC (descarga el ZIP).
# El almacenamiento (OUTPUT_DIR/DATA_DIR) apunta a un bucket montado por Cloud Run
# (Cloud Storage FUSE), asi que NO se guarda nada dentro de la imagen.
# ============================================================================

# ---------- deps: instala dependencias con cache ----------
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder: compila Next en modo standalone ----------
FROM node:20-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runner: imagen final minima ----------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run inyecta PORT (default 8080). El server standalone respeta PORT/HOSTNAME.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# Output standalone: server.js + node_modules minimo + .next necesario.
COPY --from=builder /app/.next/standalone ./
# Assets estaticos (no van en standalone).
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 8080
CMD ["node", "server.js"]
