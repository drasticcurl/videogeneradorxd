"""Construcción del archivo de subtítulos ASS (lógica pura).

Implementa el sub-paso 4b del pipeline (Req 7): a partir de los
:class:`~app.models.settings.GrupoSubtitulo` producidos por la agrupación
(``engine/grouping.py``) y de los :class:`~app.models.settings.AjustesSubtitulos`,
genera el texto completo de un archivo Advanced SubStation Alpha (ASS) con:

* Sección ``[Script Info]`` con ``PlayResX``/``PlayResY`` iguales a la
  ``Resolución_Objetivo``.
* Sección ``[V4+ Styles]`` con una línea ``Style:`` derivada del estilo
  configurado (fuente, tamaño, colores, grosor de borde, negrita).
* Sección ``[Events]`` con una línea ``Dialogue:`` por grupo, cada una con un
  *override* de la forma ``{\\anN\\move(x,y_inicial,x,y_final,0,entrada)\\fad(entrada,salida)}``.

Todo el módulo es **lógica pura y determinista**: no invoca herramientas
externas ni realiza E/S. El quemado del ASS con ffmpeg pertenece a
``engine/subtitles.py`` (tarea 11).

Invariantes clave (Propiedades 17-19 del diseño):

* La coordenada Y inicial de la animación de entrada es la Y final más los
  píxeles de deslizamiento: ``y_inicial = y_final + slide_px`` (Req 7.4).
* La alineación ``\\anN`` corresponde a la celda del teclado numérico ASS según
  la posición vertical/horizontal (Req 7.5, 7.6).
* Al volver a parsear las líneas ``Dialogue:`` se recuperan el número de grupos,
  sus textos y sus tiempos (dentro de la precisión de centésimas) (Req 7.1).

Referencias de requisitos: 7.1, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9.
"""

from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

from app.models.settings import (
    AjustesSubtitulos,
    GrupoSubtitulo,
    PosicionHorizontal,
    PosicionVertical,
    ResolucionObjetivo,
)
from app.util.ass_time import format_ass_time, parse_ass_time

# ---------------------------------------------------------------------------
# Alineación \an según el teclado numérico ASS (Req 7.5, 7.6)
#
#            izquierda   centro   derecha
#   superior     7          8         9
#   centro       4          5         6
#   inferior     1          2         3
# ---------------------------------------------------------------------------
_ALINEACION: Dict[Tuple[str, str], int] = {
    ("superior", "izquierda"): 7,
    ("superior", "centro"): 8,
    ("superior", "derecha"): 9,
    ("centro", "izquierda"): 4,
    ("centro", "centro"): 5,
    ("centro", "derecha"): 6,
    ("inferior", "izquierda"): 1,
    ("inferior", "centro"): 2,
    ("inferior", "derecha"): 3,
}

# Nombre del estilo emitido en [V4+ Styles] y referenciado en cada Dialogue.
_NOMBRE_ESTILO: str = "Short"


def calcular_alineacion(
    posicion_vertical: PosicionVertical, posicion_horizontal: PosicionHorizontal
) -> int:
    """Devuelve el valor ``\\anN`` (1..9) para una combinación de posiciones.

    Args:
        posicion_vertical: ``superior`` | ``centro`` | ``inferior``.
        posicion_horizontal: ``izquierda`` | ``centro`` | ``derecha``.

    Returns:
        El número de alineación del teclado numérico ASS (Req 7.5, 7.6).

    Raises:
        ValueError: Si la combinación no es válida.
    """
    try:
        return _ALINEACION[(posicion_vertical, posicion_horizontal)]
    except KeyError as exc:  # pragma: no cover - defensivo
        raise ValueError(
            "Combinación de posición inválida: vertical=%r horizontal=%r"
            % (posicion_vertical, posicion_horizontal)
        ) from exc


def color_a_ass(color_hex: str) -> str:
    """Convierte un color ``#RRGGBB`` al formato ASS ``&HAABBGGRR``.

    ASS ordena los canales como azul-verde-rojo y antepone un byte de alfa donde
    ``00`` significa totalmente opaco. Por tanto ``#RRGGBB`` se traduce a
    ``&H00BBGGRR``.

    Args:
        color_hex: Color en notación ``#RRGGBB`` (con o sin ``#``).

    Returns:
        El color en formato ASS ``&H00BBGGRR`` (mayúsculas).

    Raises:
        ValueError: Si la cadena no representa un color RGB de 6 dígitos hex.
    """
    texto = color_hex.strip()
    if texto.startswith("#"):
        texto = texto[1:]
    if len(texto) != 6:
        raise ValueError("Color RGB inválido (se esperaban 6 dígitos hex): %r" % (color_hex,))
    try:
        rr = int(texto[0:2], 16)
        gg = int(texto[2:4], 16)
        bb = int(texto[4:6], 16)
    except ValueError as exc:
        raise ValueError("Color RGB inválido: %r" % (color_hex,)) from exc
    return "&H00%02X%02X%02X" % (bb, gg, rr)


