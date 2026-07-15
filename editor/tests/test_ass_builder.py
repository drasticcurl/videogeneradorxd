"""Tests property-based de la construcción del archivo ASS (Req 7).

Cubre las Propiedades 17-19 del diseño sobre :mod:`app.engine.ass_builder` y
:mod:`app.util.ass_time`:

* Propiedad 17: Round-trip del archivo ASS.
* Propiedad 18: Invariante de animación slide-up en el override ASS.
* Propiedad 19: Mapeo correcto de alineación ``\\an``.

Cada propiedad se ejercita con un mínimo de 100 iteraciones (aquí 200).

Se incluyen además unos pocos tests unitarios de ejemplo/borde para el formato
de tiempo, la conversión de color y la tabla de alineación.
"""

from __future__ import annotations

import re
from typing import List

from hypothesis import given, settings
from hypothesis import strategies as st

from app.engine import ass_builder
from app.engine.ass_builder import (
    calcular_alineacion,
    calcular_posicion_base,
    color_a_ass,
    construir_ass,
    construir_override,
    parsear_dialogues,
)
from app.models.settings import (
    AjustesSubtitulos,
    GrupoSubtitulo,
    ResolucionObjetivo,
)
from app.util.ass_time import format_ass_time, parse_ass_time

# Mínimo 100 iteraciones por propiedad (diseño: PBT >= 100 ejemplos).
PBT_SETTINGS = settings(max_examples=200, deadline=None)

# Tolerancia de tiempo: el formato ASS trunca a centésimas de segundo, por lo que
# el error de redondeo por tiempo está acotado a media centésima (0,005 s).
TOLERANCIA_S = 0.005 + 1e-6


# ---------------------------------------------------------------------------
# Generadores inteligentes
# ---------------------------------------------------------------------------
def _texto_subtitulo() -> st.SearchStrategy[str]:
    """Genera texto de subtítulo con caracteres especiales y no ASCII.

    El espacio del texto de un diálogo ASS excluye por construcción los
    delimitadores de *override* (``{``, ``}``) y la barra invertida ``\\`` (inicia
    tags de estilo); también se excluyen los caracteres de control. Se permiten
    explícitamente comas (que ejercitan el parseo del último campo), acentos,
    signos, alfabetos no latinos y emojis.
    """
    return st.text(
        alphabet=st.characters(
            blacklist_categories=("Cc", "Cs"),
            blacklist_characters="{}\\",
        ),
        min_size=0,
        max_size=30,
    )


@st.composite
def grupos_subtitulo(
    draw: st.DrawFn, min_size: int = 0, max_size: int = 20
) -> List[GrupoSubtitulo]:
    """Genera una lista de grupos de subtítulo con tiempos válidos (inicio <= fin)."""
    k = draw(st.integers(min_value=min_size, max_value=max_size))
    grupos: List[GrupoSubtitulo] = []
    for _ in range(k):
        inicio = draw(
            st.floats(min_value=0.0, max_value=3600.0, allow_nan=False, allow_infinity=False)
        )
        delta = draw(
            st.floats(min_value=0.0, max_value=10.0, allow_nan=False, allow_infinity=False)
        )
        texto = draw(_texto_subtitulo())
        grupos.append(
            GrupoSubtitulo(
                texto=texto,
                inicio_s=round(inicio, 3),
                fin_s=round(inicio + delta, 3),
            )
        )
    return grupos


@st.composite
def ajustes_subtitulos(draw: st.DrawFn) -> AjustesSubtitulos:
    """Genera ajustes de subtítulos dentro de los rangos válidos del motor."""

    def color() -> str:
        return "#%06X" % draw(st.integers(min_value=0, max_value=0xFFFFFF))

    return AjustesSubtitulos(
        max_palabras=draw(st.integers(min_value=1, max_value=10)),
        posicion_vertical=draw(st.sampled_from(["superior", "centro", "inferior"])),
        posicion_horizontal=draw(st.sampled_from(["izquierda", "centro", "derecha"])),
        pos_vertical_pct=draw(
            st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)
        ),
        pos_horizontal_pct=draw(
            st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)
        ),
        margen_px=draw(st.integers(min_value=0, max_value=500)),
        fuente=draw(st.sampled_from(["Arial", "Helvetica", "Roboto", "Impact", "Verdana"])),
        tamano=draw(st.integers(min_value=12, max_value=200)),
        color=color(),
        color_borde=color(),
        grosor_borde=draw(st.integers(min_value=0, max_value=20)),
        negrita=draw(st.booleans()),
        anim_entrada_ms=draw(st.integers(min_value=100, max_value=2000)),
        anim_salida_ms=draw(st.integers(min_value=100, max_value=2000)),
        slide_px=draw(st.integers(min_value=1, max_value=500)),
    )


