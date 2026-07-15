"""Inspección de clips de video con ``ffprobe`` (Paso 1, sub-paso 1; Req 3.6).

Antes de normalizar y concatenar (Paso 1, UNIR), el motor inspecciona cada clip
para obtener su **resolución**, **rotación** y **fps**, y para decidir si es
**válido** (decodificable) o **corrupto/no soportado**. Un clip inválido detiene
la unión sin producir salida parcial y se reporta identificando el clip (Req
3.6).

Diseño para test sin binarios:

* :func:`construir_comando_ffprobe` construye (sin ejecutar) el comando
  ``ffprobe`` que emite JSON con los streams y el formato del archivo.
* :func:`parsear_salida_ffprobe` es **lógica pura**: transforma el JSON de
  ``ffprobe`` en :class:`ClipInfo` (incluye el cálculo de fps desde la fracción
  ``num/den`` y la normalización de la rotación a 0/90/180/270).
* :func:`inspeccionar_clip` orquesta ambas partes a través de un
  :data:`~app.engine.proc.Runner` **inyectable**, de modo que los tests puedan
  simular la salida de ``ffprobe`` (o su fallo) sin depender del binario real.

Referencias de requisitos: 3.6.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import List, Optional

from app.engine.proc import Runner, ejecutar_comando


class ClipInspeccionError(Exception):
    """El clip está corrupto, no es soportado o no es decodificable (Req 3.6).

    Contiene la ``ruta`` del clip que falló para poder identificarlo en el
    mensaje de error del Job.
    """

    def __init__(self, ruta: str, motivo: str) -> None:
        self.ruta = ruta
        self.motivo = motivo
        super().__init__(f"Clip no decodificable {ruta!r}: {motivo}")


@dataclass(frozen=True)
class ClipInfo:
    """Información relevante de un clip obtenida de ``ffprobe``.

    Attributes:
        ruta: Ruta del clip inspeccionado.
        ancho / alto: Resolución del stream de video en píxeles.
        rotacion: Rotación declarada en grados, normalizada a {0, 90, 180, 270}.
        fps: Cuadros por segundo (evaluando ``avg_frame_rate``/``r_frame_rate``).
        duracion_s: Duración en segundos si está disponible.
        tiene_video: ``True`` si el archivo contiene al menos un stream de video.
        tiene_audio: ``True`` si el archivo contiene al menos un stream de audio.
    """

    ruta: str
    ancho: int
    alto: int
    rotacion: int
    fps: float
    duracion_s: Optional[float]
    tiene_video: bool
    tiene_audio: bool

    @property
    def es_vertical_tras_rotacion(self) -> bool:
        """Indica si, aplicando la rotación, el clip queda en orientación vertical."""
        if self.rotacion in (90, 270):
            return self.ancho >= self.alto
        return self.alto >= self.ancho


def construir_comando_ffprobe(ruta: str) -> List[str]:
    """Construye el comando ``ffprobe`` que emite streams y formato en JSON.

    No ejecuta nada; devuelve la lista de argumentos. Se pide JSON con
    ``-show_streams`` y ``-show_format`` para poder extraer resolución, fps,
    rotación y duración.

    Args:
        ruta: Ruta del clip a inspeccionar.

    Returns:
        La lista de argumentos del comando ``ffprobe``.
    """
    return [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        ruta,
    ]


def _evaluar_fraccion(texto: object) -> Optional[float]:
    """Evalúa una fracción de fps ``"num/den"`` (o un número) a float.

    Devuelve ``None`` cuando el valor está ausente, es cero o malformado.
    """
    if texto is None:
        return None
    cadena = str(texto).strip()
    if not cadena or cadena in ("0/0", "N/A"):
        return None
    try:
        if "/" in cadena:
            num_txt, den_txt = cadena.split("/", 1)
            num = float(num_txt)
            den = float(den_txt)
            if den == 0:
                return None
            return num / den
        return float(cadena)
    except (ValueError, ZeroDivisionError):
        return None


def _normalizar_rotacion(grados: object) -> int:
    """Normaliza una rotación arbitraria (posible negativa) a {0,90,180,270}."""
    try:
        valor = int(round(float(grados)))
    except (TypeError, ValueError):
        return 0
    return valor % 360


def _extraer_rotacion(stream: dict) -> int:
    """Extrae la rotación de un stream de video de ``ffprobe``.

    ``ffprobe`` puede exponer la rotación en ``tags.rotate`` o en
    ``side_data_list`` (``rotation``, típicamente negativa).
    """
    tags = stream.get("tags") or {}
    if "rotate" in tags:
        return _normalizar_rotacion(tags.get("rotate"))
    for side in stream.get("side_data_list", []) or []:
        if "rotation" in side:
            return _normalizar_rotacion(side.get("rotation"))
    return 0


def parsear_salida_ffprobe(ruta: str, salida_json: str) -> ClipInfo:
    """Transforma el JSON de ``ffprobe`` en un :class:`ClipInfo` (lógica pura).

    Args:
        ruta: Ruta del clip (para mensajes de error).
        salida_json: Texto JSON producido por ``ffprobe``.

    Returns:
        Un :class:`ClipInfo` con resolución, rotación, fps y disponibilidad de
        pistas.

    Raises:
        ClipInspeccionError: Si el JSON no es válido, no hay streams o no existe
            un stream de video con dimensiones válidas (clip no decodificable,
            Req 3.6).
    """
    try:
        datos = json.loads(salida_json)
    except (ValueError, TypeError) as exc:
        raise ClipInspeccionError(ruta, "salida de ffprobe ilegible") from exc

    streams = datos.get("streams") or []
    if not streams:
        raise ClipInspeccionError(ruta, "sin streams (archivo corrupto o no soportado)")

    stream_video: Optional[dict] = None
    tiene_audio = False
    for stream in streams:
        tipo = stream.get("codec_type")
        if tipo == "video" and stream_video is None:
            stream_video = stream
        elif tipo == "audio":
            tiene_audio = True

    if stream_video is None:
        raise ClipInspeccionError(ruta, "sin stream de video decodificable")

    try:
        ancho = int(stream_video.get("width"))
        alto = int(stream_video.get("height"))
    except (TypeError, ValueError) as exc:
        raise ClipInspeccionError(ruta, "resolución de video inválida") from exc

    if ancho <= 0 or alto <= 0:
        raise ClipInspeccionError(ruta, f"resolución no positiva {ancho}x{alto}")

    fps = (
        _evaluar_fraccion(stream_video.get("avg_frame_rate"))
        or _evaluar_fraccion(stream_video.get("r_frame_rate"))
        or 0.0
    )

    duracion_s: Optional[float] = None
    formato = datos.get("format") or {}
    for candidato in (stream_video.get("duration"), formato.get("duration")):
        if candidato is not None:
            try:
                duracion_s = float(candidato)
                break
            except (TypeError, ValueError):
                continue

    return ClipInfo(
        ruta=ruta,
        ancho=ancho,
        alto=alto,
        rotacion=_extraer_rotacion(stream_video),
        fps=fps,
        duracion_s=duracion_s,
        tiene_video=True,
        tiene_audio=tiene_audio,
    )


def inspeccionar_clip(ruta: str, runner: Runner = ejecutar_comando) -> ClipInfo:
    """Inspecciona un clip ejecutando ``ffprobe`` y parseando su salida (Req 3.6).

    Args:
        ruta: Ruta del clip a inspeccionar.
        runner: Ejecutor de comandos inyectable (por defecto, subprocess real).

    Returns:
        El :class:`ClipInfo` del clip.

    Raises:
        ClipInspeccionError: Si ``ffprobe`` falla (código != 0) o el clip no es
            decodificable / no contiene video válido (Req 3.6).
    """
    comando = construir_comando_ffprobe(ruta)
    try:
        resultado = runner(comando)
    except FileNotFoundError as exc:  # ffprobe no instalado
        raise ClipInspeccionError(ruta, "ffprobe no disponible") from exc
    except OSError as exc:
        raise ClipInspeccionError(ruta, f"fallo al ejecutar ffprobe: {exc}") from exc

    if resultado.returncode != 0:
        detalle = (resultado.stderr or "").strip() or "código de salida distinto de cero"
        raise ClipInspeccionError(ruta, f"ffprobe falló: {detalle}")

    return parsear_salida_ffprobe(ruta, resultado.stdout)


__all__ = [
    "ClipInspeccionError",
    "ClipInfo",
    "construir_comando_ffprobe",
    "parsear_salida_ffprobe",
    "inspeccionar_clip",
]
