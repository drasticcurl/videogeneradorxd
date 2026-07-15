"""Modelos Pydantic de los ajustes de configuración del pipeline.

La ESTRUCTURA de los ajustes (tipos y valores por defecto) se definió en la
tarea 2.2. La TAREA 8 añade la **validación de rangos del motor** y la política
de reconciliación UI↔motor documentada por campo, sin romper la estructura
existente: los modelos siguen siendo permisivos en construcción y la validación
se expone como la función pura :func:`validar_ajustes` (que devuelve la lista de
campos inválidos) más el ayudante :func:`asegurar_ajustes_validos` (que lanza
:class:`AjustesInvalidosError`).

Política de reconciliación UI↔motor (Req 9.6 vs Req 3-8):
    La Interfaz valida contra el rango de UI (más amplio); el Backend aplica el
    **rango del motor** y, cuando un valor excede dicho rango, lo **rechaza**
    identificando el campo (Req 7.11, 5.5, 5.6, 4.4). La única excepción es
    ``subtitulos.max_palabras``: en lugar de rechazarse, se aplica el valor por
    defecto seguro ``4`` (Req 6.2), fallback implementado en
    :func:`app.engine.grouping.tamano_efectivo`; por eso ``max_palabras`` NO es
    un campo de rechazo aquí.

Referencias de requisitos: 7.11, 9.1, 9.6, 4.4, 5.5, 5.6, 6.2 (además de
1.2, 1.3, 10.3, 3.2, 3.5 de la estructura original).
"""

from __future__ import annotations

import re
from typing import Dict, FrozenSet, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field

from app import config

# Tipos enumerados de posición del subtítulo (Req 7.5, 7.6).
PosicionVertical = Literal["superior", "centro", "inferior"]
PosicionHorizontal = Literal["izquierda", "centro", "derecha"]

# Tipos de transición entre clips (Paso 1, UNIR). ``ninguna`` es el corte duro
# actual; el resto se implementa con el filtro ``xfade``/``acrossfade`` de ffmpeg.
TipoTransicion = Literal[
    "ninguna",
    "disolucion",
    "fundido_negro",
    "deslizar_izq",
    "deslizar_arriba",
]

# Preset de estilo de subtítulo. ``clasico`` es la línea completa con slide-up +
# fade; ``resaltado``/``bold_pop`` activan el karaoke (resalta la palabra activa).
PresetSubtitulo = Literal["clasico", "resaltado", "bold_pop"]

# Método de corte de silencios: por umbral de dB o por detección de voz (IA/VAD).
ModoSilencio = Literal["db", "voz"]

# ---------------------------------------------------------------------------
# Constantes de la corrección de subtítulos con IA (OpenAI) y del motor de
# render (spec subtitulos-ia-remotion, tarea 1.1; Req 1.1, 14.3).
# ---------------------------------------------------------------------------
# Modelos de OpenAI admitidos para la corrección de subtítulos (validación de
# conjunto en la tarea 1.2). La clave de API NUNCA se persiste (es transitoria).
SUPPORTED_OPENAI_MODELS: FrozenSet[str] = frozenset(
    {"gpt-5.4-nano", "gpt-4.1-mini", "gpt-4.1", "gpt-4.1-nano", "gpt-4o-mini"}
)
# Modelo por defecto de la corrección con IA.
DEFAULT_OPENAI_MODEL: str = "gpt-5.4-nano"

# Motor de render del paso de subtítulos. Se ELIGE en tiempo de ejecución por el
# usuario (dos botones en el frontend); NO se decide automáticamente por un
# ajuste persistido.
MotorRender = Literal["ass", "remotion"]
# Preselección de UI por defecto (solo sugerencia visual del botón resaltado).
DEFAULT_MOTOR_RENDER: MotorRender = "ass"


class ResolucionObjetivo(BaseModel):
    """Resolución vertical de salida (Req 3.2). Rangos validados en la tarea 8."""

    ancho: int = Field(default=config.DEFAULT_RESOLUCION_ANCHO)
    alto: int = Field(default=config.DEFAULT_RESOLUCION_ALTO)


class AjustesGenerales(BaseModel):
    """Ajustes generales: resolución objetivo y fps (Req 3.2, 3.5)."""

    resolucion: ResolucionObjetivo = Field(default_factory=ResolucionObjetivo)
    fps: int = Field(default=config.DEFAULT_FPS)


