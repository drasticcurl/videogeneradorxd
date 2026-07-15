"""Endpoint de progreso ``GET /progreso/{id}`` (Req 10.3, 10.4, 10.6).

Expone el estado de progreso de un Job en dos variantes:

* **JSON (polling):** ``GET /progreso/{id}`` devuelve el estado + paso + índice
  de paso + porcentaje + mensaje + error (Req 10.3).
* **SSE (streaming):** ``GET /progreso/{id}?stream=true`` responde
  ``text/event-stream`` emitiendo el **mismo objeto** como eventos ``progreso``
  cada vez que se consulta y, periódicamente, un *heartbeat* para cumplir la
  actualización <= 5 s (Req 10.6). El stream finaliza cuando el Job alcanza un
  estado terminal (``completado`` / ``fallido``).

Si el ``id`` no corresponde a ningún Job existente, ambas variantes responden
``404 JOB_NOT_FOUND`` **sin modificar ningún estado** (Req 10.4).

El Gestor de Jobs se obtiene mediante la dependencia compartida
:func:`app.api.process.obtener_gestor_jobs` (sustituible en pruebas).

Referencias de requisitos: 10.3, 10.4, 10.6.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, StreamingResponse

from app.api.process import obtener_gestor_jobs
from app.jobs.manager import ESTADOS_TERMINALES, JobManager
from app.models.errors import error_envelope
from app.models.job import JobState

router = APIRouter(tags=["progreso"])

# Intervalo entre emisiones/heartbeats del stream SSE (Req 10.6: <= 5 s).
PROGRESO_SSE_INTERVALO_S: float = 2.0


def _progreso_dict(job: JobState) -> Dict[str, Any]:
    """Serializa el estado de progreso de un Job al objeto del contrato (Req 10.3)."""
    prog = job.progreso
    return {
        "job_id": job.id,
        "estado": prog.estado.value,
        "paso_actual": prog.paso_actual.value if prog.paso_actual is not None else None,
        "indice_paso": prog.indice_paso,
        "total_pasos": prog.total_pasos,
        "porcentaje": prog.porcentaje,
        "mensaje": prog.mensaje,
        "error": prog.error,
    }


def _evento_sse(nombre: str, datos: Dict[str, Any]) -> str:
    """Formatea un evento SSE (``event:`` + ``data:``) con el objeto JSON."""
    return f"event: {nombre}\ndata: {json.dumps(datos, ensure_ascii=False)}\n\n"


def _no_encontrado(job_id: str) -> JSONResponse:
    """Respuesta ``404 JOB_NOT_FOUND`` homogénea (Req 10.4)."""
    return JSONResponse(
        status_code=404,
        content=error_envelope(
            "JOB_NOT_FOUND",
            "No existe ningún Job con el identificador indicado.",
            {"job_id": job_id},
        ),
    )


async def _stream_progreso(manager: JobManager, job_id: str):
    """Generador SSE que emite el progreso del Job hasta su estado terminal.

    Emite un evento ``progreso`` con el estado actual, y mientras el Job no sea
    terminal repite la emisión cada :data:`PROGRESO_SSE_INTERVALO_S` segundos
    (heartbeat, Req 10.6). Cuando el Job alcanza ``completado``/``fallido`` emite
    un último evento y cierra el stream.
    """
    while True:
        job = manager.obtener(job_id)
        if job is None:
            # El Job desapareció mientras se transmitía: cerrar el stream.
            return
        yield _evento_sse("progreso", _progreso_dict(job))
        if job.progreso.estado in ESTADOS_TERMINALES:
            return
        await asyncio.sleep(PROGRESO_SSE_INTERVALO_S)


@router.get("/progreso/{job_id}")
async def progreso(
    job_id: str,
    stream: bool = Query(default=False),
    manager: JobManager = Depends(obtener_gestor_jobs),
):
    """Devuelve el progreso de un Job (JSON) o lo transmite por SSE (Req 10.3/10.6).

    Responde ``404 JOB_NOT_FOUND`` sin modificar estado si el Job no existe
    (Req 10.4).
    """
    # Comprobación de existencia sin efectos secundarios (Req 10.4).
    if not manager.existe(job_id):
        return _no_encontrado(job_id)

    if stream:
        return StreamingResponse(
            _stream_progreso(manager, job_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    job = manager.obtener(job_id)
    return JSONResponse(status_code=200, content=_progreso_dict(job))
