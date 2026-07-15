"""Paso 4c' del pipeline — Motor de render con Remotion (Node), opt-in.

Este módulo es el **puente** entre el pipeline Python y el subproyecto Node de
Remotion (``remotion/``, tarea 6). Cumple dos responsabilidades:

1. **Mapeo puro ``GrupoSubtitulo`` → ``Caption``** (Req 10): traduce cada grupo
   de subtítulo (con sus tiempos en segundos) al tipo :class:`Caption` que
   consume ``@remotion/captions`` (tiempos en milisegundos). Cuando el grupo
   tiene ``palabras`` con timestamps, se emite un :class:`Caption` **por
   palabra** (con un espacio inicial en ``text``, requisito de whitespace de
   ``createTikTokStyleCaptions``); en caso contrario, uno por grupo.
2. **Invocación del render** (:func:`renderizar_con_remotion`, Req 9, 12, 13):
   serializa un ``props.json`` (dentro del directorio de trabajo del Job) con la
   ruta del vídeo, los captions y el estilo; invoca ``node render.mjs`` mediante
   el :data:`~app.engine.proc.Runner` **inyectable** (argumentos como **lista**,
   **sin shell**, con las rutas pasadas por ``props.json`` y variables de
   entorno para no concatenar datos en la línea de comandos, Req 12.3, 12.4); y
   valida el artefacto de salida.

Garantías del render (análogas a ``subtitles.py``/``music.py``):

* **Conservación del original (Req 13.1, 9.3):** el MP4 se escribe en un archivo
  de salida **distinto** de la entrada; en éxito se devuelve ``Path(salida)`` y
  la entrada se conserva.
* **Fallo accionable y sin fallback (Req 9.4):** si Node/Chromium no están
  disponibles, ``render.mjs`` termina con código != 0, o el artefacto de salida
  no existe, se lanza :class:`RemotionError` con un mensaje accionable y **sin**
  dejar artefactos parciales referenciados como salida. No hay reintento con
  otro motor: el fallo se propaga (el Job pasa a FALLIDO, Req 7.4).

La ejecución de Node pasa por un ``Runner`` inyectable, la comprobación de
existencia del artefacto es inyectable (``existe_salida``) y la inspección de la
duración del vídeo también (``inspeccionar``, análoga a ``ffprobe``), de modo
que los tests no dependan de Node, Chromium ni de los binarios reales.

Referencias de requisitos: 9.1, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 12.3, 12.4, 13.1.
"""

from __future__ import annotations

import json
import logging
import math
import os
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional, Sequence, Union

from app.engine.ffprobe import ClipInfo, inspeccionar_clip
from app.engine.proc import Runner, ejecutar_comando
from app.models.settings import (
    AjustesRender,
    AjustesSubtitulos,
    GrupoSubtitulo,
    ResolucionObjetivo,
    TextoExtra,
)

logger = logging.getLogger(__name__)

# Nombre del artefacto MP4 producido por el motor Remotion (Paso 4c').
NOMBRE_REMOTION_MP4: str = "remotion.mp4"

# Nombre del archivo de props serializado dentro del directorio de trabajo.
NOMBRE_PROPS_JSON: str = "props.json"

# Nombre del entrypoint SSR del subproyecto Node (tarea 6).
NOMBRE_RENDER_MJS: str = "render.mjs"

# Directorio del subproyecto Node de Remotion por defecto: ``{repo}/remotion``.
# ``remotion.py`` vive en ``backend/app/engine/``; parents[3] es la raíz del
# repositorio. El directorio no tiene por qué existir todavía (lo crea la tarea
# 6); los tests inyectan ``proyecto_dir`` y un ``runner`` doble.
_PROYECTO_REMOTION_POR_DEFECTO: Path = Path(__file__).resolve().parents[3] / "remotion"

# Límite de caracteres del stderr de Node que se incluye en el mensaje de error,
# para no desbordar el motivo del Job ni los logs.
_MAX_DETALLE_STDERR: int = 1500

# Marcadores en el stderr que sugieren que Node no está disponible.
_MARCADORES_NODE_AUSENTE: tuple[str, ...] = (
    "command not found",
    "no such file or directory",
    "is not recognized as an internal or external command",
    "cannot find module",
)

