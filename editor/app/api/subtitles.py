"""Endpoints de revisión manual de subtítulos (``GET``/``POST`` ``/subtitulos/{id}``).

Cuando un Job se procesa con la revisión manual activada
(``ajustes.subtitulos.revisar``), el pipeline se pausa tras la transcripción en
el estado ``ESPERANDO_REVISION`` (ver :mod:`app.engine.pipeline`). Estos
endpoints permiten a la Interfaz:

* ``GET /subtitulos/{job_id}``: obtener los grupos de subtítulo propuestos para
  revisar/editar (texto + tiempos).
* ``POST /subtitulos/{job_id}``: enviar el texto editado y **reanudar** el
  pipeline (quemar subtítulos + música). Solo se edita el **texto** de cada
  grupo; los tiempos se conservan del servidor para evitar inconsistencias.

Contratos de error:

* ``404 JOB_NOT_FOUND`` si el Job no existe.
* ``409 CONFLICT`` si el Job no está en ``ESPERANDO_REVISION`` (no hay nada que
  revisar/reanudar).
* ``400 INVALID_REQUEST`` si (a) el número de grupos enviados no coincide con el
  propuesto —la revisión solo edita texto, no crea/elimina líneas (Req 7.2)— o
  (b) el texto de al menos un grupo queda vacío tras aplicar ``trim`` (Req 7.3).

Al reanudar, se fusiona SOLO el texto confirmado sobre los grupos propuestos por
el servidor (por índice): se conservan los tiempos del grupo (``inicio_s`` /
``fin_s``) y, muy importante, los **tiempos por palabra** (``palabras``) de la
transcripción original, sin recalcular el karaoke (Req 7.4).
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.api.process import obtener_gestor_jobs, obtener_job_runner
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.errors import error_envelope
from app.models.job import JobStatus
from app.models.settings import GrupoSubtitulo

router = APIRouter(tags=["subtitulos"])


class GrupoEditado(BaseModel):
    """Un grupo de subtítulo editado por el usuario (solo el texto es relevante)."""

    texto: str = Field(default="")


class RevisarSubtitulosRequest(BaseModel):
    """Cuerpo de ``POST /subtitulos/{id}``: los grupos con el texto editado."""

    grupos: List[GrupoEditado] = Field(default_factory=list)


def _no_encontrado(job_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content=error_envelope(
            "JOB_NOT_FOUND",
            "No existe ningún Job con el identificador indicado.",
            {"job_id": job_id},
        ),
    )


def _conflicto(job_id: str, estado: str) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content=error_envelope(
            "CONFLICT",
            "El Job no está esperando revisión de subtítulos.",
            {"job_id": job_id, "estado": estado},
        ),
    )


@router.get("/subtitulos/{job_id}")
async def obtener_subtitulos(
    job_id: str,
    manager: JobManager = Depends(obtener_gestor_jobs),
) -> JSONResponse:
    """Devuelve los grupos de subtítulo propuestos para revisar (Req revisión).

    Responde ``404`` si el Job no existe. Si el Job existe pero no está en
    ``ESPERANDO_REVISION`` se devuelven los grupos disponibles (posiblemente
    vacíos) junto con el estado y ``editable=false``.
    """
    if not manager.existe(job_id):
        return _no_encontrado(job_id)
    job = manager.obtener(job_id)
    grupos = job.grupos_subtitulos or []
    return JSONResponse(
        status_code=200,
        content={
            "job_id": job_id,
            "estado": job.progreso.estado.value,
            "editable": job.progreso.estado == JobStatus.ESPERANDO_REVISION,
            "grupos": [g.model_dump() for g in grupos],
        },
    )


@router.post("/subtitulos/{job_id}")
async def enviar_subtitulos(
    job_id: str,
    peticion: RevisarSubtitulosRequest,
    manager: JobManager = Depends(obtener_gestor_jobs),
    runner: JobRunner = Depends(obtener_job_runner),
) -> JSONResponse:
    """Aplica el texto editado y reanuda el pipeline (fase 2).

    Solo se edita el **texto** de cada grupo (contrato de SOLO TEXTO): los
    tiempos ``inicio_s``/``fin_s`` y los tiempos por palabra (``palabras``) se
    toman de los grupos propuestos por el servidor (por índice), de modo que el
    usuario no pueda introducir tiempos inválidos ni se recalcule el karaoke
    (Req 7.4).

    Validaciones (en orden), todas sin modificar el estado del Job:

    * ``404 JOB_NOT_FOUND`` si el Job no existe.
    * ``409 CONFLICT`` si el Job no está en ``ESPERANDO_REVISION`` (Req 7.5).
    * ``400 INVALID_REQUEST`` si la cantidad de grupos recibidos difiere de la
      propuesta (Req 7.2) o si algún texto queda vacío tras ``trim`` (Req 7.3).
    """
    if not manager.existe(job_id):
        return _no_encontrado(job_id)
    job = manager.obtener(job_id)

    if job.progreso.estado != JobStatus.ESPERANDO_REVISION:
        return _conflicto(job_id, job.progreso.estado.value)

    originales = job.grupos_subtitulos or []
    if len(peticion.grupos) != len(originales):
        return JSONResponse(
            status_code=400,
            content=error_envelope(
                "INVALID_REQUEST",
                "El número de grupos no coincide con el propuesto para revisión.",
                {"esperados": len(originales), "recibidos": len(peticion.grupos)},
            ),
        )

    # Validación de texto vacío (Req 7.3): ningún grupo puede quedar sin texto
    # tras aplicar ``trim``. Se recopilan TODOS los índices vacíos para que la
    # Interfaz pueda marcar cada grupo afectado. Si hay alguno, se rechaza con
    # ``400 INVALID_REQUEST`` sin modificar el estado del Job.
    textos_recortados = [(g.texto or "").strip() for g in peticion.grupos]
    vacios = [i for i, texto in enumerate(textos_recortados) if not texto]
    if vacios:
        return JSONResponse(
            status_code=400,
            content=error_envelope(
                "INVALID_REQUEST",
                "El texto de uno o más grupos queda vacío tras recortar espacios.",
                {"grupos_vacios": vacios},
            ),
        )

    # Fusiona el texto confirmado sobre los grupos originales (por índice)
    # conservando los tiempos del grupo y los tiempos por palabra (``palabras``)
    # de la transcripción original: NO se recalcula el karaoke (Req 7.4).
    editados: List[GrupoSubtitulo] = []
    for texto, original in zip(textos_recortados, originales):
        editados.append(
            GrupoSubtitulo(
                texto=texto,
                inicio_s=original.inicio_s,
                fin_s=original.fin_s,
                palabras=original.palabras,
            )
        )

    # Reanuda la fase 2 en background (quemar subtítulos + música + conservar).
    await runner.lanzar_reanudacion(job_id, editados)

    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "estado": JobStatus.EN_EJECUCION.value},
    )
