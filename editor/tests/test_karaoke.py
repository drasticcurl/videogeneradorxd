"""Tests del render karaoke (resaltado palabra por palabra) del ass_builder."""

from __future__ import annotations

from app.engine.ass_builder import (
    color_a_ass,
    construir_ass,
    limites_palabras,
)
from app.models.settings import (
    AjustesSubtitulos,
    GrupoSubtitulo,
    Palabra,
    ResolucionObjetivo,
)

RES = ResolucionObjetivo(ancho=1080, alto=1920)


def _grupo() -> GrupoSubtitulo:
    return GrupoSubtitulo(
        texto="hola mundo cruel",
        inicio_s=0.0,
        fin_s=1.5,
        palabras=[
            Palabra(texto="hola", inicio_s=0.0, fin_s=0.5),
            Palabra(texto="mundo", inicio_s=0.5, fin_s=1.0),
            Palabra(texto="cruel", inicio_s=1.0, fin_s=1.5),
        ],
    )


def test_karaoke_una_linea_por_palabra() -> None:
    ass = construir_ass([_grupo()], AjustesSubtitulos(preset="bold_pop"), RES)
    # Una línea Dialogue por palabra (3), no una por grupo.
    assert ass.count("Dialogue:") == 3


def test_karaoke_usa_color_de_acento_y_posicion_estatica() -> None:
    sub = AjustesSubtitulos(preset="resaltado", color_resaltado="#FFE500")
    ass = construir_ass([_grupo()], sub, RES)
    assert color_a_ass("#FFE500") in ass
    # Posición estática (\pos), sin animación de desplazamiento (\move).
    assert "\\pos(" in ass
    assert "\\move(" not in ass


def test_clasico_sigue_una_linea_por_grupo_con_move() -> None:
    ass = construir_ass([_grupo()], AjustesSubtitulos(), RES)  # preset clasico
    assert ass.count("Dialogue:") == 1
    assert "\\move(" in ass


def test_karaoke_minusculas() -> None:
    sub = AjustesSubtitulos(preset="bold_pop", minusculas=True)
    g = GrupoSubtitulo(
        texto="HOLA Qué",
        inicio_s=0.0,
        fin_s=1.0,
        palabras=[
            Palabra(texto="HOLA", inicio_s=0.0, fin_s=0.5),
            Palabra(texto="Qué", inicio_s=0.5, fin_s=1.0),
        ],
    )
    ass = construir_ass([g], sub, RES)
    assert "hola" in ass and "qué" in ass
    assert "HOLA" not in ass


def test_limites_even_split_sin_palabras() -> None:
    g = GrupoSubtitulo(texto="a b c d", inicio_s=0.0, fin_s=4.0)  # sin palabras
    assert limites_palabras(g, 4) == [0.0, 1.0, 2.0, 3.0, 4.0]


def test_limites_usa_timestamps_y_es_monotono() -> None:
    b = limites_palabras(_grupo(), 3)
    assert b[0] == 0.0 and b[-1] == 1.5
    assert all(b[i] <= b[i + 1] for i in range(len(b) - 1))