@st.composite
def resolucion_objetivo(draw: st.DrawFn) -> ResolucionObjetivo:
    """Genera una resolución objetivo con dimensiones en 2..7680 (Req 3.2)."""
    return ResolucionObjetivo(
        ancho=draw(st.integers(min_value=2, max_value=7680)),
        alto=draw(st.integers(min_value=2, max_value=7680)),
    )


# ---------------------------------------------------------------------------
# Propiedad 17: Round-trip del archivo ASS
# Feature: vertical-shorts-editor, Property 17
# Validates: Requirements 7.1
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(
    grupos=grupos_subtitulo(),
    subtitulos=ajustes_subtitulos(),
    resolucion=resolucion_objetivo(),
)
def test_propiedad_17_round_trip_ass(
    grupos: List[GrupoSubtitulo],
    subtitulos: AjustesSubtitulos,
    resolucion: ResolucionObjetivo,
) -> None:
    """Generar el ASS y volver a parsear sus líneas Dialogue recupera el número
    de grupos, los textos y tiempos equivalentes (precisión de centésimas)."""
    ass = construir_ass(grupos, subtitulos, resolucion)
    recuperados = parsear_dialogues(ass)

    assert len(recuperados) == len(grupos)
    for original, recuperado in zip(grupos, recuperados):
        assert recuperado.texto == original.texto
        assert abs(recuperado.inicio_s - original.inicio_s) <= TOLERANCIA_S
        assert abs(recuperado.fin_s - original.fin_s) <= TOLERANCIA_S


# ---------------------------------------------------------------------------
# Propiedad 18: Invariante de animación slide-up en el override ASS
# Feature: vertical-shorts-editor, Property 18
# Validates: Requirements 7.3, 7.4
# ---------------------------------------------------------------------------
_OVERRIDE_RE = re.compile(
    r"^\{\\an(?P<an>[1-9])"
    r"\\move\((?P<x1>\d+),(?P<y1>\d+),(?P<x2>\d+),(?P<y2>\d+),0,(?P<t>\d+)\)"
    r"\\fad\((?P<fin>\d+),(?P<fout>\d+)\)\}$"
)


@PBT_SETTINGS
@given(subtitulos=ajustes_subtitulos(), resolucion=resolucion_objetivo())
def test_propiedad_18_invariante_slide_up(
    subtitulos: AjustesSubtitulos, resolucion: ResolucionObjetivo
) -> None:
    """El override tiene la forma esperada, ``y_inicial - y_final == slide_px`` y
    las duraciones de \\move/\\fad coinciden con las configuradas."""
    x, y_final = calcular_posicion_base(
        resolucion,
        subtitulos.pos_horizontal_pct,
        subtitulos.pos_vertical_pct,
        subtitulos.margen_px,
    )
    override = construir_override(subtitulos, x, y_final)

    m = _OVERRIDE_RE.match(override)
    assert m is not None, "override mal formado: %r" % override

    an_esperado = calcular_alineacion(
        subtitulos.posicion_vertical, subtitulos.posicion_horizontal
    )
    assert int(m.group("an")) == an_esperado

    # X constante durante la animación vertical.
    assert int(m.group("x1")) == x
    assert int(m.group("x2")) == x

    # Invariante slide-up (Req 7.4).
    y_inicial = int(m.group("y1"))
    y_reposo = int(m.group("y2"))
    assert y_reposo == y_final
    assert y_inicial - y_reposo == subtitulos.slide_px

    # Duraciones configuradas (Req 7.3).
    assert int(m.group("t")) == subtitulos.anim_entrada_ms
    assert int(m.group("fin")) == subtitulos.anim_entrada_ms
    assert int(m.group("fout")) == subtitulos.anim_salida_ms


# ---------------------------------------------------------------------------
# Propiedad 19: Mapeo correcto de alineación \an
# Feature: vertical-shorts-editor, Property 19
# Validates: Requirements 7.5, 7.6
# ---------------------------------------------------------------------------
# Derivación independiente de la celda del teclado numérico ASS:
#   fila:  inferior=0, centro=3, superior=6 ; columna: izquierda=1, centro=2, derecha=3
_FILA = {"inferior": 0, "centro": 3, "superior": 6}
_COLUMNA = {"izquierda": 1, "centro": 2, "derecha": 3}


