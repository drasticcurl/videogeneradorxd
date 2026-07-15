"""Endpoint de inicio de procesamiento ``POST /procesar`` (Req 9.5, 10.1, 10.2).

Recibe (JSON) el ``Orden_de_Clips`` vigente, el ``musica_id`` opcional y el
conjunto completo de ``ajustes``; **valida** la petición y, si es válida, crea un
Job en el :class:`~app.jobs.manager.JobManager` y lanza el pipeline en background
con el :class:`~app.jobs.runner.JobRunner`, devolviendo el ``job_id`` en estado
``en_cola`` rápidamente (Req 10.1).

Contrato (según el diseño):

* **202 Accepted:** ``{"job_id": "job_...", "estado": "en_cola"}`` devuelto en
  <= 2 s (Req 10.1). El pipeline se ejecuta en background sin bloquear la
  respuesta.
* **400 INVALID_REQUEST:** sin ``orden_clips``, con ``orden_clips`` vacío, con
  más de ``MAX_CLIPS_PER_JOB`` (500) clips, o sin los ajustes requeridos / con
  ajustes inválidos (Req 10.2, Propiedad 21). En todos estos casos **no se crea
  ningún Job** y el error identifica el motivo/campo.

Las dependencias :func:`obtener_gestor_jobs` y :func:`obtener_job_runner` proveen
el Gestor de Jobs y el ejecutor compartidos; ambas son sustituibles en pruebas
con ``app.dependency_overrides`` (por ejemplo para inyectar un ``JobRunner`` con
los pasos del pipeline mockeados).

Referencias de requisitos: 9.5, 10.1, 10.2.
"""

from __future__ import annotations

import logging
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import config
from app.jobs.manager import JobManager, gestor_jobs
from app.jobs.runner import JobRunner
from app.models.errors import error_envelope
from app.models.settings import Ajustes, validar_ajustes
from app.storage.backend import (
    StorageBackend,
    get_storage_backend,
    resolver_orden_clips as _resolver_orden_backend,
)
from app.storage.clip_store import ClipStore
from app.storage.music_store import MusicStore
from app.storage.workdir import JobWorkdir

router = APIRouter(tags=["procesar"])

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Dependencias compartidas (Gestor de Jobs + ejecutor en background)
# ---------------------------------------------------------------------------
def _resolver_musica_por_id(musica_id: Optional[str]) -> Optional[str]:
    """Traduce un ``musica_id`` a la ruta del WAV almacenado, o ``None``.

    Busca en el directorio base del :class:`MusicStore` un archivo cuyo nombre
    empiece por el ``musica_id``. Si no hay música o no se encuentra, devuelve
    ``None`` para que el paso 5 (MUSICA) se omita (Req 8.3).
    """
    if not musica_id:
        return None
    from pathlib import Path
    materialized = config.resolve_permitted_input_file(musica_id)
    if materialized is not None:
        return str(materialized)
    if Path(musica_id).is_absolute():
        logger.warning("Rejected music path outside permitted local roots: %s", musica_id)
        return None
    base = MusicStore().base_dir
    if not base.exists():
        return None
    coincidencias = sorted(base.glob(f"{musica_id}.*"))
    return str(coincidencias[0]) if coincidencias else None


def _resolver_clip_por_id(clip_id: str) -> Optional[str]:
    """Traduce un ``clip_id`` a la ruta del clip de video almacenado, o ``None``.

    Los clips recibidos por ``POST /clips`` se persisten en el directorio base del
    :class:`ClipStore` con nombre ``{clip_id}{ext}`` (ver
    :mod:`app.storage.clip_store`). El ``Orden_de_Clips`` de ``POST /procesar``,
    en cambio, contiene **identificadores** de clip, no rutas. El pipeline (paso
    UNIR → ``ffprobe``) necesita rutas de archivo reales, así que aquí se resuelve
    el id a la ruta almacenada haciendo glob por ``{clip_id}.*`` (BUG: el pipeline
    recibía ids en vez de rutas y ``ffprobe`` fallaba con "No such file").

    Devuelve la ruta del archivo si existe, o ``None`` si no se encuentra.
    """
    if not clip_id:
        return None
    from pathlib import Path
    permitted = config.resolve_permitted_input_file(clip_id)
    if permitted is not None:
        return str(permitted)
    if Path(clip_id).is_absolute():
        logger.warning("Rejected clip path outside permitted local roots: %s", clip_id)
        return None
    base = ClipStore().base_dir
    if not base.exists():
        return None
    coincidencias = sorted(base.glob(f"{clip_id}.*"))
    return str(coincidencias[0]) if coincidencias else None


