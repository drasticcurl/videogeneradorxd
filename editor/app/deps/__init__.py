"""Paquete del Verificador de Dependencias del backend (Req 12).

Expone la comprobación de disponibilidad de las herramientas externas que
necesita el Motor de Procesamiento (``ffmpeg``, ``ffprobe``, ``auto-editor`` y
``faster-whisper``) que se ejecuta en el evento de arranque de FastAPI.
"""

from __future__ import annotations

from app.deps.checker import (
    DEPENDENCIAS,
    DependenciasFaltantesError,
    ResultadoDependencia,
    ResultadoVerificacion,
    verificar_dependencias,
)
from app.deps.path_setup import (
    asegurar_confianza_auto_editor_macos,
    asegurar_path_local,
    asegurar_permisos_auto_editor,
    preparar_auto_editor,
)

__all__ = [
    "DEPENDENCIAS",
    "DependenciasFaltantesError",
    "ResultadoDependencia",
    "ResultadoVerificacion",
    "asegurar_confianza_auto_editor_macos",
    "asegurar_path_local",
    "asegurar_permisos_auto_editor",
    "preparar_auto_editor",
    "verificar_dependencias",
]