# Marcadores que sugieren que Chromium headless / sus dependencias faltan.
_MARCADORES_CHROMIUM_AUSENTE: tuple[str, ...] = (
    "error while loading shared libraries",
    "libnss3",
    "libatk",
    "libgbm",
    "could not find chrome",
    "could not find browser",
    "failed to launch the browser",
    "chrome headless shell",
)

# Guías accionables para los fallos de entorno más comunes (Req 9.4).
_GUIA_NODE_AUSENTE: str = (
    "Node.js no está disponible o el subproyecto remotion/ no está instalado; "
    "instala Node.js LTS y ejecuta `npm install` dentro de remotion/"
)
_GUIA_CHROMIUM_AUSENTE: str = (
    "Chromium headless o sus dependencias del sistema no están disponibles; "
    "instala las librerías de Chrome Headless Shell (en Linux, las dependencias "
    "compartidas de Chrome) o vuelve a lanzar el Job eligiendo el motor ffmpeg"
)


class RemotionError(Exception):
    """El render con Remotion falló (Node ausente, error de render, sin salida).

    Se lanza con un mensaje accionable (Req 9.4). No se realiza fallback al otro
    motor: la excepción se propaga y el Job pasa a FALLIDO (Req 7.4).
    """


# ---------------------------------------------------------------------------
# Tipo Caption (contrato con @remotion/captions) y mapeo puro (Req 10)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Caption:
    """Subtítulo en el formato del paquete ``@remotion/captions``.

    Los tiempos están en **milisegundos** (a diferencia de ``GrupoSubtitulo``,
    que usa segundos). Se serializa a JSON con :func:`caption_a_dict` para
    escribirlo en ``props.json``.

    Attributes:
        text: Texto del subtítulo. Para captions por palabra lleva un espacio
            inicial (requisito de whitespace de ``createTikTokStyleCaptions``).
        startMs: Inicio en ms (``round(inicio_s * 1000)``).
        endMs: Fin en ms (``round(fin_s * 1000)``); se garantiza ``startMs <= endMs``.
        timestampMs: Instante representativo (``round((inicio_s+fin_s)/2*1000)``),
            acotado al intervalo ``[startMs, endMs]``.
        confidence: Confianza; ``None`` (no disponible desde ``GrupoSubtitulo``).
    """

    text: str
    startMs: int
    endMs: int
    timestampMs: int
    confidence: Optional[float] = None


def _caption_desde_tiempos(
    texto: str, inicio_s: float, fin_s: float
) -> Caption:
    """Construye un :class:`Caption` a partir de un texto y tiempos en segundos.

    Aplica el mapeo del diseño (Req 10.1) y **garantiza** ``startMs <= endMs``
    (Req 10.2): si el redondeo produjera ``endMs < startMs`` (p. ej. tiempos
    invertidos o degenerados), se fija ``endMs = startMs``. El ``timestampMs`` se
    acota al intervalo ``[startMs, endMs]`` para mantenerse dentro de rango.
    """
    start_ms = round(inicio_s * 1000)
    end_ms = round(fin_s * 1000)
    if end_ms < start_ms:
        end_ms = start_ms
    ts_ms = round((inicio_s + fin_s) / 2 * 1000)
    # El instante representativo nunca cae fuera del intervalo del caption.
    ts_ms = min(max(ts_ms, start_ms), end_ms)
    return Caption(
        text=texto,
        startMs=start_ms,
        endMs=end_ms,
        timestampMs=ts_ms,
        confidence=None,
    )


