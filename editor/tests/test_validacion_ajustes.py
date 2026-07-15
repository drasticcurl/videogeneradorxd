"""Tests de validación de los ajustes de IA y render
(spec subtitulos-ia-remotion, tarea 1.4; Req 11.1, 11.2, 11.3, 11.4).

Contiene:

* **Property 11: Validación de ajustes** (property-based, Hypothesis,
  >= 100 iteraciones): un ``Ajustes`` con ``revision_ia.activado=True`` y un
  modelo NO soportado es rechazado por :func:`validar_ajustes`, que identifica
  exactamente el campo ``revision_ia.modelo`` (Req 11.1).
* Tests unitarios de apoyo: rangos fuera de límite de ``revision_ia.timeout_s``
  (Req 11.2), ``revision_ia.max_reintentos`` (Req 11.3) y
  ``render.combine_tokens_ms`` (Req 11.4), verificando el campo reportado como
  inválido; y el modelo no soportado con la IA activada frente a desactivada
  (Req 11.1).

La validación de estos campos es la misma fuente de verdad usada por el resto
del sistema: :func:`app.models.settings.validar_ajustes` y los rangos declarados
en ``RANGOS_MOTOR``.

Feature: subtitulos-ia-remotion, Property 11: Validación de ajustes
Validates: Requirements 11.1, 11.2, 11.3, 11.4
"""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from app.models.settings import (
    Ajustes,
    SUPPORTED_OPENAI_MODELS,
    validar_ajustes,
)

# Mínimo 100 iteraciones por propiedad (aquí 200).
PBT_VALIDACION = settings(max_examples=200, deadline=None)


# ---------------------------------------------------------------------------
# Generador de identificadores de modelo NO soportados por OpenAI.
# ---------------------------------------------------------------------------
@st.composite
def modelos_no_soportados(draw: st.DrawFn) -> str:
    """Genera cadenas de modelo que NO pertenecen a SUPPORTED_OPENAI_MODELS.

    Combina un banco de ejemplos plausibles con texto arbitrario, filtrando
    cualquier coincidencia accidental con el conjunto soportado.
    """
    candidato = draw(
        st.one_of(
            st.sampled_from(
                [
                    "",
                    "gpt-3.5-turbo",
                    "gpt-4",
                    "gpt-4o",
                    "gpt-4.1-micro",
                    "claude-3",
                    "gemini-pro",
                    "llama-3",
                    "modelo-inexistente",
                    "GPT-4.1-MINI",  # distinto por mayúsculas
                    " gpt-4.1-mini",  # espacio inicial
                ]
            ),
            st.text(max_size=20),
        )
    )
    # Garantiza que el candidato no está en el conjunto soportado.
    if candidato in SUPPORTED_OPENAI_MODELS:
        candidato = candidato + "-x"
    return candidato


# ---------------------------------------------------------------------------
# Property 11: Validación de ajustes
# Feature: subtitulos-ia-remotion, Property 11: Validación de ajustes
# Validates: Requirements 11.1, 11.2, 11.3, 11.4
# ---------------------------------------------------------------------------
@PBT_VALIDACION
@given(modelo=modelos_no_soportados())
def test_propiedad_11_ia_activada_modelo_no_soportado_se_rechaza(modelo: str) -> None:
    """Con ``revision_ia.activado=True`` y un modelo no soportado, la validación
    rechaza los ajustes identificando el campo ``revision_ia.modelo`` (Req 11.1).

    El resto de los campos parten de los valores por defecto (válidos), por lo
    que ``revision_ia.modelo`` debe ser el único campo reportado como inválido.
    """
    ajustes = Ajustes()
    ajustes.revision_ia.activado = True
    ajustes.revision_ia.modelo = modelo

    invalidos = validar_ajustes(ajustes)

    # Precondición: el modelo generado no es soportado.
    assert modelo not in SUPPORTED_OPENAI_MODELS
    # El campo del modelo se reporta como inválido...
    assert "revision_ia.modelo" in invalidos
    # ...y es el único campo inválido (los demás son defaults válidos).
    assert invalidos == ["revision_ia.modelo"]


@PBT_VALIDACION
@given(modelo=modelos_no_soportados())
def test_propiedad_11_ia_desactivada_modelo_no_soportado_se_acepta(modelo: str) -> None:
    """Con ``revision_ia.activado=False`` el modelo es irrelevante: aunque no sea
    soportado, no se rechaza (Req 11.1, cláusula condicional a la activación)."""
    ajustes = Ajustes()
    ajustes.revision_ia.activado = False
    ajustes.revision_ia.modelo = modelo

    invalidos = validar_ajustes(ajustes)

    assert "revision_ia.modelo" not in invalidos
    # Con el resto de defaults válidos, los ajustes se aceptan.
    assert invalidos == []


# ---------------------------------------------------------------------------
# Tests unitarios de rango fuera de límite (Req 11.2, 11.3, 11.4)
# ---------------------------------------------------------------------------
def test_timeout_s_por_debajo_del_rango_se_rechaza() -> None:
    """``revision_ia.timeout_s`` < 1.0 se identifica como inválido (Req 11.2)."""
    ajustes = Ajustes()
    ajustes.revision_ia.timeout_s = 0.5  # < 1.0
    assert "revision_ia.timeout_s" in validar_ajustes(ajustes)