def _resolver_clip_por_key(clip_key: str, backend: StorageBackend, edit_job_id: str, workdir: str) -> Optional[str]:
    """Resolve a clip by Shared_Volume key (cloud mode).

    Materializes the input from the storage backend into the workdir.
    Returns the local path of the materialized file, or None on failure.
    """
    if not clip_key:
        return None
    try:
        from pathlib import Path
        materialized = backend.materialize_input(edit_job_id, clip_key, Path(workdir))
        return str(materialized)
    except (FileNotFoundError, ValueError) as exc:
        logger.error("Failed to materialize clip key %s: %s", clip_key, exc)
        return None


# Ejecutor compartido, cableado con el Gestor de Jobs por defecto de la app y con
# los resolutores de música y de clips. En pruebas se sustituye por un runner con
# pasos mockeados vía ``app.dependency_overrides[obtener_job_runner]``.
_job_runner = JobRunner(
    gestor_jobs,
    resolver_musica=_resolver_musica_por_id,
    resolver_clip=(lambda cid: _resolver_clip_por_id(cid) or cid),
)


def obtener_gestor_jobs() -> JobManager:
    """Dependencia que provee el :class:`JobManager` compartido de la app."""
    return gestor_jobs


def obtener_job_runner() -> JobRunner:
    """Dependencia que provee el :class:`JobRunner` compartido de la app."""
    return _job_runner


# ---------------------------------------------------------------------------
# Modelo de la petición (permisivo: la validación fina se hace en el endpoint
# para poder responder 400 INVALID_REQUEST en lugar de 422)
# ---------------------------------------------------------------------------
class ProcesarRequest(BaseModel):
    """Cuerpo de ``POST /procesar``.

    Todos los campos son opcionales a nivel de esquema para que la validación de
    negocio (orden 1..500, ajustes requeridos/válidos) se realice en el endpoint
    y devuelva ``400 INVALID_REQUEST`` con el motivo (Req 10.2), en vez del 422
    genérico de validación de esquema.
    """

    orden_clips: Optional[List[str]] = Field(default=None)
    musica_id: Optional[str] = Field(default=None)
    ajustes: Optional[Ajustes] = Field(default=None)
    # Cloud mode: edit_job_id from the generator, used for Shared_Volume key
    # namespacing. When provided, clips in orden_clips are treated as Shared_Volume
    # keys rather than local clip store IDs.
    edit_job_id: Optional[str] = Field(default=None)
    # TRANSITORIO (spec subtitulos-ia-remotion, Req 2.2, 8.3, 14.3): clave de
    # OpenAI para la corrección con IA. Viaja con la petición de procesado y se
    # propaga al ``JobManager`` EN MEMORIA; **nunca** se serializa a disco
    # (``config_store`` solo persiste ``Ajustes``, y esta clave está FUERA de
    # ``Ajustes``) ni se registra en logs (``repr=False`` la excluye de la
    # representación del modelo). Puede ser ``None`` (IA desactivada / sin clave).
    openai_api_key: Optional[str] = Field(default=None, repr=False)


def _invalid_request(message: str, details: dict) -> JSONResponse:
    """Construye una respuesta ``400 INVALID_REQUEST`` homogénea (Req 10.2)."""
    return JSONResponse(
        status_code=400,
        content=error_envelope("INVALID_REQUEST", message, details),
    )