def mapear_grupo_a_captions(grupo: GrupoSubtitulo) -> List[Caption]:
    """Mapea un :class:`GrupoSubtitulo` a uno o varios :class:`Caption` (Req 10.3).

    * Si el grupo tiene ``palabras`` con timestamps, emite **un caption por
      palabra**, con un **espacio inicial** en ``text`` (whitespace requerido por
      ``createTikTokStyleCaptions``). Una palabra sin timestamps válidos hereda
      los tiempos del grupo, de modo que el caption resultante sigue cumpliendo
      ``startMs <= endMs`` (Req 10.2).
    * Si el grupo no tiene ``palabras``, emite **un único caption por grupo**.

    Args:
        grupo: El grupo de subtítulo de entrada (no se modifica).

    Returns:
        La lista de captions derivada del grupo.
    """
    if grupo.palabras:
        captions: List[Caption] = []
        for palabra in grupo.palabras:
            inicio = palabra.inicio_s if palabra.inicio_s is not None else grupo.inicio_s
            fin = palabra.fin_s if palabra.fin_s is not None else grupo.fin_s
            # Espacio inicial: createTikTokStyleCaptions combina los tokens
            # respetando el whitespace incluido en cada ``text``.
            texto = " " + palabra.texto.strip()
            captions.append(_caption_desde_tiempos(texto, inicio, fin))
        return captions
    return [_caption_desde_tiempos(grupo.texto, grupo.inicio_s, grupo.fin_s)]


def mapear_grupos_a_captions(grupos: Sequence[GrupoSubtitulo]) -> List[Caption]:
    """Mapea una secuencia de grupos a la lista aplanada de captions (Req 10).

    Es una función **pura**: no muta la entrada ni produce efectos secundarios.
    """
    captions: List[Caption] = []
    for grupo in grupos:
        captions.extend(mapear_grupo_a_captions(grupo))
    return captions


def caption_a_dict(caption: Caption) -> Dict[str, object]:
    """Serializa un :class:`Caption` a un ``dict`` apto para JSON (``confidence`` → ``null``)."""
    return asdict(caption)


# ---------------------------------------------------------------------------
# Mapeo POR GRUPO (contrato ``grupos`` de props) — arreglo del render "todo
# pegado" (texto glueado sin espacios)
# ---------------------------------------------------------------------------
def _ms_desde_segundos(inicio_s: float, fin_s: float) -> tuple[int, int]:
    """Convierte un intervalo en segundos a ``(startMs, endMs)`` garantizando orden.

    Aplica el mismo criterio que :func:`_caption_desde_tiempos`: redondea a ms y,
    si el redondeo invirtiera el intervalo (``endMs < startMs``), fija
    ``endMs = startMs`` para mantener siempre ``startMs <= endMs``.
    """
    start_ms = round(inicio_s * 1000)
    end_ms = round(fin_s * 1000)
    if end_ms < start_ms:
        end_ms = start_ms
    return start_ms, end_ms


def mapear_grupo_a_props_grupo(grupo: GrupoSubtitulo) -> Dict[str, object]:
    """Mapea un :class:`GrupoSubtitulo` a un dict del contrato ``grupos`` (por grupo).

    A diferencia del mapeo por caption (``createTikTokStyleCaptions``, que pega
    los tokens y perdía los espacios cuando el grupo no traía ``palabras``), la
    composición renderiza **por grupo**: recibe el ``text`` completo del grupo y,
    opcionalmente, sus ``words`` con tiempos individuales para el resaltado.

    Forma devuelta::

        {
          "text": <grupo.texto>,
          "startMs": round(inicio_s*1000),
          "endMs": round(fin_s*1000),   # garantizado endMs >= startMs
          "words": [ {"text", "startMs", "endMs"}, ... ]  # [] si no hay palabras
        }

    Reglas:

    * Si ``grupo.palabras`` existe, se emite una entrada por palabra (texto sin
      espacios extra, ``strip``). Una palabra sin timestamps (``inicio_s``/``fin_s``
      ``None``) **hereda** los tiempos del grupo.
    * Si el grupo NO tiene ``palabras``, ``words`` queda como lista **vacía**: la
      composición dividirá el ``text`` por espacios para mostrar las palabras
      separadas (sin resaltado individual).
    * Se garantiza ``startMs <= endMs`` tanto en el grupo como en cada palabra.
    """
    inicio_grupo_ms, fin_grupo_ms = _ms_desde_segundos(grupo.inicio_s, grupo.fin_s)

    words: List[Dict[str, object]] = []
    if grupo.palabras:
        for palabra in grupo.palabras:
            # Una palabra sin timestamps válidos hereda los del grupo.
            inicio = palabra.inicio_s if palabra.inicio_s is not None else grupo.inicio_s
            fin = palabra.fin_s if palabra.fin_s is not None else grupo.fin_s
            palabra_inicio_ms, palabra_fin_ms = _ms_desde_segundos(inicio, fin)
            words.append(
                {
                    "text": palabra.texto.strip(),
                    "startMs": palabra_inicio_ms,
                    "endMs": palabra_fin_ms,
                }
            )

    return {
        "text": grupo.texto,
        "startMs": inicio_grupo_ms,
        "endMs": fin_grupo_ms,
        "words": words,
    }


