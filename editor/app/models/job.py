"""Modelos de estado y progreso de un Job.

Define el ciclo de vida del Job, los pasos del pipeline y la estructura de
progreso que es la fuente de verdad consultada por `GET /progreso/{id}`.

Referencias de requisitos: 10.3, 10.5, 10.7, 13.3.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.models.settings import Ajustes, GrupoSubtitulo

# ---------------------------------------------------------------------------
# Modelos de la feature "edicion-avanzada-shorts" (tarea 1.1).
#
# ``TramoSilencio`` y ``TextoExtra`` viven en ``app.models.settings`` y los
# AÑADE la tarea 1.2, que se ejecuta EN PARALELO con esta tarea 1.1. Para no
# romper la importación de este módulo cuando la tarea 1.2 todavía no está
# integrada, se usa un IMPORT DIFERIDO tolerante a fallos:
#
#   - Si los modelos ya existen en settings.py, se importan tal cual (estado
#     final esperado del código integrado).
#   - Si aún no existen, se definen marcadores mínimos con los mismos nombres
#     para que las anotaciones con referencia diferida (forward-ref) de
#     ``JobState`` se resuelvan y el modelo Pydantic quede completamente
#     definido. Estos marcadores son transitorios y quedan sustituidos por los
#     modelos definitivos de settings.py una vez integrada la tarea 1.2.
#
# SUPUESTO documentado: el contrato relevante para ``JobState`` es únicamente
# la forma serializada de estos modelos; la validación fina de rangos de los
# textos extra la realiza settings.py (tarea 1.2), no este módulo.
# ---------------------------------------------------------------------------
try:  # pragma: no cover - la rama dependiente de la integración de la tarea 1.2
    from app.models.settings import TextoExtra, TramoSilencio
except ImportError:  # pragma: no cover
    class TramoSilencio(BaseModel):
        """Marcador transitorio de un tramo ``[inicio_s, fin_s]`` a BORRAR.

        Sustituido por el modelo definitivo de ``app.models.settings`` (tarea
        1.2). Solo se usa si la tarea 1.2 aún no está integrada.
        """

        inicio_s: float = Field(ge=0.0)
        fin_s: float = Field(ge=0.0)

    class TextoExtra(BaseModel):
        """Marcador transitorio de un overlay de texto plano (sin animación).

        Sustituido por el modelo definitivo de ``app.models.settings`` (tarea
        1.2). Solo se usa si la tarea 1.2 aún no está integrada.
        """

        texto: str
        inicio_s: float = Field(ge=0.0)
        fin_s: float = Field(ge=0.0)


class JobStatus(str, Enum):
    """Estados posibles de un Job (Req 10.3)."""

    EN_COLA = "en_cola"
    EN_EJECUCION = "en_ejecucion"
    # Estado NO terminal (spec edicion-avanzada-shorts, Req 1.2): tras UNIR el
    # pipeline detecta los tramos de silencio sobre el vídeo unido (sin recortar)
    # y se pausa a la espera de que el usuario edite manualmente dichos tramos en
    # el timeline y confirme con `POST /silencios/{id}`. Es una pausa PREVIA a la
    # transcripción.
    ESPERANDO_EDICION_SILENCIOS = "esperando_edicion_silencios"
    # Estado NO terminal: el pipeline se pausó tras la transcripción y espera que
    # el usuario revise/edite los subtítulos antes de continuar (revisión manual).
    ESPERANDO_REVISION = "esperando_revision"
    # Estado NO terminal (spec edicion-avanzada-shorts, Req 8.1): el pipeline
    # preparó los grupos finales de subtítulos y se pausó SIN renderizar, a la
    # espera de la edición final (previsualización + textos extra) que el usuario
    # confirma con `POST /render/{id}`. El render es SIEMPRE con Remotion.
    #
    # NOTA DE COMPATIBILIDAD (renombrado): este estado sustituye al antiguo
    # `ESPERANDO_ELECCION_RENDER` (valor previo "esperando_eleccion_render", de la
    # spec subtitulos-ia-remotion). Ocupa EXACTAMENTE el mismo punto lógico de
    # pausa del pipeline (antes "elegir motor"; ahora "preview + textos extra +
    # render Remotion"), por lo que solo cambia el nombre/valor del enum, no la
    # posición en el flujo.
    ESPERANDO_EDICION_FINAL = "esperando_edicion_final"
    COMPLETADO = "completado"
    FALLIDO = "fallido"


class PipelineStep(str, Enum):
    """Pasos del pipeline de procesamiento, en orden estricto."""

    UNIR = "UNIR"
    CORTAR_SILENCIOS = "CORTAR_SILENCIOS"
    TRANSCRIBIR = "TRANSCRIBIR"
    SUBTITULOS = "SUBTITULOS"
    MUSICA = "MUSICA"


# Número total de pasos del pipeline.
TOTAL_PASOS: int = 5


class Progress(BaseModel):
    """Estado de progreso de un Job (Req 10.3, 10.5, 10.7).

    El campo ``error`` contiene ``{"paso": ..., "motivo": ...}`` cuando el Job
    está en estado ``FALLIDO`` (Req 10.7).
    """

    estado: JobStatus = Field(default=JobStatus.EN_COLA)
    paso_actual: Optional[PipelineStep] = Field(default=None)
    indice_paso: int = Field(default=0, ge=0, le=TOTAL_PASOS)
    total_pasos: int = Field(default=TOTAL_PASOS)
    porcentaje: int = Field(default=0, ge=0, le=100)
    mensaje: str = Field(default="")
    error: Optional[Dict[str, Any]] = Field(
        default=None, description='{"paso": ..., "motivo": ...} cuando FALLIDO'
    )


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


class JobState(BaseModel):
    """Estado completo de un Job en el registro en memoria del Gestor de Jobs.

    Referencias de requisitos: 10.1, 10.2 (cardinalidad de ``orden_clips``),
    13.3 (``workdir`` por Job).
    """

    id: str = Field(..., description="Identificador único del Job")
    orden_clips: List[str] = Field(
        ..., description="Orden de clips 1..500 recibido (Req 10.1, 10.2)"
    )
    musica_id: Optional[str] = Field(default=None)
    ajustes: Ajustes
    workdir: str = Field(..., description="Directorio de trabajo del Job (Req 13.3)")
    ruta_video_final: Optional[str] = Field(default=None)
    progreso: Progress = Field(default_factory=Progress)
    # Estado de la revisión manual de subtítulos (solo se rellena cuando el Job
    # se pausa en ESPERANDO_REVISION):
    #   - ``grupos_subtitulos``: grupos de subtítulo propuestos para editar.
    #   - ``cortado_path``: ruta del video (ya cortado) sobre el que se quemarán
    #     los subtítulos al reanudar la fase 2 del pipeline.
    grupos_subtitulos: Optional[List[GrupoSubtitulo]] = Field(default=None)
    cortado_path: Optional[str] = Field(default=None)
    # Estado de la edición final (spec edicion-avanzada-shorts, Req 8.1). Solo se
    # rellena cuando el Job se pausa en ESPERANDO_EDICION_FINAL (antes
    # ESPERANDO_ELECCION_RENDER; ver nota de compatibilidad en JobStatus):
    #   - ``grupos_finales``: grupos YA definitivos (agrupados + corregidos con IA
    #     si estaba activada) que se renderizarán con Remotion. Se usa un campo
    #     DEDICADO (en vez de reutilizar ``grupos_subtitulos``) para separar
    #     semánticamente la revisión manual —grupos editables— de la edición final
    #     —grupos ya finalizados—, ya que un mismo Job puede atravesar ambas
    #     pausas de forma consecutiva.
    #   - ``cortado_path`` (reutilizado): ruta del video sobre el que se
    #     renderizarán los subtítulos al reanudar el render final.
    grupos_finales: Optional[List[GrupoSubtitulo]] = Field(default=None)
    # Estado de la edición de silencios en el timeline (spec
    # edicion-avanzada-shorts, Req 1.3). Estos campos solo se rellenan cuando el
    # Job se pausa en ESPERANDO_EDICION_SILENCIOS:
    #   - ``unido_path``: ruta del vídeo UNIDO (pre-corte) que alimenta el
    #     timeline y sobre el que se aplican los tramos a borrar al reanudar.
    #   - ``silencios_detectados``: tramos de silencio detectados (a borrar),
    #     ordenados y sin solapes, que el usuario editará en el timeline.
    #   - ``duracion_unido_s``: duración total del vídeo unido en segundos,
    #     necesaria para validar/normalizar los tramos y calcular el complemento.
    unido_path: Optional[str] = Field(default=None)
    silencios_detectados: Optional[List[TramoSilencio]] = Field(default=None)
    duracion_unido_s: Optional[float] = Field(default=None)
    # Textos extra tipo "hook" (spec edicion-avanzada-shorts, Req 8.1, 10.1).
    # Se rellena al confirmar la edición final (`POST /render/{id}`) y lo consume
    # el constructor de props del render para emitir los overlays (máx. 2).
    textos_extra: Optional[List[TextoExtra]] = Field(default=None)
    creado_en: datetime = Field(default_factory=_ahora)
    actualizado_en: datetime = Field(default_factory=_ahora)