class AjustesSilencios(BaseModel):
    """Ajustes del corte de silencios (Req 4, 9.2).

    ``umbral_db`` y ``margen_ms`` se expresan en unidades de la UI; su conversión
    a las unidades del motor y la validación de rangos se realizan más adelante.
    """

    activado: bool = Field(default=config.DEFAULT_SILENCIO_ACTIVADO)
    # Método: "db" (umbral de decibelios) o "voz" (detección de voz con IA/VAD).
    modo: ModoSilencio = Field(default=config.DEFAULT_SILENCIO_MODO)
    umbral_db: float = Field(default=config.DEFAULT_SILENCIO_UMBRAL_DB)
    margen_ms: int = Field(default=config.DEFAULT_SILENCIO_MARGEN_MS)


class AjustesTransiciones(BaseModel):
    """Ajustes de la transición entre clips (Paso 1, UNIR).

    Se aplica el **mismo** efecto entre todos los clips consecutivos. ``tipo``
    ``"ninguna"`` mantiene el corte duro (sin recodificar en la unión); cualquier
    otro tipo activa el motor ``xfade``/``acrossfade`` de ffmpeg con una duración
    de ``duracion_ms`` milisegundos (rango del motor validado en la tarea 8).
    """

    tipo: TipoTransicion = Field(default=config.DEFAULT_TRANSICION_TIPO)
    duracion_ms: int = Field(default=config.DEFAULT_TRANSICION_DURACION_MS)


class AjustesTranscripcion(BaseModel):
    """Ajustes de transcripción (Req 5, 9.3).

    La validación de ``idioma``/``modelo`` contra los conjuntos soportados por
    faster-whisper se implementa en la tarea 8.
    """

    idioma: str = Field(default=config.DEFAULT_IDIOMA)
    modelo: str = Field(default=config.DEFAULT_MODELO)


class AjustesSubtitulos(BaseModel):
    """Ajustes de subtítulos y su animación (Req 6, 7, 9.1).

    Los rangos numéricos se validan en la tarea 8; aquí solo se define la forma.
    """

    max_palabras: int = Field(default=config.DEFAULT_MAX_PALABRAS)
    # Si está activado, el pipeline se pausa tras la transcripción para que el
    # usuario revise/edite el texto de los subtítulos antes de quemarlos.
    revisar: bool = Field(default=config.DEFAULT_SUBTITULOS_REVISAR)
    # Si está activado, el pipeline se pausa para que el usuario revise/corrija a
    # mano los subtítulos —incluida la salida de la IA si está activada— antes de
    # continuar al render. A diferencia de ``revisar``, este flag NO se anula
    # cuando la corrección con IA está activada: permite revisar a mano lo que la
    # IA propuso antes de renderizar.
    aprobar_a_mano: bool = Field(default=False)
    # Si está activado, todo el texto de los subtítulos se muestra en minúscula.
    minusculas: bool = Field(default=config.DEFAULT_SUBTITULOS_MINUSCULAS)
    # Preset de estilo: "clasico" (línea completa) o "resaltado"/"bold_pop"
    # (karaoke, resalta la palabra activa en el color de acento).
    preset: PresetSubtitulo = Field(default=config.DEFAULT_SUBTITULOS_PRESET)
    # Color de acento (#RRGGBB) de la palabra activa en los presets de karaoke.
    color_resaltado: str = Field(default=config.DEFAULT_SUBTITULOS_COLOR_RESALTADO)
    posicion_vertical: PosicionVertical = Field(default="inferior")
    posicion_horizontal: PosicionHorizontal = Field(default="centro")
    pos_vertical_pct: float = Field(default=85.0)
    pos_horizontal_pct: float = Field(default=50.0)
    margen_px: int = Field(default=60)
    fuente: str = Field(default=config.DEFAULT_FUENTE)
    tamano: int = Field(default=config.DEFAULT_TAMANO_FUENTE)
    color: str = Field(default=config.DEFAULT_COLOR)
    color_borde: str = Field(default=config.DEFAULT_COLOR_BORDE)
    grosor_borde: int = Field(default=config.DEFAULT_GROSOR_BORDE)
    negrita: bool = Field(default=True)
    anim_entrada_ms: int = Field(default=config.DEFAULT_ANIM_ENTRADA_MS)
    anim_salida_ms: int = Field(default=config.DEFAULT_ANIM_SALIDA_MS)
    slide_px: int = Field(default=config.DEFAULT_SLIDE_PX)


