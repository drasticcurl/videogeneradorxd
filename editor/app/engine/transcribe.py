"""Paso 3 del pipeline — Transcripción con timestamps por palabra (Req 5).

Extrae el audio del video con ffmpeg y lo transcribe localmente en CPU con
faster-whisper (``word_timestamps=True``), produciendo una lista de
:class:`~app.models.settings.Palabra` con ``inicio_s``/``fin_s`` en segundos y
precisión de milisegundos.

Garantías:

* **Validación previa de idioma y modelo (Req 5.5, 5.6, Propiedad 11):** antes de
  iniciar cualquier extracción o transcripción se valida que el idioma (distinto
  de ``"auto"``) y el modelo pertenezcan a los conjuntos soportados por
  faster-whisper. Si alguno es inválido se rechaza la operación y **no** se
  produce ningún ``Timestamp_por_Palabra`` (ni se extrae audio ni se carga el
  modelo).
* **Idioma configurable con detección automática (Req 5.2, 5.4):** ``"auto"`` se
  traduce a ``language=None`` para que faster-whisper detecte el idioma.
* **Audio ilegible / sin voz (Req 5.7):** si la extracción o la transcripción
  fallan, o no se reconoce ninguna palabra, se lanza un error sin devolver
  timestamps parciales.

La extracción (ffmpeg) y la creación del modelo faster-whisper son
**inyectables** (parámetros ``extractor`` y ``modelo_factory``), de modo que los
tests no dependan del binario ffmpeg ni de la biblioteca faster-whisper reales.

Referencias de requisitos: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, List, Optional, Union

from app.engine.proc import Runner, ejecutar_comando
from app.models.settings import (
    AjustesTranscripcion,
    IDIOMA_AUTO,
    Palabra,
    idioma_valido,
    modelo_valido,
)

# Nombre del artefacto de audio extraído para la transcripción.
NOMBRE_AUDIO: str = "audio.wav"

# Parámetros de extracción de audio recomendados por faster-whisper (16 kHz mono).
AUDIO_SAMPLE_RATE: int = 16000
AUDIO_CANALES: int = 1

# Firma de un extractor de audio inyectable: (video, audio_wav) -> None. Debe
# lanzar excepción si falla.
Extractor = Callable[[str, str], None]

# Firma de una fábrica de modelos faster-whisper inyectable: (modelo) -> objeto
# con método ``transcribe(audio, language=..., word_timestamps=True)``.
ModeloFactory = Callable[[str], Any]


class IdiomaInvalidoError(ValueError):
    """El idioma configurado no es "auto" ni un idioma soportado (Req 5.5)."""

    def __init__(self, idioma: str) -> None:
        self.idioma = idioma
        super().__init__(f"Idioma de transcripción no válido: {idioma!r}")


class ModeloInvalidoError(ValueError):
    """El modelo configurado no está entre los soportados por faster-whisper (Req 5.6)."""

    def __init__(self, modelo: str) -> None:
        self.modelo = modelo
        super().__init__(f"Modelo de faster-whisper no válido: {modelo!r}")


class TranscripcionError(Exception):
    """Fallo de la transcripción: audio ilegible/corrupto o sin voz (Req 5.7)."""


def validar_idioma_modelo(ajustes: AjustesTranscripcion) -> None:
    """Valida idioma y modelo **antes** de transcribir (Req 5.5, 5.6, Propiedad 11).

    Raises:
        IdiomaInvalidoError: Si el idioma no es "auto" ni un idioma soportado.
        ModeloInvalidoError: Si el modelo no está entre los soportados.
    """
    if not idioma_valido(ajustes.idioma):
        raise IdiomaInvalidoError(ajustes.idioma)
    if not modelo_valido(ajustes.modelo):
        raise ModeloInvalidoError(ajustes.modelo)


def comando_extraer_audio(video: str, audio_wav: str) -> List[str]:
    """Construye el comando ffmpeg que extrae audio PCM 16 kHz mono (Req 5.1).

    Args:
        video: Ruta del video de entrada.
        audio_wav: Ruta del WAV de audio a producir.

    Returns:
        La lista de argumentos del comando ffmpeg.
    """
    return [
        "ffmpeg",
        "-y",
        "-i",
        video,
        "-vn",
        "-ar",
        str(AUDIO_SAMPLE_RATE),
        "-ac",
        str(AUDIO_CANALES),
        audio_wav,
    ]


def _extractor_ffmpeg(runner: Runner) -> Extractor:
    """Crea un extractor de audio basado en ffmpeg usando ``runner``."""

    def _extraer(video: str, audio_wav: str) -> None:
        comando = comando_extraer_audio(video, audio_wav)
        try:
            resultado = runner(comando)
        except OSError as exc:
            raise TranscripcionError(f"no se pudo ejecutar ffmpeg: {exc}") from exc
        if resultado.returncode != 0:
            detalle = (resultado.stderr or "").strip() or "código de salida distinto de cero"
            raise TranscripcionError(f"extracción de audio falló: {detalle}")

    return _extraer


def _modelo_factory_por_defecto(modelo: str) -> Any:
    """Fábrica por defecto: carga un modelo faster-whisper en CPU (int8).

    Se importa faster-whisper de forma diferida para no exigir la biblioteca al
    importar este módulo (los tests inyectan su propia fábrica).
    """
    from faster_whisper import WhisperModel  # import diferido

    return WhisperModel(modelo, device="cpu", compute_type="int8")


def _palabras_desde_segmentos(segments: Any) -> List[Palabra]:
    """Extrae la lista de :class:`Palabra` de los segmentos de faster-whisper.

    Cada palabra ``w`` expone ``word``, ``start`` y ``end``; los tiempos se
    redondean a milisegundos (0.001 s, Req 5.1).
    """
    palabras: List[Palabra] = []
    for seg in segments:
        for w in getattr(seg, "words", None) or []:
            texto = getattr(w, "word", None)
            inicio = getattr(w, "start", None)
            fin = getattr(w, "end", None)
            if texto is None or inicio is None or fin is None:
                continue
            palabras.append(
                Palabra(
                    texto=str(texto).strip(),
                    inicio_s=round(float(inicio), 3),
                    fin_s=round(float(fin), 3),
                )
            )
    return palabras


def transcribir(
    video: Union[str, Path],
    ajustes: AjustesTranscripcion,
    audio_wav: Union[str, Path],
    *,
    extractor: Optional[Extractor] = None,
    modelo_factory: ModeloFactory = _modelo_factory_por_defecto,
    runner: Runner = ejecutar_comando,
) -> List[Palabra]:
    """Ejecuta el Paso 3 (transcripción) devolviendo los timestamps por palabra.

    Orden estricto (Req 5.5, 5.6 / Propiedad 11): **primero** valida idioma y
    modelo; solo si son válidos extrae el audio y transcribe. Ante idioma/modelo
    inválido se lanza el error correspondiente **sin** extraer audio ni cargar el
    modelo (no se producen timestamps parciales).

    Args:
        video: Ruta del video de entrada (del que se extrae el audio).
        ajustes: Ajustes de transcripción (idioma y modelo).
        audio_wav: Ruta del WAV intermedio a producir.
        extractor: Extractor de audio inyectable; por defecto usa ffmpeg vía
            ``runner``.
        modelo_factory: Fábrica de modelo faster-whisper inyectable.
        runner: Ejecutor de comandos para el extractor por defecto.

    Returns:
        La lista de :class:`Palabra` con timestamps por palabra.

    Raises:
        IdiomaInvalidoError / ModeloInvalidoError: Validación previa (Req 5.5, 5.6).
        TranscripcionError: Audio ilegible/corrupto o sin voz reconocible (Req 5.7).
    """
    # Req 5.5, 5.6 / Propiedad 11: rechazo ANTES de cualquier trabajo pesado.
    validar_idioma_modelo(ajustes)

    if extractor is None:
        extractor = _extractor_ffmpeg(runner)

    video_str = str(video)
    audio_str = str(audio_wav)

    # Extracción de audio (Req 5.1). Un fallo aquí => audio ilegible (Req 5.7).
    extractor(video_str, audio_str)

    # Carga del modelo y transcripción local en CPU (Req 5.1).
    try:
        modelo = modelo_factory(ajustes.modelo)
    except Exception as exc:  # noqa: BLE001 - se traduce a error de transcripción
        raise TranscripcionError(f"no se pudo cargar el modelo: {exc}") from exc

    idioma = None if ajustes.idioma == IDIOMA_AUTO else ajustes.idioma  # Req 5.4
    try:
        segments, _info = modelo.transcribe(
            audio_str,
            language=idioma,
            word_timestamps=True,  # Req 5.1
        )
        palabras = _palabras_desde_segmentos(segments)
    except Exception as exc:  # noqa: BLE001
        raise TranscripcionError(f"la transcripción falló: {exc}") from exc

    # Req 5.7: sin voz reconocible => error, sin timestamps parciales.
    if not palabras:
        raise TranscripcionError(
            "el audio no contiene voz reconocible (sin timestamps por palabra)"
        )

    return palabras


__all__ = [
    "NOMBRE_AUDIO",
    "AUDIO_SAMPLE_RATE",
    "AUDIO_CANALES",
    "Extractor",
    "ModeloFactory",
    "IdiomaInvalidoError",
    "ModeloInvalidoError",
    "TranscripcionError",
    "validar_idioma_modelo",
    "comando_extraer_audio",
    "transcribir",
]