def mapear_grupos_a_props_grupos(
    grupos: Sequence[GrupoSubtitulo],
) -> List[Dict[str, object]]:
    """Mapea una secuencia de grupos a la lista del contrato ``grupos`` de props.

    Función **pura**: no muta la entrada ni produce efectos secundarios. Es el
    origen del nuevo campo ``grupos`` de ``props.json`` que la composición usa
    para renderizar POR GRUPO (arreglo del texto "todo pegado").
    """
    return [mapear_grupo_a_props_grupo(grupo) for grupo in grupos]


# ---------------------------------------------------------------------------
# Mapeo de TEXTOS EXTRA tipo "hook" (contrato ``textosExtra`` de props) —
# overlays de texto plano SIN animación aplicados sobre el vídeo final
# (edicion-avanzada-shorts, Req 10.2, 13.1, 13.2; diseño §4.3 y §6.1)
# ---------------------------------------------------------------------------
def _estilo_texto_extra_a_props(estilo) -> Dict[str, object]:
    """Proyecta un :class:`EstiloTextoExtra` (snake_case) al estilo camelCase que
    consume la composición Remotion (contrato TS ``EstiloTextoExtra``).

    Es una copia explícita 1:1 campo a campo, renombrando únicamente del
    snake_case del modelo Pydantic al camelCase del contrato de la composición:

    * ``fuente`` → ``fuente``
    * ``tamano`` → ``tamano``
    * ``color`` → ``color``
    * ``color_borde`` → ``colorBorde``
    * ``grosor_borde`` → ``grosorBorde``
    * ``negrita`` → ``negrita``
    * ``pos_vertical_pct`` → ``posVerticalPct``
    * ``pos_horizontal_pct`` → ``posHorizontalPct``

    El orden de las claves replica el del mapeo del frontend
    (``estiloTextoExtraARemotion`` en ``frontend/lib/remotion-map.ts``) para
    mantener el contrato idéntico en ambos lados.
    """
    return {
        "fuente": estilo.fuente,
        "tamano": estilo.tamano,
        "color": estilo.color,
        "colorBorde": estilo.color_borde,
        "grosorBorde": estilo.grosor_borde,
        "negrita": estilo.negrita,
        "posVerticalPct": estilo.pos_vertical_pct,
        "posHorizontalPct": estilo.pos_horizontal_pct,
    }


def mapear_texto_extra_a_props(t: TextoExtra) -> Dict[str, object]:
    """Mapea un :class:`TextoExtra` al dict del contrato ``textosExtra`` de props.

    Forma devuelta (contrato TS ``TextoExtraProps``)::

        {
          "texto": <t.texto>,
          "inicioMs": round(t.inicio_s*1000),
          "finMs": round(t.fin_s*1000),   # garantizado finMs >= inicioMs
          "estilo": { ...camelCase... }
        }

    La conversión segundos→ms usa :func:`_ms_desde_segundos` (la MISMA que
    aplican grupos y palabras), de modo que se garantiza ``finMs >= inicioMs`` y
    se mantiene la coherencia de redondeo backend↔frontend (Propiedad P7). El
    estilo se proyecta a camelCase con :func:`_estilo_texto_extra_a_props`.

    Función **pura**: no muta la entrada.

    :param t: texto extra a mapear.
    :returns: dict serializable a JSON con ``texto``, ``inicioMs``, ``finMs`` y ``estilo``.
    """
    inicio_ms, fin_ms = _ms_desde_segundos(t.inicio_s, t.fin_s)
    return {
        "texto": t.texto,
        "inicioMs": inicio_ms,
        "finMs": fin_ms,
        "estilo": _estilo_texto_extra_a_props(t.estilo),
    }


