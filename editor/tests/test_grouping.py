"""Tests property-based de la agrupación de palabras en subtítulos (Req 6).

Cubre las Propiedades 12-16 del diseño sobre :mod:`app.engine.grouping`:

* Propiedad 12: Tamaño de grupo acotado y fallback del máximo.
* Propiedad 13: La agrupación preserva todas las palabras en orden.
* Propiedad 14: Tiempos de grupo derivados de los timestamps por palabra.
* Propiedad 15: Robustez ante timestamps ausentes.
* Propiedad 16: Monotonicidad y no-solapamiento de los tiempos de subtítulos.

Cada propiedad se ejercita con un mínimo de 100 iteraciones (aquí 200).
"""

from __future__ import annotations

from typing import List, Optional

from hypothesis import given, settings
from hypothesis import strategies as st

from app.engine import grouping
from app.engine.grouping import agrupar, agrupar_detallado, tamano_efectivo
from app.models.settings import Palabra

# Mínimo 100 iteraciones por propiedad (diseño: PBT >= 100 ejemplos).
PBT_SETTINGS = settings(max_examples=200, deadline=None)


# ---------------------------------------------------------------------------
# Generadores inteligentes
# ---------------------------------------------------------------------------
def _texto_sin_espacios() -> st.SearchStrategy[str]:
    """Genera tokens no vacíos y sin ningún carácter de espacio.

    Al carecer de espacios, la operación ``texto.split(" ")`` recupera de forma
    exacta la lista de palabras que compone un grupo, lo que permite verificar la
    cobertura sin pérdida (Propiedad 13) y los tamaños de grupo (Propiedad 12).
    """
    return st.text(
        alphabet=st.characters(
            blacklist_categories=("Cc", "Cs", "Zs", "Zl", "Zp"),
        ),
        min_size=1,
        max_size=6,
    ).filter(lambda s: not any(ch.isspace() for ch in s))


@st.composite
def palabras_ordenadas(
    draw: st.DrawFn, min_size: int = 0, max_size: int = 40
) -> List[Palabra]:
    """Genera palabras con timestamps válidos y no decrecientes en el tiempo.

    Para ``k`` palabras se generan ``2k`` incrementos no negativos cuya suma
    acumulada produce una secuencia ordenada de tiempos ``t0 <= t1 <= ...``. La
    palabra ``j`` toma ``inicio = t[2j]`` y ``fin = t[2j+1]``, garantizando
    ``inicio <= fin`` por palabra y no-solapamiento entre palabras consecutivas.
    """
    k = draw(st.integers(min_value=min_size, max_value=max_size))
    incrementos = draw(
        st.lists(
            st.floats(min_value=0.0, max_value=5.0, allow_nan=False, allow_infinity=False),
            min_size=2 * k,
            max_size=2 * k,
        )
    )
    acc = draw(st.floats(min_value=0.0, max_value=10.0, allow_nan=False, allow_infinity=False))
    tiempos: List[float] = []
    for inc in incrementos:
        acc += inc
        tiempos.append(round(acc, 3))

    palabras: List[Palabra] = []
    for j in range(k):
        texto = draw(_texto_sin_espacios())
        palabras.append(Palabra(texto=texto, inicio_s=tiempos[2 * j], fin_s=tiempos[2 * j + 1]))
    return palabras


@st.composite
def palabra_arbitraria(draw: st.DrawFn) -> Palabra:
    """Genera una palabra con timestamps posiblemente ausentes o desordenados."""
    texto = draw(_texto_sin_espacios())
    tiempo = st.floats(min_value=-10.0, max_value=100.0, allow_nan=False, allow_infinity=False)
    inicio: Optional[float] = draw(st.one_of(st.none(), tiempo))
    fin: Optional[float] = draw(st.one_of(st.none(), tiempo))
    return Palabra(texto=texto, inicio_s=inicio, fin_s=fin)


# ---------------------------------------------------------------------------
# Propiedad 12: Tamaño de grupo acotado y fallback del máximo
# Feature: vertical-shorts-editor, Property 12
# Validates: Requirements 6.1, 6.2
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(palabras=palabras_ordenadas(), max_palabras=st.integers(min_value=-5, max_value=30))
def test_propiedad_12_tamano_acotado_y_fallback(
    palabras: List[Palabra], max_palabras: int
) -> None:
    """El tamaño efectivo está en 1..10 (4 si está fuera de rango) y ningún grupo
    excede ese tamaño."""
    n = tamano_efectivo(max_palabras)
    assert grouping.MIN_PALABRAS_GRUPO <= n <= grouping.MAX_PALABRAS_GRUPO
    if not (grouping.MIN_PALABRAS_GRUPO <= max_palabras <= grouping.MAX_PALABRAS_GRUPO):
        assert n == grouping.DEFAULT_MAX_PALABRAS

    grupos = agrupar(palabras, max_palabras)
    for grupo in grupos:
        tamano = len(grupo.texto.split(" "))
        assert 1 <= tamano <= n


