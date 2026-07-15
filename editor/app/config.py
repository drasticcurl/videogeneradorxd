"""Configuración central del backend.

Define puertos, límites de tamaño y cardinalidad, rutas del directorio de
trabajo y de salida, y los valores por defecto del pipeline.

Esta tarea (2.1) solo define constantes y ayudantes de rutas; la validación de
rangos de los ajustes se implementa en la tarea 8 (`models/settings.py`).

Referencias de requisitos: 1.4, 8.2, 10.1, 10.2, 13.3.
"""

from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Puertos de red (operación 100% local en localhost)
# ---------------------------------------------------------------------------
BACKEND_HOST: str = "127.0.0.1"
BACKEND_PORT: int = 8000
FRONTEND_PORT: int = 3000

# ---------------------------------------------------------------------------
# Límites de tamaño (Req 1.4, 8.2)
# ---------------------------------------------------------------------------
MB: int = 1024 * 1024

# Tamaño máximo por clip de video: 500 MB (Req 1.4)
MAX_CLIP_SIZE_BYTES: int = 500 * MB

# Tamaño máximo del archivo de música: 100 MB (Req 8.2)
MAX_MUSIC_SIZE_BYTES: int = 100 * MB

# ---------------------------------------------------------------------------
# Límites de cardinalidad (Req 1.5, 10.1, 10.2)
# ---------------------------------------------------------------------------
# Máximo de clips por adición en una petición `POST /clips` (Req 1.5)
MAX_CLIPS_PER_UPLOAD: int = 50

# Máximo de clips en el `orden_clips` de un Job en `POST /procesar` (Req 10.1, 10.2)
MAX_CLIPS_PER_JOB: int = 500
MIN_CLIPS_PER_JOB: int = 1

# ---------------------------------------------------------------------------
# Formatos soportados
# ---------------------------------------------------------------------------
# Formatos de video de entrada soportados (Req 1.4).
SUPPORTED_VIDEO_EXTENSIONS: tuple[str, ...] = (
    ".mp4",
    ".mov",
    ".m4v",
    ".mkv",
    ".webm",
    ".avi",
)

# Formatos de audio de música soportados (Req 8.1, 8.2).
#
# La mezcla de música se realiza con ffmpeg, que decodifica de forma nativa la
# mayoría de formatos de audio comunes (MP3, AAC/M4A, OGG/Opus, FLAC, etc.). Por
# eso la aceptación en la subida se basa en la **extensión** del archivo y se
# delega la validación real del contenido a ffmpeg en el paso de mezcla: exigir
# un contenedor WAV/RIFF rechazaba archivos perfectamente reproducibles (p. ej.
# un MP3 con extensión .wav).
SUPPORTED_MUSIC_EXTENSIONS: tuple[str, ...] = (
    ".wav",
    ".mp3",
    ".m4a",
    ".aac",
    ".ogg",
    ".oga",
    ".opus",
    ".flac",
    ".wma",
    ".aiff",
    ".aif",
)

# ---------------------------------------------------------------------------
# Rutas del directorio de trabajo y de salida (Req 13.3)
# ---------------------------------------------------------------------------
# Directorio base del backend (…/backend).
BACKEND_ROOT: Path = Path(__file__).resolve().parent.parent

# Directorio de trabajo raíz; los temporales por Job viven en `<WORKDIR>/jobs/{job_id}/`.
# Configurable mediante variable de entorno para facilitar pruebas locales.
WORKDIR_ROOT: Path = Path(
    os.environ.get("VSE_WORKDIR", str(BACKEND_ROOT / ".workdir"))
).resolve()

# Directorio de salida donde se conserva el `Video_Final` de cada Job, separado
# del directorio temporal para permitir la descarga tras la limpieza (Req 13.4/13.5).
OUTPUT_ROOT: Path = Path(
    os.environ.get("VSE_OUTPUT", str(BACKEND_ROOT / ".output"))
).resolve()