def _clamp(valor: float, minimo: float, maximo: float) -> float:
    """Satura ``valor`` a ``[minimo, maximo]`` tolerando que ``minimo > maximo``.

    Cuando los márgenes dejan un intervalo vacío (``margen_px`` demasiado grande
    para la dimensión), se usa el punto medio del intervalo degenerado para
    obtener siempre una coordenada bien definida.
    """
    lo, hi = (minimo, maximo) if minimo <= maximo else (maximo, minimo)
    if valor < lo:
        return lo
    if valor > hi:
        return hi
    return valor


def calcular_posicion_base(
    resolucion: ResolucionObjetivo,
    pos_horizontal_pct: float,
    pos_vertical_pct: float,
    margen_px: int,
) -> Tuple[int, int]:
    """Calcula la posición base ``(x, y_final)`` de los subtítulos.

    La posición se deriva de los porcentajes sobre la ``Resolución_Objetivo`` y
    se acota (clamp) al área interior definida por ``margen_px`` en cada borde
    (Req 7.7, 9.1)::

        x       = clamp(ancho * pos_horizontal_pct/100, margen_px, ancho - margen_px)
        y_final = clamp(alto  * pos_vertical_pct/100,   margen_px, alto  - margen_px)

    Returns:
        Tupla ``(x, y_final)`` con coordenadas enteras en píxeles.
    """
    x = _clamp(
        resolucion.ancho * (pos_horizontal_pct / 100.0),
        margen_px,
        resolucion.ancho - margen_px,
    )
    y_final = _clamp(
        resolucion.alto * (pos_vertical_pct / 100.0),
        margen_px,
        resolucion.alto - margen_px,
    )
    return int(round(x)), int(round(y_final))


def construir_override(subtitulos: AjustesSubtitulos, x: int, y_final: int) -> str:
    """Construye el *override* de línea ASS con animación slide-up + fade.

    Produce ``{\\anN\\move(x,y_inicial,x,y_final,0,entrada)\\fad(entrada,salida)}``
    donde ``y_inicial = y_final + slide_px`` (deslizamiento hacia arriba, Req
    7.4). ``\\move`` anima la entrada desde ``y_inicial`` hasta ``y_final`` en el
    tiempo ``anim_entrada_ms`` y ``\\fad`` aplica el desvanecimiento de entrada y
    de salida (Req 7.3).

    Args:
        subtitulos: Ajustes de subtítulos (posición, slide y duraciones).
        x: Coordenada X (constante en la animación vertical).
        y_final: Coordenada Y de reposo del subtítulo.

    Returns:
        La cadena del *override* de línea.
    """
    an = calcular_alineacion(
        subtitulos.posicion_vertical, subtitulos.posicion_horizontal
    )
    # Invariante Req 7.4: la Y inicial supera a la final en `slide_px` píxeles.
    y_inicial = y_final + subtitulos.slide_px
    entrada = subtitulos.anim_entrada_ms
    salida = subtitulos.anim_salida_ms
    return (
        "{\\an%d\\move(%d,%d,%d,%d,0,%d)\\fad(%d,%d)}"
        % (an, x, y_inicial, x, y_final, entrada, entrada, salida)
    )


def _linea_estilo(subtitulos: AjustesSubtitulos) -> str:
    """Compone la línea ``Style:`` de la sección ``[V4+ Styles]`` (Req 7.8, 7.9)."""
    an = calcular_alineacion(
        subtitulos.posicion_vertical, subtitulos.posicion_horizontal
    )
    negrita = -1 if subtitulos.negrita else 0
    return (
        "Style: %s,%s,%d,%s,%s,%d,%d,%d,%d,%d,%d"
        % (
            _NOMBRE_ESTILO,
            subtitulos.fuente,
            subtitulos.tamano,
            color_a_ass(subtitulos.color),
            color_a_ass(subtitulos.color_borde),
            negrita,
            subtitulos.grosor_borde,
            an,
            subtitulos.margen_px,
            subtitulos.margen_px,
            subtitulos.margen_px,
        )
    )


def _es_karaoke(subtitulos: AjustesSubtitulos) -> bool:
    """Indica si el preset activa el resaltado palabra por palabra (karaoke)."""
    return getattr(subtitulos, "preset", "clasico") in ("resaltado", "bold_pop")


def _tokens_grupo(grupo: GrupoSubtitulo, minusculas: bool) -> List[str]:
    """Divide el texto del grupo en palabras (aplicando minúscula si procede)."""
    texto = grupo.texto.lower() if minusculas else grupo.texto
    return texto.split()