# ---------------------------------------------------------------------------
# Propiedad 13: La agrupación preserva todas las palabras en orden
# Feature: vertical-shorts-editor, Property 13
# Validates: Requirements 6.3
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(palabras=palabras_ordenadas(), max_palabras=st.integers(min_value=1, max_value=10))
def test_propiedad_13_cobertura_sin_perdida(
    palabras: List[Palabra], max_palabras: int
) -> None:
    """Concatenar en orden los textos de todos los grupos reproduce la lista
    original de palabras, y la suma de tamaños es el total de palabras."""
    grupos = agrupar(palabras, max_palabras)

    tokens: List[str] = []
    for grupo in grupos:
        tokens.extend(grupo.texto.split(" "))

    assert tokens == [p.texto for p in palabras]
    assert sum(len(g.texto.split(" ")) for g in grupos) == len(palabras)


# ---------------------------------------------------------------------------
# Propiedad 14: Tiempos de grupo derivados de los timestamps por palabra
# Feature: vertical-shorts-editor, Property 14
# Validates: Requirements 6.4
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(palabras=palabras_ordenadas(), max_palabras=st.integers(min_value=1, max_value=10))
def test_propiedad_14_tiempos_derivados(
    palabras: List[Palabra], max_palabras: int
) -> None:
    """El inicio de cada grupo es el inicio de su primera palabra y el fin es el
    fin de su última palabra."""
    n = tamano_efectivo(max_palabras)
    grupos = agrupar(palabras, max_palabras)

    trozos = [palabras[i : i + n] for i in range(0, len(palabras), n)]
    # Con timestamps válidos y ordenados no se excluye ningún grupo.
    assert len(grupos) == len(trozos)
    for grupo, trozo in zip(grupos, trozos):
        assert grupo.inicio_s == trozo[0].inicio_s
        assert grupo.fin_s == trozo[-1].fin_s


# ---------------------------------------------------------------------------
# Propiedad 15: Robustez ante timestamps ausentes
# Feature: vertical-shorts-editor, Property 15
# Validates: Requirements 6.5
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(
    palabras=st.lists(palabra_arbitraria(), min_size=0, max_size=40),
    max_palabras=st.integers(min_value=1, max_value=10),
)
def test_propiedad_15_robustez_timestamps_ausentes(
    palabras: List[Palabra], max_palabras: int
) -> None:
    """Ningún grupo emitido contiene tiempos inválidos y se registra advertencia
    cuando se excluye algún grupo."""
    resultado = agrupar_detallado(palabras, max_palabras)

    for grupo in resultado.grupos:
        assert grupo.inicio_s is not None
        assert grupo.fin_s is not None
        assert grupo.inicio_s <= grupo.fin_s

    n = resultado.tamano_efectivo
    num_trozos = len(range(0, len(palabras), n)) if palabras else 0
    # max_palabras está en rango, por lo que no hay advertencia de fallback:
    # cualquier grupo faltante respecto de los trozos implica una exclusión.
    if len(resultado.grupos) < num_trozos:
        assert resultado.advertencias


# ---------------------------------------------------------------------------
# Propiedad 16: Monotonicidad y no-solapamiento de los tiempos de subtítulos
# Feature: vertical-shorts-editor, Property 16
# Validates: Requirements 6.4
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(palabras=palabras_ordenadas(), max_palabras=st.integers(min_value=1, max_value=10))
def test_propiedad_16_monotonicidad_sin_solapamiento(
    palabras: List[Palabra], max_palabras: int
) -> None:
    """Cada grupo cumple inicio <= fin y el inicio de cada grupo es >= al fin del
    grupo anterior (tiempos monótonos no decrecientes, sin solapamiento)."""
    grupos = agrupar(palabras, max_palabras)

    for grupo in grupos:
        assert grupo.inicio_s <= grupo.fin_s

    for anterior, siguiente in zip(grupos, grupos[1:]):
        assert siguiente.inicio_s >= anterior.fin_s
