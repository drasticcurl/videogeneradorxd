"""Eliminación de risas (jaja/jeje/...) por transcripción.

A partir de la lista de :class:`~app.models.settings.Palabra` (con timestamps por
palabra) producida por la transcripción, detecta las palabras que son **risa**
(``jaja``, ``jeje``, ``jiji``, ``haha``, ``(risas)``, ...) y recorta esos
segmentos del video, **remapeando** los tiempos de las palabras restantes a la
nueva línea de tiempo (más corta).

La detección y los cálculos de segmentos/remapeo son **lógica pura y
determinista**; el recorte reutiliza el mismo ``select``/``aselect`` del motor de
silencios (:mod:`app.engine.silence`). Toda la ejecución externa (ffmpeg/ffprobe)
pasa por un :data:`~app.engine.proc.Runner` inyectable.

Nota: la detección depende de que el modelo transcriba la risa como texto; es
best-effort (no atrapa la risa que Whisper no transcribe).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple, Union

from app.engine.proc import Runner, ejecutar_comando
from app.engine.silence import (
    SilenceProcessingError,
    calcular_segmentos_conservar,
    comando_recorte_ffmpeg,
    construir_filtro_recorte,
    obtener_duracion,
)
from app.models.settings import Palabra

logger = logging.getLogger(__name__)

# Nombre del artefacto de video sin risas producido por este paso.
NOMBRE_SIN_RISAS: str = "sin_risas.mp4"

# Patrón de risa: sílabas repetidas de risa (``ja``/``je``/``ha``/``he``/...),
# al menos dos, con una posible ``j``/``h`` final. Reconoce jaja, jajaja, jeje,
# jiji, haha, hehe, etc. Requiere >= 2 sílabas para evitar falsos positivos.
_RE_RISA = re.compile(r"^(?:[jh][aeiou]){2,}[jh]?$")


def es_risa(texto: str) -> bool:
    """Indica si ``texto`` corresponde a una risa (lógica pura).

    Normaliza (minúsculas, quita todo lo que no sea letra) y reconoce:

    * la mención explícita ``risa``/``risas`` (p. ej. ``(risas)``), y
    * secuencias de sílabas de risa (``jaja``, ``jajaja``, ``jeje``, ``jiji``,
      ``haha``, ``hehe``, ...), con un mínimo de dos sílabas.
    """
    t = re.sub(r"[^a-záéíóúñü]", "", (texto or "").lower())
    if not t:
        return False
    if "risa" in t:
        return True
    return bool(_RE_RISA.match(t))


def segmentos_risa(
    palabras_risa: Sequence[Palabra], margen_s: float, duracion: float
) -> List[Tuple[float, float]]:
    """Calcula los segmentos de risa a eliminar, expandidos y fusionados (PURA).

    Cada palabra de risa aporta ``[inicio - margen, fin + margen]`` (recortado a
    ``[0, duracion]``); los segmentos solapados se fusionan.

    Args:
        palabras_risa: Palabras de risa con timestamps válidos.
        margen_s: Margen (segundos) a añadir a cada lado del segmento.
        duracion: Duración total del medio (segundos).

    Returns:
        Lista ordenada y fusionada de segmentos ``(inicio, fin)`` a eliminar.
    """
    segs: List[Tuple[float, float]] = []
    for p in palabras_risa:
        if p.inicio_s is None or p.fin_s is None:
            continue
        ini = max(0.0, float(p.inicio_s) - margen_s)
        fin = min(duracion, float(p.fin_s) + margen_s)
        if fin > ini:
            segs.append((ini, fin))
    segs.sort()

    fusionados: List[Tuple[float, float]] = []
    for ini, fin in segs:
        if fusionados and ini <= fusionados[-1][1]:
            prev_ini, prev_fin = fusionados[-1]
            fusionados[-1] = (prev_ini, max(prev_fin, fin))
        else:
            fusionados.append((ini, fin))
    return fusionados


def remapear_tiempos(
    palabras: Sequence[Palabra], conservar: Sequence[Tuple[float, float]]
) -> List[Palabra]:
    """Remapea los tiempos de las palabras a la línea de tiempo recortada (PURA).

    Dada la lista de segmentos ``conservar`` (los tramos que permanecen tras
    eliminar las risas), devuelve las palabras que caen dentro de algún segmento
    conservado con sus tiempos trasladados a la nueva línea de tiempo (como si los
    segmentos se hubieran concatenado). Las palabras que caen en un tramo
    eliminado (las risas y su margen) se descartan.

    Args:
        palabras: Palabras originales (tiempos en la línea de tiempo previa).
        conservar: Segmentos ``(inicio, fin)`` conservados, ordenados y sin solape.

    Returns:
        Nueva lista de :class:`Palabra` con los tiempos remapeados.
    """
    # Desplazamiento acumulado (duración conservada antes de cada segmento).
    prefijos: List[float] = []
    acumulado = 0.0
    for a, b in conservar:
        prefijos.append(acumulado)
        acumulado += max(0.0, b - a)

    salida: List[Palabra] = []
    for p in palabras:
        if p.inicio_s is None or p.fin_s is None:
            continue
        ws = float(p.inicio_s)
        we = float(p.fin_s)
        # Pertenencia por el PUNTO MEDIO de la palabra: robusto ante límites
        # exactos (una risa que empieza justo donde termina un tramo conservado
        # cae en el tramo eliminado y se descarta).
        medio = (ws + we) / 2.0
        seg_idx: Optional[int] = None
        for i, (a, b) in enumerate(conservar):
            if a <= medio <= b:
                seg_idx = i
                break
        if seg_idx is None:
            continue  # palabra en un tramo eliminado (risa/margen): se descarta
        a, b = conservar[seg_idx]
        ws_c = min(max(ws, a), b)
        we_c = min(max(we, a), b)
        nuevo_ini = prefijos[seg_idx] + (ws_c - a)
        nuevo_fin = prefijos[seg_idx] + (we_c - a)
        if nuevo_fin < nuevo_ini:
            nuevo_fin = nuevo_ini
        salida.append(
            Palabra(
                texto=p.texto,
                inicio_s=round(nuevo_ini, 3),
                fin_s=round(nuevo_fin, 3),
            )
        )
    return salida


def eliminar_risas(
    entrada: Union[str, Path],
    salida: Union[str, Path],
    palabras: Sequence[Palabra],
    *,
    margen_ms: float = 100.0,
    runner: Runner = ejecutar_comando,
    es_risa_fn: Callable[[str], bool] = es_risa,
) -> Tuple[Path, List[Palabra]]:
    """Recorta los segmentos de risa del video y remapea los tiempos (best-effort).

    Si no se detecta ninguna risa (o no queda nada que recortar), es un **no-op**:
    devuelve el video de entrada y las palabras sin cambios (no invoca ffmpeg).

    Args:
        entrada: Ruta del video de entrada.
        salida: Ruta del video sin risas a producir.
        palabras: Palabras transcritas (con timestamps).
        margen_ms: Margen (ms) recortado a cada lado de cada risa.
        runner: Ejecutor de comandos inyectable (ffprobe/ffmpeg).
        es_risa_fn: Detector de risa inyectable (por defecto :func:`es_risa`).

    Returns:
        Tupla ``(ruta_video, palabras_remapeadas)``. Si no hubo risas, la ruta es
        la de entrada y las palabras son las originales.

    Raises:
        SilenceProcessingError: Si ffmpeg/ffprobe fallan durante el recorte.
    """
    entrada_path = Path(entrada)
    salida_path = Path(salida)

    risas = [
        p
        for p in palabras
        if p.inicio_s is not None and p.fin_s is not None and es_risa_fn(p.texto)
    ]
    if not risas:
        logger.info("No se detectaron risas; se conserva el video sin cambios.")
        return entrada_path, list(palabras)

    duracion = obtener_duracion(str(entrada_path), runner)
    margen_s = float(margen_ms) / 1000.0
    a_eliminar = segmentos_risa(risas, margen_s, duracion)
    if not a_eliminar:
        return entrada_path, list(palabras)

    # Segmentos a CONSERVAR = complemento de las risas (sin expandir: margen 0).
    conservar = calcular_segmentos_conservar(a_eliminar, duracion, 0.0)
    palabras_out = remapear_tiempos(palabras, conservar)

    filtro = construir_filtro_recorte(conservar)
    comando = comando_recorte_ffmpeg(str(entrada_path), str(salida_path), filtro)
    logger.info(
        "Eliminando %d risa(s); segmentos a conservar: %d. Comando: %s",
        len(risas),
        len(conservar),
        " ".join(comando),
    )
    try:
        resultado = runner(comando)
    except OSError as exc:
        raise SilenceProcessingError(
            f"no se pudo ejecutar ffmpeg (recorte de risas): {exc}"
        ) from exc
    if resultado.returncode != 0:
        detalle = (resultado.stderr or "").strip() or "código de salida distinto de cero"
        raise SilenceProcessingError(
            f"ffmpeg (recorte de risas) falló (código {resultado.returncode}): {detalle}"
        )

    return salida_path, palabras_out


__all__ = [
    "NOMBRE_SIN_RISAS",
    "es_risa",
    "segmentos_risa",
    "remapear_tiempos",
    "eliminar_risas",
]
