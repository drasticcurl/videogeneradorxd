"""Tests property-based de la validación de textos extra (spec
edicion-avanzada-shorts, tarea 1.3).

Propiedad bajo prueba (**P8 — Validación de rangos de estilo de textos extra**,
diseño §12 / Req 15.4, 15.5, 19.4): para todo :class:`TextoExtra` y toda
``duracion_s``, la función pura :func:`validar_texto_extra` devuelve la lista
**vacía si y solo si** (bicondicional):

* el rango temporal cumple ``0 <= inicio_s < fin_s <= duracion_s``; y
* todos los campos de estilo están dentro de rango: ``tamano`` 12..200,
  ``grosor_borde`` 0..20, ``pos_vertical_pct`` 0..100, ``pos_horizontal_pct``
  0..100; y
* ``color`` y ``color_borde`` tienen el formato exacto ``#RRGGBB``.

Además, cuando la lista NO es vacía, contiene EXACTAMENTE los identificadores de
campo esperados (calculados de forma INDEPENDIENTE en el test, sin reutilizar la
lógica de :mod:`app.models.settings`).

La estrategia genera valores válidos e inválidos (incluidos casos borde: límites
exactos de rango, colores mal formados, ``inicio == fin``, ``fin > duracion`` y
``NaN`` en las posiciones porcentuales) para ejercitar ambos sentidos del
bicondicional. Se ejecutan >= 100 iteraciones (Req 19.6; aquí 200).

Validates: Requirements 15.4, 15.5, 19.4
"""

from __future__ import annotations

import math
import re
from typing import List, Set, Tuple

from hypothesis import given, settings
from hypothesis import strategies as st

from app.models.settings import (
    EstiloTextoExtra,
    TextoExtra,
    validar_texto_extra,
)

# Mínimo 100 iteraciones por propiedad (aquí 200), sin límite de tiempo por
# ejemplo para no marcar como lento en máquinas cargadas.
PBT_SETTINGS = settings(max_examples=200, deadline=None)

# ---------------------------------------------------------------------------
# Predicados de referencia INDEPENDIENTES (no reutilizan la implementación bajo
# prueba). Definen la especificación del bicondicional P8.
# ---------------------------------------------------------------------------
_HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def _color_ok(color: str) -> bool:
    """Formato exacto ``#RRGGBB`` (predicado de referencia del test)."""
    return isinstance(color, str) and bool(_HEX_RE.fullmatch(color))


def _num_en_rango(valor: object, minimo: float, maximo: float) -> bool:
    """``valor`` es numérico (no booleano ni NaN) y está en ``[minimo, maximo]``."""
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        return False
    if isinstance(valor, float) and math.isnan(valor):
        return False
    return minimo <= valor <= maximo


def _errores_esperados(t: TextoExtra, duracion_s: float) -> List[str]:
    """Calcula, de forma INDEPENDIENTE, los identificadores de campo inválidos.

    El orden coincide con el de :func:`validar_texto_extra` para poder comparar
    también la lista (no sólo el conjunto).
    """
    errores: List[str] = []
    # Rango temporal (Req 15.4).
    if not (0.0 <= t.inicio_s < t.fin_s <= duracion_s):
        errores.append("rango_temporal")
    # Rangos de estilo del motor (Req 15.5).
    if not _num_en_rango(t.estilo.tamano, 12, 200):
        errores.append("estilo.tamano")
    if not _num_en_rango(t.estilo.grosor_borde, 0, 20):
        errores.append("estilo.grosor_borde")
    if not _num_en_rango(t.estilo.pos_vertical_pct, 0.0, 100.0):
        errores.append("estilo.pos_vertical_pct")
    if not _num_en_rango(t.estilo.pos_horizontal_pct, 0.0, 100.0):
        errores.append("estilo.pos_horizontal_pct")
    # Colores en formato exacto `#RRGGBB` (Req 15.5).
    if not _color_ok(t.estilo.color):
        errores.append("estilo.color")
    if not _color_ok(t.estilo.color_borde):
        errores.append("estilo.color_borde")
    return errores


