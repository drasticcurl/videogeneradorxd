"""Tests de la validación de ajustes de configuración (Tarea 8, Req 7.11, 9.1,
9.6, 4.4, 5.5, 5.6, 6.2).

Contiene:

* La **Propiedad 20** (property-based, Hypothesis, >= 100 iteraciones): la
  validación acepta un conjunto de ajustes si y solo si todos sus campos están
  dentro de sus rangos/conjuntos permitidos, y el rechazo identifica el/los
  campo(s) inválido(s).
* Tests unitarios de apoyo (defaults válidos, detección de campo concreto,
  idioma/modelo/color, y la política de fallback de ``max_palabras``).

Cada test property-based se etiqueta con el formato del diseño.
"""

from __future__ import annotations

from typing import List, Set, Tuple

from hypothesis import given, settings
from hypothesis import strategies as st

from app.models.settings import (
    Ajustes,
    AjustesMusica,
    RANGOS_MOTOR,
    SUPPORTED_WHISPER_LANGUAGES,
    SUPPORTED_WHISPER_MODELS,
    ajustes_validos,
    asegurar_ajustes_validos,
    AjustesInvalidosError,
    obtener_por_ruta,
    validar_ajustes,
)

# Mínimo 100 iteraciones por propiedad (aquí 200).
PBT_SETTINGS = settings(max_examples=200, deadline=None)

# Campos numéricos de tipo entero (el resto de RANGOS_MOTOR son flotantes).
CAMPOS_ENTEROS: Set[str] = {
    "generales.resolucion.ancho",
    "generales.resolucion.alto",
    "generales.fps",
    "silencios.margen_ms",
    "subtitulos.margen_px",
    "subtitulos.tamano",
    "subtitulos.grosor_borde",
    "subtitulos.anim_entrada_ms",
    "subtitulos.anim_salida_ms",
    "subtitulos.slide_px",
    "musica.volumen_base_pct",
    "musica.ataque_ms",
    "musica.liberacion_ms",
}


def _set_por_ruta(ajustes: Ajustes, ruta: str, valor: object) -> None:
    """Asigna un valor a un campo anidado a partir de su ruta con puntos."""
    partes = ruta.split(".")
    obj: object = ajustes
    for parte in partes[:-1]:
        obj = getattr(obj, parte)
    setattr(obj, partes[-1], valor)


# ---------------------------------------------------------------------------
# Generadores inteligentes que producen valores dentro y fuera de rango,
# registrando qué campos se hicieron inválidos.
# ---------------------------------------------------------------------------
def _valor_valido(ruta: str, minimo: float, maximo: float) -> st.SearchStrategy:
    if ruta in CAMPOS_ENTEROS:
        return st.integers(min_value=int(minimo), max_value=int(maximo))
    return st.floats(
        min_value=float(minimo),
        max_value=float(maximo),
        allow_nan=False,
        allow_infinity=False,
    )


def _valor_invalido(ruta: str, minimo: float, maximo: float) -> st.SearchStrategy:
    """Genera un valor estrictamente fuera del rango inclusivo [min, max]."""
    if ruta in CAMPOS_ENTEROS:
        por_debajo = st.integers(min_value=int(minimo) - 200, max_value=int(minimo) - 1)
        por_encima = st.integers(min_value=int(maximo) + 1, max_value=int(maximo) + 200)
    else:
        por_debajo = st.floats(
            min_value=float(minimo) - 200.0,
            max_value=float(minimo) - 0.5,
            allow_nan=False,
            allow_infinity=False,
        )
        por_encima = st.floats(
            min_value=float(maximo) + 0.5,
            max_value=float(maximo) + 200.0,
            allow_nan=False,
            allow_infinity=False,
        )
    return st.one_of(por_debajo, por_encima)


