"""Tests de la eliminación de risas (detección, segmentos, remapeo, recorte)."""

from __future__ import annotations

from typing import List

from app.engine.proc import ResultadoComando
from app.engine.risas import (
    eliminar_risas,
    es_risa,
    remapear_tiempos,
    segmentos_risa,
)
from app.models.settings import Palabra


def test_es_risa_detecta_variantes() -> None:
    assert es_risa("jaja")
    assert es_risa("jajaja")
    assert es_risa("JAJA")
    assert es_risa("jeje")
    assert es_risa("jiji")
    assert es_risa("haha")
    assert es_risa("(risas)")
    assert es_risa("risas")


def test_es_risa_no_falso_positivo() -> None:
    assert not es_risa("hola")
    assert not es_risa("casa")
    assert not es_risa("ja")  # una sola sílaba: no se considera risa
    assert not es_risa("")


def test_segmentos_risa_expande_y_fusiona() -> None:
    palabras = [Palabra(texto="jaja", inicio_s=1.0, fin_s=1.5),
                Palabra(texto="jaja", inicio_s=1.6, fin_s=2.0)]
    # Con margen 0.2: (0.8,1.7) y (1.4,2.2) se solapan -> (0.8,2.2).
    assert segmentos_risa(palabras, 0.2, 10.0) == [(0.8, 2.2)]


def test_remapear_descarta_risa_y_traslada() -> None:
    palabras = [
        Palabra(texto="hola", inicio_s=0.0, fin_s=1.0),
        Palabra(texto="jaja", inicio_s=1.0, fin_s=2.0),
        Palabra(texto="mundo", inicio_s=2.0, fin_s=3.0),
    ]
    # Se elimina [1,2]; se conservan [0,1] y [2,3].
    out = remapear_tiempos(palabras, [(0.0, 1.0), (2.0, 3.0)])
    assert [p.texto for p in out] == ["hola", "mundo"]
    assert (out[0].inicio_s, out[0].fin_s) == (0.0, 1.0)
    # 'mundo' se traslada a [1,2] en la nueva línea de tiempo.
    assert (out[1].inicio_s, out[1].fin_s) == (1.0, 2.0)


class _Runner:
    def __init__(self, duracion: str = "3.0") -> None:
        self.duracion = duracion
        self.comandos: List[List[str]] = []

    def __call__(self, args) -> ResultadoComando:
        args = list(args)
        self.comandos.append(args)
        if "format=duration" in args:
            return ResultadoComando(returncode=0, stdout=self.duracion, stderr="", args=args)
        return ResultadoComando(returncode=0, stdout="", stderr="", args=args)


def test_eliminar_risas_noop_sin_risas() -> None:
    runner = _Runner()
    palabras = [Palabra(texto="hola", inicio_s=0.0, fin_s=1.0),
                Palabra(texto="mundo", inicio_s=1.0, fin_s=2.0)]
    ruta, out = eliminar_risas("in.mp4", "out.mp4", palabras, margen_ms=0, runner=runner)
    # No-op: devuelve el video de entrada y las palabras sin cambios, sin ffmpeg.
    assert str(ruta) == "in.mp4"
    assert [p.texto for p in out] == ["hola", "mundo"]
    assert runner.comandos == []


def test_eliminar_risas_corta_y_remapea() -> None:
    runner = _Runner(duracion="3.0")
    palabras = [
        Palabra(texto="hola", inicio_s=0.0, fin_s=1.0),
        Palabra(texto="jaja", inicio_s=1.0, fin_s=2.0),
        Palabra(texto="mundo", inicio_s=2.0, fin_s=3.0),
    ]
    ruta, out = eliminar_risas("in.mp4", "out.mp4", palabras, margen_ms=0, runner=runner)
    assert str(ruta) == "out.mp4"
    # La risa se elimina; quedan 'hola' y 'mundo' remapeadas.
    assert [p.texto for p in out] == ["hola", "mundo"]
    # Se ejecutó el recorte con filter_complex.
    assert any("-filter_complex" in c for c in runner.comandos)
