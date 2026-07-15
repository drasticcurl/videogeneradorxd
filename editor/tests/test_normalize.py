"""Tests property-based de la normalización 9:16 (Req 3).

Cubre las Propiedades 6 y 7 del diseño sobre :mod:`app.engine.normalize`:

* Propiedad 6: Normalización 9:16 sin deformación (escala + pad centrado).
* Propiedad 7: Homogeneización de clips heterogéneos.

Cada propiedad se ejercita con un mínimo de 100 iteraciones (aquí 200). Los
generadores cubren explícitamente las dimensiones extremas del rango (2 y 7680,
Req 3.2).
"""

from __future__ import annotations

from typing import List, Tuple

from hypothesis import given, settings
from hypothesis import strategies as st

from app.engine import normalize
from app.engine.normalize import (
    MAX_DIMENSION,
    MIN_DIMENSION,
    factor_escala,
    plan_normalizacion,
    planificar_clips,
)

# Mínimo 100 iteraciones por propiedad (diseño: PBT >= 100 ejemplos).
PBT_SETTINGS = settings(max_examples=200, deadline=None)

# Tolerancia para comparaciones en coma flotante. El relleno y las dimensiones
# escaladas son exactas en la matemática real; el error acumulado por el uso de
# `float` está muy por debajo de este umbral.
EPS = 1e-6


# ---------------------------------------------------------------------------
# Generadores inteligentes
# ---------------------------------------------------------------------------
def _dimension() -> st.SearchStrategy[int]:
    """Genera una dimensión de píxel en 2..7680, sesgada hacia los extremos.

    Se incluyen explícitamente los bordes del rango (2 y 7680, Req 3.2) para
    ejercitar los casos de escala extrema (ampliar mucho / reducir mucho).
    """
    return st.one_of(
        st.just(MIN_DIMENSION),
        st.just(MAX_DIMENSION),
        st.integers(min_value=MIN_DIMENSION, max_value=MAX_DIMENSION),
    )


@st.composite
def dimensiones(draw: st.DrawFn) -> Tuple[int, int]:
    """Genera un par ``(ancho, alto)`` de dimensiones válidas."""
    return draw(_dimension()), draw(_dimension())


# ---------------------------------------------------------------------------
# Propiedad 6: Normalización 9:16 sin deformación (escala + pad centrado)
# Feature: vertical-shorts-editor, Property 6
# Validates: Requirements 3.1
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(origen=dimensiones(), objetivo=dimensiones(), fps=st.integers(min_value=1, max_value=120))
def test_propiedad_6_normalizacion_sin_deformacion(
    origen: Tuple[int, int], objetivo: Tuple[int, int], fps: int
) -> None:
    """El factor de escala es idéntico en ambos ejes (`min(W/w, H/h)`), las
    dimensiones escaladas no exceden el objetivo y el relleno por lado es no
    negativo y centrado."""
    w, h = origen
    W, H = objetivo

    s = factor_escala(w, h, W, H)
    plan = plan_normalizacion(w, h, W, H, fps)

    # Factor de escala idéntico en ambos ejes = preserva la relación de aspecto.
    assert plan.factor_escala == s == min(W / w, H / h)

    # Las dimensiones escaladas no exceden el objetivo (Req 3.1).
    assert plan.ancho_escalado <= W + EPS
    assert plan.alto_escalado <= H + EPS
    assert plan.ancho_escalado == w * s
    assert plan.alto_escalado == h * s

    # Al menos un eje toca exactamente el objetivo (el eje que limita la escala).
    assert plan.ancho_escalado >= W - EPS or plan.alto_escalado >= H - EPS

    # Relleno por lado no negativo y centrado (Req 3.1).
    assert plan.pad_x >= -EPS
    assert plan.pad_y >= -EPS
    assert abs(plan.pad_x - (W - w * s) / 2.0) <= EPS
    assert abs(plan.pad_y - (H - h * s) / 2.0) <= EPS

    # La suma del contenido escalado más el relleno de ambos lados reconstruye el
    # objetivo (letterbox centrado exacto).
    assert abs(plan.ancho_escalado + 2 * plan.pad_x - W) <= EPS
    assert abs(plan.alto_escalado + 2 * plan.pad_y - H) <= EPS


# ---------------------------------------------------------------------------
# Propiedad 7: Homogeneización de clips heterogéneos
# Feature: vertical-shorts-editor, Property 7
# Validates: Requirements 3.3
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(
    clips=st.lists(dimensiones(), min_size=1, max_size=20),
    objetivo=dimensiones(),
    fps=st.integers(min_value=1, max_value=120),
)
def test_propiedad_7_homogeneizacion(
    clips: List[Tuple[int, int]], objetivo: Tuple[int, int], fps: int
) -> None:
    """Tras planificar la normalización, todos los intermedios comparten idéntica
    resolución objetivo e idénticos fps, con independencia de sus dimensiones y
    orientaciones de origen."""
    W, H = objetivo
    planes = planificar_clips(clips, W, H, fps)

    assert len(planes) == len(clips)

    resoluciones = {(p.ancho_objetivo, p.alto_objetivo) for p in planes}
    fps_objetivo = {p.fps_objetivo for p in planes}
    filtros = {p.filtro for p in planes}

    # Una única resolución objetivo y un único fps compartidos por todos.
    assert resoluciones == {(W, H)}
    assert fps_objetivo == {fps}
    # Como el filtro depende solo del objetivo y del fps, es idéntico para todos.
    assert len(filtros) == 1
    assert normalize.cadena_filtro_normalizacion(W, H, fps) in filtros


# ---------------------------------------------------------------------------
# Tests unitarios de ejemplo / borde
# ---------------------------------------------------------------------------
def test_factor_escala_reduce_landscape_a_vertical() -> None:
    # 1920x1080 (landscape) hacia 1080x1920: limita el ancho -> s = 1080/1920.
    s = factor_escala(1920, 1080, 1080, 1920)
    assert s == 1080 / 1920
    plan = plan_normalizacion(1920, 1080, 1080, 1920, 30)
    assert abs(plan.ancho_escalado - 1080) <= EPS  # el ancho toca el objetivo
    assert plan.alto_escalado < 1920  # el alto se rellena con barras negras
    assert plan.pad_x == 0 or abs(plan.pad_x) <= EPS
    assert plan.pad_y > 0


def test_cadena_filtro_formato_exacto() -> None:
    filtro = normalize.cadena_filtro_normalizacion(1080, 1920, 30)
    assert filtro == (
        "scale=w=1080:h=1920:force_original_aspect_ratio=decrease,"
        "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,"
        "setsar=1,fps=30"
    )


def test_dimensiones_extremas() -> None:
    # Ampliar desde 2x2 hasta 7680x7680 y reducir a la inversa.
    plan_up = plan_normalizacion(2, 2, MAX_DIMENSION, MAX_DIMENSION, 60)
    assert plan_up.pad_x >= -EPS and plan_up.pad_y >= -EPS
    plan_down = plan_normalizacion(MAX_DIMENSION, MAX_DIMENSION, 2, 2, 1)
    assert plan_down.ancho_escalado <= 2 + EPS
    assert plan_down.alto_escalado <= 2 + EPS


def test_dimension_invalida_rechazada() -> None:
    import pytest

    with pytest.raises(ValueError):
        plan_normalizacion(0, 100, 1080, 1920, 30)
    with pytest.raises(ValueError):
        plan_normalizacion(100, 100, 1080, 1920, 0)