def local_input_roots() -> tuple[Path, ...]:
    """Return roots from which FastAPI may consume absolute input paths.

    The editor workdir and generator output directory are permitted by default.
    Additional roots must be explicitly supplied via ``VSE_LOCAL_INPUT_ROOTS``
    using the platform path separator.
    """
    generator_output = Path(
        os.environ.get("OUTPUT_DIR", str(BACKEND_ROOT.parent / "output"))
    ).resolve()
    roots = {WORKDIR_ROOT.resolve(), generator_output}
    for raw in os.environ.get("VSE_LOCAL_INPUT_ROOTS", "").split(os.pathsep):
        if raw.strip():
            roots.add(Path(raw).expanduser().resolve())
    return tuple(sorted(roots, key=str))


def resolve_permitted_input_file(value: str) -> Path | None:
    """Resolve an existing file only when it is beneath a permitted root."""
    candidate = Path(value)
    if not candidate.is_absolute():
        return None
    try:
        resolved = candidate.resolve(strict=True)
    except (FileNotFoundError, OSError):
        return None
    if not resolved.is_file():
        return None
    for root in local_input_roots():
        try:
            resolved.relative_to(root)
            return resolved
        except ValueError:
            continue
    return None

# Nombre del artefacto final por Job.
FINAL_VIDEO_FILENAME: str = "final.mp4"

# ---------------------------------------------------------------------------
# Configuración persistente del usuario (ajustes por defecto) — JSON local
# ---------------------------------------------------------------------------
# Directorio donde se guarda la configuración por defecto del usuario, de modo
# que la Interfaz pueda "Guardar como predeterminado" y recuperarla al abrir.
# Es un archivo JSON local en la máquina del usuario (operación 100% local).
# Configurable con la variable de entorno ``VSE_CONFIG_DIR``.
USER_CONFIG_ROOT: Path = Path(
    os.environ.get("VSE_CONFIG_DIR", str(BACKEND_ROOT / ".config"))
).resolve()

# Nombre del archivo JSON de ajustes por defecto del usuario.
USER_CONFIG_FILENAME: str = "ajustes.json"


def user_config_path() -> Path:
    """Devuelve la ruta del JSON de ajustes por defecto del usuario.

    Se resuelve en tiempo de llamada (no como constante) para que las pruebas
    puedan redirigir ``USER_CONFIG_ROOT`` mediante monkeypatch.
    """
    return USER_CONFIG_ROOT / USER_CONFIG_FILENAME


def job_workdir(job_id: str) -> Path:
    """Devuelve el directorio de trabajo temporal de un Job (`<WORKDIR>/jobs/{job_id}`)."""
    return WORKDIR_ROOT / "jobs" / job_id


def job_output_path(job_id: str) -> Path:
    """Devuelve la ruta del `Video_Final` conservado para descarga del Job."""
    return OUTPUT_ROOT / job_id / FINAL_VIDEO_FILENAME


# ---------------------------------------------------------------------------
# Tiempos límite (Req 12.1)
# ---------------------------------------------------------------------------
# Plazo total de verificación de dependencias al arrancar (Req 12.1).
DEPENDENCY_CHECK_TIMEOUT_S: float = 10.0

# ---------------------------------------------------------------------------
# Plazos de subprocesos externos (bugfix unir-step-hang, Req 2.2, 2.4)
# ---------------------------------------------------------------------------
# Toda invocación de una herramienta externa (ffmpeg/ffprobe/auto-editor/node)
# pasa por ``app/engine/proc.py::ejecutar_comando``. Para evitar que un
# subproceso bloqueado congele un paso indefinidamente (el síntoma "atascado al
# 25 %, sin logs"), se aplica un plazo acotado por paso. Los valores son
# generosos a propósito para que ejecuciones sanas con entradas válidas NUNCA lo
# disparen (preservación / caso lento-pero-sano). Configurables por entorno.


def _env_float(nombre: str, defecto: float) -> float:
    """Lee un plazo en segundos desde el entorno con respaldo numérico.

    Un valor ausente, vacío, no numérico o no positivo cae al ``defecto`` (un
    plazo debe ser un número positivo para tener sentido como deadline).
    """
    crudo = os.environ.get(nombre)
    if crudo is None:
        return defecto
    try:
        valor = float(crudo)
    except (TypeError, ValueError):
        return defecto
    return valor if valor > 0 else defecto


