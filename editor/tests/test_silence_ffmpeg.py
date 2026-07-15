"""Tests del motor nativo de corte de silencios con ffmpeg (Req 4.1, 4.5).

Cubre:

* ``parsear_silencedetect``: extracción de tramos de silencio del stderr de
  ffmpeg (varios casos, incluyendo ``start`` sin ``end`` y ausencia de silencios).
* ``calcular_segmentos_conservar``: propiedad (Hypothesis) que garantiza salidas
  dentro de ``[0, D]``, ordenadas, sin solapes y con ``inicio < fin``.
* ``construir_filtro_recorte``: contiene ``select``/``aselect``/``between`` y las
  etiquetas ``[v]``/``[a]``.
* Integración con runner mock: silencedetect -> duración -> recorte (returncode 0
  devuelve la salida; recorte con returncode != 0 lanza SilenceProcessingError).
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Sequence, Tuple

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.engine.proc import ResultadoComando
from app.engine.silence import (
    SilenceProcessingError,
    calcular_segmentos_conservar,
    comando_recorte_ffmpeg,
    comando_silencedetect,
    construir_filtro_recorte,
    cortar_silencios,
    cortar_silencios_ffmpeg,
    obtener_duracion,
    parsear_silencedetect,
)

PBT = settings(max_examples=200, deadline=None)


# ---------------------------------------------------------------------------
# parsear_silencedetect
# ---------------------------------------------------------------------------
def test_parsear_sin_silencios_lista_vacia() -> None:
    """Sin marcas de silencio, se devuelve una lista vacía."""
    stderr = "frame= 100 fps=25 q=-1.0 Lsize=N/A time=00:00:04.00"
    assert parsear_silencedetect(stderr) == []


def test_parsear_un_silencio_completo() -> None:
    """Un par start/end se empareja en un tramo (inicio, fin)."""
    stderr = (
        "[silencedetect @ 0x1] silence_start: 1.5\n"
        "[silencedetect @ 0x1] silence_end: 2.75 | silence_duration: 1.25\n"
    )
    assert parsear_silencedetect(stderr) == [(1.5, 2.75)]


def test_parsear_varios_silencios() -> None:
    """Varios pares se emparejan en orden."""
    stderr = (
        "silence_start: 0.5\n"
        "silence_end: 1.0\n"
        "silence_start: 3.0\n"
        "silence_end: 4.2\n"
    )
    assert parsear_silencedetect(stderr) == [(0.5, 1.0), (3.0, 4.2)]


def test_parsear_start_sin_end_hasta_el_final() -> None:
    """Un ``start`` sin ``end`` posterior se marca con fin infinito."""
    stderr = "silence_start: 5.0\n"
    resultado = parsear_silencedetect(stderr)
    assert len(resultado) == 1
    assert resultado[0][0] == 5.0
    assert resultado[0][1] == float("inf")


# ---------------------------------------------------------------------------
# calcular_segmentos_conservar — casos concretos
# ---------------------------------------------------------------------------
def test_conservar_sin_silencios_devuelve_todo() -> None:
    """Sin silencios se conserva todo el medio [(0, D)]."""
    assert calcular_segmentos_conservar([], 10.0, 0.0) == [(0.0, 10.0)]


def test_conservar_todo_silencio_no_vacio() -> None:
    """Si todo es silencio, nunca se devuelve vacío: se conserva todo."""
    assert calcular_segmentos_conservar([(0.0, 10.0)], 10.0, 0.0) == [(0.0, 10.0)]


def test_conservar_complemento_basico() -> None:
    """El complemento de un silencio central son los tramos de voz."""
    segs = calcular_segmentos_conservar([(2.0, 4.0)], 10.0, 0.0)
    assert segs == [(0.0, 2.0), (4.0, 10.0)]


def test_conservar_expande_y_fusiona_con_margen() -> None:
    """El margen expande los segmentos y fusiona los que se solapan."""
    # Silencio (4.9, 5.1) con margen 0.2 hace que los dos tramos se toquen/fusionen.
    segs = calcular_segmentos_conservar([(4.9, 5.1)], 10.0, 0.2)
    assert segs == [(0.0, 10.0)]


# ---------------------------------------------------------------------------
# Propiedad (Hypothesis) — Feature: vertical-shorts-editor, Property (silencios ffmpeg)
# Validates: Requirements 4.1
# ---------------------------------------------------------------------------
@st.composite
def _silencios_y_duracion(draw: st.DrawFn) -> Tuple[List[Tuple[float, float]], float, float]:
    duracion = draw(st.floats(min_value=0.1, max_value=1000.0))
    margen = draw(st.floats(min_value=0.0, max_value=5.0))
    n = draw(st.integers(min_value=0, max_value=8))
    silencios: List[Tuple[float, float]] = []
    for _ in range(n):
        a = draw(st.floats(min_value=-5.0, max_value=duracion + 5.0))
        b = draw(st.floats(min_value=-5.0, max_value=duracion + 5.0))
        silencios.append((min(a, b), max(a, b)))
    return silencios, duracion, margen


@PBT
@given(datos=_silencios_y_duracion())
def test_propiedad_segmentos_conservar_bien_formados(
    datos: Tuple[List[Tuple[float, float]], float, float],
) -> None:
    """Los segmentos a conservar están en [0, D], ordenados, sin solapes e
    inicio < fin, y nunca se devuelve una lista vacía."""
    silencios, duracion, margen = datos
    segs = calcular_segmentos_conservar(silencios, duracion, margen)

    # Nunca vacío.
    assert len(segs) >= 1

    prev_fin = None
    for ini, fin in segs:
        # Dentro de [0, D].
        assert 0.0 <= ini <= duracion
        assert 0.0 <= fin <= duracion
        # inicio < fin (longitud positiva).
        assert ini < fin
        # Ordenados y sin solapes.
        if prev_fin is not None:
            assert ini >= prev_fin
        prev_fin = fin


# ---------------------------------------------------------------------------
# construir_filtro_recorte
# ---------------------------------------------------------------------------
def test_construir_filtro_contiene_elementos_clave() -> None:
    """El filtro contiene select/aselect/between y las etiquetas [v]/[a]."""
    filtro = construir_filtro_recorte([(0.0, 2.0), (4.0, 10.0)])
    assert "select=" in filtro
    assert "aselect=" in filtro
    assert "between(t," in filtro
    assert "[v]" in filtro
    assert "[a]" in filtro
    # Los dos segmentos se unen con '+' (OR lógico) dentro de select.
    assert "+" in filtro
    # El video reajusta PTS con setpts=N/FRAME_RATE/TB.
    assert "setpts=N/FRAME_RATE/TB" in filtro
    # Regresión: el audio debe usar asetpts=N/SR/TB. 'STB' NO es una constante
    # válida de ffmpeg (provocaba "Undefined constant or missing '(' in 'STB'").
    assert "asetpts=N/SR/TB" in filtro
    assert "STB" not in filtro


# ---------------------------------------------------------------------------
# Comandos ffmpeg/ffprobe
# ---------------------------------------------------------------------------
def test_comando_silencedetect_usa_db_directo() -> None:
    comando = comando_silencedetect("in.mp4", -30.0, 0.5)
    assert comando[0] == "ffmpeg"
    assert "-af" in comando
    idx = comando.index("-af")
    assert comando[idx + 1] == "silencedetect=noise=-30dB:d=0.5"
    assert comando[-1] == "-"
    assert "null" in comando


def test_comando_recorte_mapea_v_y_a() -> None:
    comando = comando_recorte_ffmpeg("in.mp4", "out.mp4", "FILTRO")
    assert comando[0] == "ffmpeg"
    assert "-filter_complex" in comando
    assert "[v]" in comando and "[a]" in comando
    assert comando[-1] == "out.mp4"


# ---------------------------------------------------------------------------
# obtener_duracion (ffprobe) — comando canónico y parseo
# ---------------------------------------------------------------------------
class _RunnerCaptura:
    """Runner que captura el comando y devuelve un resultado fijo."""

    def __init__(self, stdout: str = "", returncode: int = 0, stderr: str = "") -> None:
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr
        self.comandos: List[List[str]] = []

    def __call__(self, args: Sequence[str]) -> ResultadoComando:
        args = list(args)
        self.comandos.append(args)
        return ResultadoComando(
            returncode=self.returncode,
            stdout=self.stdout,
            stderr=self.stderr,
            args=args,
        )


def test_obtener_duracion_comando_usa_noprint_wrappers() -> None:
    """El comando ffprobe de duración usa la forma canónica (ffprobe 8.x).

    Regresión: ffprobe 8.x rechaza la opción inexistente ``np``; debe usarse
    ``default=noprint_wrappers=1:nokey=1``.
    """
    runner = _RunnerCaptura(stdout="38.08\n", returncode=0)
    obtener_duracion("in.mp4", runner=runner)
    comando = runner.comandos[0]
    assert comando[0] == "ffprobe"
    assert "-of" in comando
    idx = comando.index("-of")
    assert comando[idx + 1] == "default=noprint_wrappers=1:nokey=1"
    # No debe quedar rastro de la opción inválida 'np' ni del alias corto 'nk'.
    assert "np=1" not in comando[idx + 1]
    assert "nk=1" not in comando[idx + 1]


def test_obtener_duracion_parsea_stdout_numerico() -> None:
    """Con rc 0 y stdout numérico devuelve el float correspondiente."""
    runner = _RunnerCaptura(stdout="38.08\n", returncode=0)
    assert obtener_duracion("in.mp4", runner=runner) == pytest.approx(38.08)


def test_obtener_duracion_rc_distinto_de_cero_lanza_error() -> None:
    """Con rc != 0 se lanza SilenceProcessingError."""
    runner = _RunnerCaptura(stdout="", returncode=1, stderr="boom")
    with pytest.raises(SilenceProcessingError):
        obtener_duracion("in.mp4", runner=runner)


def test_obtener_duracion_stdout_vacio_lanza_error() -> None:
    """Con rc 0 pero stdout vacío/no numérico se lanza SilenceProcessingError."""
    runner = _RunnerCaptura(stdout="   ", returncode=0)
    with pytest.raises(SilenceProcessingError):
        obtener_duracion("in.mp4", runner=runner)


# ---------------------------------------------------------------------------
# Integración con runner mock
# ---------------------------------------------------------------------------
class _RunnerSecuencia:
    """Runner que responde según el binario/subcomando invocado."""

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
        # ffmpeg: distinguir silencedetect del recorte.
        if "silencedetect" in " ".join(args):
            return ResultadoComando(returncode=0, stderr=self.stderr_detect, args=args)
        return ResultadoComando(
            returncode=self.rc_recorte,
            stderr="boom" if self.rc_recorte != 0 else "",
            args=args,
        )


def test_integracion_ffmpeg_devuelve_salida_en_exito(tmp_path: Path) -> None:
    """silencedetect -> duración -> recorte (rc 0) devuelve la ruta de salida."""
    runner = _RunnerSecuencia(
        stderr_detect="silence_start: 2.0\nsilence_end: 4.0\n",
        duracion="10.0",
    )
    salida = tmp_path / "cortado.mp4"
    resultado = cortar_silencios_ffmpeg(
        tmp_path / "unido.mp4", salida, -30.0, 200, runner=runner
    )
    assert resultado == salida
    # Se invocaron: silencedetect, ffprobe y recorte.
    assert any(c[0] == "ffprobe" for c in runner.comandos)
    assert any("silencedetect" in " ".join(c) for c in runner.comandos)
    assert any("-filter_complex" in c for c in runner.comandos)


def test_integracion_ffmpeg_recorte_falla_lanza_error(tmp_path: Path) -> None:
    """Si el recorte devuelve rc != 0 se lanza SilenceProcessingError."""
    runner = _RunnerSecuencia(
        stderr_detect="silence_start: 2.0\nsilence_end: 4.0\n",
        duracion="10.0",
        rc_recorte=1,
    )
    with pytest.raises(SilenceProcessingError):
        cortar_silencios_ffmpeg(
            tmp_path / "unido.mp4", tmp_path / "cortado.mp4", -30.0, 200, runner=runner
        )


def test_dispatch_por_defecto_usa_ffmpeg(tmp_path: Path) -> None:
    """Sin ``engine`` explícito, ``cortar_silencios`` usa el motor ffmpeg por defecto."""
    runner = _RunnerSecuencia(
        stderr_detect="",  # sin silencios
        duracion="8.0",
    )
    salida = tmp_path / "cortado.mp4"
    resultado = cortar_silencios(
        tmp_path / "unido.mp4",
        salida,
        activado=True,
        umbral_db=-30.0,
        margen_ms=200,
        runner=runner,
    )
    assert resultado == salida
    # Motor ffmpeg: no se invoca auto-editor.
    assert not any(c[0] == "auto-editor" for c in runner.comandos)
    assert any(c[0] == "ffprobe" for c in runner.comandos)