def test_timeout_s_por_encima_del_rango_se_rechaza() -> None:
    """``revision_ia.timeout_s`` > 120.0 se identifica como inválido (Req 11.2)."""
    ajustes = Ajustes()
    ajustes.revision_ia.timeout_s = 120.1  # > 120.0
    assert "revision_ia.timeout_s" in validar_ajustes(ajustes)


def test_timeout_s_en_limites_es_valido() -> None:
    """Los extremos inclusivos 1.0 y 120.0 de ``timeout_s`` son válidos (Req 11.2)."""
    for valor in (1.0, 120.0):
        ajustes = Ajustes()
        ajustes.revision_ia.timeout_s = valor
        assert "revision_ia.timeout_s" not in validar_ajustes(ajustes)


def test_max_reintentos_por_debajo_del_rango_se_rechaza() -> None:
    """``revision_ia.max_reintentos`` < 0 se identifica como inválido (Req 11.3)."""
    ajustes = Ajustes()
    ajustes.revision_ia.max_reintentos = -1  # < 0
    assert "revision_ia.max_reintentos" in validar_ajustes(ajustes)


def test_max_reintentos_por_encima_del_rango_se_rechaza() -> None:
    """``revision_ia.max_reintentos`` > 5 se identifica como inválido (Req 11.3)."""
    ajustes = Ajustes()
    ajustes.revision_ia.max_reintentos = 6  # > 5
    assert "revision_ia.max_reintentos" in validar_ajustes(ajustes)


def test_max_reintentos_en_limites_es_valido() -> None:
    """Los extremos inclusivos 0 y 5 de ``max_reintentos`` son válidos (Req 11.3)."""
    for valor in (0, 5):
        ajustes = Ajustes()
        ajustes.revision_ia.max_reintentos = valor
        assert "revision_ia.max_reintentos" not in validar_ajustes(ajustes)


def test_combine_tokens_ms_por_debajo_del_rango_se_rechaza() -> None:
    """``render.combine_tokens_ms`` < 0 se identifica como inválido (Req 11.4)."""
    ajustes = Ajustes()
    ajustes.render.combine_tokens_ms = -1  # < 0
    assert "render.combine_tokens_ms" in validar_ajustes(ajustes)


def test_combine_tokens_ms_por_encima_del_rango_se_rechaza() -> None:
    """``render.combine_tokens_ms`` > 5000 se identifica como inválido (Req 11.4)."""
    ajustes = Ajustes()
    ajustes.render.combine_tokens_ms = 5001  # > 5000
    assert "render.combine_tokens_ms" in validar_ajustes(ajustes)


def test_combine_tokens_ms_en_limites_es_valido() -> None:
    """Los extremos inclusivos 0 y 5000 de ``combine_tokens_ms`` son válidos (Req 11.4)."""
    for valor in (0, 5000):
        ajustes = Ajustes()
        ajustes.render.combine_tokens_ms = valor
        assert "render.combine_tokens_ms" not in validar_ajustes(ajustes)


# ---------------------------------------------------------------------------
# Modelo no soportado: IA activada vs desactivada (ejemplos concretos, Req 11.1)
# ---------------------------------------------------------------------------
def test_modelo_no_soportado_con_ia_activada_se_rechaza() -> None:
    """Ejemplo concreto: IA activada + modelo no soportado => rechazo (Req 11.1)."""
    ajustes = Ajustes()
    ajustes.revision_ia.activado = True
    ajustes.revision_ia.modelo = "gpt-3.5-turbo"
    assert validar_ajustes(ajustes) == ["revision_ia.modelo"]


def test_modelo_no_soportado_con_ia_desactivada_se_acepta() -> None:
    """Ejemplo concreto: IA desactivada + modelo no soportado => aceptado (Req 11.1)."""
    ajustes = Ajustes()
    ajustes.revision_ia.activado = False
    ajustes.revision_ia.modelo = "gpt-3.5-turbo"
    assert validar_ajustes(ajustes) == []


def test_modelo_soportado_con_ia_activada_se_acepta() -> None:
    """Cada modelo soportado es válido con la IA activada (Req 11.1)."""
    for modelo in SUPPORTED_OPENAI_MODELS:
        ajustes = Ajustes()
        ajustes.revision_ia.activado = True
        ajustes.revision_ia.modelo = modelo
        assert "revision_ia.modelo" not in validar_ajustes(ajustes)


def test_varios_campos_ia_render_invalidos_se_reportan_todos() -> None:
    """Varios campos de IA/render fuera de rango se reportan simultáneamente."""
    ajustes = Ajustes()
    ajustes.revision_ia.activado = True
    ajustes.revision_ia.modelo = "no-existe"
    ajustes.revision_ia.timeout_s = 999.0  # > 120.0
    ajustes.revision_ia.max_reintentos = 10  # > 5
    ajustes.render.combine_tokens_ms = -5  # < 0

    invalidos = set(validar_ajustes(ajustes))
    assert invalidos == {
        "revision_ia.modelo",
        "revision_ia.timeout_s",
        "revision_ia.max_reintentos",
        "render.combine_tokens_ms",
    }