class AjustesRisas(BaseModel):
    """Ajustes de la eliminación de risas (jaja/jeje/...) por transcripción.

    Cuando ``activado`` es ``True``, tras transcribir se detectan las palabras de
    risa y se recortan esos segmentos del video (con ``margen_ms`` de recorte a
    cada lado), remapeando los tiempos de las palabras restantes.
    """

    activado: bool = Field(default=config.DEFAULT_RISAS_ACTIVADO)
    margen_ms: int = Field(default=config.DEFAULT_RISAS_MARGEN_MS)


class AjustesMusica(BaseModel):
    """Ajustes de la música de fondo y el ducking (Req 8)."""

    volumen_base_pct: int = Field(default=config.DEFAULT_VOLUMEN_MUSICA_PCT)
    reduccion_db: float = Field(default=config.DEFAULT_REDUCCION_DB)
    umbral_voz_dbfs: float = Field(default=config.DEFAULT_UMBRAL_VOZ_DBFS)
    ataque_ms: int = Field(default=config.DEFAULT_ATAQUE_MS)
    liberacion_ms: int = Field(default=config.DEFAULT_LIBERACION_MS)


class AjustesRevisionIA(BaseModel):
    """Ajustes de la verificación/corrección de subtítulos con IA (opt-in).

    Es la primera dependencia de red externa del sistema, por eso está
    desactivada por defecto (Req 1.1). La clave de API NO se declara aquí: es
    transitoria y no debe persistirse nunca en disco (Req 2.3, 14.3). Los rangos
    de ``timeout_s``/``max_reintentos`` y el conjunto de ``modelo`` se validan en
    la tarea 1.2.
    """

    activado: bool = Field(default=False)  # OPT-IN: desactivado por defecto
    modelo: str = Field(default=DEFAULT_OPENAI_MODEL)
    # Timeout (segundos) de la llamada a OpenAI y número de reintentos ante 429.
    timeout_s: float = Field(default=20.0)
    max_reintentos: int = Field(default=1)


class AjustesRender(BaseModel):
    """Ajustes del render de subtítulos (Paso 4c).

    NOTA: NO existe ``fallback_ass``. El motor NO se decide automáticamente desde
    aquí: la elección efectiva la hace el usuario en tiempo de ejecución con los
    dos botones del frontend. ``motor_preferido`` es SOLO una preselección de UI
    (qué botón aparece resaltado); no fuerza la ejecución.
    """

    motor_preferido: MotorRender = Field(default=DEFAULT_MOTOR_RENDER)  # solo UI
    combine_tokens_ms: int = Field(default=1200)  # agrupación estilo TikTok


class Ajustes(BaseModel):
    """Conjunto completo de ajustes enviado en `POST /procesar`.

    La música es opcional: si no se proporciona un WAV válido, el paso 5 se omite.
    """

    generales: AjustesGenerales = Field(default_factory=AjustesGenerales)
    silencios: AjustesSilencios = Field(default_factory=AjustesSilencios)
    transiciones: AjustesTransiciones = Field(default_factory=AjustesTransiciones)
    risas: AjustesRisas = Field(default_factory=AjustesRisas)
    transcripcion: AjustesTranscripcion = Field(default_factory=AjustesTranscripcion)
    subtitulos: AjustesSubtitulos = Field(default_factory=AjustesSubtitulos)
    musica: Optional[AjustesMusica] = Field(default=None)
    # Nuevas capacidades (spec subtitulos-ia-remotion): corrección con IA
    # (opt-in) y ajustes del motor de render. Se añaden con default_factory para
    # mantener compatibilidad hacia atrás con configuraciones ya persistidas.
    revision_ia: AjustesRevisionIA = Field(default_factory=AjustesRevisionIA)
    render: AjustesRender = Field(default_factory=AjustesRender)


# ---------------------------------------------------------------------------
# Modelos de subtítulos derivados de la transcripción (Req 5.1, 6.4)
# ---------------------------------------------------------------------------
class Palabra(BaseModel):
    """Palabra transcrita con timestamps por palabra (Req 5.1).

    ``inicio_s``/``fin_s`` pueden ser ``None`` cuando faltan timestamps válidos;
    el tratamiento robusto se implementa en la agrupación (tarea 4, Req 6.5).
    """

    texto: str
    inicio_s: Optional[float] = Field(default=None)
    fin_s: Optional[float] = Field(default=None)


