"""Paso 5 del pipeline — Música de fondo con ducking (Req 8).

Mezcla un archivo WAV de música con el audio del video aplicando *ducking*: la
voz del video actúa como cadena lateral (*sidechain*) que comprime la música con
el filtro ``sidechaincompress`` de ffmpeg, de modo que la música baje de volumen
cuando hay voz y se restaure cuando la voz cae.

Parámetros del ducking (Req 8.3-8.6):

* **Volumen base** de la música configurable (0..100 %, def 30 %) (Req 8.4).
* **Reducción >= 12 dB** cuando la voz supera el umbral (Req 8.5).
* **Umbral de voz -30 dBFS**, convertido a amplitud lineal (Req 8.5, 8.6).
* **Ataque <= 250 ms** (Req 8.5) y **liberación <= 500 ms** (Req 8.6).

Garantías:

* **Omisión sin WAV válido (Req 8.3):** si no se proporciona un WAV de música,
  el paso se omite y el ``Video_Final`` es el video subtitulado sin música.
* **Reporte de fallo (Req 8.7):** si ``sidechaincompress``/ffmpeg falla (código
  != 0), se lanza :class:`MusicaError`.

La ejecución de ffmpeg pasa por un :data:`~app.engine.proc.Runner` inyectable,
por lo que los tests no dependen del binario ffmpeg real.

Referencias de requisitos: 8.3, 8.4, 8.5, 8.6, 8.7.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Union

from app.engine.proc import Runner, ejecutar_comando
from app.models.settings import RANGOS_MOTOR, AjustesMusica
from app.util.units import dbfs_a_amplitud

# Nombre del artefacto de video final con música.
NOMBRE_FINAL: str = "final.mp4"

# Prefijo de las rutas de campo de música dentro de RANGOS_MOTOR.
_PREFIJO_MUSICA: str = "musica."

# Reducción mínima exigida por el diseño (Req 8.5).
REDUCCION_MINIMA_DB: float = 12.0

# Ratio máximo admitido por ``sidechaincompress`` en ffmpeg.
_RATIO_MAX: float = 20.0


class ConfiguracionMusicaError(ValueError):
    """La configuración de música/ducking está fuera de rango (Req 8.4-8.6)."""

    def __init__(self, campos_invalidos: List[str]) -> None:
        self.campos_invalidos = list(campos_invalidos)
        super().__init__(
            "Configuración de música inválida; campos fuera de rango: "
            + ", ".join(self.campos_invalidos)
        )


class MusicaError(Exception):
    """``sidechaincompress``/ffmpeg falló durante la mezcla de música (Req 8.7)."""


def validar_config_musica(musica: AjustesMusica) -> List[str]:
    """Valida los campos de música contra los rangos del motor (Req 8.4-8.6).

    Returns:
        La lista de nombres de campo inválidos (vacía si es válida).
    """
    invalidos: List[str] = []
    for ruta, (minimo, maximo) in RANGOS_MOTOR.items():
        if not ruta.startswith(_PREFIJO_MUSICA):
            continue
        atributo = ruta[len(_PREFIJO_MUSICA) :]
        valor = getattr(musica, atributo)
        if isinstance(valor, bool) or not isinstance(valor, (int, float)):
            invalidos.append(ruta)
        elif not (minimo <= valor <= maximo):
            invalidos.append(ruta)
    return invalidos


@dataclass(frozen=True)
class ParametrosDucking:
    """Parámetros efectivos del ducking, ya convertidos a unidades del motor.

    Attributes:
        volumen_base: Ganancia lineal de la música (0..1) desde ``volumen_base_pct``.
        threshold_lin: Umbral de la voz en amplitud lineal (desde ``umbral_voz_dbfs``).
        ratio: Ratio de compresión de ``sidechaincompress`` (>= 1). Se elige alto
            para garantizar una reducción >= ``reduccion_db`` cuando hay voz.
        reduccion_db: Reducción de volumen objetivo (>= 12 dB, Req 8.5).
        ataque_ms: Tiempo de ataque en ms (<= 250, Req 8.5).
        liberacion_ms: Tiempo de liberación en ms (<= 500, Req 8.6).
    """

    volumen_base: float
    threshold_lin: float
    ratio: float
    reduccion_db: float
    ataque_ms: int
    liberacion_ms: int


def calcular_parametros_ducking(musica: AjustesMusica) -> ParametrosDucking:
    """Calcula los :class:`ParametrosDucking` desde los ajustes de música (Req 8.4-8.6).

    Convierte el volumen base a ganancia lineal, el umbral de voz de dBFS a
    amplitud lineal y deriva un ``ratio`` monótonamente creciente con la reducción
    objetivo (acotado al máximo de ffmpeg), de modo que a mayor ``reduccion_db``
    mayor compresión.

    Raises:
        ConfiguracionMusicaError: Si algún campo está fuera de rango.
    """
    invalidos = validar_config_musica(musica)
    if invalidos:
        raise ConfiguracionMusicaError(invalidos)

    volumen_base = musica.volumen_base_pct / 100.0
    threshold_lin = dbfs_a_amplitud(musica.umbral_voz_dbfs)
    # Ratio creciente con la reducción objetivo; acotado a [2, 20]. Un ratio alto
    # actúa como limitador y garantiza una reducción >= reduccion_db (Req 8.5).
    ratio = min(_RATIO_MAX, max(2.0, float(musica.reduccion_db)))
    return ParametrosDucking(
        volumen_base=volumen_base,
        threshold_lin=threshold_lin,
        ratio=ratio,
        reduccion_db=float(musica.reduccion_db),
        ataque_ms=int(musica.ataque_ms),
        liberacion_ms=int(musica.liberacion_ms),
    )


def _fmt(valor: float) -> str:
    """Formatea un flotante de forma compacta para el filtro."""
    redondeado = round(float(valor), 6)
    if redondeado == int(redondeado):
        return str(int(redondeado))
    return ("%.6f" % redondeado).rstrip("0").rstrip(".")


def construir_filtro_ducking(params: ParametrosDucking) -> str:
    """Construye el ``filter_complex`` de ducking con ``sidechaincompress`` (Req 8.3, 8.5, 8.6).

    Estructura del filtro::

        [0:a]asplit=2[voz][sc];
        [1:a]volume=<vol>[mus];
        [mus][sc]sidechaincompress=threshold=<thr>:ratio=<ratio>:attack=<ataque>:release=<liberacion>:makeup=1[duck];
        [voz][duck]amix=inputs=2:duration=first:normalize=0[aout]

    La voz (entrada 0) se divide para actuar como cadena lateral que comprime la
    música (entrada 1) previamente atenuada al volumen base.

    Args:
        params: Parámetros efectivos del ducking.

    Returns:
        La cadena ``filter_complex`` para ffmpeg.
    """
    return (
        "[0:a]asplit=2[voz][sc];"
        "[1:a]volume=%s[mus];"
        "[mus][sc]sidechaincompress=threshold=%s:ratio=%s:attack=%d:release=%d:makeup=1[duck];"
        "[voz][duck]amix=inputs=2:duration=first:normalize=0[aout]"
        % (
            _fmt(params.volumen_base),
            _fmt(params.threshold_lin),
            _fmt(params.ratio),
            params.ataque_ms,
            params.liberacion_ms,
        )
    )


def comando_mezclar_musica(
    video: str, musica_wav: str, salida: str, filtro: str
) -> List[str]:
    """Construye el comando ffmpeg que mezcla música con ducking (Req 8.3).

    Args:
        video: Ruta del video (fuente de la voz).
        musica_wav: Ruta del WAV de música.
        salida: Ruta del video final a producir.
        filtro: ``filter_complex`` de ducking.

    Returns:
        La lista de argumentos del comando ffmpeg.
    """
    return [
        "ffmpeg",
        "-y",
        "-i",
        video,
        "-i",
        musica_wav,
        "-filter_complex",
        filtro,
        "-map",
        "0:v",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-shortest",
        salida,
    ]


def mezclar_musica(
    video: Union[str, Path],
    musica_wav: Optional[Union[str, Path]],
    musica: Optional[AjustesMusica],
    salida: Union[str, Path],
    *,
    runner: Runner = ejecutar_comando,
) -> Path:
    """Ejecuta el Paso 5 (música con ducking) o lo omite si no hay WAV (Req 8).

    * Si ``musica_wav`` o ``musica`` es ``None`` (sin WAV válido): **omisión**; se
      devuelve la ruta del ``video`` de entrada sin modificar (Req 8.3).
    * En caso contrario: calcula los parámetros del ducking, construye el filtro
      con ``sidechaincompress`` y ejecuta ffmpeg (Req 8.3-8.6). Si ffmpeg falla,
      lanza :class:`MusicaError` (Req 8.7).

    Args:
        video: Ruta del video de entrada (subtitulado).
        musica_wav: Ruta del WAV de música, o ``None`` para omitir.
        musica: Ajustes de música/ducking, o ``None`` para omitir.
        salida: Ruta del video final a producir cuando hay música.
        runner: Ejecutor de comandos ffmpeg inyectable.

    Returns:
        La ruta del video de **entrada** si se omite, o la de **salida** si se
        mezcló la música.

    Raises:
        ConfiguracionMusicaError: Configuración de música fuera de rango.
        MusicaError: ffmpeg/``sidechaincompress`` falló (Req 8.7).
    """
    video_path = Path(video)

    # Req 8.3: sin WAV válido => omitir el paso.
    if musica_wav is None or musica is None:
        return video_path

    params = calcular_parametros_ducking(musica)
    filtro = construir_filtro_ducking(params)
    salida_path = Path(salida)
    comando = comando_mezclar_musica(
        str(video_path), str(musica_wav), str(salida_path), filtro
    )
    try:
        resultado = runner(comando)
    except OSError as exc:
        raise MusicaError(f"no se pudo ejecutar ffmpeg: {exc}") from exc

    if resultado.returncode != 0:
        detalle = (resultado.stderr or "").strip() or "código de salida distinto de cero"
        raise MusicaError(f"sidechaincompress falló: {detalle}")

    return salida_path


__all__ = [
    "NOMBRE_FINAL",
    "REDUCCION_MINIMA_DB",
    "ConfiguracionMusicaError",
    "MusicaError",
    "ParametrosDucking",
    "validar_config_musica",
    "calcular_parametros_ducking",
    "construir_filtro_ducking",
    "comando_mezclar_musica",
    "mezclar_musica",
]