# ---------------------------------------------------------------------------
# Estrategias de generación: producen valores válidos e inválidos, cubriendo
# casos borde (límites exactos, colores mal formados, NaN, inicio==fin, etc.).
# ---------------------------------------------------------------------------
# Colores bien formados (#RRGGBB) y mal formados típicos.
_color_valido_st = st.from_regex(r"\A#[0-9A-Fa-f]{6}\Z")
_color_invalido_st = st.sampled_from(
    ["red", "#FFF", "FFFFFF", "#GGGGGG", "#1234567", "#12345", "#12 34 56", "", "#zzzzzz"]
)
_color_st = st.one_of(_color_valido_st, _color_invalido_st)

# Tamaño (int): válido 12..200; inválido por debajo/por encima (incluye borde).
_tamano_valido_st = st.integers(min_value=12, max_value=200)
_tamano_invalido_st = st.one_of(
    st.integers(min_value=-500, max_value=11),
    st.integers(min_value=201, max_value=1000),
)
_tamano_st = st.one_of(_tamano_valido_st, _tamano_invalido_st)

# Grosor de borde (int): válido 0..20; inválido fuera.
_grosor_valido_st = st.integers(min_value=0, max_value=20)
_grosor_invalido_st = st.one_of(
    st.integers(min_value=-500, max_value=-1),
    st.integers(min_value=21, max_value=1000),
)
_grosor_st = st.one_of(_grosor_valido_st, _grosor_invalido_st)

# Posición porcentual (float): válido 0..100; inválido fuera + NaN.
_pos_valido_st = st.floats(
    min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False
)
_pos_invalido_st = st.one_of(
    st.floats(min_value=-1000.0, max_value=-0.001, allow_nan=False, allow_infinity=False),
    st.floats(min_value=100.001, max_value=1000.0, allow_nan=False, allow_infinity=False),
    st.just(float("nan")),
)
_pos_st = st.one_of(_pos_valido_st, _pos_invalido_st)


@st.composite
def _estilo_st(draw: st.DrawFn) -> EstiloTextoExtra:
    """Genera un :class:`EstiloTextoExtra` con cada campo válido o inválido."""
    return EstiloTextoExtra(
        tamano=draw(_tamano_st),
        grosor_borde=draw(_grosor_st),
        pos_vertical_pct=draw(_pos_st),
        pos_horizontal_pct=draw(_pos_st),
        color=draw(_color_st),
        color_borde=draw(_color_st),
    )


@st.composite
def _texto_extra_y_duracion_st(draw: st.DrawFn) -> Tuple[TextoExtra, float]:
    """Genera un ``(TextoExtra, duracion_s)`` cubriendo rangos temporales
    válidos e inválidos.

    Los campos ``inicio_s``/``fin_s`` del modelo tienen ``Field(ge=0.0)``, por lo
    que sólo se generan valores no negativos (un negativo lo rechazaría pydantic
    en construcción). Los casos temporales inválidos posibles con valores >= 0
    son: ``inicio == fin``, ``inicio > fin`` y ``fin > duracion``.
    """
    duracion = draw(
        st.floats(min_value=0.1, max_value=3600.0, allow_nan=False, allow_infinity=False)
    )

    modo = draw(
        st.sampled_from(["valido", "inicio_igual_fin", "inicio_mayor_fin", "fin_supera_dur"])
    )

    if modo == "valido":
        # 0 <= inicio < fin <= duracion (incluye bordes inicio=0 y fin=duracion).
        inicio = draw(
            st.floats(min_value=0.0, max_value=duracion, allow_nan=False, allow_infinity=False)
        )
        fin = draw(
            st.floats(
                min_value=inicio, max_value=duracion, allow_nan=False, allow_infinity=False
            )
        )
    elif modo == "inicio_igual_fin":
        inicio = draw(
            st.floats(min_value=0.0, max_value=duracion, allow_nan=False, allow_infinity=False)
        )
        fin = inicio  # inicio == fin => inválido
    elif modo == "inicio_mayor_fin":
        fin = draw(
            st.floats(min_value=0.0, max_value=duracion, allow_nan=False, allow_infinity=False)
        )
        inicio = draw(
            st.floats(
                min_value=fin, max_value=duracion + 100.0, allow_nan=False, allow_infinity=False
            )
        )
        # Forzar inicio estrictamente mayor (si coincidieran, sigue siendo inválido).
    else:  # fin_supera_dur
        inicio = draw(
            st.floats(min_value=0.0, max_value=duracion, allow_nan=False, allow_infinity=False)
        )
        fin = draw(
            st.floats(
                min_value=duracion + 0.001,
                max_value=duracion + 1000.0,
                allow_nan=False,
                allow_infinity=False,
            )
        )

    texto = draw(st.text(max_size=40))
    modelo = TextoExtra(
        texto=texto,
        inicio_s=inicio,
        fin_s=fin,
        estilo=draw(_estilo_st()),
    )
    return modelo, duracion


