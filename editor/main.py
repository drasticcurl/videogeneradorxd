"""Punto de entrada del backend FastAPI (vertical-shorts-editor).

Esta aplicación FastAPI sirve de base para el resto del backend e integra la
verificación de dependencias al arrancar (Verificador_de_Dependencias, tarea 10)
y los routers de subida de clips y música (tarea 13).

Routers registrados:

- `POST /clips` y `POST /musica` (tarea 13, Req 1 y 8.1/8.2).
- `POST /procesar`, `GET /progreso/{id}` (JSON + SSE) y `GET /descargar/{id}`
  (tarea 14, Req 9.5, 10.x, 11.x), cableados con el Gestor de Jobs y el ejecutor
  en background compartidos.

Verificación de dependencias al iniciar (Req 12):

- En el evento de arranque (lifespan) se comprueban `ffmpeg`, `ffprobe`,
  `auto-editor` y `faster-whisper` dentro de un plazo total de 10 s.
- Si falta al menos una dependencia se **aborta el arranque** lanzando una
  excepción (fallo de inicialización), identificando por nombre las faltantes
  (Req 12.2, 12.4). Si todas están disponibles, el arranque continúa (Req 12.5).

Se ejecuta localmente con:

    uvicorn main:app --host 127.0.0.1 --port 8000

Referencias de requisitos: 12.4, 12.5, 14.5, 14.6.
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, List

# IMPORTANTE: ajustar el PATH del proceso ANTES de importar/usar cualquier cosa
# que resuelva binarios externos (ffmpeg, ffprobe, auto-editor). Al lanzarse
# desde la GUI (doble clic) el PATH de Homebrew puede no estar presente; esto lo
# corrige de forma idempotente para que tanto la verificación de dependencias
# como los subprocess posteriores hereden el PATH correcto.
from app.deps import asegurar_path_local, preparar_auto_editor

asegurar_path_local()
# Algunos empaquetados de auto_editor dejan su binario sin bit de ejecución
# ("[Errno 13] Permission denied") y, en macOS, sin firmar o en cuarentena, lo
# que hace que el sistema lo mate con SIGKILL ("Killed: 9", código 247). Se
# corrige de forma idempotente y tolerante a fallos en el arranque (chmod +x y,
# en macOS, xattr/codesign best-effort).
preparar_auto_editor()

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from app import config  # noqa: E402
from app.api import clips as clips_router  # noqa: E402
from app.api import download as download_router  # noqa: E402
from app.api import music as music_router  # noqa: E402
from app.api import process as process_router  # noqa: E402
from app.api import progress as progress_router  # noqa: E402
from app.api import render as render_router  # noqa: E402
from app.api import settings_config as settings_config_router  # noqa: E402
from app.api import silencios as silencios_router  # noqa: E402
from app.api import subtitles as subtitles_router  # noqa: E402
from app.deps import DependenciasFaltantesError, verificar_dependencias  # noqa: E402

# Configura el logging al importar el módulo. Solo si aún no hay handlers en el
# root logger, para no duplicar la configuración cuando se ejecuta bajo uvicorn
# (que instala sus propios handlers).
if not logging.getLogger().handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
    )

logger = logging.getLogger(__name__)


def _origenes_cors() -> List[str]:
    """Orígenes permitidos por CORS.

    Por defecto permite la Interfaz local en el puerto 3000 (``localhost`` y
    ``127.0.0.1``). Se puede sobrescribir con la variable de entorno
    ``VSE_CORS_ORIGINS`` (lista separada por comas).
    """
    override = os.environ.get("VSE_CORS_ORIGINS")
    if override:
        origenes = [o.strip() for o in override.split(",") if o.strip()]
        if origenes:
            return origenes
    return ["http://localhost:3000", "http://127.0.0.1:3000"]


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Ciclo de vida de la app: verifica dependencias antes de servir (Req 12).

    Ejecuta el Verificador_de_Dependencias en el arranque. Si falta alguna
    dependencia, lanza :class:`DependenciasFaltantesError`, lo que impide que el
    Backend complete su arranque e indica el fallo de inicialización (Req 12.4).
    Cuando todas están disponibles, cede el control y la app comienza a servir
    peticiones (Req 12.5).
    """
    resultado = verificar_dependencias()
    if resultado.debe_bloquear:
        faltantes = resultado.faltantes
        logger.error(
            "No se puede iniciar el Backend: faltan dependencias requeridas: %s",
            ", ".join(faltantes),
        )
        # Pista accionable para resolver cada tipo de dependencia (Req 12.4).
        binarios = {"ffmpeg", "ffprobe"}
        if binarios.intersection(faltantes):
            logger.error(
                "  - Para ffmpeg/ffprobe instala ffmpeg con Homebrew: "
                "`brew install ffmpeg`."
            )
        if "auto-editor" in faltantes or "faster-whisper" in faltantes:
            logger.error(
                "  - Para auto-editor y faster-whisper instala las dependencias "
                "de Python: `pip install -r requirements.txt` (dentro de tu venv)."
            )
        logger.error(
            "  - Si arrancas con doble clic, el PATH de Homebrew "
            "(/opt/homebrew/bin, /usr/local/bin) se añade automáticamente; "
            "verifica que los binarios estén realmente instalados."
        )
        # Req 12.4: impedir que el Backend complete su arranque.
        raise DependenciasFaltantesError(faltantes)
    logger.info("Todas las dependencias están disponibles; el Backend inicia.")
    yield


