"""Tests del motor de transiciones entre clips (xfade/acrossfade).

Cubre las funciones puras de cálculo de offsets y construcción del
``filter_complex``, el mapeo de tipos de la UI a nombres de ``xfade`` y la ruta
de ejecución de :func:`app.engine.normalize.unir_clips` cuando se pide una
transición (usa un ``Runner`` e inspector inyectables, sin ffmpeg real).
"""

from __future__ import annotations

from pathlib import Path
from typing import List

import pytest

from app import config
from app.engine.ffprobe import ClipInfo
from app.engine.normalize import (
    calcular_offsets_xfade,
    comando_unir_con_transiciones,
    construir_filtro_transiciones,
    nombre_transicion_xfade,
    unir_clips,
)
from app.engine.proc import ResultadoComando
from app.models.settings import AjustesTransiciones
from app.storage.workdir import JobWorkdir


# ---------------------------------------------------------------------------
# Mapeo de tipos y funciones puras
# ---------------------------------------------------------------------------
def test_nombre_transicion_xfade_mapea_tipos() -> None:
    assert nombre_transicion_xfade("disolucion") == "fade"
    assert nombre_transicion_xfade("fundido_negro") == "fadeblack"
    assert nombre_transicion_xfade("deslizar_izq") == "slideleft"
    assert nombre_transicion_xfade("deslizar_arriba") == "slideup"


def test_nombre_transicion_ninguna_o_desconocida_es_none() -> None:
    assert nombre_transicion_xfade("ninguna") is None
    assert nombre_transicion_xfade("inexistente") is None


def test_calcular_offsets_xfade_acumula_menos_solape() -> None:
    # offset_j = sum(dur[0..j-1]) - j*d
    offsets = calcular_offsets_xfade([2.0, 3.0, 4.0], 0.5)
    assert offsets == [pytest.approx(1.5), pytest.approx(4.0)]


def test_calcular_offsets_menos_de_dos_clips_vacio() -> None:
    assert calcular_offsets_xfade([2.0], 0.5) == []
    assert calcular_offsets_xfade([], 0.5) == []


def test_construir_filtro_dos_clips() -> None:
    filtro = construir_filtro_transiciones(2, "fade", 0.5, [1.5])
    assert "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=1.5[vout]" in filtro
    assert "[0:a][1:a]acrossfade=d=0.5[aout]" in filtro


def test_construir_filtro_tres_clips_encadena() -> None:
    filtro = construir_filtro_transiciones(3, "fade", 0.5, [1.5, 4.0])
    # Primer xfade produce [v1]; el segundo lo consume y produce [vout].
    assert "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=1.5[v1]" in filtro
    assert "[v1][2:v]xfade=transition=fade:duration=0.5:offset=4[vout]" in filtro
    assert "[0:a][1:a]acrossfade=d=0.5[a1]" in filtro
    assert "[a1][2:a]acrossfade=d=0.5[aout]" in filtro


def test_construir_filtro_valida_argumentos() -> None:
    with pytest.raises(ValueError):
        construir_filtro_transiciones(1, "fade", 0.5, [])
    with pytest.raises(ValueError):
        construir_filtro_transiciones(3, "fade", 0.5, [1.5])  # faltan offsets


def test_comando_unir_con_transiciones_estructura() -> None:
    cmd = comando_unir_con_transiciones(
        ["a.mp4", "b.mp4"], "out.mp4", "fade", 0.5, [1.5], 30
    )
    assert cmd[0] == "ffmpeg"
    assert cmd.count("-i") == 2
    assert "-filter_complex" in cmd
    assert "[vout]" in cmd and "[aout]" in cmd
    assert cmd[-1] == "out.mp4"
    # Recodifica (no -c copy).
    assert "-c:v" in cmd and "libx264" in cmd


# ---------------------------------------------------------------------------
# Ruta de ejecución de unir_clips con transiciones (Runner/inspector fake)
# ---------------------------------------------------------------------------
def _inspector_fake(_ruta: str) -> ClipInfo:
    return ClipInfo(
        ruta=_ruta,
        ancho=1920,
        alto=1080,
        rotacion=0,
        fps=30.0,
        duracion_s=2.0,
        tiene_video=True,
        tiene_audio=True,
    )


class _RunnerGrabador:
    """Runner falso que registra los comandos y simula ffprobe de duración."""

    def __init__(self) -> None:
        self.comandos: List[List[str]] = []

    def __call__(self, args) -> ResultadoComando:
        args = list(args)
        self.comandos.append(args)
        # Comando de duración de ffprobe: devolver un número.
        if "format=duration" in args:
            return ResultadoComando(returncode=0, stdout="2.0", stderr="", args=args)
        return ResultadoComando(returncode=0, stdout="", stderr="", args=args)


def _hacer_job(tmp_path: Path, monkeypatch, nombre: str) -> JobWorkdir:
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")
    return JobWorkdir(nombre)


def test_unir_clips_con_transicion_usa_xfade(tmp_path: Path, monkeypatch) -> None:
    """Con una transición activa, la unión usa xfade en vez de concat + copy."""
    job = _hacer_job(tmp_path, monkeypatch, "job-trans")
    runner = _RunnerGrabador()

    unir_clips(
        job,
        ["/clips/a.mp4", "/clips/b.mp4"],
        1080,
        1920,
        30,
        runner=runner,
        inspector=_inspector_fake,
        transiciones=AjustesTransiciones(tipo="disolucion", duracion_ms=400),
    )

    # El último comando debe ser el de unión con filter_complex/xfade.
    ultimo = runner.comandos[-1]
    assert "-filter_complex" in ultimo
    filtro = ultimo[ultimo.index("-filter_complex") + 1]
    assert "xfade=transition=fade" in filtro
    assert "acrossfade" in filtro
    # No se usó el demuxer concat (corte duro).
    assert not any("concat" in c for c in ultimo)


def test_unir_clips_sin_transicion_usa_concat(tmp_path: Path, monkeypatch) -> None:
    """Sin transición (por defecto), la unión usa el demuxer concat + copy."""
    job = _hacer_job(tmp_path, monkeypatch, "job-concat")
    runner = _RunnerGrabador()

    unir_clips(
        job,
        ["/clips/a.mp4", "/clips/b.mp4"],
        1080,
        1920,
        30,
        runner=runner,
        inspector=_inspector_fake,
        transiciones=AjustesTransiciones(tipo="ninguna"),
    )

    ultimo = runner.comandos[-1]
    assert "concat" in ultimo
    assert "-filter_complex" not in ultimo