def limites_palabras(grupo: GrupoSubtitulo, num_tokens: int) -> List[float]:
    """Calcula los ``num_tokens + 1`` límites de tiempo del karaoke (lógica pura).

    Usa los timestamps por palabra de ``grupo.palabras`` cuando están disponibles
    y son coherentes (misma cantidad que ``num_tokens`` y estrictamente
    crecientes); en caso contrario reparte el intervalo del grupo por igual entre
    las palabras. Los límites resultantes son no decrecientes, empiezan en
    ``grupo.inicio_s`` y terminan en ``grupo.fin_s``.
    """
    ini = float(grupo.inicio_s)
    fin = float(grupo.fin_s)
    if fin < ini:
        fin = ini
    if num_tokens <= 0:
        return [ini, fin]

    starts: List[float] = []
    palabras = grupo.palabras or []
    if len(palabras) == num_tokens:
        ok = True
        prev = ini - 1.0
        for p in palabras:
            s = getattr(p, "inicio_s", None)
            if s is None:
                ok = False
                break
            s = min(max(float(s), ini), fin)
            if s <= prev:  # exige orden estricto para evitar solapes
                ok = False
                break
            starts.append(s)
            prev = s
        if not ok:
            starts = []

    if not starts:
        dur = fin - ini
        starts = [ini + dur * k / num_tokens for k in range(num_tokens)]

    bounds = list(starts) + [fin]
    bounds[0] = ini
    for k in range(1, len(bounds)):
        if bounds[k] < bounds[k - 1]:
            bounds[k] = bounds[k - 1]
    return bounds


def construir_lineas_karaoke(
    grupo: GrupoSubtitulo,
    subtitulos: AjustesSubtitulos,
    x: int,
    y: int,
) -> List[str]:
    """Construye las líneas ``Dialogue:`` de un grupo con resaltado por palabra.

    Emite una línea por palabra: durante su intervalo, la palabra activa se pinta
    en el color de acento (``color_resaltado``) y el resto en el color base. La
    posición es estática (``\\pos``) para que el efecto sea el cambio de resaltado
    y no un desplazamiento. Si el grupo no tiene palabras/duración útil, emite una
    única línea con el texto completo.
    """
    tokens = _tokens_grupo(grupo, subtitulos.minusculas)
    an = calcular_alineacion(
        subtitulos.posicion_vertical, subtitulos.posicion_horizontal
    )
    base = color_a_ass(subtitulos.color)
    override_base = "{\\an%d\\pos(%d,%d)\\1c%s}" % (an, x, y, base)

    if not tokens:
        return []
    if len(tokens) == 1 or grupo.fin_s <= grupo.inicio_s:
        # Sin karaoke útil: una sola línea con el texto completo.
        texto = _escape_texto(" ".join(tokens))
        return [
            "Dialogue: 0,%s,%s,%s,,0,0,0,,%s%s"
            % (
                format_ass_time(grupo.inicio_s),
                format_ass_time(grupo.fin_s),
                _NOMBRE_ESTILO,
                override_base,
                texto,
            )
        ]

    accent = color_a_ass(subtitulos.color_resaltado)
    bounds = limites_palabras(grupo, len(tokens))

    lineas: List[str] = []
    for k, _tok in enumerate(tokens):
        ini_k = bounds[k]
        fin_k = bounds[k + 1]
        if fin_k <= ini_k:
            # Solo la última palabra puede quedar sin margen; dale una pizca.
            fin_k = ini_k + 0.03 if k == len(tokens) - 1 else ini_k
            if fin_k <= ini_k:
                continue
        partes: List[str] = []
        for j, t in enumerate(tokens):
            t_esc = _escape_texto(t)
            if j == k:
                partes.append("{\\1c%s}%s{\\1c%s}" % (accent, t_esc, base))
            else:
                partes.append(t_esc)
        texto = " ".join(partes)
        lineas.append(
            "Dialogue: 0,%s,%s,%s,,0,0,0,,%s%s"
            % (
                format_ass_time(ini_k),
                format_ass_time(fin_k),
                _NOMBRE_ESTILO,
                override_base,
                texto,
            )
        )
    return lineas


