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



# ---------------------------------------------------------------------------
# Modo offline: fábrica de modelo por defecto resuelve el modelo horneado
# (bugfix: eliminar la descarga de faster-whisper desde HuggingFace en runtime).
#
# Cuando ``config.WHISPER_MODEL_DIR`` está seteado, ``_modelo_factory_por_defecto``
# debe construir ``WhisperModel`` apuntando al directorio LOCAL horneado y con
# ``local_files_only=True`` (nunca consulta HuggingFace => no hay 429/cuelgue).
# Se inyecta un módulo ``faster_whisper`` falso para no depender de la biblioteca
# real ni descargar nada.
# ---------------------------------------------------------------------------
import sys
import types
from pathlib import Path

from app import config
from app.engine.transcribe import _modelo_factory_por_defecto


def _instalar_fake_faster_whisper(monkeypatch) -> dict:
    """Inyecta un ``faster_whisper`` falso y devuelve las llamadas capturadas."""
    capturado: dict = {}

    class _FakeWhisperModel:
        def __init__(self, model, **kwargs):  # noqa: D401 - doble de prueba
            capturado["model"] = model
            capturado["kwargs"] = kwargs

    modulo = types.ModuleType("faster_whisper")
    modulo.WhisperModel = _FakeWhisperModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", modulo)
    return capturado


def test_factory_offline_usa_ruta_local_del_modelo_horneado(monkeypatch, tmp_path) -> None:
    """Con WHISPER_MODEL_DIR seteado y el modelo horneado presente, la fábrica
    apunta a la ruta local ``<dir>/<modelo>`` con ``local_files_only=True``."""
    capturado = _instalar_fake_faster_whisper(monkeypatch)

    modelo_dir = tmp_path / "faster-whisper"
    (modelo_dir / "small").mkdir(parents=True)  # modelo horneado presente
    monkeypatch.setattr(config, "WHISPER_MODEL_DIR", str(modelo_dir))

    _modelo_factory_por_defecto("small")

    assert capturado["model"] == str(modelo_dir / "small")
    assert capturado["kwargs"].get("local_files_only") is True
    assert capturado["kwargs"].get("device") == "cpu"
    assert capturado["kwargs"].get("compute_type") == "int8"


def test_factory_offline_fallback_download_root_local_files_only(monkeypatch, tmp_path) -> None:
    """Con WHISPER_MODEL_DIR seteado pero SIN el subdirectorio del modelo, la
    fábrica usa el directorio como ``download_root`` y fuerza ``local_files_only``
    (nunca consulta la red)."""
    capturado = _instalar_fake_faster_whisper(monkeypatch)

    modelo_dir = tmp_path / "faster-whisper"
    modelo_dir.mkdir(parents=True)  # existe el dir base, no el del modelo
    monkeypatch.setattr(config, "WHISPER_MODEL_DIR", str(modelo_dir))

    _modelo_factory_por_defecto("small")

    assert capturado["model"] == "small"
    assert capturado["kwargs"].get("download_root") == str(modelo_dir)
    assert capturado["kwargs"].get("local_files_only") is True


def test_factory_local_dev_conserva_comportamiento_por_defecto(monkeypatch) -> None:
    """Con WHISPER_MODEL_DIR vacío (modo local/dev) se conserva el comportamiento
    previo: WhisperModel(modelo, device=cpu, int8) SIN forzar ``local_files_only``."""
    capturado = _instalar_fake_faster_whisper(monkeypatch)
    monkeypatch.setattr(config, "WHISPER_MODEL_DIR", "")

    _modelo_factory_por_defecto("small")

    assert capturado["model"] == "small"
    assert capturado["kwargs"].get("device") == "cpu"
    assert capturado["kwargs"].get("compute_type") == "int8"
    assert "local_files_only" not in capturado["kwargs"]
    assert "download_root" not in capturado["kwargs"]
