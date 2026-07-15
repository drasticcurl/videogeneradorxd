"""Prueba basada en propiedades del round-trip de serialización de ``Ajustes``
(spec subtitulos-ia-remotion, tarea 1.3).

Contiene:

* **Property 15: Serialización round-trip** (property-based, Hypothesis,
  >= 100 iteraciones): para todo ``Ajustes`` válido (incluyendo variaciones de
  ``revision_ia`` y ``render``), serializar y deserializar produce un ``Ajustes``
  equivalente al original y la representación intermedia es JSON válido.
* Tests unitarios de apoyo (defaults, activado con modelos soportados, música
  presente/ausente).

El round-trip se ejerce con el MISMO mecanismo que usa el almacén de
configuración (``storage/config_store.py``): ``json.dumps(ajustes.model_dump())``
para serializar y ``Ajustes.model_validate(json.loads(...))`` para deserializar.

Feature: subtitulos-ia-remotion, Property 15: Serialización round-trip
Validates: Requirements 15.1, 15.2
"""

from __future__ import annotations

import json
from typing import Set

from hypothesis import given, settings
from hypothesis import strategies as st

from app.models.settings import (
    Ajustes,
    AjustesMusica,
    RANGOS_MOTOR,
    SUPPORTED_OPENAI_MODELS,
    SUPPORTED_WHISPER_LANGUAGES,
    SUPPORTED_WHISPER_MODELS,
    ajustes_validos,
)

# Mínimo 100 iteraciones por propiedad (aquí 200).
PBT_ROUNDTRIP = settings(max_examples=200, deadline=None)

# Campos numéricos de tipo entero (el resto de RANGOS_MOTOR son flotantes).
CAMPOS_ENTEROS: Set[str] = {
    "generales.resolucion.ancho",
    "generales.resolucion.alto",
    "generales.fps",
    "silencios.margen_ms",
    "transiciones.duracion_ms",
    "risas.margen_ms",
    "subtitulos.margen_px",
    "subtitulos.tamano",
    "subtitulos.grosor_borde",
    "subtitulos.anim_entrada_ms",
    "subtitulos.anim_salida_ms",
    "subtitulos.slide_px",
    "musica.volumen_base_pct",
    "musica.ataque_ms",
    "musica.liberacion_ms",
    "revision_ia.max_reintentos",
    "render.combine_tokens_ms",
}


def _set_por_ruta(ajustes: Ajustes, ruta: str, valor: object) -> None:
    """Asigna un valor a un campo anidado a partir de su ruta con puntos."""
    partes = ruta.split(".")
    obj: object = ajustes
    for parte in partes[:-1]:
        obj = getattr(obj, parte)
    setattr(obj, partes[-1], valor)


def _valor_valido(ruta: str, minimo: float, maximo: float) -> st.SearchStrategy:
    """Genera un valor dentro del rango inclusivo [min, max] del campo."""
    if ruta in CAMPOS_ENTEROS:
        return st.integers(min_value=int(minimo), max_value=int(maximo))
    return st.floats(
        min_value=float(minimo),
        max_value=float(maximo),
        allow_nan=False,
        allow_infinity=False,
    )


@st.composite
def ajustes_validos_arbitrarios(draw: st.DrawFn) -> Ajustes:
    """Construye un ``Ajustes`` válido y arbitrario.

    Parte de los valores por defecto y sortea, dentro de rango, cada campo
    numérico validado. Varía en particular ``revision_ia`` (activado, modelo,
    timeout_s, max_reintentos) y ``render`` (motor_preferido, combine_tokens_ms),
    además de idioma/modelo/colores válidos. La música se incluye u omite
    aleatoriamente. El resultado se garantiza válido (``ajustes_validos``).
    """
    # La música se incluye u omite para ejercitar ambos caminos.
    con_musica = draw(st.booleans())
    ajustes = Ajustes(musica=AjustesMusica() if con_musica else None)

    for ruta, (minimo, maximo) in RANGOS_MOTOR.items():
        # Los rangos de estilo de textos extra no son campos de ``Ajustes``.
        if ruta.startswith("texto_extra."):
            continue
        if ruta.startswith("musica.") and not con_musica:
            continue
        _set_por_ruta(ajustes, ruta, draw(_valor_valido(ruta, minimo, maximo)))

    # Idioma / modelo de transcripción válidos.
    _set_por_ruta(
        ajustes,
        "transcripcion.idioma",
        draw(st.sampled_from(sorted(SUPPORTED_WHISPER_LANGUAGES) + ["auto"])),
    )
    _set_por_ruta(
        ajustes,
        "transcripcion.modelo",
        draw(st.sampled_from(sorted(SUPPORTED_WHISPER_MODELS))),
    )

    # Colores de subtítulo válidos (#RRGGBB).
    color = st.from_regex(r"\A#[0-9A-Fa-f]{6}\Z")
    _set_por_ruta(ajustes, "subtitulos.color", draw(color))
    _set_por_ruta(ajustes, "subtitulos.color_borde", draw(color))
    _set_por_ruta(ajustes, "subtitulos.color_resaltado", draw(color))

    # Flags booleanos varios.
    ajustes.subtitulos.minusculas = draw(st.booleans())
    ajustes.subtitulos.revisar = draw(st.booleans())
    ajustes.silencios.activado = draw(st.booleans())
    ajustes.risas.activado = draw(st.booleans())

    # Variaciones de revision_ia: al activarlo, el modelo debe ser soportado.
    ajustes.revision_ia.activado = draw(st.booleans())
    ajustes.revision_ia.modelo = draw(st.sampled_from(sorted(SUPPORTED_OPENAI_MODELS)))

    # Variaciones de render: motor_preferido es un Literal ass|remotion.
    ajustes.render.motor_preferido = draw(st.sampled_from(["ass", "remotion"]))

    return ajustes