class GrupoSubtitulo(BaseModel):
    """Grupo de palabras mostrado como una línea de subtítulo (Req 6.4).

    ``palabras`` conserva (cuando está disponible) las palabras del grupo con sus
    timestamps individuales, necesarias para el resaltado palabra por palabra
    (karaoke). Es opcional: los grupos editados a mano en la revisión pueden no
    incluirlas, en cuyo caso el karaoke reparte el tiempo del grupo por igual.
    """

    texto: str
    inicio_s: float
    fin_s: float
    palabras: Optional[List[Palabra]] = Field(default=None)


# ===========================================================================
# EDICIÓN AVANZADA DE SHORTS — Tramos de silencio y textos extra (Req 1, 13, 15)
# ===========================================================================
class TramoSilencio(BaseModel):
    """Tramo ``[inicio_s, fin_s]`` (en segundos) marcado para BORRAR del vídeo
    unido en el timeline de silencios (Req 1, 5, 15).

    Los modelos son permisivos en construcción (igual que el resto de ajustes):
    ``inicio_s``/``fin_s`` sólo se restringen a ``>= 0`` en el propio campo; la
    invariante temporal completa (``0 <= inicio < fin <= duración``) se comprueba
    con :func:`validar_tramos_silencio`, que conoce la duración del vídeo.
    """

    inicio_s: float = Field(ge=0.0)
    fin_s: float = Field(ge=0.0)


class EstiloTextoExtra(BaseModel):
    """Estilo de un texto extra tipo "hook", INDEPENDIENTE del de los subtítulos
    aunque comparte los mismos tipos de campo (Req 9.4, 13, 15).

    Los valores por defecto siguen el diseño §4.1. Los rangos del motor se
    validan con :func:`validar_texto_extra` reutilizando los límites de
    subtítulos declarados en :data:`RANGOS_MOTOR`.
    """

    fuente: str = Field(default=config.DEFAULT_FUENTE)
    tamano: int = Field(default=64)              # rango motor 12..200
    color: str = Field(default="#FFFFFF")        # #RRGGBB
    color_borde: str = Field(default="#000000")  # #RRGGBB
    grosor_borde: int = Field(default=6)         # rango motor 0..20
    negrita: bool = Field(default=True)
    pos_vertical_pct: float = Field(default=20.0)    # 0..100 % de la altura
    pos_horizontal_pct: float = Field(default=50.0)  # 0..100 % del ancho


class TextoExtra(BaseModel):
    """Overlay de texto plano SIN animación aplicado al vídeo final (Req 9, 10).

    Se muestra únicamente en el intervalo ``[inicio_s, fin_s)`` sobre el vídeo ya
    recortado/producido. Su rango temporal y su estilo se validan con
    :func:`validar_texto_extra` (rango temporal + rangos de estilo del motor).
    """

    texto: str
    inicio_s: float = Field(ge=0.0)
    fin_s: float = Field(ge=0.0)
    estilo: EstiloTextoExtra = Field(default_factory=EstiloTextoExtra)


# ===========================================================================
# TAREA 8 — Validación de rangos del motor y de idioma/modelo (Req 7.11, 9.1,
# 9.6, 4.4, 5.5, 5.6, 6.2)
# ===========================================================================

# ---------------------------------------------------------------------------
# Conjuntos soportados por faster-whisper (validación previa a transcribir,
# Req 5.5, 5.6). El rechazo ocurre ANTES de iniciar la transcripción.
# ---------------------------------------------------------------------------
# Valor especial de idioma que activa la detección automática (Req 5.2, 5.4).
IDIOMA_AUTO: str = "auto"

# Modelos soportados por faster-whisper (incluye variantes .en y destiladas).
SUPPORTED_WHISPER_MODELS: FrozenSet[str] = frozenset(
    {
        "tiny",
        "tiny.en",
        "base",
        "base.en",
        "small",
        "small.en",
        "medium",
        "medium.en",
        "large-v1",
        "large-v2",
        "large-v3",
        "large",
        "large-v3-turbo",
        "turbo",
        "distil-small.en",
        "distil-medium.en",
        "distil-large-v2",
        "distil-large-v3",
    }
)

