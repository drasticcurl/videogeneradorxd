"""Pruebas unitarias de equivalencia del refactor del motor de silencios (Tarea 2.3).

Tras el refactor (Tarea 2.1), ``cortar_silencios``/``cortar_silencios_ffmpeg`` se
apoyan en las nuevas piezas puras/inyectables (``detectar_silencios`` +
``calcular_segmentos_conservar`` + recorte). Estas pruebas comprueban que el
**comportamiento observable** (los comandos ffmpeg y, en particular, el
``filter_complex``/segmentos calculados) es EL MISMO que el de la lógica previa
para las mismas entradas de detección.

La "lógica previa" se reproduce aquí como pipeline de referencia con las
funciones puras que ya existían antes del refactor:

    parsear_silencedetect(stderr)
        -> calcular_segmentos_conservar(silencios, duracion, margen_s)
        -> construir_filtro_recorte(segmentos)

Se usa un ``Runner`` doble/inyectable que devuelve un stderr de ``silencedetect``
fijo (mismo patrón que ``tests/test_silence_ffmpeg.py``) para no depender del
binario real de ffmpeg.

Cobertura:

* Equivalencia del ``filter_complex``/segmentos entre la nueva implementación y
  el pipeline de referencia (silencio central, con y sin margen, y silencio
  ``start`` sin ``end`` -> ``inf``).
* Casos borde: sin silencios (conservar todo), silencios adyacentes/solapados
  (se fusionan) y todo marcado para borrar (caso **D-VACIO** ->
  ``[(0, duracion)]``).
* Coherencia entre ``segmentos_conservar_desde_borrado`` y
  ``calcular_segmentos_conservar`` (mismo criterio de fusión/orden con margen 0).
* ``aplicar_tramos_borrado`` genera el comando de recorte esperado con un
  ``Runner`` doble.

**Valida: Requisitos 5.6, 5.8**
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Sequence, Tuple

import pytest

from app.engine.proc import ResultadoComando
from app.engine.silence import (
    aplicar_tramos_borrado,
    calcular_segmentos_conservar,
    comando_recorte_ffmpeg,
    construir_filtro_recorte,
    cortar_silencios,
    cortar_silencios_ffmpeg,
    parsear_silencedetect,
    segmentos_conservar_desde_borrado,
)


# ---------------------------------------------------------------------------
# Dobles de Runner (mismo patrón que tests/test_silence_ffmpeg.py)
# ---------------------------------------------------------------------------
class _RunnerSecuencia:
    """Runner doble que responde según el binario/subcomando invocado.

    * ``ffprobe`` -> devuelve la duración fija (por stdout).
    * ``ffmpeg ... silencedetect`` -> devuelve el stderr de detección fijo.
    * ``ffmpeg ... -filter_complex`` (recorte) -> devuelve ``rc_recorte``.

    Registra todos los comandos ejecutados en ``self.comandos``.
    """

    def __init__(self, stderr_detect: str, duracion: str, rc_recorte: int = 0) -> None:
        self.stderr_detect = stderr_detect
        self.duracion = duracion
        self.rc_recorte = rc_recorte
        self.comandos: List[List[str]] = []

    def __call__(self, args: Sequence[str]) -> ResultadoComando:
        args = list(args)
        self.comandos.append(args)
        if args[0] == "ffprobe":
            return ResultadoComando(returncode=0, stdout=self.duracion, args=args)
        if "silencedetect" in " ".join(args):
            return ResultadoComando(returncode=0, stderr=self.stderr_detect, args=args)
        return ResultadoComando(
            returncode=self.rc_recorte,
            stderr="boom" if self.rc_recorte != 0 else "",
            args=args,
        )


class _RunnerRecorte:
    """Runner doble mínimo para la fase de aplicación (solo recorte)."""

    def __init__(self, rc_recorte: int = 0) -> None:
        self.rc_recorte = rc_recorte
        self.comandos: List[List[str]] = []

    def __call__(self, args: Sequence[str]) -> ResultadoComando:
        args = list(args)
        self.comandos.append(args)
        return ResultadoComando(
            returncode=self.rc_recorte,
            stderr="boom" if self.rc_recorte != 0 else "",
            args=args,
        )


# ---------------------------------------------------------------------------
# Utilidades de la prueba
# ---------------------------------------------------------------------------
def _filtro_ejecutado(runner) -> str:
    """Extrae el ``filter_complex`` del comando de recorte ejecutado."""
    for cmd in runner.comandos:
        if "-filter_complex" in cmd:
            return cmd[cmd.index("-filter_complex") + 1]
    raise AssertionError("no se ejecutó ningún recorte con -filter_complex")


def _referencia_previa(
    stderr_detect: str, duracion: float, margen_ms: float
) -> Tuple[List[Tuple[float, float]], str]:
    """Reproduce la lógica PREVIA al refactor (segmentos + filtro esperados)."""
    silencios = parsear_silencedetect(stderr_detect)
    margen_s = float(margen_ms) / 1000.0
    segmentos = calcular_segmentos_conservar(silencios, duracion, margen_s)
    return segmentos, construir_filtro_recorte(segmentos)


# ---------------------------------------------------------------------------
# Equivalencia: nueva implementación vs. pipeline de referencia
# ---------------------------------------------------------------------------
def test_equivalencia_silencio_central_sin_margen(tmp_path: Path) -> None:
    """Un silencio central produce el mismo filtro/segmentos que la lógica previa."""
    stderr = "silence_start: 2.0\nsilence_end: 4.0\n"
    duracion = 10.0
    margen_ms = 0

    _segmentos_ref, filtro_ref = _referencia_previa(stderr, duracion, margen_ms)

    runner = _RunnerSecuencia(stderr_detect=stderr, duracion="10.0")
    salida = tmp_path / "cortado.mp4"
    resultado = cortar_silencios_ffmpeg(
        tmp_path / "unido.mp4", salida, -30.0, margen_ms, runner=runner
    )

    assert resultado == salida
    # El filtro ejecutado por la nueva implementación coincide con el de referencia.
    assert _filtro_ejecutado(runner) == filtro_ref
    # Y corresponde a los segmentos esperados [(0, 2), (4, 10)].
    assert filtro_ref == construir_filtro_recorte([(0.0, 2.0), (4.0, 10.0)])


def test_equivalencia_con_margen(tmp_path: Path) -> None:
    """Con margen no nulo, el filtro también coincide con el pipeline de referencia."""
    stderr = "silence_start: 2.0\nsilence_end: 4.0\n"
    duracion = 10.0
    margen_ms = 300  # 0.3 s a cada lado

    _segmentos_ref, filtro_ref = _referencia_previa(stderr, duracion, margen_ms)

    runner = _RunnerSecuencia(stderr_detect=stderr, duracion="10.0")
    cortar_silencios_ffmpeg(
        tmp_path / "unido.mp4", tmp_path / "cortado.mp4", -30.0, margen_ms, runner=runner
    )

    assert _filtro_ejecutado(runner) == filtro_ref


def test_equivalencia_start_sin_end_hasta_el_final(tmp_path: Path) -> None:
    """Un ``silence_start`` sin ``silence_end`` (silencio hasta el final) equivale."""
    stderr = "silence_start: 7.5\n"  # sin end -> inf, se recorta a la duración
    duracion = 10.0
    margen_ms = 0

    _segmentos_ref, filtro_ref = _referencia_previa(stderr, duracion, margen_ms)

    runner = _RunnerSecuencia(stderr_detect=stderr, duracion="10.0")
    cortar_silencios_ffmpeg(
        tmp_path / "unido.mp4", tmp_path / "cortado.mp4", -30.0, margen_ms, runner=runner
    )

    assert _filtro_ejecutado(runner) == filtro_ref
    # Se conserva únicamente lo previo al silencio final: [(0, 7.5)].
    assert filtro_ref == construir_filtro_recorte([(0.0, 7.5)])


def test_equivalencia_a_traves_de_cortar_silencios_por_defecto(tmp_path: Path) -> None:
    """``cortar_silencios`` (motor ffmpeg por defecto) es equivalente a la referencia."""
    stderr = "silence_start: 1.0\nsilence_end: 2.0\n"
    duracion = 8.0
    margen_ms = 0

    _segmentos_ref, filtro_ref = _referencia_previa(stderr, duracion, margen_ms)

    runner = _RunnerSecuencia(stderr_detect=stderr, duracion="8.0")
    salida = tmp_path / "cortado.mp4"
    resultado = cortar_silencios(
        tmp_path / "unido.mp4",
        salida,
        activado=True,
        umbral_db=-30.0,
        margen_ms=margen_ms,
        runner=runner,
    )

    assert resultado == salida
    # No se invoca auto-editor (motor ffmpeg por defecto).
    assert not any(c[0] == "auto-editor" for c in runner.comandos)
    assert _filtro_ejecutado(runner) == filtro_ref


# ---------------------------------------------------------------------------
# Casos borde
# ---------------------------------------------------------------------------
def test_borde_sin_silencios_conserva_todo(tmp_path: Path) -> None:
    """Sin silencios detectados se conserva todo el vídeo [(0, duracion)]."""
    stderr = "frame= 100 fps=25 time=00:00:04.00\n"  # sin marcas de silencio
    duracion = 10.0

    _segmentos_ref, filtro_ref = _referencia_previa(stderr, duracion, 0)

    runner = _RunnerSecuencia(stderr_detect=stderr, duracion="10.0")
    cortar_silencios_ffmpeg(
        tmp_path / "unido.mp4", tmp_path / "cortado.mp4", -30.0, 0, runner=runner
    )

    assert _filtro_ejecutado(runner) == filtro_ref
    assert filtro_ref == construir_filtro_recorte([(0.0, 10.0)])


def test_borde_silencios_adyacentes_o_solapados_se_fusionan(tmp_path: Path) -> None:
    """Silencios adyacentes/solapados se fusionan igual que en la lógica previa."""
    # (2,4) y (4,6) son adyacentes; (5,7) solapa con el resultado -> silencio [2,7].
    stderr = (
        "silence_start: 2.0\nsilence_end: 4.0\n"
        "silence_start: 4.0\nsilence_end: 6.0\n"
        "silence_start: 5.0\nsilence_end: 7.0\n"
    )
    duracion = 10.0

    _segmentos_ref, filtro_ref = _referencia_previa(stderr, duracion, 0)

    runner = _RunnerSecuencia(stderr_detect=stderr, duracion="10.0")
    cortar_silencios_ffmpeg(
        tmp_path / "unido.mp4", tmp_path / "cortado.mp4", -30.0, 0, runner=runner
    )

    assert _filtro_ejecutado(runner) == filtro_ref
    # El silencio fusionado [2,7] deja conservar [(0,2), (7,10)].
    assert filtro_ref == construir_filtro_recorte([(0.0, 2.0), (7.0, 10.0)])


def test_borde_todo_silencio_conserva_todo(tmp_path: Path) -> None:
    """Si todo es silencio, la nueva implementación nunca produce salida vacía."""
    stderr = "silence_start: 0.0\nsilence_end: 10.0\n"
    duracion = 10.0

    _segmentos_ref, filtro_ref = _referencia_previa(stderr, duracion, 0)

    runner = _RunnerSecuencia(stderr_detect=stderr, duracion="10.0")
    cortar_silencios_ffmpeg(
        tmp_path / "unido.mp4", tmp_path / "cortado.mp4", -30.0, 0, runner=runner
    )

    assert _filtro_ejecutado(runner) == filtro_ref
    assert filtro_ref == construir_filtro_recorte([(0.0, 10.0)])


# ---------------------------------------------------------------------------
# Caso D-VACIO y coherencia de segmentos_conservar_desde_borrado
# ---------------------------------------------------------------------------
def test_segmentos_desde_borrado_todo_borrado_es_d_vacio() -> None:
    """Si el usuario marca todo para borrar, se conserva el vídeo entero (D-VACIO)."""
    assert segmentos_conservar_desde_borrado([(0.0, 10.0)], 10.0) == [(0.0, 10.0)]
    # Varios tramos que en conjunto cubren [0, duracion] también dan D-VACIO.
    assert segmentos_conservar_desde_borrado(
        [(0.0, 5.0), (5.0, 10.0)], 10.0
    ) == [(0.0, 10.0)]


def test_segmentos_desde_borrado_complemento_y_fusion() -> None:
    """Complemento con fusión de tramos solapados/adyacentes, ordenado y sin solapes."""
    # Borrar [2,4],[3,5] (solapados -> [2,5]) y [7,8] sobre 10 s.
    conservar = segmentos_conservar_desde_borrado([(2.0, 4.0), (3.0, 5.0), (7.0, 8.0)], 10.0)
    assert conservar == [(0.0, 2.0), (5.0, 7.0), (8.0, 10.0)]


def test_segmentos_desde_borrado_sin_borrados_conserva_todo() -> None:
    """Sin tramos a borrar, se conserva todo el vídeo."""
    assert segmentos_conservar_desde_borrado([], 10.0) == [(0.0, 10.0)]


@pytest.mark.parametrize(
    "tramos, duracion",
    [
        ([(2.0, 4.0)], 10.0),
        ([(0.0, 3.0), (6.0, 9.0)], 10.0),
        ([(2.0, 4.0), (3.0, 5.0)], 10.0),  # solapados -> fusión
        ([(4.0, 6.0), (6.0, 8.0)], 10.0),  # adyacentes -> fusión
        ([], 10.0),  # sin borrados
        ([(0.0, 10.0)], 10.0),  # todo borrado (D-VACIO)
    ],
)
def test_coherencia_desde_borrado_vs_calcular_conservar(
    tramos: List[Tuple[float, float]], duracion: float
) -> None:
    """``segmentos_conservar_desde_borrado`` coincide con ``calcular_segmentos_conservar``.

    Con margen 0, ambas funciones aplican el mismo criterio de fusión/orden y el
    mismo complemento en ``[0, duracion]`` (incluida la garantía de "nunca vacío"),
    tratando los tramos a borrar como si fueran los silencios detectados.
    """
    desde_borrado = segmentos_conservar_desde_borrado(tramos, duracion)
    desde_calcular = calcular_segmentos_conservar(tramos, duracion, 0.0)
    assert desde_borrado == desde_calcular


# ---------------------------------------------------------------------------
# aplicar_tramos_borrado: comando de recorte esperado
# ---------------------------------------------------------------------------
def test_aplicar_tramos_borrado_genera_comando_de_recorte_esperado(tmp_path: Path) -> None:
    """``aplicar_tramos_borrado`` ejecuta el recorte con el filtro/segmentos esperados."""
    tramos = [(2.0, 4.0), (7.0, 8.0)]
    duracion = 10.0
    segmentos_esperados = segmentos_conservar_desde_borrado(tramos, duracion)
    filtro_esperado = construir_filtro_recorte(segmentos_esperados)
    comando_esperado = comando_recorte_ffmpeg(
        str(tmp_path / "unido.mp4"), str(tmp_path / "cortado.mp4"), filtro_esperado
    )

    runner = _RunnerRecorte()
    salida = tmp_path / "cortado.mp4"
    resultado = aplicar_tramos_borrado(
        tmp_path / "unido.mp4", salida, tramos, duracion, runner=runner
    )

    assert resultado == salida
    # Se ejecutó exactamente un comando y coincide con el de recorte esperado.
    assert len(runner.comandos) == 1
    assert runner.comandos[0] == comando_esperado
    assert _filtro_ejecutado(runner) == filtro_esperado


def test_aplicar_tramos_borrado_d_vacio_conserva_todo(tmp_path: Path) -> None:
    """Si se borra todo, ``aplicar_tramos_borrado`` conserva el vídeo entero (D-VACIO)."""
    duracion = 10.0
    filtro_esperado = construir_filtro_recorte([(0.0, duracion)])

    runner = _RunnerRecorte()
    aplicar_tramos_borrado(
        tmp_path / "unido.mp4",
        tmp_path / "cortado.mp4",
        [(0.0, 10.0)],
        duracion,
        runner=runner,
    )

    assert _filtro_ejecutado(runner) == filtro_esperado