# ---------------------------------------------------------------------------
# Estilo y props (contrato Python → Node)
# ---------------------------------------------------------------------------
def _estilo_desde_subtitulos(subtitulos: AjustesSubtitulos) -> Dict[str, object]:
    """Construye el ``estilo`` de ``props.json`` desde los ajustes de subtítulos."""
    return {
        "fuente": subtitulos.fuente,
        "tamano": subtitulos.tamano,
        "color": subtitulos.color,
        "colorResaltado": subtitulos.color_resaltado,
        "posVerticalPct": subtitulos.pos_vertical_pct,
        "animEntradaMs": subtitulos.anim_entrada_ms,
        # Borde/outline y negrita del texto (aditivo; el modelo ya los expone).
        "colorBorde": subtitulos.color_borde,
        "grosorBorde": subtitulos.grosor_borde,
        "negrita": subtitulos.negrita,
    }


def construir_props(
    entrada: Union[str, Path],
    grupos: Sequence[GrupoSubtitulo],
    subtitulos: AjustesSubtitulos,
    resolucion: ResolucionObjetivo,
    fps: int,
    duration_in_frames: int,
    combine_tokens_ms: int,
    video_src: Optional[str] = None,
    textos_extra: Sequence[TextoExtra] = (),
) -> Dict[str, object]:
    """Construye el diccionario de ``inputProps`` que consume la composición Node.

    Sobre ``videoSrc``: ``<OffthreadVideo src>`` de Remotion **no** acepta una
    ruta absoluta del disco (la interpretaría como relativa al bundle servido en
    ``http://localhost:.../`` y devolvería 404); solo admite una URL remota o un
    ``staticFile()`` de ``public/``. Por eso, cuando se dispone de una URL HTTP
    del backend (``video_src``), se usa como ``videoSrc``. Si no se proporciona
    (``None``), se conserva el comportamiento previo de resolver la **ruta
    absoluta** de ``entrada`` (compatibilidad con los tests existentes).

    Args:
        entrada: Ruta del vídeo de fondo (cortado).
        grupos: Grupos de subtítulo a renderizar.
        subtitulos: Ajustes de estilo de subtítulo.
        resolucion: Resolución objetivo (``width``/``height``).
        fps: Cuadros por segundo.
        duration_in_frames: Duración del vídeo en frames (``duración * fps``).
        combine_tokens_ms: Ventana de agrupación estilo TikTok (ms).
        video_src: URL HTTP del vídeo de fondo a usar como ``videoSrc`` (p. ej.
            servida por ``GET /workfile/{job_id}/{nombre}``). Si es ``None``, se
            usa la ruta absoluta de ``entrada``.
        textos_extra: Overlays de texto plano tipo "hook" a aplicar sobre el
            vídeo final (0..2). Se emiten en ``props["textosExtra"]`` mapeados con
            :func:`mapear_texto_extra_a_props`. Por defecto ``()`` (sin textos):
            el campo se emite como lista vacía ``[]`` y el resto del contrato
            queda idéntico al previo (retrocompatibilidad, Propiedad P9).

    Returns:
        El diccionario de props serializable a JSON.
    """
    captions = [caption_a_dict(c) for c in mapear_grupos_a_captions(grupos)]
    # Nuevo contrato POR GRUPO: la composición renderiza cada grupo con su texto
    # completo (y, si están, sus palabras con tiempos para el resaltado). Esto
    # arregla el render "todo pegado": cuando un grupo no traía ``palabras``, el
    # mapeo por caption emitía un token por grupo sin espacios y
    # ``createTikTokStyleCaptions`` los concatenaba. Con ``grupos`` la composición
    # divide el texto por espacios y muestra las palabras separadas.
    grupos_props = mapear_grupos_a_props_grupos(grupos)
    video_src_final = video_src if video_src is not None else str(Path(entrada).resolve())
    return {
        "videoSrc": video_src_final,
        "fps": int(fps),
        "width": int(resolucion.ancho),
        "height": int(resolucion.alto),
        "durationInFrames": int(duration_in_frames),
        # ``captions`` se conserva por compatibilidad hacia atrás; el nuevo campo
        # ``grupos`` es aditivo y es el que consume la composición actualizada.
        "captions": captions,
        "grupos": grupos_props,
        "estilo": _estilo_desde_subtitulos(subtitulos),
        "combineTokensWithinMs": int(combine_tokens_ms),
        # Campo aditivo ``textosExtra`` (edicion-avanzada-shorts): overlays de
        # texto plano. Lista vacía ``[]`` cuando no hay textos (default ``()``),
        # preservando el contrato previo byte a byte (retrocompatibilidad P9).
        "textosExtra": [mapear_texto_extra_a_props(t) for t in textos_extra],
    }