# Idiomas soportados por Whisper/faster-whisper (códigos ISO 639-1/2). El valor
# "auto" se admite adicionalmente para la detección automática (Req 5.4).
SUPPORTED_WHISPER_LANGUAGES: FrozenSet[str] = frozenset(
    {
        "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca",
        "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms",
        "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la",
        "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
        "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
        "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be",
        "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn",
        "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha",
        "ba", "jw", "su", "yue",
    }
)


def idioma_valido(idioma: str) -> bool:
    """Indica si ``idioma`` es "auto" o pertenece al conjunto soportado (Req 5.5)."""
    return idioma == IDIOMA_AUTO or idioma in SUPPORTED_WHISPER_LANGUAGES


def modelo_valido(modelo: str) -> bool:
    """Indica si ``modelo`` pertenece a los modelos soportados (Req 5.6)."""
    return modelo in SUPPORTED_WHISPER_MODELS


# ---------------------------------------------------------------------------
# Formato de color de subtítulo: `#RRGGBB` (Req 7.8). Se convierte a ASS más
# adelante; aquí solo se valida la forma.
# ---------------------------------------------------------------------------
_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")


def color_valido(color: str) -> bool:
    """Indica si ``color`` tiene la forma hexadecimal `#RRGGBB` (Req 7.8)."""
    return bool(_HEX_COLOR_RE.match(color))


# ---------------------------------------------------------------------------
# Rangos del motor por campo (mínimo, máximo, ambos inclusivos). Fuente única de
# verdad usada tanto por :func:`validar_ajustes` como por los tests. Cada rango
# documenta la política de reconciliación UI↔motor del diseño.
# ---------------------------------------------------------------------------
# Cada entrada mapea la ruta con puntos del campo a (mínimo, máximo).
RANGOS_MOTOR: Dict[str, Tuple[float, float]] = {
    # Generales — Resolución objetivo 2..7680 px por eje (Req 3.2).
    "generales.resolucion.ancho": (2, 7680),
    "generales.resolucion.alto": (2, 7680),
    # Cuadros por segundo objetivo 1..120 (Req 3.5).
    "generales.fps": (1, 120),
    # Silencios — unidades de UI (se convierten en util/units.py):
    #   umbral -60..0 dB, margen 0..5000 ms (Req 9.2, 4.4).
    "silencios.umbral_db": (-60.0, 0.0),
    "silencios.margen_ms": (0, 5000),
    # Transiciones — duración del efecto entre clips (ms). El tipo se valida por
    # el Literal ``TipoTransicion``; solo la duración tiene rango numérico.
    "transiciones.duracion_ms": (
        config.TRANSICION_DURACION_MS_MIN,
        config.TRANSICION_DURACION_MS_MAX,
    ),
    # Risas — margen (ms) de recorte a cada lado del segmento de risa.
    "risas.margen_ms": (
        config.RISAS_MARGEN_MS_MIN,
        config.RISAS_MARGEN_MS_MAX,
    ),
    # Subtítulos — rangos del motor (Req 7.x); más estrictos que la UI (Req 9.1).
    "subtitulos.pos_vertical_pct": (0.0, 100.0),   # 0..100 % de la altura (Req 9.1)
    "subtitulos.pos_horizontal_pct": (0.0, 100.0),  # 0..100 % del ancho (Req 9.1)
    "subtitulos.margen_px": (0, 500),               # 0..500 px (Req 7.7)
    "subtitulos.tamano": (12, 200),                 # motor 12..200 pt (Req 7.8)
    "subtitulos.grosor_borde": (0, 20),             # motor 0..20 px (Req 7.8)
    "subtitulos.anim_entrada_ms": (100, 2000),      # motor 100..2000 ms (Req 7.3)
    "subtitulos.anim_salida_ms": (100, 2000),       # motor 100..2000 ms (Req 7.3)
    "subtitulos.slide_px": (1, 500),                # motor 1..500 px (Req 7.4)
    # Música / ducking (Req 8.4, 8.5, 8.6).
    "musica.volumen_base_pct": (0, 100),            # 0..100 % (Req 8.4)
    "musica.reduccion_db": (12.0, 60.0),            # >= 12 dB de reducción (Req 8.5)
    "musica.umbral_voz_dbfs": (-60.0, 0.0),         # umbral de voz en dBFS (Req 8.5)
    "musica.ataque_ms": (0, 250),                   # <= 250 ms de ataque (Req 8.5)
    "musica.liberacion_ms": (0, 500),               # <= 500 ms de liberación (Req 8.6)
    # Corrección con IA / motor de render (spec subtitulos-ia-remotion).
    # Timeout de la llamada a OpenAI 1..120 s (Req 11.2) y reintentos 0..5 ante
    # 429 (Req 11.3). ``combine_tokens_ms`` es la ventana de agrupación estilo
    # TikTok del motor Remotion 0..5000 ms (Req 11.4). Estos campos SIEMPRE se
    # validan (no dependen de ``revision_ia.activado``): un valor fuera de rango
    # es un error de ajustes independientemente de si la IA se usará.
    "revision_ia.timeout_s": (1.0, 120.0),          # 1..120 s (Req 11.2)
    "revision_ia.max_reintentos": (0, 5),           # 0..5 reintentos (Req 11.3)
    "render.combine_tokens_ms": (0, 5000),          # 0..5000 ms (Req 11.4)
}

