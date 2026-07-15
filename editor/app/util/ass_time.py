"""Formato de tiempos para el archivo ASS (lógica pura).

El formato Advanced SubStation Alpha (ASS) expresa los tiempos como
``h:mm:ss.cs``:

* ``h``  — horas, sin ceros a la izquierda (1 o más dígitos).
* ``mm`` — minutos, siempre 2 dígitos (00..59).
* ``ss`` — segundos, siempre 2 dígitos (00..59).
* ``cs`` — centésimas de segundo, siempre 2 dígitos (00..99).

Este módulo concentra la conversión entre segundos (float) y esa
representación textual. La conversión desde segundos **redondea a la centésima
de segundo más cercana** y propaga cualquier acarreo (p. ej. ``59.999`` s se
redondea a ``1:00.00``), de modo que el resultado siempre es un tiempo ASS
sintácticamente válido.

Se incluye además la operación inversa :func:`parse_ass_time`, útil para
verificar el *round-trip* del archivo generado (Propiedad 17 del diseño).

Referencias de requisitos: 7.1.
"""

from __future__ import annotations

import math

# Centésimas de segundo por unidad de tiempo.
_CS_POR_SEGUNDO: int = 100
_SEGUNDOS_POR_MINUTO: int = 60
_MINUTOS_POR_HORA: int = 60


def segundos_a_centesimas(segundos: float) -> int:
    """Convierte segundos a centésimas de segundo redondeando al entero más cercano.

    Los valores negativos se saturan a 0 (un tiempo ASS nunca es negativo) y los
    no finitos (``nan``/``inf``) se rechazan.
    """
    valor = float(segundos)
    if not math.isfinite(valor):
        raise ValueError("El tiempo en segundos debe ser finito: %r" % (segundos,))
    if valor < 0.0:
        valor = 0.0
    # ``round`` aplica redondeo al par más cercano; suficiente para centésimas.
    return int(round(valor * _CS_POR_SEGUNDO))


def format_ass_time(segundos: float) -> str:
    """Formatea un tiempo en segundos como ``h:mm:ss.cs`` (centésimas).

    Args:
        segundos: Tiempo en segundos (>= 0). Se redondea a la centésima más
            cercana, propagando el acarreo hacia segundos/minutos/horas.

    Returns:
        La representación textual del tiempo en formato ASS.

    Ejemplos:
        >>> format_ass_time(0.5)
        '0:00:00.50'
        >>> format_ass_time(3661.239)
        '1:01:01.24'
        >>> format_ass_time(59.999)
        '0:01:00.00'
    """
    total_cs = segundos_a_centesimas(segundos)

    cs = total_cs % _CS_POR_SEGUNDO
    total_s = total_cs // _CS_POR_SEGUNDO

    s = total_s % _SEGUNDOS_POR_MINUTO
    total_m = total_s // _SEGUNDOS_POR_MINUTO

    m = total_m % _MINUTOS_POR_HORA
    h = total_m // _MINUTOS_POR_HORA

    return "%d:%02d:%02d.%02d" % (h, m, s, cs)


def parse_ass_time(texto: str) -> float:
    """Convierte un tiempo ASS ``h:mm:ss.cs`` de vuelta a segundos (float).

    Es la operación inversa de :func:`format_ass_time` (con la precisión de
    centésimas propia del formato). Útil para el *round-trip* del archivo ASS.

    Args:
        texto: Cadena en formato ``h:mm:ss.cs``.

    Returns:
        El tiempo equivalente en segundos.

    Raises:
        ValueError: Si la cadena no respeta el formato esperado.
    """
    try:
        parte_horas, parte_minutos, parte_resto = texto.strip().split(":")
        parte_segundos, parte_centesimas = parte_resto.split(".")
        horas = int(parte_horas)
        minutos = int(parte_minutos)
        seg = int(parte_segundos)
        centesimas = int(parte_centesimas)
    except (ValueError, AttributeError) as exc:  # pragma: no cover - defensivo
        raise ValueError("Tiempo ASS inválido: %r" % (texto,)) from exc

    total_cs = (
        ((horas * _MINUTOS_POR_HORA + minutos) * _SEGUNDOS_POR_MINUTO + seg)
        * _CS_POR_SEGUNDO
        + centesimas
    )
    return total_cs / _CS_POR_SEGUNDO


__all__ = [
    "segundos_a_centesimas",
    "format_ass_time",
    "parse_ass_time",
]
