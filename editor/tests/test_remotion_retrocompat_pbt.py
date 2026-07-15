"""Prueba property-based de la Propiedad P9 (spec ``edicion-avanzada-shorts``,
tarea 3.2): **idempotencia / retrocompatibilidad de ``ShortVideoProps``**.

Propiedad P9 (diseño §12): para todo conjunto de entradas (grupos/subtítulos/
resolución/fps/``durationInFrames``/``combineTokensWithinMs``, con o sin
``video_src``), la ampliación aditiva de :func:`app.engine.remotion.construir_props`
NO introduce regresión sobre el contrato previo:

* Llamar a ``construir_props(...)`` SIN ``textos_extra`` (o con ``textos_extra=()``)
  produce ``props["textosExtra"] == []`` (Req 13.2, 13.3).
* El resto del contrato es **byte-idéntico** al de la feature previa: al quitar la
  clave ``textosExtra`` del dict resultante, las claves restantes
  (``videoSrc``, ``fps``, ``width``, ``height``, ``durationInFrames``,
  ``captions``, ``grupos``, ``estilo``, ``combineTokensWithinMs``) coinciden
  exactamente con las esperadas (no hay regresión de P1/P2, Req 19.5).
* Además, añadir ``textos_extra`` NO altera ninguna de las otras claves: sólo
  cambia ``textosExtra`` (el resto del dict permanece idéntico).

Se ejecutan ≥ 100 iteraciones (Req 19.6). La prueba es totalmente pura: no
depende de Node, Chromium, ffprobe ni del sistema de ficheros (``construir_props``
sólo resuelve la ruta de ``entrada`` de forma determinista cuando no hay
``video_src``, lo que se reproduce igual en el valor esperado).

Validates: Requirements 13.2, 13.3, 19.5
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.engine.remotion import (
    caption_a_dict,
    construir_props,
    mapear_grupos_a_captions,
    mapear_grupos_a_props_grupos,
)
from app.models.settings import (
    AjustesSubtitulos,
    EstiloTextoExtra,
    GrupoSubtitulo,
    Palabra,
    ResolucionObjetivo,
    TextoExtra,
)

# Conjunto EXACTO de claves del contrato previo (feature previa), sin el campo
# aditivo ``textosExtra``. Si el contrato de ``construir_props`` cambiara alguna
# clave, esta prueba lo detecta como regresión.
_CLAVES_CONTRATO_PREVIO = frozenset(
    {
        "videoSrc",
        "fps",
        "width",
        "height",
        "durationInFrames",
        "captions",
        "grupos",
        "estilo",
        "combineTokensWithinMs",
    }
)


# ---------------------------------------------------------------------------
# Estrategias de generación
# ---------------------------------------------------------------------------
# Color hexadecimal ``#RRGGBB`` (forma del contrato de estilo).
_hex_color = st.from_regex(r"#[0-9A-Fa-f]{6}", fullmatch=True)

# Tiempos en segundos: finitos, no negativos y acotados (evita NaN/inf).
_tiempo = st.floats(
    min_value=0.0, max_value=100_000.0, allow_nan=False, allow_infinity=False
)
_tiempo_opcional = st.one_of(st.none(), _tiempo)


@st.composite
def _estrategia_palabra(draw: st.DrawFn) -> Palabra:
    """Genera una :class:`Palabra` con tiempos opcionales (posiblemente ``None``)."""
    return Palabra(
        texto=draw(st.text(max_size=12)),
        inicio_s=draw(_tiempo_opcional),
        fin_s=draw(_tiempo_opcional),
    )


@st.composite
def _estrategia_grupo(draw: st.DrawFn) -> GrupoSubtitulo:
    """Genera un :class:`GrupoSubtitulo` con ``inicio_s <= fin_s``.

    ``palabras`` puede ser ``None`` (grupo sin palabras), lista vacía o una lista
    de palabras con o sin tiempos, para ejercitar ambos caminos del mapeo.
    """
    inicio = draw(_tiempo)
    delta = draw(
        st.floats(min_value=0.0, max_value=60.0, allow_nan=False, allow_infinity=False)
    )
    palabras = draw(
        st.one_of(st.none(), st.lists(_estrategia_palabra(), max_size=5))
    )
    return GrupoSubtitulo(
        texto=draw(st.text(max_size=40)),
        inicio_s=inicio,
        fin_s=inicio + delta,
        palabras=palabras,
    )


@st.composite
def _estrategia_subtitulos(draw: st.DrawFn) -> AjustesSubtitulos:
    """Genera ``AjustesSubtitulos`` variando los campos que proyecta el estilo."""
    return AjustesSubtitulos(
        fuente=draw(st.text(min_size=1, max_size=20)),
        tamano=draw(st.integers(min_value=12, max_value=200)),
        color=draw(_hex_color),
        color_resaltado=draw(_hex_color),
        color_borde=draw(_hex_color),
        grosor_borde=draw(st.integers(min_value=0, max_value=20)),
        negrita=draw(st.booleans()),
        pos_vertical_pct=draw(
            st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)
        ),
        anim_entrada_ms=draw(st.integers(min_value=100, max_value=2000)),
    )


@st.composite
def _estrategia_resolucion(draw: st.DrawFn) -> ResolucionObjetivo:
    """Genera una :class:`ResolucionObjetivo` dentro del rango del motor."""
    return ResolucionObjetivo(
        ancho=draw(st.integers(min_value=2, max_value=7680)),
        alto=draw(st.integers(min_value=2, max_value=7680)),
    )


@st.composite
def _estrategia_texto_extra(draw: st.DrawFn) -> TextoExtra:
    """Genera un :class:`TextoExtra` (usado sólo para la comprobación de que
    añadir textos extra no altera el resto del contrato)."""
    inicio = draw(
        st.floats(min_value=0.0, max_value=1000.0, allow_nan=False, allow_infinity=False)
    )
    delta = draw(
        st.floats(min_value=0.0, max_value=60.0, allow_nan=False, allow_infinity=False)
    )
    estilo = EstiloTextoExtra(
        fuente=draw(st.text(min_size=1, max_size=20)),
        tamano=draw(st.integers(min_value=12, max_value=200)),
        color=draw(_hex_color),
        color_borde=draw(_hex_color),
        grosor_borde=draw(st.integers(min_value=0, max_value=20)),
        negrita=draw(st.booleans()),
        pos_vertical_pct=draw(
            st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)
        ),
        pos_horizontal_pct=draw(
            st.floats(min_value=0.0, max_value=100.0, allow_nan=False, allow_infinity=False)
        ),
    )
    return TextoExtra(
        texto=draw(st.text(max_size=30)),
        inicio_s=inicio,
        fin_s=inicio + delta,
        estilo=estilo,
    )


@st.composite
def _estrategia_caso(draw: st.DrawFn) -> Dict[str, object]:
    """Genera un caso completo de entrada para ``construir_props``.

    Varía: la ruta de ``entrada``, la presencia de ``video_src`` (rama URL vs.
    ruta absoluta resuelta), los grupos (con/sin palabras), los ajustes de
    subtítulo, la resolución, ``fps``, ``durationInFrames`` y
    ``combineTokensWithinMs``. Incluye además una lista NO vacía de textos extra
    para la comprobación de que el campo aditivo no perturba el resto.
    """
    entrada = draw(
        st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789_-/.", min_size=1, max_size=24)
    )
    video_src = draw(
        st.one_of(
            st.none(),
            st.builds(
                lambda h, p: f"http://{h}/workfile/{p}.mp4",
                st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789.:", min_size=1, max_size=16),
                st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789_-", min_size=1, max_size=12),
            ),
        )
    )
    return {
        "entrada": entrada,
        "grupos": draw(st.lists(_estrategia_grupo(), max_size=6)),
        "subtitulos": draw(_estrategia_subtitulos()),
        "resolucion": draw(_estrategia_resolucion()),
        "fps": draw(st.integers(min_value=1, max_value=120)),
        "duration_in_frames": draw(st.integers(min_value=1, max_value=1_000_000)),
        "combine_tokens_ms": draw(st.integers(min_value=0, max_value=5000)),
        "video_src": video_src,
        "textos_extra": draw(st.lists(_estrategia_texto_extra(), min_size=1, max_size=2)),
    }


# ---------------------------------------------------------------------------
# Construcción del contrato PREVIO esperado (independiente de construir_props)
# ---------------------------------------------------------------------------
def _estilo_esperado(subtitulos: AjustesSubtitulos) -> Dict[str, object]:
    """Reconstruye, de forma explícita e independiente, el dict ``estilo`` del
    contrato previo (proyección snake_case → camelCase de los ajustes de
    subtítulo). Duplicarlo aquí actúa como "oráculo" para detectar regresiones.
    """
    return {
        "fuente": subtitulos.fuente,
        "tamano": subtitulos.tamano,
        "color": subtitulos.color,
        "colorResaltado": subtitulos.color_resaltado,
        "posVerticalPct": subtitulos.pos_vertical_pct,
        "animEntradaMs": subtitulos.anim_entrada_ms,
        "colorBorde": subtitulos.color_borde,
        "grosorBorde": subtitulos.grosor_borde,
        "negrita": subtitulos.negrita,
    }


def _contrato_previo_esperado(caso: Dict[str, object]) -> Dict[str, object]:
    """Construye el dict de props del contrato PREVIO (sin ``textosExtra``).

    Reproduce byte a byte lo que la firma previa de ``construir_props`` producía,
    reutilizando las funciones puras de mapeo existentes (captions y grupos) y el
    oráculo de estilo. El ``videoSrc`` sigue la misma regla: URL si se pasó
    ``video_src``; en caso contrario, la ruta absoluta resuelta de ``entrada``.
    """
    grupos = caso["grupos"]  # type: ignore[assignment]
    resolucion: ResolucionObjetivo = caso["resolucion"]  # type: ignore[assignment]
    video_src: Optional[str] = caso["video_src"]  # type: ignore[assignment]
    entrada = caso["entrada"]

    video_src_final = (
        video_src if video_src is not None else str(Path(str(entrada)).resolve())
    )
    return {
        "videoSrc": video_src_final,
        "fps": int(caso["fps"]),  # type: ignore[arg-type]
        "width": int(resolucion.ancho),
        "height": int(resolucion.alto),
        "durationInFrames": int(caso["duration_in_frames"]),  # type: ignore[arg-type]
        "captions": [caption_a_dict(c) for c in mapear_grupos_a_captions(grupos)],
        "grupos": mapear_grupos_a_props_grupos(grupos),
        "estilo": _estilo_esperado(caso["subtitulos"]),  # type: ignore[arg-type]
        "combineTokensWithinMs": int(caso["combine_tokens_ms"]),  # type: ignore[arg-type]
    }


def _construir(caso: Dict[str, object], *, con_textos: bool) -> Dict[str, object]:
    """Invoca ``construir_props`` con el caso dado, con o sin textos extra."""
    textos = tuple(caso["textos_extra"]) if con_textos else ()  # type: ignore[arg-type]
    return construir_props(
        caso["entrada"],  # type: ignore[arg-type]
        caso["grupos"],  # type: ignore[arg-type]
        caso["subtitulos"],  # type: ignore[arg-type]
        caso["resolucion"],  # type: ignore[arg-type]
        caso["fps"],  # type: ignore[arg-type]
        caso["duration_in_frames"],  # type: ignore[arg-type]
        caso["combine_tokens_ms"],  # type: ignore[arg-type]
        video_src=caso["video_src"],  # type: ignore[arg-type]
        textos_extra=textos,
    )


# ---------------------------------------------------------------------------
# Propiedad P9 — retrocompatibilidad / no regresión de ShortVideoProps
# ---------------------------------------------------------------------------
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(caso=_estrategia_caso())
def test_p9_retrocompatibilidad_short_video_props(caso: Dict[str, object]) -> None:
    """P9: sin textos extra, ``textosExtra == []`` y el resto es byte-idéntico
    al contrato previo; con textos extra, sólo cambia ``textosExtra``.

    Validates: Requirements 13.2, 13.3, 19.5
    """
    props_sin = _construir(caso, con_textos=False)

    # (1) El campo aditivo se emite como lista vacía cuando no hay textos extra.
    assert props_sin["textosExtra"] == []

    # (2) El conjunto de claves es EXACTAMENTE el previo más ``textosExtra``.
    assert set(props_sin.keys()) == _CLAVES_CONTRATO_PREVIO | {"textosExtra"}

    # (3) Al quitar ``textosExtra``, el dict es byte-idéntico al contrato previo
    #     (no hay regresión de ninguna clave: videoSrc/fps/width/height/
    #     durationInFrames/captions/grupos/estilo/combineTokensWithinMs).
    props_sin_campo = {k: v for k, v in props_sin.items() if k != "textosExtra"}
    esperado_previo = _contrato_previo_esperado(caso)
    assert props_sin_campo == esperado_previo

    # (4) Añadir textos extra NO altera ninguna otra clave: sólo cambia
    #     ``textosExtra``. El resto del contrato permanece idéntico.
    props_con = _construir(caso, con_textos=True)
    assert {k: v for k, v in props_con.items() if k != "textosExtra"} == props_sin_campo
    # Con textos extra, el campo deja de ser la lista vacía (se generó min_size=1).
    assert isinstance(props_con["textosExtra"], list)
    assert len(props_con["textosExtra"]) == len(caso["textos_extra"])  # type: ignore[arg-type]


@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(caso=_estrategia_caso())
def test_p9_construir_props_es_puro_no_muta_entradas(caso: Dict[str, object]) -> None:
    """``construir_props`` no debe mutar sus entradas (grupos/subtítulos/textos).

    Refuerza la retrocompatibilidad: la extensión aditiva es una función pura.

    Validates: Requirements 13.2, 19.5
    """
    grupos_antes = [g.model_dump() for g in caso["grupos"]]  # type: ignore[union-attr]
    subtitulos_antes = caso["subtitulos"].model_dump()  # type: ignore[union-attr]
    textos_antes = [t.model_dump() for t in caso["textos_extra"]]  # type: ignore[union-attr]

    _construir(caso, con_textos=True)

    assert [g.model_dump() for g in caso["grupos"]] == grupos_antes  # type: ignore[union-attr]
    assert caso["subtitulos"].model_dump() == subtitulos_antes  # type: ignore[union-attr]
    assert [t.model_dump() for t in caso["textos_extra"]] == textos_antes  # type: ignore[union-attr]