_IDIOMAS_INVALIDOS = st.sampled_from(["xx", "zzz", "klingon", "", "e s", "123"])
_MODELOS_INVALIDOS = st.sampled_from(
    ["gigantic", "huge", "small.fr", "", "modelo-inexistente"]
)
_COLORES_INVALIDOS = st.sampled_from(["red", "#FFF", "FFFFFF", "#GGGGGG", "#1234567", ""])


@st.composite
def ajustes_con_marcas(draw: st.DrawFn) -> Tuple[Ajustes, Set[str]]:
    """Construye unos ``Ajustes`` marcando aleatoriamente campos como inválidos.

    Parte de los valores por defecto (todos válidos, incluida la música) y, para
    cada campo validado, decide con probabilidad ~1/3 hacerlo inválido. Devuelve
    los ajustes junto con el conjunto exacto de rutas que se hicieron inválidas,
    que debe coincidir con lo reportado por :func:`validar_ajustes`.
    """
    # Los defaults son todos válidos; se incluye música para ejercitar sus campos.
    ajustes = Ajustes(musica=AjustesMusica())
    invalidos: Set[str] = set()

    for ruta, (minimo, maximo) in RANGOS_MOTOR.items():
        # Los rangos de estilo de textos extra no son campos de ``Ajustes``.
        if ruta.startswith("texto_extra."):
            continue
        hacer_invalido = draw(st.booleans() | st.just(False))  # sesgo hacia válido
        if hacer_invalido:
            valor = draw(_valor_invalido(ruta, minimo, maximo))
            invalidos.add(ruta)
        else:
            valor = draw(_valor_valido(ruta, minimo, maximo))
        _set_por_ruta(ajustes, ruta, valor)

    # Idioma
    if draw(st.booleans() | st.just(False)):
        _set_por_ruta(ajustes, "transcripcion.idioma", draw(_IDIOMAS_INVALIDOS))
        invalidos.add("transcripcion.idioma")
    else:
        idioma = draw(st.sampled_from(sorted(SUPPORTED_WHISPER_LANGUAGES) + ["auto"]))
        _set_por_ruta(ajustes, "transcripcion.idioma", idioma)

    # Modelo
    if draw(st.booleans() | st.just(False)):
        _set_por_ruta(ajustes, "transcripcion.modelo", draw(_MODELOS_INVALIDOS))
        invalidos.add("transcripcion.modelo")
    else:
        modelo = draw(st.sampled_from(sorted(SUPPORTED_WHISPER_MODELS)))
        _set_por_ruta(ajustes, "transcripcion.modelo", modelo)

    # Colores de subtítulo
    for ruta_color in ("subtitulos.color", "subtitulos.color_borde"):
        if draw(st.booleans() | st.just(False)):
            _set_por_ruta(ajustes, ruta_color, draw(_COLORES_INVALIDOS))
            invalidos.add(ruta_color)
        else:
            _set_por_ruta(ajustes, ruta_color, "#1A2B3C")

    return ajustes, invalidos


# ---------------------------------------------------------------------------
# Propiedad 20: Validación de ajustes (aceptado si y solo si todos los campos
# están en rango)
# Feature: vertical-shorts-editor, Property 20
# Validates: Requirements 7.11, 9.1, 9.6
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(caso=ajustes_con_marcas())
def test_propiedad_20_validacion_iff_rangos(caso: Tuple[Ajustes, Set[str]]) -> None:
    """La validación acepta si y solo si todos los campos están en rango, y el
    rechazo identifica exactamente los campos inválidos."""
    ajustes, esperados_invalidos = caso

    reportados = validar_ajustes(ajustes)

    # El rechazo identifica exactamente el/los campo(s) inválido(s).
    assert set(reportados) == esperados_invalidos
    # Sin duplicados en el reporte.
    assert len(reportados) == len(set(reportados))

    # Aceptado (válido) si y solo si no hay ningún campo fuera de rango.
    assert ajustes_validos(ajustes) == (len(esperados_invalidos) == 0)

    if esperados_invalidos:
        # asegurar_ajustes_validos lanza e identifica por nombre los campos.
        try:
            asegurar_ajustes_validos(ajustes)
            raise AssertionError("Se esperaba AjustesInvalidosError")
        except AjustesInvalidosError as exc:
            assert set(exc.campos_invalidos) == esperados_invalidos
    else:
        # No lanza y devuelve el mismo objeto de ajustes.
        assert asegurar_ajustes_validos(ajustes) is ajustes