# Rangos de estilo de los textos extra (Req 13, 15.5). Se REUTILIZAN los límites
# del motor ya definidos para los subtítulos (misma semántica de campo) como
# fuente única de verdad, evitando duplicar números mágicos. Estas rutas usan el
# prefijo ``texto_extra.`` y NO son campos de :class:`Ajustes`; por eso
# :func:`validar_ajustes` las omite (ver el guard del prefijo) y sólo las
# consume :func:`validar_texto_extra`.
RANGOS_MOTOR.update(
    {
        "texto_extra.estilo.tamano": RANGOS_MOTOR["subtitulos.tamano"],
        "texto_extra.estilo.grosor_borde": RANGOS_MOTOR["subtitulos.grosor_borde"],
        "texto_extra.estilo.pos_vertical_pct": RANGOS_MOTOR[
            "subtitulos.pos_vertical_pct"
        ],
        "texto_extra.estilo.pos_horizontal_pct": RANGOS_MOTOR[
            "subtitulos.pos_horizontal_pct"
        ],
    }
)

# Campos con conjunto/formato permitido (no numéricos por rango). Se validan de
# forma explícita en :func:`validar_ajustes`.
CAMPOS_CONJUNTO: Tuple[str, ...] = (
    "transcripcion.idioma",   # "auto" o idioma soportado (Req 5.5)
    "transcripcion.modelo",   # modelo soportado por faster-whisper (Req 5.6)
    "subtitulos.color",       # #RRGGBB (Req 7.8)
    "subtitulos.color_borde",  # #RRGGBB (Req 7.8)
)


def obtener_por_ruta(ajustes: "Ajustes", ruta: str):
    """Devuelve el valor de un campo anidado a partir de su ruta con puntos.

    Ejemplo: ``obtener_por_ruta(ajustes, "generales.resolucion.ancho")``.
    """
    actual: object = ajustes
    for parte in ruta.split("."):
        actual = getattr(actual, parte)
    return actual


class AjustesInvalidosError(ValueError):
    """Error de validación que identifica por nombre los campos fuera de rango."""

    def __init__(self, campos_invalidos: List[str]) -> None:
        self.campos_invalidos = list(campos_invalidos)
        super().__init__(
            "Ajustes inválidos; campos fuera de rango o de conjunto permitido: "
            + ", ".join(self.campos_invalidos)
        )