# ---------------------------------------------------------------------------
# Property 15: Serialización round-trip
# Feature: subtitulos-ia-remotion, Property 15: Serialización round-trip
# Validates: Requirements 15.1, 15.2
# ---------------------------------------------------------------------------
@PBT_ROUNDTRIP
@given(ajustes=ajustes_validos_arbitrarios())
def test_propiedad_15_roundtrip_serializacion(ajustes: Ajustes) -> None:
    """Para todo ``Ajustes`` válido, serializar y deserializar produce un
    ``Ajustes`` equivalente y la representación intermedia es JSON válido."""
    # Precondición del generador: los ajustes son válidos.
    assert ajustes_validos(ajustes)

    # Serializar con el mismo mecanismo que config_store.guardar_ajustes.
    contenido = json.dumps(ajustes.model_dump(), ensure_ascii=False)

    # Req 15.1: la representación es JSON válido (parseable sin error).
    datos = json.loads(contenido)
    assert isinstance(datos, dict)

    # Req 15.2: la deserialización produce un Ajustes equivalente al original.
    reconstruido = Ajustes.model_validate(datos)
    assert reconstruido == ajustes
    # El volcado del reconstruido coincide byte-a-byte a nivel de dict.
    assert reconstruido.model_dump() == ajustes.model_dump()

    # Round-trip idempotente: un segundo ciclo no cambia nada.
    contenido2 = json.dumps(reconstruido.model_dump(), ensure_ascii=False)
    assert contenido2 == contenido


# ---------------------------------------------------------------------------
# Tests unitarios de apoyo
# ---------------------------------------------------------------------------
def test_roundtrip_defaults() -> None:
    """Los ajustes por defecto (con y sin música) sobreviven al round-trip."""
    for ajustes in (Ajustes(), Ajustes(musica=AjustesMusica())):
        datos = json.loads(json.dumps(ajustes.model_dump()))
        assert Ajustes.model_validate(datos) == ajustes


def test_roundtrip_incluye_revision_ia_y_render() -> None:
    """El round-trip conserva los nuevos campos revision_ia y render."""
    ajustes = Ajustes()
    ajustes.revision_ia.activado = True
    ajustes.revision_ia.modelo = "gpt-4.1"
    ajustes.revision_ia.timeout_s = 42.5
    ajustes.revision_ia.max_reintentos = 3
    ajustes.render.motor_preferido = "remotion"
    ajustes.render.combine_tokens_ms = 800

    datos = json.loads(json.dumps(ajustes.model_dump()))
    reconstruido = Ajustes.model_validate(datos)

    assert reconstruido == ajustes
    assert reconstruido.revision_ia.activado is True
    assert reconstruido.revision_ia.modelo == "gpt-4.1"
    assert reconstruido.revision_ia.timeout_s == 42.5
    assert reconstruido.revision_ia.max_reintentos == 3
    assert reconstruido.render.motor_preferido == "remotion"
    assert reconstruido.render.combine_tokens_ms == 800


def test_serializacion_no_contiene_clave_api() -> None:
    """La representación serializada de Ajustes nunca incluye una clave de API
    (la clave es transitoria y no forma parte del modelo)."""
    ajustes = Ajustes()
    ajustes.revision_ia.activado = True
    contenido = json.dumps(ajustes.model_dump())
    assert "openai_api_key" not in contenido
    assert "api_key" not in contenido