# Plazo general por defecto para herramientas de proceso (ffmpeg/auto-editor):
# 900 s (15 min). Cubre normalizaciones/concats/mezclas largas sin ser infinito.
VSE_SUBPROCESS_TIMEOUT_S: float = _env_float("VSE_SUBPROCESS_TIMEOUT_S", 900.0)

# Plazo corto para la inspección/duración con ``ffprobe``: 60 s. Un clip válido
# se sondea en muy por debajo de un segundo, así que 60 s es un margen amplísimo
# que aún corta rápido un ffprobe bloqueado (p. ej. lectura FUSE estancada).
VSE_PROBE_TIMEOUT_S: float = _env_float("VSE_PROBE_TIMEOUT_S", 60.0)

# Plazo más largo para pasos de transcripción/render (faster-whisper, Remotion),
# que legítimamente pueden tardar bastante más que ffmpeg. Por defecto 1800 s.
VSE_TRANSCRIPTION_TIMEOUT_S: float = _env_float("VSE_TRANSCRIPTION_TIMEOUT_S", 1800.0)

# ---------------------------------------------------------------------------
# Valores por defecto del pipeline (Req 3.2, 3.5, 4.2, 5.2, 5.3, 6.1, 7.x, 8.4)
# ---------------------------------------------------------------------------
# Resolución objetivo por defecto: 1080x1920 (9:16) (Req 3.2).
DEFAULT_RESOLUCION_ANCHO: int = 1080
DEFAULT_RESOLUCION_ALTO: int = 1920

# Cuadros por segundo objetivo por defecto (Req 3.5).
DEFAULT_FPS: int = 30

# Corte de silencios (Req 4.2): umbral por defecto 4 %, margen por defecto 0,2 s.
DEFAULT_SILENCIO_ACTIVADO: bool = True
DEFAULT_SILENCIO_UMBRAL_DB: float = -30.0  # equivalente UI (~4 % del motor)
DEFAULT_SILENCIO_MARGEN_MS: int = 200

# Motor de corte de silencios. Por defecto se usa el motor nativo de ffmpeg
# (``silencedetect`` + recorte con ``select``/``aselect``), que no depende de
# ``auto-editor`` (cuyo binario macOS mata con SIGKILL). Alternativa:
# ``"auto-editor"``. Configurable con la variable de entorno
# ``VSE_SILENCE_ENGINE``.
SILENCE_ENGINE: str = os.environ.get("VSE_SILENCE_ENGINE", "ffmpeg").strip() or "ffmpeg"

# Método de corte de silencios elegido en la UI:
#   - "db": por umbral de decibelios (silencedetect / auto-editor).
#   - "voz": por detección de voz con IA (VAD Silero, vía faster-whisper), que
#     conserva los tramos con voz humana y corta el resto (más robusto ante ruido
#     de fondo/música que el umbral de dB).
DEFAULT_SILENCIO_MODO: str = "db"

# Duración mínima (en segundos) de un silencio para que ffmpeg ``silencedetect``
# lo considere; también es el valor por defecto de ``d=`` del filtro.
DEFAULT_MIN_SILENCIO_S: float = 0.5

# ---------------------------------------------------------------------------
# Eliminación de risas (jaja/jeje/...) por transcripción.
# ---------------------------------------------------------------------------
# Si está activada, tras transcribir se detectan las palabras de risa y se
# recortan esos segmentos del video (remapeando los tiempos de las demás
# palabras). Por defecto desactivada en el modelo (la UI la ofrece activada).
DEFAULT_RISAS_ACTIVADO: bool = False
# Margen (ms) que se recorta a cada lado del segmento de risa.
DEFAULT_RISAS_MARGEN_MS: int = 100
RISAS_MARGEN_MS_MIN: int = 0
RISAS_MARGEN_MS_MAX: int = 2000

# Transiciones entre clips (Paso 1, UNIR). Por defecto SIN transición (corte
# duro), para preservar el comportamiento previo y no forzar recodificación.
# Cuando se activa, se aplica el MISMO efecto entre todos los clips con una
# duración configurable (ms).
DEFAULT_TRANSICION_TIPO: str = "ninguna"
DEFAULT_TRANSICION_DURACION_MS: int = 400
TRANSICION_DURACION_MS_MIN: int = 100
TRANSICION_DURACION_MS_MAX: int = 2000

