"""Endpoints de edición manual de silencios (``GET``/``POST`` ``/silencios/{id}``).

Tras UNIR los clips, el pipeline detecta los tramos de silencio sobre el vídeo
**unido** (sin recortar) y se pausa en el estado ``ESPERANDO_EDICION_SILENCIOS``
(ver :mod:`app.engine.pipeline` y
:meth:`app.jobs.manager.JobManager.marcar_esperando_edicion_silencios`). En ese
momento la Interfaz muestra un timeline tipo CapCut con los tramos detectados
(los que se van a BORRAR) sobre el vídeo unido, para que el usuario los ajuste
(mover/estirar/achicar/añadir/eliminar) y confirme. Estos endpoints dan soporte a
esa pausa (spec edicion-avanzada-shorts, Req 2, 5, 14, 15):

* ``GET /silencios/{job_id}``: obtener (solo lectura) los tramos de silencio
  detectados, la duración del vídeo unido, la URL HTTP del vídeo unido para el
  timeline y los parámetros de vídeo (``fps``/``ancho``/``alto``). ``editable`` es
  ``true`` únicamente cuando el Job está en ``ESPERANDO_EDICION_SILENCIOS``.
* ``POST /silencios/{job_id}``: enviar los tramos a BORRAR ya editados y
  **reanudar** el pipeline (aplica el corte + transcribe...). Responde ``202`` y
  la reanudación corre en background.

Contratos de error homogéneos (envoltura ``{"error": {code, message, details}}``,
Req 14.2-14.5):

* ``404 JOB_NOT_FOUND`` si el Job no existe.
* ``409 CONFLICT`` si el Job no está en ``ESPERANDO_EDICION_SILENCIOS`` (no hay
  ninguna edición de silencios pendiente para ese Job).
* ``400 INVALID_REQUEST`` si algún tramo es inválido según
  :func:`app.models.settings.validar_tramos_silencio` (``inicio >= fin``, fuera de
  ``[0, duración]`` o no numérico) o el cuerpo es inválido.
"""

from __future__ import annotations

from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import config
from app.api.process import obtener_gestor_jobs, obtener_job_runner
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.errors import error_envelope
from app.models.job import JobState, JobStatus
from app.models.settings import validar_tramos_silencio

router = APIRouter(tags=["silencios"])


class TramoEntrada(BaseModel):
    """Un tramo ``[inicio_s, fin_s]`` (en segundos) a BORRAR, editado por el usuario.

    El modelo es PERMISIVO a propósito (campos ``float`` sin restricción de rango
    y con valores por defecto): así la validación de negocio la realiza
    :func:`app.models.settings.validar_tramos_silencio` y se puede responder
    ``400 INVALID_REQUEST`` con el tramo afectado en lugar del ``422`` genérico de
    validación de esquema. Los valores por defecto ``0.0`` hacen que un tramo con
    campos ausentes resulte inválido (``inicio_s == fin_s``) y sea rechazado.
    """

    inicio_s: float = Field(default=0.0)
    fin_s: float = Field(default=0.0)


class EditarSilenciosRequest(BaseModel):
    """Cuerpo de ``POST /silencios/{id}``: los tramos a BORRAR ya editados."""

    tramos: List[TramoEntrada] = Field(default_factory=list)


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
            "El Job no está esperando la edición manual de silencios.",
            {"job_id": job_id, "estado": estado},
        ),
    )


def construir_respuesta_silencios(job: JobState) -> dict:
    """Construye el cuerpo (solo lectura) de ``GET /silencios/{id}`` (Req 2.1-2.4).

    Expone los datos necesarios para el timeline de silencios sobre el vídeo
    **unido** (pre-corte):

    * ``estado``: estado actual del Job.
    * ``editable``: ``true`` solo si el Job está en ``ESPERANDO_EDICION_SILENCIOS``
      (Req 2.3, 2.4); en cualquier otro estado es ``false`` y ``tramos`` son los
      disponibles (posiblemente vacíos).
    * ``video_url`` / ``video_nombre``: URL HTTP y nombre del vídeo **unido**
      servido por ``GET /workfile/{job_id}/{nombre}``. Se derivan de
      ``job.unido_path`` reutilizando el mismo patrón de construcción de URL que
      :func:`app.api.render.construir_respuesta_render` para el vídeo cortado
      (``http://{BACKEND_HOST}:{BACKEND_PORT}/workfile/...``). Si ``unido_path``
      es ``None`` ambos son ``None``.
    * ``duracion_s``: duración total del vídeo unido en segundos (``0.0`` si no se
      ha detectado todavía).
    * ``fps`` / ``ancho`` / ``alto``: parámetros de vídeo tomados de
      ``job.ajustes.generales`` (Req 2.1).
    * ``tramos``: lista de tramos de silencio detectados (a borrar), ordenados y
      sin solapes, cada uno ``{inicio_s, fin_s}``.

    No muta el ``job`` (operación de solo lectura).
    """
    generales = job.ajustes.generales

    if job.unido_path:
        video_nombre = Path(job.unido_path).name
        video_url = (
            f"http://{config.BACKEND_HOST}:{config.BACKEND_PORT}"
            f"/workfile/{job.id}/{video_nombre}"
        )
    else:
        video_nombre = None
        video_url = None

    tramos = job.silencios_detectados or []

    return {
        "job_id": job.id,
        "estado": job.progreso.estado.value,
        "editable": job.progreso.estado == JobStatus.ESPERANDO_EDICION_SILENCIOS,
        "video_url": video_url,
        "video_nombre": video_nombre,
        "duracion_s": (
            job.duracion_unido_s if job.duracion_unido_s is not None else 0.0
        ),
        "fps": generales.fps,
        "ancho": generales.resolucion.ancho,
        "alto": generales.resolucion.alto,
        # Serialización DEFENSIVA de los tramos: normalmente son ``TramoSilencio``
        # (tienen ``model_dump``), pero el pipeline puede haberlos dejado como
        # tuplas/listas ``(inicio_s, fin_s)``. Soportamos ambos casos para que el
        # endpoint nunca vuelva a romper (``AttributeError`` sobre una tupla),
        # manteniendo el contrato de salida ``[{"inicio_s":..., "fin_s":...}]``.
        "tramos": [_serializar_tramo(t) for t in tramos],
    }


