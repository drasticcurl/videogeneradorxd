"""Tests del Paso 3 — Transcripción (Tarea 11.7, Req 5).

Contiene:

* **Propiedad 11** (Feature: vertical-shorts-editor, Property 11): para cualquier
  idioma distinto de "auto" fuera del conjunto soportado, o cualquier modelo
  fuera del conjunto soportado por faster-whisper, el motor **rechaza la
  operación antes de iniciar la transcripción** y **no produce timestamps por
  palabra** (ni extrae audio ni carga el modelo).
  **Validates: Requisitos 5.5, 5.6**

La extracción de audio (ffmpeg) y la fábrica del modelo faster-whisper se
inyectan con dobles que registran si fueron invocados; así se verifica que la
validación ocurre **antes** de cualquier trabajo pesado, sin depender de los
binarios/bibliotecas reales.
"""

from __future__ import annotations

from typing import List, Tuple, Type

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.engine.transcribe import (
    IdiomaInvalidoError,
    ModeloInvalidoError,
    transcribir,
)
from app.models.settings import (
    SUPPORTED_WHISPER_LANGUAGES,
    SUPPORTED_WHISPER_MODELS,
    AjustesTranscripcion,
)

PBT = settings(max_examples=200, deadline=None)


class _ExtractorGrabador:
    """Extractor de audio inyectable que registra sus invocaciones."""

    def __init__(self) -> None:
        self.llamadas: List[Tuple[str, str]] = []

    def __call__(self, video: str, audio_wav: str) -> None:
        self.llamadas.append((video, audio_wav))


class _FactoryGrabador:
    """Fábrica de modelo inyectable que registra sus invocaciones."""

    def __init__(self) -> None:
        self.llamadas: List[str] = []

    def __call__(self, modelo: str):  # pragma: no cover - no debe invocarse
        self.llamadas.append(modelo)
        raise AssertionError("La fábrica de modelo no debería invocarse")


# Idiomas y modelos que NO pertenecen a los conjuntos soportados (ni "auto").
_IDIOMAS_INVALIDOS = st.sampled_from(
    ["xx", "zzz", "klingon", "e s", "123", "", "eng", "spanish"]
)
_MODELOS_INVALIDOS = st.sampled_from(
    ["gigantic", "huge", "small.fr", "modelo-inexistente", "", "whisper-x"]
)
_IDIOMAS_VALIDOS = st.sampled_from(sorted(SUPPORTED_WHISPER_LANGUAGES) + ["auto"])
_MODELOS_VALIDOS = st.sampled_from(sorted(SUPPORTED_WHISPER_MODELS))


@st.composite
def _casos_invalidos(draw: st.DrawFn) -> Tuple[str, str, Type[Exception]]:
    """Genera (idioma, modelo, tipo_error_esperado) con al menos un campo inválido.

    El idioma se valida antes que el modelo, por lo que un idioma inválido produce
    :class:`IdiomaInvalidoError` aunque el modelo también sea inválido.
    """
    escenario = draw(st.sampled_from(["idioma", "modelo", "ambos"]))
    if escenario == "idioma":
        return draw(_IDIOMAS_INVALIDOS), draw(_MODELOS_VALIDOS), IdiomaInvalidoError
    if escenario == "modelo":
        return draw(_IDIOMAS_VALIDOS), draw(_MODELOS_INVALIDOS), ModeloInvalidoError
    return draw(_IDIOMAS_INVALIDOS), draw(_MODELOS_INVALIDOS), IdiomaInvalidoError


# ---------------------------------------------------------------------------
# Propiedad 11: Validación de idioma y modelo antes de transcribir
# Feature: vertical-shorts-editor, Property 11
# Validates: Requisitos 5.5, 5.6
# ---------------------------------------------------------------------------
@PBT
@given(caso=_casos_invalidos())
def test_propiedad_11_validacion_idioma_modelo_antes_de_transcribir(
    caso: Tuple[str, str, Type[Exception]],
) -> None:
    """Idioma/modelo inválido => rechazo antes de transcribir, sin timestamps y
    sin invocar la extracción de audio ni la carga del modelo (Req 5.5, 5.6)."""
    idioma, modelo, tipo_error = caso
    ajustes = AjustesTranscripcion(idioma=idioma, modelo=modelo)
    extractor = _ExtractorGrabador()
    factory = _FactoryGrabador()

    with pytest.raises(tipo_error):
        transcribir(
            "video.mp4",
            ajustes,
            "audio.wav",
            extractor=extractor,
            modelo_factory=factory,
        )

    # No se produjo ningún trabajo: ni extracción de audio ni carga de modelo,
    # por tanto no hay timestamps por palabra (ni parciales).
    assert extractor.llamadas == []
    assert factory.llamadas == []


# ---------------------------------------------------------------------------
# Tests unitarios de apoyo
# ---------------------------------------------------------------------------
def test_idioma_y_modelo_validos_no_lanzan_en_validacion() -> None:
    """Un idioma y modelo válidos no son rechazados por la validación previa.

    (Se usa una fábrica que devuelve un modelo trivial con una palabra para no
    disparar el error de "sin voz".)"""
    from app.engine.transcribe import validar_idioma_modelo

    ajustes = AjustesTranscripcion(idioma="es", modelo="small")
    # No debe lanzar.
    validar_idioma_modelo(ajustes)

    ajustes_auto = AjustesTranscripcion(idioma="auto", modelo="tiny")
    validar_idioma_modelo(ajustes_auto)
