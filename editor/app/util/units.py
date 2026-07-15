"""Conversión de unidades UI <-> motor (lógica pura).

La Interfaz expresa varios ajustes en unidades pensadas para el usuario
(decibelios, milisegundos, dBFS), mientras que el Motor de Procesamiento y las
herramientas externas (``auto-editor``, filtro ``sidechaincompress`` de ffmpeg)
esperan otras unidades (porcentaje, segundos, amplitud lineal). Este módulo
concentra esas conversiones como funciones puras y deterministas.

Garantías (Propiedad 8 del diseño):

* **Monotonicidad no decreciente:** si el valor de entrada crece, el valor
  convertido nunca disminuye.
* **Acotamiento:** el resultado siempre queda dentro del rango del motor, y la
  entrada se satura (clamp) al rango válido de la UI antes de convertir, de modo
  que valores fuera de rango no producen salidas fuera de rango.

Referencias de requisitos: 4.2 (umbral/margen de silencio) y 8.5 (umbral de voz
para el ducking).
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Rangos de la UI (entrada) y del motor (salida)
# ---------------------------------------------------------------------------
# Umbral de silencio: UI en decibelios (Req 9.2) -> motor en porcentaje (Req 4.2).
UI_UMBRAL_DB_MIN: float = -60.0
UI_UMBRAL_DB_MAX: float = 0.0
ENGINE_UMBRAL_PCT_MIN: float = 0.0
ENGINE_UMBRAL_PCT_MAX: float = 100.0

# Margen de silencio: UI en milisegundos (Req 9.2) -> motor en segundos (Req 4.2).
UI_MARGEN_MS_MIN: float = 0.0
UI_MARGEN_MS_MAX: float = 5000.0
ENGINE_MARGEN_S_MIN: float = 0.0
ENGINE_MARGEN_S_MAX: float = 5.0

# Umbral de voz para el ducking: UI en dBFS (Req 8.5/8.6) -> amplitud lineal
# usada como `threshold` de `sidechaincompress`. Un nivel de 0 dBFS equivale a
# amplitud 1.0 (fondo de escala); niveles negativos dan amplitudes en (0, 1).
UI_UMBRAL_VOZ_DBFS_MIN: float = -60.0
UI_UMBRAL_VOZ_DBFS_MAX: float = 0.0
ENGINE_AMPLITUD_MIN: float = 0.0
ENGINE_AMPLITUD_MAX: float = 1.0


def _clamp(valor: float, minimo: float, maximo: float) -> float:
    """Satura ``valor`` al intervalo cerrado ``[minimo, maximo]``."""
    if valor < minimo:
        return minimo
    if valor > maximo:
        return maximo
    return valor


def umbral_db_a_pct(umbral_db: float) -> float:
    """Convierte un umbral de silencio en dB (UI, -60..0) a porcentaje del motor.

    Usa la relación de amplitud ``10^(dB/20)`` escalada a porcentaje, de modo que
    0 dB -> 100 % y -60 dB -> ~0,1 %. La entrada se satura al rango de la UI y el
    resultado al rango del motor (0..100 %). Es monótona no decreciente respecto
    del dB de entrada.

    Referencia: Req 4.2.
    """
    db = _clamp(float(umbral_db), UI_UMBRAL_DB_MIN, UI_UMBRAL_DB_MAX)
    pct = (10.0 ** (db / 20.0)) * 100.0
    return _clamp(pct, ENGINE_UMBRAL_PCT_MIN, ENGINE_UMBRAL_PCT_MAX)


def margen_ms_a_s(margen_ms: float) -> float:
    """Convierte un margen en milisegundos (UI, 0..5000) a segundos del motor (0..5).

    Conversión lineal ``ms / 1000`` con saturación de entrada y salida a sus
    respectivos rangos. Es monótona no decreciente.

    Referencia: Req 4.2.
    """
    ms = _clamp(float(margen_ms), UI_MARGEN_MS_MIN, UI_MARGEN_MS_MAX)
    segundos = ms / 1000.0
    return _clamp(segundos, ENGINE_MARGEN_S_MIN, ENGINE_MARGEN_S_MAX)


def dbfs_a_amplitud(dbfs: float) -> float:
    """Convierte un umbral de voz en dBFS (UI) a amplitud lineal (0..1) del motor.

    Usa ``10^(dBFS/20)``; -30 dBFS -> ~0,0316, 0 dBFS -> 1,0. Se emplea como
    ``threshold`` lineal del filtro ``sidechaincompress`` en el ducking. La
    entrada se satura al rango de la UI y el resultado al rango del motor (0..1).
    Es monótona no decreciente respecto del dBFS de entrada.

    Referencia: Req 8.5.
    """
    db = _clamp(float(dbfs), UI_UMBRAL_VOZ_DBFS_MIN, UI_UMBRAL_VOZ_DBFS_MAX)
    amplitud = 10.0 ** (db / 20.0)
    return _clamp(amplitud, ENGINE_AMPLITUD_MIN, ENGINE_AMPLITUD_MAX)


__all__ = [
    "UI_UMBRAL_DB_MIN",
    "UI_UMBRAL_DB_MAX",
    "ENGINE_UMBRAL_PCT_MIN",
    "ENGINE_UMBRAL_PCT_MAX",
    "UI_MARGEN_MS_MIN",
    "UI_MARGEN_MS_MAX",
    "ENGINE_MARGEN_S_MIN",
    "ENGINE_MARGEN_S_MAX",
    "UI_UMBRAL_VOZ_DBFS_MIN",
    "UI_UMBRAL_VOZ_DBFS_MAX",
    "ENGINE_AMPLITUD_MIN",
    "ENGINE_AMPLITUD_MAX",
    "umbral_db_a_pct",
    "margen_ms_a_s",
    "dbfs_a_amplitud",
]
