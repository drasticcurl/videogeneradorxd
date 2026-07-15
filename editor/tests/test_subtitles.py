"""Tests del Paso 4 — Quemado de subtítulos (Req 7.2, 7.10).

Cubre el arreglo de compatibilidad con ffmpeg 8.x:

* ``comando_quemar_subtitulos`` usa la opción **nombrada** ``ass=filename=...``
  (no la ruta posicional ``ass=<path>``), y escapa las rutas con ``:`` / ``\\``.
* Cuando ffmpeg no incluye libass (o el filtro de subtítulos no está disponible)
  se lanza :class:`SubtitulosError` con un mensaje accionable que menciona libass
  y ``brew reinstall ffmpeg``.

La ejecución de ffmpeg se simula con un runner inyectable.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Sequence

import pytest

from app.engine.proc import ResultadoComando
from app.engine.subtitles import (
    SubtitulosError,
    _escapar_ruta_ass,
    comando_quemar_subtitulos,
    generar_y_quemar_subtitulos,
)
from app.models.settings import AjustesSubtitulos, ResolucionObjetivo


# ---------------------------------------------------------------------------
# comando_quemar_subtitulos: opción nombrada filename= y escapado de rutas
# ---------------------------------------------------------------------------
def test_comando_usa_opcion_nombrada_filename() -> None:
    """El filtro es ``ass=filename=...`` y ya no la ruta posicional ``ass=<path>``."""
    comando = comando_quemar_subtitulos("in.mp4", "/tmp/subtitulos.ass", "out.mp4")

    assert comando[0] == "ffmpeg"
    assert "-vf" in comando
    idx = comando.index("-vf")
    filtro = comando[idx + 1]
    assert filtro.startswith("ass=filename=")
    # No debe usarse la forma posicional (ass=<ruta> sin "filename=").
    assert filtro != "ass=/tmp/subtitulos.ass"
    # El audio se copia sin recodificar.
    assert "-c:a" in comando and "copy" in comando


def test_comando_escapa_rutas_con_dos_puntos_y_barra() -> None:
    """Una ruta con ``:`` y ``\\`` queda escapada en el filtro (filtergraph ffmpeg)."""
    ruta = "C:\\Users\\me\\subs.ass"
    comando = comando_quemar_subtitulos("in.mp4", ruta, "out.mp4")
    idx = comando.index("-vf")
    filtro = comando[idx + 1]

    esperado = "ass=filename=%s" % _escapar_ruta_ass(ruta)
    assert filtro == esperado
    # Verifica el escapado concreto: ':' -> '\:' y '\' -> '\\'.
    assert "\\:" in filtro
    assert "\\\\" in filtro


def test_escapar_ruta_ass_maneja_comilla_simple() -> None:
    """El helper escapa también la comilla simple (``'`` -> ``\\'``)."""
    assert _escapar_ruta_ass("/tmp/it's.ass") == "/tmp/it\\'s.ass"


# ---------------------------------------------------------------------------
# Detección de libass ausente / filtro de subtítulos no disponible (Req 7.10)
# ---------------------------------------------------------------------------
def _runner_stderr(stderr: str, returncode: int = 1):
    def runner(args: Sequence[str]) -> ResultadoComando:
        return ResultadoComando(returncode=returncode, stderr=stderr, args=list(args))

    return runner


def test_libass_ausente_lanza_error_accionable(tmp_path: Path) -> None:
    """stderr con 'No such filter: ass' => SubtitulosError con guía de libass."""
    runner = _runner_stderr("Error: No such filter: 'ass'")

    with pytest.raises(SubtitulosError) as info:
        generar_y_quemar_subtitulos(
            tmp_path / "cortado.mp4",
            [],
            AjustesSubtitulos(),
            ResolucionObjetivo(),
            tmp_path / "s.ass",
            tmp_path / "s.mp4",
            runner=runner,
            existe_salida=lambda _p: False,
        )

    mensaje = str(info.value).lower()
    assert "libass" in mensaje
    assert "brew reinstall ffmpeg" in mensaje


def test_error_generico_conserva_stderr(tmp_path: Path) -> None:
    """Un fallo que no es de libass conserva el stderr recortado en el motivo."""
    runner = _runner_stderr("algún otro error de ffmpeg")

    with pytest.raises(SubtitulosError) as info:
        generar_y_quemar_subtitulos(
            tmp_path / "cortado.mp4",
            [],
            AjustesSubtitulos(),
            ResolucionObjetivo(),
            tmp_path / "s.ass",
            tmp_path / "s.mp4",
            runner=runner,
            existe_salida=lambda _p: False,
        )

    mensaje = str(info.value)
    assert "algún otro error de ffmpeg" in mensaje
    assert "libass" not in mensaje.lower()