@PBT_SETTINGS
@given(
    vertical=st.sampled_from(["superior", "centro", "inferior"]),
    horizontal=st.sampled_from(["izquierda", "centro", "derecha"]),
)
def test_propiedad_19_mapeo_alineacion(vertical: str, horizontal: str) -> None:
    """El \\anN generado corresponde a la celda del teclado numérico ASS."""
    esperado = _FILA[vertical] + _COLUMNA[horizontal]
    assert calcular_alineacion(vertical, horizontal) == esperado
    # Rango válido del teclado numérico.
    assert 1 <= calcular_alineacion(vertical, horizontal) <= 9


# ---------------------------------------------------------------------------
# Tests unitarios de ejemplo / borde
# ---------------------------------------------------------------------------
def test_format_ass_time_ejemplos() -> None:
    assert format_ass_time(0.0) == "0:00:00.00"
    assert format_ass_time(0.5) == "0:00:00.50"
    assert format_ass_time(3661.24) == "1:01:01.24"


def test_format_ass_time_acarreo_por_redondeo() -> None:
    # 59,999 s se redondea a la centésima -> 1:00.00 (propaga acarreo).
    assert format_ass_time(59.999) == "0:01:00.00"


def test_format_ass_time_negativo_se_satura_a_cero() -> None:
    assert format_ass_time(-3.2) == "0:00:00.00"


def test_parse_ass_time_es_inverso() -> None:
    assert parse_ass_time("1:01:01.24") == 3661.24
    assert parse_ass_time("0:00:00.50") == 0.5


def test_color_a_ass_conversion() -> None:
    # #RRGGBB -> &H00BBGGRR (opaco).
    assert color_a_ass("#FFFFFF") == "&H00FFFFFF"
    assert color_a_ass("#000000") == "&H00000000"
    assert color_a_ass("#123456") == "&H00563412"
    # Tolera ausencia de '#'.
    assert color_a_ass("112233") == "&H00332211"


def test_tabla_alineacion_completa() -> None:
    assert calcular_alineacion("superior", "izquierda") == 7
    assert calcular_alineacion("superior", "centro") == 8
    assert calcular_alineacion("superior", "derecha") == 9
    assert calcular_alineacion("centro", "izquierda") == 4
    assert calcular_alineacion("centro", "centro") == 5
    assert calcular_alineacion("centro", "derecha") == 6
    assert calcular_alineacion("inferior", "izquierda") == 1
    assert calcular_alineacion("inferior", "centro") == 2
    assert calcular_alineacion("inferior", "derecha") == 3


def test_minusculas_pasa_el_texto_a_minuscula() -> None:
    """Con ``minusculas=True`` el texto del Dialogue va en minúscula (con acentos)."""
    grupos = [GrupoSubtitulo(texto="HOLA Qué TAL Ñoño", inicio_s=0.0, fin_s=1.0)]
    resolucion = ResolucionObjetivo(ancho=1080, alto=1920)

    ass_min = construir_ass(grupos, AjustesSubtitulos(minusculas=True), resolucion)
    [recuperado] = parsear_dialogues(ass_min)
    assert recuperado.texto == "hola qué tal ñoño"


def test_minusculas_desactivado_conserva_el_texto() -> None:
    """Por defecto (``minusculas=False``) el texto se conserva tal cual."""
    grupos = [GrupoSubtitulo(texto="HOLA Qué TAL", inicio_s=0.0, fin_s=1.0)]
    resolucion = ResolucionObjetivo(ancho=1080, alto=1920)

    ass = construir_ass(grupos, AjustesSubtitulos(), resolucion)
    [recuperado] = parsear_dialogues(ass)
    assert recuperado.texto == "HOLA Qué TAL"


def test_construir_ass_incluye_secciones_y_playres() -> None:
    grupos = [GrupoSubtitulo(texto="hola qué tal", inicio_s=0.5, fin_s=1.2)]
    subtitulos = AjustesSubtitulos()
    resolucion = ResolucionObjetivo(ancho=1080, alto=1920)
    ass = construir_ass(grupos, subtitulos, resolucion)
    assert "[Script Info]" in ass
    assert "PlayResX: 1080" in ass
    assert "PlayResY: 1920" in ass
    assert "[V4+ Styles]" in ass
    assert "[Events]" in ass
    assert ass.count("Dialogue:") == 1
    # El módulo expone su nombre para trazabilidad.
    assert hasattr(ass_builder, "construir_ass")
