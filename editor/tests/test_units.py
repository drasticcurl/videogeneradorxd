"""Tests property-based de la conversión de unidades UI <-> motor.

Feature: vertical-shorts-editor, Property 8: Conversión de unidades UI<->motor
monótona y acotada.

Para cualquier valor de umbral en dB (-60..0) y margen en ms (0..5000)
provenientes de la Interfaz, la conversión a las unidades del motor (umbral en
%, margen en s) es monótona no decreciente y el resultado queda dentro de los
rangos del motor (umbral 0..100 %, margen 0..5 s); análogamente para el umbral
de voz en dBFS convertido a amplitud lineal usado por el ducking.

Validates: Requisitos 4.2, 8.5
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from app.util import units

# Mínimo 100 iteraciones por propiedad (diseño: PBT >= 100 ejemplos).
PBT_SETTINGS = settings(max_examples=200, deadline=None)

# Generador de floats finitos "amplios" para ejercitar también la saturación
# (clamp) con valores por debajo y por encima de los rangos de la UI.
_finite_floats = st.floats(
    allow_nan=False,
    allow_infinity=False,
    min_value=-1_000.0,
    max_value=1_000.0,
)


# ---------------------------------------------------------------------------
# Umbral de silencio: dB (UI) -> porcentaje (motor)
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(_finite_floats)
def test_umbral_db_a_pct_acotado(umbral_db: float) -> None:
    """El porcentaje resultante siempre está en [0, 100]."""
    pct = units.umbral_db_a_pct(umbral_db)
    assert units.ENGINE_UMBRAL_PCT_MIN <= pct <= units.ENGINE_UMBRAL_PCT_MAX


@PBT_SETTINGS
@given(_finite_floats, _finite_floats)
def test_umbral_db_a_pct_monotono(a: float, b: float) -> None:
    """Si el dB de entrada no decrece, el porcentaje tampoco decrece."""
    menor, mayor = sorted((a, b))
    assert units.umbral_db_a_pct(menor) <= units.umbral_db_a_pct(mayor)


# ---------------------------------------------------------------------------
# Margen de silencio: ms (UI) -> s (motor)
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(st.floats(allow_nan=False, allow_infinity=False, min_value=-10_000.0, max_value=10_000.0))
def test_margen_ms_a_s_acotado(margen_ms: float) -> None:
    """El margen en segundos siempre está en [0, 5]."""
    segundos = units.margen_ms_a_s(margen_ms)
    assert units.ENGINE_MARGEN_S_MIN <= segundos <= units.ENGINE_MARGEN_S_MAX


@PBT_SETTINGS
@given(
    st.floats(allow_nan=False, allow_infinity=False, min_value=-10_000.0, max_value=10_000.0),
    st.floats(allow_nan=False, allow_infinity=False, min_value=-10_000.0, max_value=10_000.0),
)
def test_margen_ms_a_s_monotono(a: float, b: float) -> None:
    """Si el margen en ms no decrece, el margen en segundos tampoco decrece."""
    menor, mayor = sorted((a, b))
    assert units.margen_ms_a_s(menor) <= units.margen_ms_a_s(mayor)


# ---------------------------------------------------------------------------
# Umbral de voz: dBFS (UI) -> amplitud lineal (motor / ducking)
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(_finite_floats)
def test_dbfs_a_amplitud_acotado(dbfs: float) -> None:
    """La amplitud lineal resultante siempre está en [0, 1]."""
    amp = units.dbfs_a_amplitud(dbfs)
    assert units.ENGINE_AMPLITUD_MIN <= amp <= units.ENGINE_AMPLITUD_MAX


@PBT_SETTINGS
@given(_finite_floats, _finite_floats)
def test_dbfs_a_amplitud_monotono(a: float, b: float) -> None:
    """Si el dBFS de entrada no decrece, la amplitud tampoco decrece."""
    menor, mayor = sorted((a, b))
    assert units.dbfs_a_amplitud(menor) <= units.dbfs_a_amplitud(mayor)