# ---------------------------------------------------------------------------
# P8 — Validación de rangos de estilo de textos extra (bicondicional)
# Feature: edicion-avanzada-shorts, Property 8
# Validates: Requirements 15.4, 15.5, 19.4
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(caso=_texto_extra_y_duracion_st())
def test_p8_validar_texto_extra_bicondicional(caso: Tuple[TextoExtra, float]) -> None:
    """``validar_texto_extra`` devuelve [] si y sólo si todas las condiciones
    (rango temporal + rangos de estilo + colores) se cumplen; y el rechazo
    identifica EXACTAMENTE los campos inválidos.

    Validates: Requirements 15.4, 15.5, 19.4
    """
    t, duracion = caso

    reportados = validar_texto_extra(t, duracion)
    esperados = _errores_esperados(t, duracion)

    # (equivalencia global) [] si y sólo si no hay ninguna condición violada,
    # calculada de forma INDEPENDIENTE en el test.
    todas_validas = len(esperados) == 0
    assert (reportados == []) == todas_validas

    # (b) si algún campo es inválido, la lista NO es vacía y contiene los
    #     identificadores esperados; sin duplicados y en el mismo orden.
    assert reportados == esperados
    assert set(reportados) == set(esperados)
    assert len(reportados) == len(set(reportados))


# ---------------------------------------------------------------------------
# (a) Un texto extra completamente válido SIEMPRE produce lista vacía.
# ---------------------------------------------------------------------------
@st.composite
def _texto_extra_valido_st(draw: st.DrawFn) -> Tuple[TextoExtra, float]:
    """Genera exclusivamente textos extra VÁLIDOS (todos los campos en rango)."""
    duracion = draw(
        st.floats(min_value=0.1, max_value=3600.0, allow_nan=False, allow_infinity=False)
    )
    inicio = draw(
        st.floats(min_value=0.0, max_value=duracion, allow_nan=False, allow_infinity=False)
    )
    fin = draw(
        st.floats(min_value=inicio, max_value=duracion, allow_nan=False, allow_infinity=False)
    )
    estilo = EstiloTextoExtra(
        tamano=draw(_tamano_valido_st),
        grosor_borde=draw(_grosor_valido_st),
        pos_vertical_pct=draw(_pos_valido_st),
        pos_horizontal_pct=draw(_pos_valido_st),
        color=draw(_color_valido_st),
        color_borde=draw(_color_valido_st),
    )
    t = TextoExtra(texto=draw(st.text(max_size=40)), inicio_s=inicio, fin_s=fin, estilo=estilo)
    return t, duracion


