"""Endpoint de subida de clips ``POST /clips`` (Req 1).

Recibe entre 1 y 50 archivos de video vía ``multipart/form-data`` (el orden de
las partes define el orden de recepción), **revalida** formato y tamaño en el
backend, y almacena los clips de forma **atómica** delegando en
:class:`~app.storage.clip_store.ClipStore`.

Comportamiento (contrato del diseño):

* **200 OK:** devuelve ``{"clips": [{id, nombre_original, posicion,
  tamano_bytes, duracion_s}, ...]}`` con un identificador único por clip y su
  posición ``1..n`` en el orden de recepción (Req 1.2, 1.3).
* **400 INVALID_REQUEST:** número de archivos fuera de ``1..50`` (Req 1.1, 1.5).
* **415 UNSUPPORTED_FORMAT:** algún archivo con formato no soportado (Req 1.4);
  no se almacena nada.
* **413 CLIP_TOO_LARGE:** algún archivo supera 500 MB (Req 1.4); no se almacena
  nada.
* **422 CLIP_STORAGE_FAILED:** fallo de almacenamiento; se identifican los clips
  no almacenados y no queda almacenamiento parcial (Req 1.6).

La instancia de :class:`ClipStore` se resuelve mediante la dependencia
:func:`obtener_clip_store`, sustituible en pruebas con
``app.dependency_overrides``.

Referencias de requisitos: 1.1, 1.2, 1.3, 1.4, 1.6.
"""

from __future__ import annotations

import os
from typing import List

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import JSONResponse

from app import config
from app.models.errors import error_envelope
from app.storage.clip_store import ClipStore, ClipStorageError

router = APIRouter(tags=["clips"])

# Almacén por defecto (producción). En pruebas se sustituye vía
# ``app.dependency_overrides[obtener_clip_store]``.
_clip_store = ClipStore()


def obtener_clip_store() -> ClipStore:
    """Dependencia que provee el :class:`ClipStore` a usar por el endpoint."""
    return _clip_store


def _extension(nombre: str) -> str:
    return os.path.splitext(nombre or "")[1].lower()


@router.post("/clips")
async def subir_clips(
    files: List[UploadFile] = File(...),
    store: ClipStore = Depends(obtener_clip_store),
) -> JSONResponse:
    """Sube y almacena 1..50 clips de video preservando el orden (Req 1)."""
    # --- Validación de cardinalidad (Req 1.1, 1.5) ---
    if not files:
        return JSONResponse(
            status_code=400,
            content=error_envelope(
                "INVALID_REQUEST",
                "Debe enviarse al menos un clip de video.",
                {"recibidos": 0},
            ),
        )
    if len(files) > config.MAX_CLIPS_PER_UPLOAD:
        return JSONResponse(
            status_code=400,
            content=error_envelope(
                "INVALID_REQUEST",
                (
                    "El número máximo de archivos por adición es "
                    f"{config.MAX_CLIPS_PER_UPLOAD}."
                ),
                {"recibidos": len(files), "maximo": config.MAX_CLIPS_PER_UPLOAD},
            ),
        )

    # --- Lectura y revalidación de formato/tamaño (Req 1.4) ---
    entradas: List[tuple[str, bytes]] = []
    formato_invalido: List[str] = []
    demasiado_grandes: List[str] = []

    for archivo in files:
        nombre = archivo.filename or "sin_nombre"
        contenido = await archivo.read()

        ext = _extension(nombre)
        if ext not in config.SUPPORTED_VIDEO_EXTENSIONS:
            formato_invalido.append(nombre)
        elif len(contenido) > config.MAX_CLIP_SIZE_BYTES:
            demasiado_grandes.append(nombre)

        entradas.append((nombre, contenido))

    # Rechazo temprano sin almacenar nada si hay archivos inválidos.
    if formato_invalido:
        return JSONResponse(
            status_code=415,
            content=error_envelope(
                "UNSUPPORTED_FORMAT",
                "Uno o más archivos tienen un formato de video no soportado.",
                {
                    "archivos": formato_invalido,
                    "formatos_soportados": list(config.SUPPORTED_VIDEO_EXTENSIONS),
                },
            ),
        )
    if demasiado_grandes:
        return JSONResponse(
            status_code=413,
            content=error_envelope(
                "CLIP_TOO_LARGE",
                "Uno o más archivos superan el tamaño máximo por clip (500 MB).",
                {
                    "archivos": demasiado_grandes,
                    "maximo_bytes": config.MAX_CLIP_SIZE_BYTES,
                },
            ),
        )

    # --- Almacenamiento atómico (Req 1.2, 1.3, 1.6) ---
    try:
        clips = store.guardar(entradas)
    except ClipStorageError as exc:
        return JSONResponse(
            status_code=422,
            content=error_envelope(
                "CLIP_STORAGE_FAILED",
                "No se pudieron almacenar uno o más clips; no se guardó ninguno.",
                {"clips_no_almacenados": exc.clips_fallidos, "motivo": exc.motivo},
            ),
        )

    return JSONResponse(
        status_code=200,
        content={
            "clips": [
                {
                    "id": clip.id,
                    "nombre_original": clip.nombre_original,
                    "posicion": clip.posicion,
                    "tamano_bytes": clip.tamano_bytes,
                    "duracion_s": clip.duracion_s,
                }
                for clip in clips
            ]
        },
    )
