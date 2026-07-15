"""Agrupación de palabras transcritas en grupos de subtítulo (lógica pura).

Este módulo implementa el sub-paso 4a del pipeline (Req 6): a partir de la lista
de :class:`~app.models.settings.Palabra` producida por la transcripción, agrupa
las palabras en :class:`~app.models.settings.GrupoSubtitulo` de tamaño acotado,
derivando los tiempos de cada grupo de los ``Timestamps_por_Palabra``.

Es **lógica pura y determinista**: no invoca herramientas externas ni realiza
E/S (más allá de emitir advertencias por el logger estándar). Esto la hace
directamente verificable con property-based testing.

Garantías (Propiedades 12-16 del diseño):

* El tamaño efectivo de grupo se acota a ``1..10``; si ``max_palabras`` está
  fuera de rango se usa el valor por defecto ``4`` y se registra una advertencia
  (Req 6.1, 6.2).
* El último grupo contiene las palabras restantes cuando son menos que el máximo
  (Req 6.3).
* El tiempo de inicio de un grupo es el ``inicio`` de su primera palabra y el
  tiempo de fin es el ``fin`` de su última palabra (Req 6.4).
* Ante palabras sin ``Timestamp_por_Palabra`` válido, el grupo afectado se
  excluye y se registra una advertencia; nunca se emiten tiempos inválidos
  (``inicio > fin`` ni valores nulos) (Req 6.5).

Referencias de requisitos: 6.1, 6.2, 6.3, 6.4, 6.5.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import List, Sequence

from app.models.settings import GrupoSubtitulo, Palabra

logger = logging.getLogger(__name__)

# Rango del motor para el tamaño de grupo de subtítulo (Req 6.1) y valor por
# defecto seguro que se aplica cuando la configuración está fuera de rango
# (Req 6.2).
MIN_PALABRAS_GRUPO: int = 1
MAX_PALABRAS_GRUPO: int = 10
DEFAULT_MAX_PALABRAS: int = 4


def tamano_efectivo(max_palabras: int) -> int:
    """Devuelve el tamaño de grupo efectivo, acotado al rango del motor.

    Si ``max_palabras`` está dentro de ``1..10`` se usa tal cual; en caso
    contrario (incluidos valores no enteros/negativos) se aplica el valor por
    defecto ``4`` (Req 6.1, 6.2).
    """
    try:
        valor = int(max_palabras)
    except (TypeError, ValueError):
        return DEFAULT_MAX_PALABRAS
    if MIN_PALABRAS_GRUPO <= valor <= MAX_PALABRAS_GRUPO:
        return valor
    return DEFAULT_MAX_PALABRAS


@dataclass
class ResultadoAgrupacion:
    """Resultado detallado de la agrupación.

    Atributos:
        grupos: Grupos de subtítulo válidos emitidos, en orden.
        advertencias: Mensajes de advertencia acumulados (configuración inválida
            o palabras sin timestamp válido), útiles para diagnóstico y test.
        tamano_efectivo: Tamaño de grupo realmente utilizado (1..10).
    """

    grupos: List[GrupoSubtitulo] = field(default_factory=list)
    advertencias: List[str] = field(default_factory=list)
    tamano_efectivo: int = DEFAULT_MAX_PALABRAS


def _timestamp_valido(palabra: Palabra) -> bool:
    """Indica si una palabra tiene ``inicio_s``/``fin_s`` presentes y finitos."""
    inicio = palabra.inicio_s
    fin = palabra.fin_s
    if inicio is None or fin is None:
        return False
    try:
        return math.isfinite(inicio) and math.isfinite(fin)
    except (TypeError, ValueError):
        return False


def agrupar_detallado(
    palabras: Sequence[Palabra], max_palabras: int
) -> ResultadoAgrupacion:
    """Agrupa palabras en grupos de subtítulo devolviendo diagnóstico detallado.

    Args:
        palabras: Secuencia de palabras transcritas en orden temporal.
        max_palabras: Máximo configurado de palabras por grupo (UI). Se acota al
            rango del motor con fallback a 4.

    Returns:
        Un :class:`ResultadoAgrupacion` con los grupos válidos, las advertencias
        acumuladas y el tamaño efectivo empleado.
    """
    resultado = ResultadoAgrupacion()
    n = tamano_efectivo(max_palabras)
    resultado.tamano_efectivo = n

    # Req 6.2: señalar que la configuración es inválida y se aplicó el fallback.
    try:
        solicitado = int(max_palabras)
    except (TypeError, ValueError):
        solicitado = None
    if solicitado is None or not (MIN_PALABRAS_GRUPO <= solicitado <= MAX_PALABRAS_GRUPO):
        resultado.advertencias.append(
            "max_palabras=%r fuera de rango [1..10]; se usa el valor por defecto %d"
            % (max_palabras, DEFAULT_MAX_PALABRAS)
        )

    for i in range(0, len(palabras), n):
        trozo = list(palabras[i : i + n])  # Req 6.3: el último trozo puede ser menor.
        if not trozo:
            continue

        # Req 6.5: excluir el grupo cuando alguna palabra carece de timestamp válido.
        if any(not _timestamp_valido(p) for p in trozo):
            resultado.advertencias.append(
                "Grupo excluido: palabra(s) sin Timestamp_por_Palabra válido en "
                "el trozo %r" % [p.texto for p in trozo]
            )
            continue

        inicio_s = trozo[0].inicio_s
        fin_s = trozo[-1].fin_s

        # Req 6.5: nunca emitir un grupo con inicio > fin.
        if inicio_s > fin_s:
            resultado.advertencias.append(
                "Grupo excluido: tiempos inválidos (inicio=%s > fin=%s) en el "
                "trozo %r" % (inicio_s, fin_s, [p.texto for p in trozo])
            )
            continue

        resultado.grupos.append(
            GrupoSubtitulo(
                texto=" ".join(p.texto for p in trozo),  # Req 6.3
                inicio_s=inicio_s,  # Req 6.4
                fin_s=fin_s,  # Req 6.4
                # Palabras con sus timestamps individuales, para el resaltado
                # palabra por palabra (karaoke) en ass_builder.
                palabras=list(trozo),
            )
        )

    return resultado


def agrupar(palabras: Sequence[Palabra], max_palabras: int) -> List[GrupoSubtitulo]:
    """Agrupa palabras en grupos de subtítulo (Req 6).

    Envoltorio de :func:`agrupar_detallado` que registra las advertencias por el
    logger estándar y devuelve únicamente los grupos válidos emitidos.

    Args:
        palabras: Secuencia de palabras transcritas en orden temporal.
        max_palabras: Máximo configurado de palabras por grupo (con fallback a 4).

    Returns:
        Lista de :class:`~app.models.settings.GrupoSubtitulo` válidos, en orden.
    """
    resultado = agrupar_detallado(palabras, max_palabras)
    for advertencia in resultado.advertencias:
        logger.warning(advertencia)
    return resultado.grupos


__all__ = [
    "MIN_PALABRAS_GRUPO",
    "MAX_PALABRAS_GRUPO",
    "DEFAULT_MAX_PALABRAS",
    "tamano_efectivo",
    "ResultadoAgrupacion",
    "agrupar_detallado",
    "agrupar",
]