def comando_render_remotion(render_mjs: Union[str, Path]) -> List[str]:
    """Construye el comando ``node render.mjs`` como **lista** (sin shell) (Req 9.2).

    Los datos (rutas del ``props.json`` y del MP4 de salida, captions, estilo) NO
    se concatenan en la línea de comandos: viajan por ``props.json`` y por
    variables de entorno (``PROPS_PATH``/``OUT_PATH``), evitando la inyección de
    comandos (Req 12.3, 12.4). El comando solo contiene el ejecutable y la ruta
    del entrypoint.

    Args:
        render_mjs: Ruta del entrypoint ``render.mjs`` del subproyecto Node.

    Returns:
        La lista de argumentos del comando (apta para el ``Runner`` sin shell).
    """
    return ["node", str(render_mjs)]


@contextmanager
def _variables_entorno_temporales(variables: Dict[str, str]) -> Iterator[None]:
    """Aplica ``variables`` a ``os.environ`` durante el bloque y las restaura.

    Permite pasar rutas al proceso Node por variables de entorno (Req 12.4) sin
    concatenarlas en la línea de comandos y sin dejar residuos en el entorno del
    backend tras la ejecución.
    """
    previos: Dict[str, Optional[str]] = {
        clave: os.environ.get(clave) for clave in variables
    }
    try:
        os.environ.update(variables)
        yield
    finally:
        for clave, valor in previos.items():
            if valor is None:
                os.environ.pop(clave, None)
            else:
                os.environ[clave] = valor


def _recortar_stderr(texto: str, limite: int = _MAX_DETALLE_STDERR) -> str:
    """Devuelve el final del ``texto`` recortado a ``limite`` caracteres."""
    texto = (texto or "").strip()
    if len(texto) <= limite:
        return texto
    return "...(recortado)... " + texto[-limite:]


def _stderr_indica(stderr: str, marcadores: Sequence[str]) -> bool:
    """Indica si el ``stderr`` contiene alguno de los ``marcadores`` (case-insensitive)."""
    texto = (stderr or "").lower()
    return any(marcador in texto for marcador in marcadores)


def _calcular_duration_in_frames(
    entrada: Union[str, Path],
    grupos: Sequence[GrupoSubtitulo],
    fps: int,
    duracion_s: Optional[float],
    inspeccionar: Optional[Callable[[str], ClipInfo]],
) -> int:
    """Deriva ``durationInFrames`` de la duración del vídeo por ``fps`` (Req 9.1).

    La duración se toma, en orden de preferencia:

    1. Del parámetro ``duracion_s`` si se proporcionó.
    2. De la inspección del vídeo (``inspeccionar``, análoga a ``ffprobe``).
    3. Como último recurso, del mayor ``fin_s`` de los grupos (para no fallar el
       render si ``ffprobe`` no reporta duración).

    Se redondea hacia arriba (``ceil``) y se garantiza un mínimo de 1 frame.
    """
    duracion = duracion_s
    if duracion is None:
        inspector = inspeccionar if inspeccionar is not None else inspeccionar_clip
        try:
            info = inspector(str(entrada))
            duracion = info.duracion_s
        except Exception as exc:  # noqa: BLE001 - degradar al fallback por grupos
            logger.warning(
                "Remotion: no se pudo inspeccionar la duración de %s (%s); "
                "se usa el mayor fin_s de los grupos",
                entrada,
                type(exc).__name__,
            )
            duracion = None

    if duracion is None:
        duracion = max((float(g.fin_s) for g in grupos), default=0.0)

    return max(1, math.ceil(float(duracion) * int(fps)))