@router.post("/procesar")
async def procesar(
    peticion: ProcesarRequest,
    manager: JobManager = Depends(obtener_gestor_jobs),
    runner: JobRunner = Depends(obtener_job_runner),
) -> JSONResponse:
    """Valida la petición y, si es válida, crea un Job y lanza el pipeline.

    Rechaza con ``400 INVALID_REQUEST`` sin crear Job cuando la entrada es
    inválida (Req 10.2, Propiedad 21). En caso válido responde ``202`` con el
    ``job_id`` en estado ``en_cola`` (Req 10.1).
    """
    orden = peticion.orden_clips

    # --- Validación del Orden_de_Clips (Req 10.2, Propiedad 21) ---
    if orden is None:
        return _invalid_request(
            "La petición debe incluir 'orden_clips'.", {"campo": "orden_clips"}
        )
    if not isinstance(orden, list) or len(orden) < config.MIN_CLIPS_PER_JOB:
        return _invalid_request(
            "'orden_clips' no puede estar vacío.",
            {"campo": "orden_clips", "recibidos": len(orden) if isinstance(orden, list) else 0},
        )
    if len(orden) > config.MAX_CLIPS_PER_JOB:
        return _invalid_request(
            (
                "El número máximo de clips por Job es "
                f"{config.MAX_CLIPS_PER_JOB}."
            ),
            {
                "campo": "orden_clips",
                "recibidos": len(orden),
                "maximo": config.MAX_CLIPS_PER_JOB,
            },
        )

    # --- Validación de los ajustes (Req 10.2) ---
    if peticion.ajustes is None:
        return _invalid_request(
            "La petición debe incluir 'ajustes'.", {"campo": "ajustes"}
        )

    campos_invalidos = validar_ajustes(peticion.ajustes)
    if campos_invalidos:
        return _invalid_request(
            "Uno o más ajustes están fuera de rango o no son válidos.",
            {"campos_invalidos": campos_invalidos},
        )

    # --- Creación del Job y lanzamiento en background (Req 10.1) ---
    job_id = f"job_{uuid.uuid4().hex}"
    workdir = str(JobWorkdir(job_id).root)

    # In cloud/volume mode with an edit_job_id, materialize inputs from the
    # Shared_Volume before launching the pipeline. The orden_clips entries are
    # treated as Shared_Volume keys instead of local clip store IDs.
    resolved_music_id = peticion.musica_id
    if peticion.edit_job_id and config.is_volume_backend():
        backend = get_storage_backend()
        from pathlib import Path
        workdir_path = Path(workdir)
        workdir_path.mkdir(parents=True, exist_ok=True)
        try:
            materialized = _resolver_orden_backend(
                orden, backend, peticion.edit_job_id, workdir_path
            )
            # Replace orden with materialized local paths
            orden = [str(p) for p in materialized]
            if peticion.musica_id:
                resolved_music_id = str(
                    backend.materialize_input(
                        peticion.edit_job_id,
                        peticion.musica_id,
                        workdir_path,
                    )
                )
        except (FileNotFoundError, ValueError) as exc:
            campo = "musica_id" if peticion.musica_id and peticion.musica_id in str(exc) else "orden_clips"
            return _invalid_request(
                f"Input materialization failed: {exc}",
                {"campo": campo, "error": str(exc)},
            )

    manager.crear_job(
        job_id,
        orden,
        peticion.ajustes,
        workdir,
        musica_id=resolved_music_id,
        # Clave transitoria de OpenAI (Req 2.2): se propaga al Gestor de Jobs,
        # que la guarda FUERA de la serialización del Job (mapa en memoria) y la
        # elimina al alcanzar un estado terminal. Nunca se persiste ni se loguea.
        openai_api_key=peticion.openai_api_key,
    )

    # Store the edit_job_id on the internal job for persist_output later
    if peticion.edit_job_id:
        manager.establecer_edit_job_id(job_id, peticion.edit_job_id)

    # Lanza el pipeline sin bloquear: ``lanzar`` programa la ejecución en el
    # executor y devuelve de inmediato, por lo que la respuesta llega en <= 2 s.
    await runner.lanzar(job_id)

    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "estado": "en_cola"},
    )
