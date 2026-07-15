"""Test property-based de preservación del orden de clips (Req 2.4, 3.4).

Cubre la Propiedad 5 del diseño sobre :mod:`app.engine.normalize`:

* Propiedad 5: Preservación del orden de clips extremo a extremo.

La lista de concatenación (contenido de ``concat.txt``) que el motor construye a
partir del ``Orden_de_Clips`` debe ser igual, elemento a elemento, al orden
recibido: nunca reordena, omite ni duplica clips.

Se ejercita con un mínimo de 100 iteraciones (aquí 200). Los generadores cubren
referencias de clip con caracteres problemáticos para el demuxer ``concat``
(comillas simples, espacios, barras y caracteres no ASCII).
"""

from __future__ import annotations

from typing import List

from hypothesis import given, settings
from hypothesis import strategies as st

from app.engine.normalize import (
    contenido_concat_txt,
    orden_concatenacion,
    parsear_concat_txt,
)

# Mínimo 100 iteraciones por propiedad (diseño: PBT >= 100 ejemplos).
PBT_SETTINGS = settings(max_examples=200, deadline=None)


# ---------------------------------------------------------------------------
# Generadores inteligentes
# ---------------------------------------------------------------------------
def _referencia_clip() -> st.SearchStrategy[str]:
    """Genera una referencia de clip (id o ruta) no vacía y sin saltos de línea.

    Se incluyen deliberadamente comillas simples, espacios, barras y caracteres
    no ASCII para ejercitar el escapado/desescapado del demuxer ``concat`` sin
    romper el round-trip. Se excluyen los saltos de línea porque delimitan las
    líneas ``file '...'`` del archivo.
    """
    return st.text(
        alphabet=st.characters(blacklist_categories=("Cc", "Cs"), blacklist_characters="\n\r"),
        min_size=1,
        max_size=40,
    )


def _orden_clips() -> st.SearchStrategy[List[str]]:
    """Genera un ``Orden_de_Clips`` de 1..500 referencias (posiblemente repetidas).

    Se permiten referencias repetidas para verificar que la construcción no
    "deduplica" por su cuenta: la salida debe reflejar exactamente la entrada.
    """
    return st.lists(_referencia_clip(), min_size=1, max_size=500)


# ---------------------------------------------------------------------------
# Propiedad 5: Preservación del orden de clips extremo a extremo
# Feature: vertical-shorts-editor, Property 5
# Validates: Requirements 2.4, 3.4
# ---------------------------------------------------------------------------
@PBT_SETTINGS
@given(orden=_orden_clips())
def test_propiedad_5_preservacion_orden(orden: List[str]) -> None:
    """El contenido de ``concat.txt`` es igual, elemento a elemento, al orden
    recibido; nunca reordena, omite ni duplica clips."""
    # La secuencia de concatenación es idéntica al orden recibido (identidad de
    # orden y cardinalidad).
    secuencia = orden_concatenacion(orden)
    assert secuencia == orden
    assert len(secuencia) == len(orden)

    # Round-trip a través del archivo concat.txt: parsear reproduce el orden
    # exacto elemento a elemento (sin reordenar/omitir/duplicar).
    contenido = contenido_concat_txt(orden)
    recuperado = parsear_concat_txt(contenido)
    assert recuperado == orden

    # Verificación explícita elemento a elemento y de multiconjunto (cardinalidad
    # e identidad preservadas, incluidas repeticiones).
    assert len(recuperado) == len(orden)
    for esperado, obtenido in zip(orden, recuperado):
        assert obtenido == esperado
    assert sorted(recuperado) == sorted(orden)


# ---------------------------------------------------------------------------
# Tests unitarios de ejemplo / borde
# ---------------------------------------------------------------------------
def test_contenido_concat_formato() -> None:
    contenido = contenido_concat_txt(["a.mp4", "b.mp4", "c.mp4"])
    assert contenido == "file 'a.mp4'\nfile 'b.mp4'\nfile 'c.mp4'\n"


def test_round_trip_con_comillas_y_espacios() -> None:
    orden = ["clip uno.mp4", "o'brien.mov", "ruta/con espacio/x.mkv"]
    recuperado = parsear_concat_txt(contenido_concat_txt(orden))
    assert recuperado == orden


def test_no_deduplica_ni_reordena() -> None:
    orden = ["b", "a", "b", "a", "b"]
    assert orden_concatenacion(orden) == orden
    assert parsear_concat_txt(contenido_concat_txt(orden)) == orden


def test_orden_concatenacion_devuelve_copia() -> None:
    orden = ["x", "y"]
    salida = orden_concatenacion(orden)
    salida.append("z")
    # No debe mutar la lista de entrada.
    assert orden == ["x", "y"]
