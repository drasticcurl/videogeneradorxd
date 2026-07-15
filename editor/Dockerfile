# syntax=docker/dockerfile:1
# ============================================================================
# Editor sidecar container for the multi-container Cloud Run service.
# Runs the FastAPI editor (5-step video editing pipeline) as an internal-only
# sidecar accessible only over localhost from the generator container.
#
# The editor requires: ffmpeg, ffprobe, Python 3.11+, faster-whisper, auto-editor.
# ============================================================================

# ---------- base: Python + ffmpeg + system deps ----------
FROM python:3.11-slim AS base

# Install ffmpeg (includes ffprobe) and other system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libass-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------- deps: install Python dependencies ----------
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ---------- app: copy application code ----------
COPY . .

# ---------- runtime config ----------
# The editor sidecar binds to 127.0.0.1:8000 in cloud mode.
# It is NOT exposed to ingress — only reachable from the generator container.
ENV VSE_STORAGE_BACKEND=volume
ENV EDIT_MODE=cloud
ENV SHARED_VOLUME_PATH=/shared
ENV VSE_WORKDIR=/shared/editor-workdir
ENV VSE_OUTPUT=/shared/editor-output

# Health check (used by Cloud Run sidecar health probes)
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/salud')" || exit 1

EXPOSE 8000

# Start the editor on localhost only (sidecar mode)
CMD ["python", "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "8000"]