def validar_ajustes(ajustes: "Ajustes") -> List[str]:
    """Valida los ajustes contra los rangos del motor y los conjuntos permitidos.

    Devuelve la lista (posiblemente vacía) de rutas de campo inválidas. El
    conjunto de ajustes se **acepta si y solo si** la lista devuelta está vacía,
    es decir, si y solo si todos los campos están dentro de su rango/conjunto
    permitido (Propiedad 20; Req 7.11, 9.1, 9.6, 5.5, 5.6, 4.4).

    Nota de política (Req 6.2): ``subtitulos.max_palabras`` NO se incluye como
    campo de rechazo; los valores fuera de ``1..10`` se corrigen con el valor por
    defecto ``4`` en :func:`app.engine.grouping.tamano_efectivo`.

    Si ``ajustes.musica`` es ``None`` (sin música), los campos de música se
    omiten de la validación (el paso 5 se omitirá en el pipeline).
    """
    invalidos: List[str] = []

    for ruta, (minimo, maximo) in RANGOS_MOTOR.items():
        # Los rangos de estilo de textos extra NO son campos de ``Ajustes``: son
        # límites reutilizados por :func:`validar_texto_extra` y se omiten aquí.
        if ruta.startswith("texto_extra."):
            continue
        # Los campos de música solo se validan cuando hay ajustes de música.
        if ruta.startswith("musica.") and ajustes.musica is None:
            continue
        valor = obtener_por_ruta(ajustes, ruta)
        # Un valor no numérico (o booleano, que no es un número válido aquí) es
        # inválido; de lo contrario se comprueba la inclusión en el rango.
        if isinstance(valor, bool) or not isinstance(valor, (int, float)):
            invalidos.append(ruta)
        elif not (minimo <= valor <= maximo):
            invalidos.append(ruta)

    # Idioma / modelo (Req 5.5, 5.6): rechazo antes de transcribir.
    if not idioma_valido(ajustes.transcripcion.idioma):
        invalidos.append("transcripcion.idioma")
    if not modelo_valido(ajustes.transcripcion.modelo):
        invalidos.append("transcripcion.modelo")

    # Colores de subtítulo (Req 7.8): forma `#RRGGBB`.
    if not color_valido(ajustes.subtitulos.color):
        invalidos.append("subtitulos.color")
    if not color_valido(ajustes.subtitulos.color_borde):
        invalidos.append("subtitulos.color_borde")
    if not color_valido(ajustes.subtitulos.color_resaltado):
        invalidos.append("subtitulos.color_resaltado")

    # Corrección con IA (Req 11.1): solo cuando está activada se exige que el
    # modelo pertenezca al conjunto soportado por OpenAI. Con la IA desactivada
    # el modelo es irrelevante y no se rechaza.
    if (
        ajustes.revision_ia.activado
        and ajustes.revision_ia.modelo not in SUPPORTED_OPENAI_MODELS
    ):
        invalidos.append("revision_ia.modelo")

    return invalidos


def ajustes_validos(ajustes: "Ajustes") -> bool:
    """Devuelve ``True`` si y solo si todos los campos están en rango (Propiedad 20)."""
    return not validar_ajustes(ajustes)


def asegurar_ajustes_validos(ajustes: "Ajustes") -> "Ajustes":
    """Devuelve ``ajustes`` si son válidos; si no, lanza :class:`AjustesInvalidosError`.

    Punto de entrada conveniente para el rechazo temprano en la capa API
    (`POST /procesar`) y antes de quemar subtítulos/transcribir (Req 7.11, 5.5,
    5.6). El error identifica por nombre cada campo inválido (Req 9.6).
    """
    invalidos = validar_ajustes(ajustes)
    if invalidos:
        raise AjustesInvalidosError(invalidos)
    return ajustes


# ===========================================================================
# EDICIÓN AVANZADA DE SHORTS — Validadores de tramos de silencio y textos extra
# (Req 5, 15; diseño §6.1 y §7.3)
# ===========================================================================
def _en_rango_motor(ruta: str, valor: float) -> bool:
    """Indica si ``valor`` es numérico y está dentro del rango del motor de
    ``ruta`` en :data:`RANGOS_MOTOR` (rangos inclusivos).

    Un booleano NO se considera numérico válido (coherente con
    :func:`validar_ajustes`).
    """
    minimo, maximo = RANGOS_MOTOR[ruta]
    if isinstance(valor, bool) or not isinstance(valor, (int, float)):
        return False
    return minimo <= valor <= maximo


def validar_tramos_silencio(
    tramos: List[TramoSilencio], duracion_s: float
) -> List[str]:
    """Valida una lista de tramos de silencio contra la duración del vídeo unido.

    Un tramo es válido si y solo si cumple ``0 <= inicio_s < fin_s <= duracion_s``
    (Req 5.1, 15.1, 15.2). Devuelve la lista (posiblemente vacía) de
    identificadores de los tramos inválidos con el formato ``"tramos[i]"``, donde
    ``i`` es el índice del tramo dentro de ``tramos``. La lista está vacía si y
    solo si todos los tramos son válidos.

    :param tramos: tramos ``[inicio_s, fin_s]`` marcados para borrar.
    :param duracion_s: duración total del vídeo unido en segundos.
    :returns: lista de identificadores de tramos inválidos (vacía si todos válidos).
    """
    invalidos: List[str] = []
    for i, tramo in enumerate(tramos):
        if not (0.0 <= tramo.inicio_s < tramo.fin_s <= duracion_s):
            invalidos.append(f"tramos[{i}]")
    return invalidos