def renderizar_con_remotion(
    entrada: Union[str, Path],
    grupos: Sequence[GrupoSubtitulo],
    subtitulos: AjustesSubtitulos,
    resolucion: ResolucionObjetivo,
    fps: int,
    props_path: Union[str, Path],
    salida: Union[str, Path],
    *,
    runner: Runner = ejecutar_comando,
    existe_salida: Optional[Callable[[Path], bool]] = None,
    proyecto_dir: Optional[Union[str, Path]] = None,
    combine_tokens_ms: int = AjustesRender().combine_tokens_ms,
    duracion_s: Optional[float] = None,
    inspeccionar: Optional[Callable[[str], ClipInfo]] = None,
    video_url: Optional[str] = None,
    textos_extra: Sequence[TextoExtra] = (),
) -> Path:
    """Renderiza el vídeo con Remotion (Node) y valida el artefacto (Req 9, 12, 13).

    Flujo:

    1. Deriva ``durationInFrames`` de la duración del vídeo por ``fps`` (Req 9.1).
    2. Serializa ``props.json`` (videoSrc, fps, width/height, durationInFrames,
       captions, estilo, combineTokensWithinMs) dentro del directorio de trabajo
       del Job (Req 9.1). El vídeo de entrada NO se modifica.
    3. Construye ``node render.mjs`` como **lista** (sin shell) y pasa las rutas
       por ``props.json`` y variables de entorno (``PROPS_PATH``/``OUT_PATH``),
       sin concatenar datos en la línea de comandos (Req 9.2, 12.3, 12.4).
    4. Valida la salida: código 0 + artefacto presente → devuelve ``Path(salida)``
       conservando la entrada (Req 9.3, 13.1). En fallo (Node/Chromium ausentes,
       código != 0, artefacto ausente) lanza :class:`RemotionError` accionable,
       sin dejar artefactos parciales referenciados como salida (Req 9.4).

    Args:
        entrada: Ruta del vídeo de fondo (cortado). Se conserva sin modificar.
        grupos: Grupos de subtítulo a renderizar (mapeados a captions). Inmutable.
        subtitulos: Ajustes de estilo de subtítulo. Inmutable.
        resolucion: Resolución objetivo (``width``/``height``).
        fps: Cuadros por segundo.
        props_path: Ruta donde escribir ``props.json`` (dentro del ``JobWorkdir``).
        salida: Ruta del MP4 a producir (distinta de ``entrada``, Req 13.1).
        runner: Ejecutor de comandos Node inyectable (por defecto subprocess).
        existe_salida: Predicado inyectable de existencia del artefacto (por
            defecto, comprobación real en disco).
        proyecto_dir: Directorio del subproyecto Node ``remotion/`` (por defecto
            ``{repo}/remotion``).
        combine_tokens_ms: Ventana de agrupación estilo TikTok (ms).
        duracion_s: Duración del vídeo en segundos (opcional). Si es ``None`` se
            inspecciona el vídeo con ``inspeccionar``.
        inspeccionar: Inspector de vídeo inyectable (análogo a ``ffprobe``) para
            obtener la duración cuando ``duracion_s`` es ``None``.
        video_url: URL HTTP del vídeo de fondo que se pasa como ``videoSrc`` en
            ``props.json`` (Remotion la descarga durante el render). Si es
            ``None`` se usa la ruta absoluta de ``entrada`` (comportamiento
            previo). La duración se sigue calculando desde ``entrada`` (el backend
            tiene el archivo en disco), no desde esta URL.
        textos_extra: Overlays de texto plano tipo "hook" (0..2) a aplicar sobre
            el vídeo final (spec edicion-avanzada-shorts, Req 10.2). Se propagan a
            :func:`construir_props`, que los emite en ``props["textosExtra"]``. Por
            defecto ``()`` (sin textos): el campo se emite como lista vacía,
            preservando el contrato previo (retrocompatibilidad P9).

    Returns:
        La ruta del MP4 renderizado (``Path(salida)``).

    Raises:
        RemotionError: Node/Chromium no disponibles, ``render.mjs`` con código
            != 0, o artefacto de salida ausente (Req 9.4).
    """
    salida_path = Path(salida)
    props_path_obj = Path(props_path)
    proyecto = Path(proyecto_dir) if proyecto_dir is not None else _PROYECTO_REMOTION_POR_DEFECTO
    render_mjs = proyecto / NOMBRE_RENDER_MJS

    # (1) durationInFrames = duración del vídeo * fps (Req 9.1).
    duration_in_frames = _calcular_duration_in_frames(
        entrada, grupos, fps, duracion_s, inspeccionar
    )

    # (2) Serializar props.json dentro del directorio de trabajo (Req 9.1). Si se
    # pasó ``video_url``, se usa como ``videoSrc`` (URL HTTP que Remotion descarga
    # durante el render); si no, se cae a la ruta absoluta de ``entrada``.
    props = construir_props(
        entrada,
        grupos,
        subtitulos,
        resolucion,
        fps,
        duration_in_frames,
        combine_tokens_ms,
        video_src=video_url,
        textos_extra=textos_extra,
    )
    props_path_obj.parent.mkdir(parents=True, exist_ok=True)
    props_path_obj.write_text(
        json.dumps(props, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # (3) Comando como lista (sin shell); rutas por env, no en la línea de
    # comandos (Req 9.2, 12.3, 12.4).
    comando = comando_render_remotion(render_mjs)
    entorno = {"PROPS_PATH": str(props_path_obj), "OUT_PATH": str(salida_path)}

    logger.info(
        "Ejecutando Remotion: %s (PROPS_PATH=%s, OUT_PATH=%s)",
        " ".join(comando),
        entorno["PROPS_PATH"],
        entorno["OUT_PATH"],
    )

    try:
        with _variables_entorno_temporales(entorno):
            resultado = runner(comando)
    except FileNotFoundError as exc:  # node no instalado
        raise RemotionError(
            f"no se pudo ejecutar el render de Remotion: {_GUIA_NODE_AUSENTE} ({exc})"
        ) from exc
    except OSError as exc:
        raise RemotionError(
            f"no se pudo ejecutar el render de Remotion: {exc}"
        ) from exc

    # (4) Validación de la salida (Req 9.3, 9.4, 13.1).
    if resultado.returncode != 0:
        stderr_texto = (resultado.stderr or "").strip()
        logger.error(
            "Remotion falló (código %s). Comando: %s\nstderr:\n%s",
            resultado.returncode,
            " ".join(comando),
            stderr_texto or "(vacío)",
        )
        # No dejar artefactos parciales referenciados como salida (Req 9.4).
        _eliminar_parcial(salida_path, existe_salida)

        if _stderr_indica(stderr_texto, _MARCADORES_CHROMIUM_AUSENTE):
            raise RemotionError(f"el render de Remotion falló: {_GUIA_CHROMIUM_AUSENTE}")
        if _stderr_indica(stderr_texto, _MARCADORES_NODE_AUSENTE):
            raise RemotionError(f"el render de Remotion falló: {_GUIA_NODE_AUSENTE}")

        detalle = _recortar_stderr(stderr_texto) or "código de salida distinto de cero"
        raise RemotionError(f"el render de Remotion falló: {detalle}")

    comprobar = existe_salida if existe_salida is not None else (lambda p: p.exists())
    if not comprobar(salida_path):
        raise RemotionError(
            "el render de Remotion terminó con código 0 pero no produjo el "
            "archivo de salida MP4"
        )

    return salida_path


def _eliminar_parcial(
    salida_path: Path, existe_salida: Optional[Callable[[Path], bool]]
) -> None:
    """Elimina, en la medida de lo posible, un artefacto parcial tras un fallo.

    Evita que un MP4 incompleto quede referenciado como salida (Req 9.4). Un
    fallo al eliminar no debe enmascarar el :class:`RemotionError` original.
    """
    comprobar = existe_salida if existe_salida is not None else (lambda p: p.exists())
    try:
        if comprobar(salida_path):
            os.remove(salida_path)
    except OSError:
        logger.warning(
            "Remotion: no se pudo eliminar el artefacto parcial %s", salida_path
        )


__all__ = [
    "NOMBRE_REMOTION_MP4",
    "NOMBRE_PROPS_JSON",
    "NOMBRE_RENDER_MJS",
    "RemotionError",
    "Caption",
    "mapear_grupo_a_captions",
    "mapear_grupos_a_captions",
    "mapear_grupo_a_props_grupo",
    "mapear_grupos_a_props_grupos",
    "mapear_texto_extra_a_props",
    "caption_a_dict",
    "construir_props",
    "comando_render_remotion",
    "renderizar_con_remotion",
]