# Revisión manual de subtítulos: si está activada, el pipeline se pausa tras la
# transcripción para que el usuario edite el texto antes de quemarlos. Por
# defecto desactivada (el pipeline corre de principio a fin sin intervención).
DEFAULT_SUBTITULOS_REVISAR: bool = False

# Transcripción (Req 5.2, 5.3).
DEFAULT_IDIOMA: str = "es"
DEFAULT_MODELO: str = "small"

# Subtítulos (Req 6.1, 7.3, 7.4, 7.8, 7.9).
DEFAULT_MAX_PALABRAS: int = 4
DEFAULT_TAMANO_FUENTE: int = 72
DEFAULT_GROSOR_BORDE: int = 5
DEFAULT_ANIM_ENTRADA_MS: int = 300
DEFAULT_ANIM_SALIDA_MS: int = 300
DEFAULT_SLIDE_PX: int = 50
DEFAULT_FUENTE: str = "Arial"
DEFAULT_COLOR: str = "#FFFFFF"
DEFAULT_COLOR_BORDE: str = "#000000"

# Si está activado, todo el texto de los subtítulos se muestra en minúscula.
# Por defecto desactivado (se conserva el texto tal cual lo transcribe el modelo).
DEFAULT_SUBTITULOS_MINUSCULAS: bool = False

# Preset de estilo de subtítulo:
#   - "clasico": línea completa con slide-up + fade (comportamiento previo).
#   - "resaltado": karaoke, resalta la palabra activa en el color de acento.
#   - "bold_pop": como "resaltado" pensado para fuentes bold (p. ej. Poppins).
# El modelo por defecto es "clasico" (compatibilidad); la UI ofrece "bold_pop".
DEFAULT_SUBTITULOS_PRESET: str = "clasico"
# Color de acento para la palabra activa en los presets de karaoke (#RRGGBB).
DEFAULT_SUBTITULOS_COLOR_RESALTADO: str = "#FFE500"

# Música / ducking (Req 8.4, 8.5, 8.6).
DEFAULT_VOLUMEN_MUSICA_PCT: int = 30
DEFAULT_REDUCCION_DB: float = 12.0
DEFAULT_UMBRAL_VOZ_DBFS: float = -30.0
DEFAULT_ATAQUE_MS: int = 250
DEFAULT_LIBERACION_MS: int = 500


# ---------------------------------------------------------------------------
# Integration flags — storage backend & edit mode (video-editor-integration)
# ---------------------------------------------------------------------------
# These flags control the editor's I/O mode when deployed in the combined
# Cloud Run container alongside the generator process.
# Both default to "local" so standalone operation is preserved (Req 10).
#
# Durable output storage config is inherited from videogeneradorxd's existing
# storage configuration. No dedicated edit bucket is introduced.
# ---------------------------------------------------------------------------

# Literal type for storage backend selection.
from typing import Literal

StorageBackendMode = Literal["local", "volume"]
EditModeValue = Literal["local", "cloud"]


def get_storage_backend() -> StorageBackendMode:
    """Return the configured storage backend mode.

    - "local":  read/write via on-disk filesystem paths (default, standalone).
    - "volume": read/write via the Shared_Volume mounted in-instance, used when
                deployed in the combined Cloud Run container.
    """
    raw = os.environ.get("VSE_STORAGE_BACKEND", "local").strip().lower()
    if raw == "volume":
        return "volume"
    return "local"


def get_edit_mode() -> EditModeValue:
    """Return the configured edit mode.

    - "local": standalone operation, editor runs independently (default).
    - "cloud": combined Cloud Run container with an internal editor process.
    """
    raw = os.environ.get("EDIT_MODE", "local").strip().lower()
    if raw == "cloud":
        return "cloud"
    return "local"


def is_cloud_mode() -> bool:
    """Convenience predicate: True when running in combined cloud mode."""
    return get_edit_mode() == "cloud"


def is_volume_backend() -> bool:
    """Convenience predicate: True when using the shared-volume storage backend."""
    return get_storage_backend() == "volume"