def _serializar_tramo(t: object) -> dict:
    """Serializa un tramo a ``{"inicio_s":..., "fin_s":...}`` de forma robusta.

    Acepta tanto instancias :class:`~app.models.settings.TramoSilencio` (u otro
    modelo con ``model_dump``) como tuplas/listas ``(inicio_s, fin_s)`` que el
    pipeline pudiera haber entregado. Así ``GET /silencios/{id}`` nunca falla por
    recibir un tipo inesperado.
    """
    if hasattr(t, "model_dump"):
        return t.model_dump()
    if isinstance(t, (tuple, list)) and len(t) >= 2:
        return {"inicio_s": float(t[0]), "fin_s": float(t[1])}
    # Si ya es un dict con las claves esperadas, se devuelve tal cual.
    if isinstance(t, dict):
        return {"inicio_s": float(t["inicio_s"]), "fin_s": float(t["fin_s"])}
    raise TypeError(f"Tramo de silencio no serializable: {t!r}")


@router.get("/silencios/{job_id}")
async def obtener_silencios(
    job_id: str,
    manager: JobManager = Depends(obtener_gestor_jobs),
) -> JSONResponse:
    """Devuelve los tramos detectados + datos del vídeo unido (Req 2.1-2.4).

    Responde ``404 JOB_NOT_FOUND`` si el Job no existe. Si el Job existe pero no
    está en ``ESPERANDO_EDICION_SILENCIOS`` se devuelven los tramos disponibles
    (posiblemente vacíos) junto con el estado y ``editable=false``. Ver
    :func:`construir_respuesta_silencios`.
    """
    if not manager.existe(job_id):
        return _no_encontrado(job_id)
    job = manager.obtener(job_id)
    return JSONResponse(
        status_code=200,
        content=construir_respuesta_silencios(job),
    )


@router.post("/silencios/{job_id}")
async def enviar_silencios(
    job_id: str,
    peticion: EditarSilenciosRequest,
    manager: JobManager = Depends(obtener_gestor_jobs),
    runner: JobRunner = Depends(obtener_job_runner),
) -> JSONResponse:
    """Aplica los tramos editados y reanuda el pipeline en background (Req 5.1-5.4).

    Validaciones (en orden): ``404 JOB_NOT_FOUND`` si el Job no existe;
    ``409 CONFLICT`` si el Job no está en ``ESPERANDO_EDICION_SILENCIOS``;
    ``400 INVALID_REQUEST`` si algún tramo es inválido según
    :func:`app.models.settings.validar_tramos_silencio` (``0 <= inicio < fin <=
    duración``). En caso válido lanza la reanudación desde silencios (que aplica
    el corte y continúa a TRANSCRIBIR) y responde ``202`` con el Job en ejecución.
    """
    if not manager.existe(job_id):
        return _no_encontrado(job_id)

    job = manager.obtener(job_id)
    if job.progreso.estado != JobStatus.ESPERANDO_EDICION_SILENCIOS:
        return _conflicto(job_id, job.progreso.estado.value)

    # Validación de los tramos contra la duración del vídeo unido persistida en la
    # pausa (Req 5.3, 15.1, 15.2). Los objetos ``TramoEntrada`` exponen
    # ``inicio_s``/``fin_s``, que es lo único que consume ``validar_tramos_silencio``.
    duracion = job.duracion_unido_s if job.duracion_unido_s is not None else 0.0
    invalidos = validar_tramos_silencio(peticion.tramos, duracion)
    if invalidos:
        return JSONResponse(
            status_code=400,
            content=error_envelope(
                "INVALID_REQUEST",
                "Uno o más tramos de silencio son inválidos "
                "(se exige 0 <= inicio_s < fin_s <= duración).",
                {"tramos_invalidos": invalidos, "duracion_s": duracion},
            ),
        )

    # Tramos a BORRAR como tuplas ``(inicio_s, fin_s)``, que es lo que espera la
    # reanudación del pipeline (``reanudar_desde_silencios``). El runner obtiene
    # el resto de artefactos (``unido_path``, ``duracion_unido_s``) del JobState.
    tramos_borrar = [(t.inicio_s, t.fin_s) for t in peticion.tramos]

    # Reanuda en background: responde 202 mientras el corte + transcripción +
    # resto del flujo corren en segundo plano.
    await runner.lanzar_reanudacion_silencios(job_id, tramos_borrar)

    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "estado": JobStatus.EN_EJECUCION.value},
    )