app = FastAPI(
    title="Vertical Shorts Editor",
    description=(
        "Backend local que envuelve el Motor de Procesamiento de shorts "
        "verticales (unir, cortar silencios, transcribir, subtitular, música)."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# CORS: permite que la Interfaz (navegador en localhost:3000) llame al backend
# (localhost:8000). Sin esto el navegador bloquea la respuesta y el frontend
# recibe "Failed to fetch". No se usan credenciales (operación local sin auth).
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origenes_cors(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def registrar_peticiones(request: Request, call_next):
    """Middleware de logging: registra método, ruta, estado y duración (ms).

    Ejemplo de línea registrada: ``POST /clips -> 200 (123 ms)``. Ante una
    excepción no controlada, la registra y la re-lanza para que la maneje la
    capa correspondiente.
    """
    inicio = time.monotonic()
    try:
        respuesta = await call_next(request)
    except Exception:
        duracion_ms = (time.monotonic() - inicio) * 1000
        logger.exception(
            "%s %s -> ERROR (%.0f ms)",
            request.method,
            request.url.path,
            duracion_ms,
        )
        raise
    duracion_ms = (time.monotonic() - inicio) * 1000
    logger.info(
        "%s %s -> %d (%.0f ms)",
        request.method,
        request.url.path,
        respuesta.status_code,
        duracion_ms,
    )
    return respuesta


# Routers de la API (tarea 13): subida de clips (Req 1) y música (Req 8.1, 8.2).
app.include_router(clips_router.router)
app.include_router(music_router.router)

# Routers de la API (tarea 14): procesamiento, progreso y descarga, cableados con
# el Gestor de Jobs y el ejecutor en background compartidos (Req 9.5, 10.x, 11.x).
app.include_router(process_router.router)
app.include_router(progress_router.router)
app.include_router(download_router.router)

# Endpoints nuevos: revisión manual de subtítulos, elección del motor de render
# (spec subtitulos-ia-remotion) y configuración por defecto del usuario
# (persistencia local en JSON).
app.include_router(subtitles_router.router)
app.include_router(render_router.router)
app.include_router(settings_config_router.router)

# Edición manual de silencios (spec edicion-avanzada-shorts, tarea 5.4, Req 2.6,
# 14.1, 14.5): GET/POST /silencios/{job_id}. El timeline usa el vídeo unido
# servido por GET /workfile/{job_id}/{nombre} (que ya sirve unido.mp4 y
# cortado.mp4 por nombre desde el workdir del Job).
app.include_router(silencios_router.router)


@app.get("/salud")
def salud() -> dict[str, str]:
    """Endpoint de salud trivial para verificar que el backend está arriba.

    No forma parte del contrato funcional del pipeline; sirve como comprobación
    básica de disponibilidad durante el desarrollo.
    """
    return {"estado": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=config.BACKEND_HOST,
        port=config.BACKEND_PORT,
        reload=False,
    )
