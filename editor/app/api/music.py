"""Endpoint de subida de música ``POST /musica`` (Req 8.1, 8.2).

Recibe un archivo de audio vía ``multipart/form-data``, valida **formato** (por
extensión dentro de :data:`app.config.SUPPORTED_MUSIC_EXTENSIONS`) y **tamaño**
(<= 100 MB), y lo almacena devolviendo un ``musica_id``. Si el archivo tiene una
extensión no soportada o supera el límite, se **rechaza** conservando el audio y
el video originales sin modificar (Req 8.2): el rechazo ocurre antes de cualquier
almacenamiento.

La aceptación se basa en la **extensión** y no en la cabecera del contenedor: la
mezcla de música la realiza ffmpeg, que decodifica de forma nativa MP3, AAC/M4A,
OGG/Opus, FLAC, etc. Validar aquí una cabecera RIFF/WAVE rechazaba archivos
perfectamente reproducibles (por ejemplo, un MP3 con extensión ``.wav``); es
ffmpeg quien valida de verdad el contenido al mezclar.

Comportamiento (contrato del diseño):

* **200 OK:** ``{"musica_id": ..., "nombre_original": ..., "duracion_s": null}``.
* **415 UNSUPPORTED_AUDIO:** la extensión del archivo no es un formato de audio
  soportado (Req 8.2).
* **413 MUSIC_TOO_LARGE:** el archivo supera 100 MB (Req 8.2).

Referencias de requisitos: 8.1, 8.2.
"""

from __future__ import annotations

import logging
import os
from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import JSONResponse

from app import config
from app.models.errors import error_envelope
from app.storage.music_store import MusicStore, MusicStorageError

logger = logging.getLogger(__name__)

router = APIRouter(tags=["musica"])

_music_store = MusicStore()


def obtener_music_store() -> MusicStore:
    """Dependencia que provee el :class:`MusicStore` a usar por el endpoint."""
    return _music_store


def _extension_soportada(nombre: str, tamano: int) -> bool:
    """Comprueba que el archivo tenga una extensión de audio soportada (Req 8.2).

    La validación es puramente por **extensión** (dentro de
    :data:`app.config.SUPPORTED_MUSIC_EXTENSIONS`); el contenido real lo valida
    ffmpeg en el paso de mezcla. Cuando se rechaza, se registra el nombre, el
    tamaño y la extensión para poder diagnosticar futuros casos.
    """
    ext = os.path.splitext(nombre or "")[1].lower()
    if ext not in config.SUPPORTED_MUSIC_EXTENSIONS:
        logger.warning(
            "Rechazado audio %s (%d bytes): extensión %r no soportada",
            nombre,
            tamano,
            ext,
        )
        return False
    return True


@router.post("/musica")
async def subir_musica(
    file: UploadFile = File(...),
    store: MusicStore = Depends(obtener_music_store),
) -> JSONResponse:
    """Sube y almacena el archivo de audio de música (Req 8.1, 8.2)."""
    nombre = file.filename or "sin_nombre"
    contenido = await file.read()

    # --- Validación de tamaño (Req 8.2) ---
    if len(contenido) > config.MAX_MUSIC_SIZE_BYTES:
        return JSONResponse(
            status_code=413,
            content=error_envelope(
                "MUSIC_TOO_LARGE",
                "El archivo de música supera el tamaño máximo (100 MB).",
                {"tamano_bytes": len(contenido), "maximo_bytes": config.MAX_MUSIC_SIZE_BYTES},
            ),
        )

    # --- Validación de formato por extensión (Req 8.2) ---
    if not _extension_soportada(nombre, len(contenido)):
        formatos = ", ".join(config.SUPPORTED_MUSIC_EXTENSIONS)
        return JSONResponse(
            status_code=415,
            content=error_envelope(
                "UNSUPPORTED_AUDIO",
                (
                    "El archivo de música no tiene un formato de audio soportado. "
                    f"Formatos aceptados: {formatos}."
                ),
                {"nombre": nombre, "formatos_soportados": list(config.SUPPORTED_MUSIC_EXTENSIONS)},
            ),
        )

    # --- Almacenamiento ---
    try:
        almacenada = store.guardar(nombre, contenido)
    except MusicStorageError as exc:
        return JSONResponse(
            status_code=422,
            content=error_envelope(
                "MUSIC_STORAGE_FAILED",
                "No se pudo almacenar el archivo de música.",
                {"motivo": exc.motivo},
            ),
        )

    return JSONResponse(
        status_code=200,
        content={
            "musica_id": almacenada.musica_id,
            "nombre_original": almacenada.nombre_original,
            "duracion_s": None,
        },
    )