def validar_texto_extra(t: TextoExtra, duracion_s: float) -> List[str]:
    """Valida un texto extra: rango temporal + rangos de estilo (diseño §7.3).

    Devuelve la lista (posiblemente vacía) de rutas de campo inválidas. La lista
    está **vacía si y solo si** (bicondicional, Propiedad 8 / Req 15.4, 15.5):

    * el rango temporal cumple ``0 <= inicio_s < fin_s <= duracion_s``; y
    * cada campo de estilo está dentro de su rango del motor: ``tamano`` 12..200,
      ``grosor_borde`` 0..20, ``pos_vertical_pct`` y ``pos_horizontal_pct``
      0..100 (rangos reutilizados de subtítulos en :data:`RANGOS_MOTOR`); y
    * ``color`` y ``color_borde`` tienen el formato exacto ``#RRGGBB``.

    :param t: texto extra a validar.
    :param duracion_s: duración total del vídeo cortado en segundos.
    :returns: rutas de campo inválidas (vacía si el texto extra es válido).
    """
    invalidos: List[str] = []

    # Rango temporal (Req 15.4). Cualquier violación (incluido NaN, que hace
    # falsa la comparación encadenada) marca "rango_temporal".
    if not (0.0 <= t.inicio_s < t.fin_s <= duracion_s):
        invalidos.append("rango_temporal")

    # Rangos de estilo del motor (Req 15.5), reutilizando RANGOS_MOTOR.
    if not _en_rango_motor("texto_extra.estilo.tamano", t.estilo.tamano):
        invalidos.append("estilo.tamano")
    if not _en_rango_motor("texto_extra.estilo.grosor_borde", t.estilo.grosor_borde):
        invalidos.append("estilo.grosor_borde")
    if not _en_rango_motor(
        "texto_extra.estilo.pos_vertical_pct", t.estilo.pos_vertical_pct
    ):
        invalidos.append("estilo.pos_vertical_pct")
    if not _en_rango_motor(
        "texto_extra.estilo.pos_horizontal_pct", t.estilo.pos_horizontal_pct
    ):
        invalidos.append("estilo.pos_horizontal_pct")

    # Colores en formato exacto `#RRGGBB` (Req 15.5).
    if not color_valido(t.estilo.color):
        invalidos.append("estilo.color")
    if not color_valido(t.estilo.color_borde):
        invalidos.append("estilo.color_borde")

    return invalidos


__all__: List[str] = [
    "PosicionVertical",
    "PosicionHorizontal",
    "ResolucionObjetivo",
    "AjustesGenerales",
    "AjustesSilencios",
    "AjustesTransiciones",
    "TipoTransicion",
    "PresetSubtitulo",
    "ModoSilencio",
    "AjustesRisas",
    "AjustesTranscripcion",
    "AjustesSubtitulos",
    "AjustesMusica",
    "AjustesRevisionIA",
    "AjustesRender",
    "Ajustes",
    "Palabra",
    "GrupoSubtitulo",
    # Edición avanzada de shorts (tramos de silencio y textos extra)
    "TramoSilencio",
    "EstiloTextoExtra",
    "TextoExtra",
    "validar_tramos_silencio",
    "validar_texto_extra",
    # Constantes IA / motor de render (spec subtitulos-ia-remotion)
    "SUPPORTED_OPENAI_MODELS",
    "DEFAULT_OPENAI_MODEL",
    "MotorRender",
    "DEFAULT_MOTOR_RENDER",
    # Validación (Tarea 8)
    "IDIOMA_AUTO",
    "SUPPORTED_WHISPER_MODELS",
    "SUPPORTED_WHISPER_LANGUAGES",
    "RANGOS_MOTOR",
    "CAMPOS_CONJUNTO",
    "idioma_valido",
    "modelo_valido",
    "color_valido",
    "obtener_por_ruta",
    "validar_ajustes",
    "ajustes_validos",
    "asegurar_ajustes_validos",
    "AjustesInvalidosError",
]