# ---------------------------------------------------------------------------
# Política de fallback de max_palabras (Req 6.2): nunca es motivo de rechazo.
# Feature: vertical-shorts-editor, Property 20 (política asociada, Req 6.2)
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(max_palabras=st.integers(min_value=-50, max_value=50))
def test_max_palabras_nunca_causa_rechazo(max_palabras: int) -> None:
    """``max_palabras`` fuera de 1..10 se corrige por fallback (Req 6.2) y por
    tanto nunca aparece como campo inválido en la validación de ajustes."""
    ajustes = Ajustes(musica=AjustesMusica())
    ajustes.subtitulos.max_palabras = max_palabras

    invalidos = validar_ajustes(ajustes)
    assert "subtitulos.max_palabras" not in invalidos
    # Con el resto de defaults válidos, los ajustes se aceptan.
    assert ajustes_validos(ajustes)


# ---------------------------------------------------------------------------
# Tests unitarios de apoyo
# ---------------------------------------------------------------------------
def test_defaults_son_validos() -> None:
    """Los ajustes por defecto (con y sin música) están todos en rango."""
    assert validar_ajustes(Ajustes()) == []
    assert validar_ajustes(Ajustes(musica=AjustesMusica())) == []


def test_identifica_campo_fuera_de_rango() -> None:
    """Un tamaño de fuente fuera del rango del motor (12..200) se identifica."""
    ajustes = Ajustes()
    ajustes.subtitulos.tamano = 5  # < 12
    invalidos = validar_ajustes(ajustes)
    assert invalidos == ["subtitulos.tamano"]


def test_varios_campos_invalidos_se_reportan_todos() -> None:
    ajustes = Ajustes(musica=AjustesMusica())
    ajustes.generales.fps = 0  # < 1
    ajustes.subtitulos.slide_px = 0  # < 1
    ajustes.musica.reduccion_db = 5.0  # < 12
    invalidos = set(validar_ajustes(ajustes))
    assert invalidos == {"generales.fps", "subtitulos.slide_px", "musica.reduccion_db"}


def test_idioma_auto_es_valido() -> None:
    ajustes = Ajustes()
    ajustes.transcripcion.idioma = "auto"
    assert "transcripcion.idioma" not in validar_ajustes(ajustes)


def test_idioma_no_soportado_se_rechaza() -> None:
    ajustes = Ajustes()
    ajustes.transcripcion.idioma = "klingon"
    assert "transcripcion.idioma" in validar_ajustes(ajustes)


def test_modelo_no_soportado_se_rechaza() -> None:
    ajustes = Ajustes()
    ajustes.transcripcion.modelo = "gigantic"
    assert "transcripcion.modelo" in validar_ajustes(ajustes)


def test_color_no_hex_se_rechaza() -> None:
    ajustes = Ajustes()
    ajustes.subtitulos.color = "rojo"
    assert "subtitulos.color" in validar_ajustes(ajustes)


def test_musica_none_omite_campos_de_musica() -> None:
    """Sin música, los campos de música no se validan (paso 5 se omite)."""
    ajustes = Ajustes(musica=None)
    assert validar_ajustes(ajustes) == []


def test_obtener_por_ruta_navega_anidado() -> None:
    ajustes = Ajustes()
    assert obtener_por_ruta(ajustes, "generales.resolucion.ancho") == ajustes.generales.resolucion.ancho
    assert obtener_por_ruta(ajustes, "subtitulos.tamano") == ajustes.subtitulos.tamano
