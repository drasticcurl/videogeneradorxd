"""Modelos de dominio del backend (Pydantic).

Reexporta los modelos principales para facilitar su importación:

    from app.models import Clip, JobState, ApiError, Ajustes
"""

from app.models.clip import Clip
from app.models.errors import ApiError, error_envelope
from app.models.job import JobState, JobStatus, PipelineStep, Progress
from app.models.settings import (
    Ajustes,
    AjustesGenerales,
    AjustesMusica,
    AjustesSilencios,
    AjustesSubtitulos,
    AjustesTranscripcion,
    GrupoSubtitulo,
    Palabra,
    PosicionHorizontal,
    PosicionVertical,
    ResolucionObjetivo,
)

__all__ = [
    "Clip",
    "ApiError",
    "error_envelope",
    "JobState",
    "JobStatus",
    "PipelineStep",
    "Progress",
    "Ajustes",
    "AjustesGenerales",
    "AjustesMusica",
    "AjustesSilencios",
    "AjustesSubtitulos",
    "AjustesTranscripcion",
    "ResolucionObjetivo",
    "PosicionVertical",
    "PosicionHorizontal",
    "Palabra",
    "GrupoSubtitulo",
]
