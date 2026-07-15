"""Endpoints de la edición final y del render (``GET``/``POST`` ``/render/{id}``).

Tras preparar los grupos finales de subtítulos (agrupación + corrección IA
opcional), el pipeline se pausa en el estado ``ESPERANDO_EDICION_FINAL`` (ver
:mod:`app.engine.pipeline` y :meth:`app.jobs.runner.JobRunner.reanudar_job`). En
la feature *edicion-avanzada-shorts* ese punto de pausa YA NO es una elección de
motor: es la **edición final** (previsualización en vivo del vídeo cortado con
los subtítulos confirmados + hasta 2 **textos extra** tipo "hook"). El render es
**SIEMPRE con Remotion**; el código de ffmpeg permanece en el repo pero no se
elige ni se usa en este flujo (Req 11.1, 11.2, 11.6).

NOTA DE COMPATIBILIDAD (renombrado): el estado ``ESPERANDO_EDICION_FINAL`` ocupa
EXACTAMENTE el mismo punto lógico de pausa que el antiguo
``ESPERANDO_ELECCION_RENDER`` (spec subtitulos-ia-remotion). Este módulo se
actualiza para referirse al nuevo miembro del enum.

Estos endpoints dan soporte a esa pausa (spec edicion-avanzada-shorts, §5.5,
§5.6; Req 8.2, 10.1, 10.5, 11.2-11.5, 14.3, 14.4, 15.3-15.5):

* ``GET /render/{job_id}``: contrato de solo lectura con los ``grupos`` finales,
  los datos del vídeo **cortado** (``video_url``/``video_nombre``,
  ``fps``/``ancho``/``alto``, ``duracion_s``) que necesita ``PreviewFinal`` para
  la previsualización, y los ``textos_extra`` últimos persistidos (lista vacía si
  no hay ninguno). ``editable=true`` cuando el estado es ``ESPERANDO_EDICION_FINAL``.
* ``POST /render/{job_id}``: acepta el cuerpo de la edición final con
  ``textos_extra`` (máx. 2, validados con :func:`validar_texto_extra`) y un campo
  ``motor`` **opcional** que sólo admite el valor exacto ``"remotion"`` (por
  defecto ``"remotion"``). Persiste los textos extra y **reanuda siempre con
  Remotion**, respondiendo ``202``.

Contratos de error homogéneos ``{"error": {code, message, details}}`` (Req 14.2-14.5):

* ``404 JOB_NOT_FOUND`` si el Job no existe.
* ``400 INVALID_REQUEST`` si ``motor`` es distinto de ``"remotion"``, si hay más
  de 2 textos extra, o si algún texto extra es inválido (estructura, rango
  temporal o estilo fuera de rango).
* ``409 CONFLICT`` si el Job no está en ``ESPERANDO_EDICION_FINAL``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError

from app import config
from app.api.process import obtener_gestor_jobs, obtener_job_runner
from app.engine.ffprobe import ClipInfo, inspeccionar_clip
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.errors import error_envelope
from app.models.job import JobState, JobStatus
from app.models.settings import TextoExtra, validar_texto_extra

router = APIRouter(tags=["render"])

# Motor de render admitido en el flujo de edición avanzada de shorts. El render
# es SIEMPRE con Remotion (Req 11.2, 11.6): el campo ``motor`` de la petición es
# opcional y, si se envía, sólo se acepta este valor EXACTO (comparación sensible
# a mayúsculas, Req 11.3). Cualquier otro valor => ``400 INVALID_REQUEST``.
MOTOR_REMOTION: str = "remotion"

# Número máximo de textos extra tipo "hook" admitidos en la edición final
# (Req 9.2, 10.5, 15.3).
MAX_TEXTOS_EXTRA: int = 2


class EditarRenderFinalRequest(BaseModel):
    """Cuerpo de ``POST /render/{id}`` en la edición final (spec edicion-avanzada-shorts).

    * ``textos_extra``: lista de overlays de texto plano en formato *snake_case* y
      **segundos** (máx. 2). Se recibe como lista de diccionarios permisivos y se
      parsea manualmente a modelos :class:`~app.models.settings.TextoExtra` para
      poder devolver ``400 INVALID_REQUEST`` (en vez del ``422`` de Pydantic)
      cuando la estructura es inválida (Req 10.5, 15.3-15.5).
    * ``motor``: motor de render **opcional**. ``None`` (omitido) => ``"remotion"``
      por defecto (Req 11.4); si se envía, sólo se acepta el valor exacto
      ``"remotion"`` (Req 11.3, 11.5).
    """

    textos_extra: List[Dict[str, Any]] = Field(default_factory=list)
    motor: Optional[str] = Field(default=None)


def _no_encontrado(job_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content=error_envelope(
            "JOB_NOT_FOUND",
            "No existe ningún Job con el identificador indicado.",
            {"job_id": job_id},
        ),
    )


def _invalido(message: str, details: Optional[Dict[str, Any]] = None) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content=error_envelope("INVALID_REQUEST", message, details),
    )


def _conflicto(job_id: str, estado: str) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content=error_envelope(
            "CONFLICT",
            "El Job no está en la etapa de edición final (ESPERANDO_EDICION_FINAL).",
            {"job_id": job_id, "estado": estado},
        ),
    )


def _inspeccionar_duracion_best_effort(
    cortado_path: str,
    inspeccionar_fn: Callable[..., ClipInfo],
) -> Optional[float]:
    """Obtiene ``duracion_s`` inspeccionando el vídeo cortado (best-effort, Req 8.2).

    Inspecciona ``cortado_path`` con ``inspeccionar_fn`` (por defecto
    :func:`app.engine.ffprobe.inspeccionar_clip`, inyectable para los tests) y
    devuelve la duración en segundos. Cualquier excepción durante la inspección
    (``ffprobe`` ausente, clip no decodificable, salida ilegible, etc.) se
    captura y resulta en ``None`` sin propagar, de modo que la respuesta de
    ``GET /render`` nunca falla por no poder inspeccionar el vídeo.

    También devuelve ``None`` cuando la inspección tiene éxito pero el clip no
    expone una duración (``ClipInfo.duracion_s is None``).
    """
    try:
        info = inspeccionar_fn(cortado_path)
    except Exception:  # noqa: BLE001 - best-effort: cualquier fallo => None
        return None
    return info.duracion_s


def construir_respuesta_render(
    job: JobState,
    inspeccionar_fn: Callable[..., ClipInfo] = inspeccionar_clip,
) -> Dict[str, Any]:
    """Construye el cuerpo (solo lectura) de ``GET /render/{id}`` (Req 8.2, 10.1).

    Además de los campos históricos que el frontend ya consume (``job_id``,
    ``estado``, ``editable``, ``motor_preferido``, ``grupos``), expone los datos
    necesarios para la previsualización final (``PreviewFinal``) y la lista de
    textos extra vigente:

    * ``video_nombre`` / ``video_url``: nombre y URL HTTP del vídeo **cortado**
      (sobre el que se previsualizan/renderizan los subtítulos), servido por
      ``GET /workfile/{job_id}/{nombre}``. Se derivan de ``job.cortado_path``
      reutilizando el mismo patrón de construcción de URL que el pipeline
      (``http://{BACKEND_HOST}:{BACKEND_PORT}/workfile/...``). Si ``cortado_path``
      es ``None`` ambos son ``None``.
    * ``fps`` / ``ancho`` / ``alto``: tomados de ``job.ajustes.generales`` — las
      dimensiones que ``PreviewFinal`` necesita para montar ``@remotion/player``
      (Req 8.2).
    * ``duracion_s``: duración del vídeo cortado, inspeccionada best-effort con
      ``inspeccionar_fn`` (inyectable). Cualquier fallo de inspección resulta en
      ``None`` sin propagar. Si ``cortado_path`` es ``None`` también es ``None``.
    * ``textos_extra``: los últimos textos extra persistidos en el ``JobState``
      (``job.textos_extra``) serializados en *snake_case*, o lista vacía si no hay
      ninguno (Req 8.2, 10.1).
    * ``editable``: ``true`` si y sólo si el Job está en ``ESPERANDO_EDICION_FINAL``.
    * ``grupos``: cada grupo incluye ``palabras`` (garantizado por
      :meth:`GrupoSubtitulo.model_dump` y reforzado con una aserción de contrato).

    NOTA DE COMPATIBILIDAD: ``motor_preferido`` se conserva por retrocompatibilidad
    del contrato (la UI de edición final lo ignora, ya que el render es siempre
    Remotion, Req 11.1); no se rompe ningún campo que consumiera el flujo antiguo.

    Args:
        job: Job del que se construye la respuesta.
        inspeccionar_fn: Inspector de clips inyectable (por defecto
            :func:`app.engine.ffprobe.inspeccionar_clip`); facilita los tests.

    No muta el ``job`` (operación de solo lectura).
    """
    grupos = [g.model_dump() for g in (job.grupos_finales or [])]
    # Aserción de contrato: ``GrupoSubtitulo.model_dump()`` siempre serializa el
    # campo ``palabras`` (``None`` si el grupo no tiene palabras).
    assert all("palabras" in grupo for grupo in grupos), (
        "Cada grupo de la respuesta de /render debe incluir el campo 'palabras'"
    )

    # Textos extra últimos persistidos (Req 8.2, 10.1): serializados en snake_case
    # (texto, inicio_s, fin_s, estilo{...}). Lista vacía si el Job aún no tiene.
    textos_extra = [t.model_dump() for t in (job.textos_extra or [])]

    generales = job.ajustes.generales

    if job.cortado_path is not None:
        video_nombre = Path(job.cortado_path).name
        video_url = (
            f"http://{config.BACKEND_HOST}:{config.BACKEND_PORT}"
            f"/workfile/{job.id}/{video_nombre}"
        )
        duracion_s = _inspeccionar_duracion_best_effort(
            job.cortado_path, inspeccionar_fn
        )
    else:
        video_nombre = None
        video_url = None
        duracion_s = None

    return {
        "job_id": job.id,
        "estado": job.progreso.estado.value,
        # ``editable`` es true sólo en la etapa de edición final (Req 8.2).
        "editable": job.progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL,
        # Se conserva por retrocompatibilidad del contrato; la UI lo ignora.
        "motor_preferido": job.ajustes.render.motor_preferido,
        "grupos": grupos,
        # --- Datos del vídeo cortado para la previsualización final (Req 8.2) ---
        "video_url": video_url,
        "video_nombre": video_nombre,
        "fps": generales.fps,
        "ancho": generales.resolucion.ancho,
        "alto": generales.resolucion.alto,
        # Duración inspeccionada best-effort: None si falla o no hay vídeo.
        "duracion_s": duracion_s,
        # Textos extra vigentes (últimos persistidos o lista vacía) (Req 8.2, 10.1).
        "textos_extra": textos_extra,
    }


def _parsear_textos_extra(
    crudos: List[Dict[str, Any]], duracion_cortado_s: float
) -> Any:
    """Parsea y valida la lista de textos extra del cuerpo de ``POST /render/{id}``.

    Devuelve la tupla ``(textos, error)`` donde:

    * en caso válido, ``textos`` es la lista de modelos
      :class:`~app.models.settings.TextoExtra` (posiblemente vacía) y ``error`` es
      ``None``;
    * en caso inválido, ``textos`` es ``None`` y ``error`` es un :class:`JSONResponse`
      ``400 INVALID_REQUEST`` con el detalle del problema.

    Reglas (Req 10.5, 15.3-15.5):

    1. Más de :data:`MAX_TEXTOS_EXTRA` (2) textos => ``400``.
    2. Cada elemento se parsea a ``TextoExtra`` (snake_case + segundos); un
       elemento con estructura inválida (campo obligatorio ausente, tipo
       incorrecto, etc.) => ``400`` indicando su índice.
    3. Cada texto se valida con :func:`validar_texto_extra` contra
       ``duracion_cortado_s`` (rango temporal + rangos de estilo del motor); si
       devuelve campos inválidos => ``400`` indicando el texto y los campos
       afectados.
    """
    # (1) Límite de cantidad ANTES de parsear (Req 10.5, 15.3).
    if len(crudos) > MAX_TEXTOS_EXTRA:
        return None, _invalido(
            f"No se admiten más de {MAX_TEXTOS_EXTRA} textos extra.",
            {"recibidos": len(crudos), "maximo": MAX_TEXTOS_EXTRA},
        )

    textos: List[TextoExtra] = []
    for i, crudo in enumerate(crudos):
        # (2) Parseo estructural permisivo -> modelo TextoExtra (Req 10.5).
        try:
            textos.append(TextoExtra.model_validate(crudo))
        except (ValidationError, TypeError, ValueError):
            return None, _invalido(
                "Alguno de los textos extra tiene una estructura inválida.",
                {"indice": i},
            )

    # (3) Validación de rango temporal y estilo de cada texto (Req 15.4, 15.5).
    for i, texto in enumerate(textos):
        campos_invalidos = validar_texto_extra(texto, duracion_cortado_s)
        if campos_invalidos:
            return None, _invalido(
                "Alguno de los textos extra tiene datos inválidos (rango temporal "
                "o estilo fuera de rango).",
                {"indice": i, "campos": campos_invalidos},
            )

    return textos, None


@router.get("/render/{job_id}")
async def obtener_render(
    job_id: str,
    manager: JobManager = Depends(obtener_gestor_jobs),
) -> JSONResponse:
    """Devuelve los grupos finales, los datos del vídeo cortado y los textos extra (Req 8.2).

    Responde ``404`` si el Job no existe. Si el Job existe pero no está en
    ``ESPERANDO_EDICION_FINAL`` se devuelven los grupos disponibles (posiblemente
    vacíos) junto con el estado y ``editable=false``; los ``textos_extra`` son los
    últimos persistidos o una lista vacía.

    La respuesta incluye los datos del vídeo **cortado**
    (``video_url``/``video_nombre``), sus dimensiones (``fps``/``ancho``/``alto``)
    y la duración (``duracion_s``) para que ``PreviewFinal`` monte la
    previsualización en vivo con subtítulos y overlays (spec
    edicion-avanzada-shorts, Req 8.2). Ver :func:`construir_respuesta_render`.
    """
    if not manager.existe(job_id):
        return _no_encontrado(job_id)
    job = manager.obtener(job_id)
    return JSONResponse(
        status_code=200,
        content=construir_respuesta_render(job),
    )


@router.post("/render/{job_id}")
async def confirmar_render_final(
    job_id: str,
    peticion: EditarRenderFinalRequest,
    manager: JobManager = Depends(obtener_gestor_jobs),
    runner: JobRunner = Depends(obtener_job_runner),
) -> JSONResponse:
    """Persiste los textos extra y reanuda el render SIEMPRE con Remotion (Req 10.1, 11.2).

    Validaciones (en orden):

    1. ``404 JOB_NOT_FOUND`` si el Job no existe (Req 14.2).
    2. ``400 INVALID_REQUEST`` si el campo ``motor`` se envía con un valor
       distinto del exacto ``"remotion"`` (Req 11.3, 11.5). Si se omite se usa
       ``"remotion"`` por defecto (Req 11.4).
    3. ``409 CONFLICT`` si el Job no está en ``ESPERANDO_EDICION_FINAL`` (Req 14.3).
    4. ``400 INVALID_REQUEST`` si hay más de 2 textos extra, si alguno tiene una
       estructura inválida, o si algún texto extra incumple el rango temporal o
       tiene el estilo fuera de rango (Req 10.5, 15.3-15.5). La validación temporal
       usa la duración del vídeo cortado.

    En caso válido persiste los textos extra en el Job
    (:meth:`~app.jobs.manager.JobManager.guardar_textos_extra`) y lanza la
    reanudación del render con Remotion
    (:meth:`~app.jobs.runner.JobRunner.lanzar_reanudacion_render`), respondiendo
    ``202`` con el Job en ejecución. Ninguna rama de error muta el estado del Job
    (Req 10.5, 14.3, 14.4).
    """
    if not manager.existe(job_id):
        return _no_encontrado(job_id)

    # Motor opcional: omitido (None) => "remotion" por defecto (Req 11.4); si se
    # envía, sólo se acepta el valor EXACTO "remotion" (sensible a mayúsculas,
    # Req 11.3). Cualquier otro valor => 400 sin modificar el estado (Req 11.5).
    if peticion.motor is not None and peticion.motor != MOTOR_REMOTION:
        return _invalido(
            "El render final usa siempre Remotion; 'motor' sólo admite 'remotion'.",
            {"motor": peticion.motor, "esperado": MOTOR_REMOTION},
        )

    job = manager.obtener(job_id)
    if job.progreso.estado != JobStatus.ESPERANDO_EDICION_FINAL:
        return _conflicto(job_id, job.progreso.estado.value)

    # Duración del vídeo cortado para validar el rango temporal de los textos
    # extra (Req 15.4). Se inspecciona best-effort; si no puede determinarse
    # (``ffprobe`` ausente, clip no decodificable, sin ``cortado_path``) se usa
    # ``+inf`` como cota superior para no rechazar erróneamente por una duración
    # desconocida: se siguen validando ``0 <= inicio < fin`` y los rangos de estilo.
    duracion_cortado_s: Optional[float] = None
    if job.cortado_path is not None:
        duracion_cortado_s = _inspeccionar_duracion_best_effort(
            job.cortado_path, inspeccionar_clip
        )
    if duracion_cortado_s is None:
        duracion_cortado_s = float("inf")

    textos_extra, error = _parsear_textos_extra(
        peticion.textos_extra, duracion_cortado_s
    )
    if error is not None:
        return error

    # Persistir los textos extra validados (Req 10.1) y reanudar el render SIEMPRE
    # con Remotion (Req 11.2, 11.6): responde 202 mientras el render corre en
    # segundo plano. Se pasa ``motor="remotion"`` explícito (el default de
    # ``lanzar_reanudacion_render`` es el histórico "ass", que no aplica aquí).
    manager.guardar_textos_extra(job_id, textos_extra)
    await runner.lanzar_reanudacion_render(job_id, motor=MOTOR_REMOTION)

    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "estado": JobStatus.EN_EJECUCION.value},
    )