@PBT_SETTINGS
@given(caso=_texto_extra_valido_st())
def test_p8_texto_extra_valido_lista_vacia(caso: Tuple[TextoExtra, float]) -> None:
    """(a) Si se construye un texto extra completamente válido => lista vacía.

    Nota: cuando ``inicio == fin`` (posible al muestrear ``fin`` desde ``inicio``)
    el rango temporal es inválido; ese caso se contempla comparando contra el
    predicado de referencia independiente.

    Validates: Requirements 15.4, 15.5, 19.4
    """
    t, duracion = caso
    reportados = validar_texto_extra(t, duracion)
    assert reportados == _errores_esperados(t, duracion)


# ---------------------------------------------------------------------------
# Tests unitarios de apoyo (casos borde explícitos)
# ---------------------------------------------------------------------------
def _texto(inicio: float, fin: float, **estilo_kwargs) -> TextoExtra:
    return TextoExtra(
        texto="hook", inicio_s=inicio, fin_s=fin, estilo=EstiloTextoExtra(**estilo_kwargs)
    )


def test_defaults_validos_en_rango_temporal_valido() -> None:
    """El estilo por defecto con un rango temporal válido pasa la validación."""
    assert validar_texto_extra(_texto(0.0, 5.0), 10.0) == []


def test_limites_exactos_de_estilo_son_validos() -> None:
    """Los límites exactos (12, 200, 0, 20, 0.0, 100.0) están DENTRO de rango."""
    t = _texto(
        0.0,
        10.0,
        tamano=12,
        grosor_borde=0,
        pos_vertical_pct=0.0,
        pos_horizontal_pct=100.0,
    )
    assert validar_texto_extra(t, 10.0) == []
    t2 = _texto(
        0.0,
        10.0,
        tamano=200,
        grosor_borde=20,
        pos_vertical_pct=100.0,
        pos_horizontal_pct=0.0,
    )
    assert validar_texto_extra(t2, 10.0) == []


def test_inicio_igual_fin_es_invalido() -> None:
    """``inicio == fin`` viola el rango temporal (intervalo vacío)."""
    assert validar_texto_extra(_texto(3.0, 3.0), 10.0) == ["rango_temporal"]


def test_fin_supera_duracion_es_invalido() -> None:
    """``fin > duracion`` viola el rango temporal."""
    assert validar_texto_extra(_texto(1.0, 12.0), 10.0) == ["rango_temporal"]


def test_borde_fin_igual_duracion_es_valido() -> None:
    """``fin == duracion`` es el límite superior VÁLIDO del rango temporal."""
    assert validar_texto_extra(_texto(0.0, 10.0), 10.0) == []


def test_color_mal_formado_se_identifica() -> None:
    """Un color sin el formato ``#RRGGBB`` se reporta como ``estilo.color``."""
    assert validar_texto_extra(_texto(0.0, 5.0, color="rojo"), 10.0) == ["estilo.color"]
    assert validar_texto_extra(_texto(0.0, 5.0, color="#FFF"), 10.0) == ["estilo.color"]


def test_varios_campos_invalidos_se_reportan_en_orden() -> None:
    """Varias violaciones se reportan juntas en el orden de la función."""
    t = _texto(
        5.0,
        1.0,  # inicio > fin => rango_temporal
        tamano=5,  # < 12
        grosor_borde=99,  # > 20
        pos_vertical_pct=150.0,  # > 100
        color="nope",  # color inválido
    )
    assert validar_texto_extra(t, 10.0) == [
        "rango_temporal",
        "estilo.tamano",
        "estilo.grosor_borde",
        "estilo.pos_vertical_pct",
        "estilo.color",
    ]


def test_nan_en_posicion_es_invalido() -> None:
    """Un ``NaN`` en una posición porcentual se considera fuera de rango."""
    t = _texto(0.0, 5.0, pos_horizontal_pct=float("nan"))
    assert validar_texto_extra(t, 10.0) == ["estilo.pos_horizontal_pct"]
