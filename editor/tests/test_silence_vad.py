"""Tests del motor de silencios por voz (VAD), con detector y runner inyectados."""

from __future__ import annotations

from typing import List, Tuple

from app.engine.proc import ResultadoComando
from app.engine.silence import _silencios_desde_voz, cortar_silencios_vad


class _Runner:
    """Runner falso: simula ffprobe (duración) y ffmpeg (recorte)."""

    def __init__(self, duracion: str = "5.0") -> None:
        self.duracion = duracion
        self.comandos: List[List[str]] = []

    def __call__(self, args) -> ResultadoComando:
        args = list(args)
        self.comandos.append(args)
        if "format=duration" in args:
            return ResultadoComando(returncode=0, stdout=self.duracion, stderr="", args=args)
        return ResultadoComando(returncode=0, stdout="", stderr="", args=args)


def test_silencios_desde_voz_complemento() -> None:
    # Voz en [1,2] y [3,4] sobre 5 s -> silencios [0,1],[2,3],[4,5].
    silencios = _silencios_desde_voz([(1.0, 2.0), (3.0, 4.0)], 5.0)
    assert silencios == [(0.0, 1.0), (2.0, 3.0), (4.0, 5.0)]


def test_vad_conserva_los_tramos_de_voz() -> None:
    runner = _Runner(duracion="5.0")
    detector = lambda _ruta: [(1.0, 2.0), (3.0, 4.0)]  # noqa: E731

    cortar_silencios_vad("in.mp4", "out.mp4", 0, runner=runner, detector_voz=detector)

    recorte = runner.comandos[-1]
    assert "-filter_complex" in recorte
    filtro = recorte[recorte.index("-filter_complex") + 1]
    # Conserva exactamente los tramos de voz (margen 0).
    assert "between(t,1,2)" in filtro
    assert "between(t,3,4)" in filtro


def test_vad_falla_si_detector_lanza() -> None:
    runner = _Runner()

    def detector(_ruta):
        raise RuntimeError("modelo no disponible")

    import pytest

    from app.engine.silence import SilenceProcessingError

    with pytest.raises(SilenceProcessingError):
        cortar_silencios_vad("in.mp4", "out.mp4", 0, runner=runner, detector_voz=detector)