def construir_ass(
    grupos: Sequence[GrupoSubtitulo],
    subtitulos: AjustesSubtitulos,
    resolucion: ResolucionObjetivo,
) -> str:
    """Construye el texto completo del archivo ASS (Req 7.1, 7.3-7.9).

    Args:
        grupos: Grupos de subtítulo con texto y tiempos (en segundos).
        subtitulos: Ajustes de estilo, posición y animación.
        resolucion: Resolución objetivo; fija ``PlayResX``/``PlayResY``.

    Returns:
        El contenido textual del archivo ASS.
    """
    x, y_final = calcular_posicion_base(
        resolucion,
        subtitulos.pos_horizontal_pct,
        subtitulos.pos_vertical_pct,
        subtitulos.margen_px,
    )
    override = construir_override(subtitulos, x, y_final)

    lineas: List[str] = []

    # [Script Info]
    lineas.append("[Script Info]")
    lineas.append("ScriptType: v4.00+")
    lineas.append("PlayResX: %d" % resolucion.ancho)
    lineas.append("PlayResY: %d" % resolucion.alto)
    lineas.append("")

    # [V4+ Styles]
    lineas.append("[V4+ Styles]")
    lineas.append(
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, "
        "Bold, Outline, Alignment, MarginL, MarginR, MarginV"
    )
    lineas.append(_linea_estilo(subtitulos))
    lineas.append("")

    # [Events]
    lineas.append("[Events]")
    lineas.append(
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text"
    )
    karaoke = _es_karaoke(subtitulos)
    for grupo in grupos:
        if karaoke:
            # Resaltado palabra por palabra (posición estática).
            lineas.extend(construir_lineas_karaoke(grupo, subtitulos, x, y_final))
            continue
        inicio = format_ass_time(grupo.inicio_s)
        fin = format_ass_time(grupo.fin_s)
        # Req: opción de mostrar todo el texto en minúscula (respeta acentos).
        texto_grupo = grupo.texto.lower() if subtitulos.minusculas else grupo.texto
        texto = _escape_texto(texto_grupo)
        lineas.append(
            "Dialogue: 0,%s,%s,%s,,0,0,0,,%s%s"
            % (inicio, fin, _NOMBRE_ESTILO, override, texto)
        )

    return "\n".join(lineas) + "\n"


# ---------------------------------------------------------------------------
# Escapado / parsing del texto de diálogo (soporte del round-trip, Propiedad 17)
# ---------------------------------------------------------------------------
def _escape_texto(texto: str) -> str:
    """Escapa saltos de línea del texto para no romper la línea ``Dialogue:``.

    Los saltos de línea se representan con la secuencia ASS ``\\N``. El texto de
    subtítulo no debe contener las llaves ``{}`` (delimitan *overrides*); la
    construcción antepone su propio *override* y el texto de los grupos proviene
    de palabras transcritas sin dichos delimitadores.
    """
    return texto.replace("\r\n", "\\N").replace("\n", "\\N").replace("\r", "\\N")


def _unescape_texto(texto: str) -> str:
    """Operación inversa de :func:`_escape_texto`."""
    return texto.replace("\\N", "\n")


def _quitar_override(texto: str) -> str:
    """Elimina el bloque de *override* ``{...}`` inicial de un texto de diálogo."""
    if texto.startswith("{"):
        cierre = texto.find("}")
        if cierre != -1:
            return texto[cierre + 1 :]
    return texto


def parsear_dialogues(ass: str) -> List[GrupoSubtitulo]:
    """Parsea las líneas ``Dialogue:`` de un ASS y recupera los grupos.

    Recorre la sección ``[Events]`` y, por cada ``Dialogue:``, extrae el tiempo
    de inicio, el de fin y el texto (tras descartar el *override* inicial),
    reconstruyendo una lista de :class:`~app.models.settings.GrupoSubtitulo`.

    Args:
        ass: Contenido textual de un archivo ASS.

    Returns:
        Lista de grupos recuperados, en el mismo orden que aparecen.
    """
    grupos: List[GrupoSubtitulo] = []
    en_events = False
    for linea in ass.splitlines():
        encabezado = linea.strip()
        if encabezado.startswith("[") and encabezado.endswith("]"):
            en_events = encabezado == "[Events]"
            continue
        if not en_events or not linea.startswith("Dialogue:"):
            continue
        payload = linea[len("Dialogue:") :].lstrip()
        # El campo Text es el último; contiene comas (dentro de \move) por lo que
        # se limita el número de divisiones a los 9 campos previos.
        campos = payload.split(",", 9)
        if len(campos) < 10:
            continue  # pragma: no cover - línea Dialogue malformada
        inicio_s = parse_ass_time(campos[1])
        fin_s = parse_ass_time(campos[2])
        texto = _unescape_texto(_quitar_override(campos[9]))
        grupos.append(GrupoSubtitulo(texto=texto, inicio_s=inicio_s, fin_s=fin_s))
    return grupos


__all__ = [
    "calcular_alineacion",
    "color_a_ass",
    "calcular_posicion_base",
    "construir_override",
    "construir_ass",
    "construir_lineas_karaoke",
    "limites_palabras",
    "parsear_dialogues",
]
