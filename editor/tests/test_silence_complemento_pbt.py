"""Prueba de propiedad P5 — Complemento de tramos a borrar (Tarea 2.2, hypothesis).

Verifica :func:`app.engine.silence.segmentos_conservar_desde_borrado` (la función
PURA que, dados los tramos a BORRAR editados por el usuario y la ``duracion``,
devuelve los segmentos a CONSERVAR, es decir su complemento dentro de
``[0, duracion]``; véase el pseudocódigo §7.1 y la propiedad P5 §12 del diseño).

**Propiedad 5 (P5): Complemento de tramos a borrar**

**Valida: Requisitos 5.5, 5.8, 19.1, 19.2**

Para toda lista de tramos a borrar y toda ``duracion > 0`` se comprueba:

* **P5a (complemento exacto salvo D-VACIO):** la unión de los segmentos
  conservados es exactamente ``[0, duracion]`` menos la unión (fusionada) de los
  tramos a borrar; SALVO el caso **D-VACIO** (los tramos cubren todo
  ``[0, duracion]``), en el que el resultado debe ser ``[(0.0, duracion)]`` (vídeo
  entero) para evitar una duración cero.
* **P5b (ordenado, sin solapes):** para todo ``i``,
  ``salida[i].fin <= salida[i+1].inicio``.
* **P5c (clamp):** todo segmento está contenido en ``[0, duracion]``.
* **P5d (no vacío):** la salida NUNCA es una lista vacía.

El complemento de referencia se calcula de forma **INDEPENDIENTE** de la
implementación mediante un muestreo por puntos medios de los intervalos
elementales (partición inducida por todos los extremos relevantes), sin reutilizar
el algoritmo de fusión + resta de :mod:`app.engine.silence`. De este modo la
prueba no queda "acoplada" a la propia implementación que valida.

La PBT ejecuta ≥ 100 iteraciones (Req 19.6): ``max_examples=200``.
"""

from __future__ import annotations

from typing import List, Tuple

from hypothesis import example, given, settings
from hypothesis import strategies as st

from app.engine.silence import segmentos_conservar_desde_borrado

# Perfil de la PBT: mínimo 100 iteraciones (Req 19.6); sin límite de tiempo para
# no producir falsos negativos por lentitud en CI. Coherente con el resto del
# repo (véase ``test_silence.py``: ``settings(max_examples=200, deadline=None)``).
PBT = settings(max_examples=200, deadline=None)

# Tipo de comodidad para un intervalo ``(inicio, fin)`` en segundos.
Tramo = Tuple[float, float]


# ---------------------------------------------------------------------------
# Referencia INDEPENDIENTE del complemento (muestreo por puntos medios)
# ---------------------------------------------------------------------------
def _clampear_tramos(tramos: List[Tramo], duracion: float) -> List[Tramo]:
    """Recorta los tramos a ``[0, duracion]`` y descarta los degenerados.

    Es el único preprocesado que comparte semántica con la especificación
    (clamp + descarte de ``fin <= inicio``); NO fusiona ni resta intervalos, por
    lo que la comprobación del complemento sigue siendo independiente del
    algoritmo bajo prueba.
    """
    recortados: List[Tramo] = []
    for ini, fin in tramos:
        ini_c = max(0.0, min(float(ini), duracion))
        fin_c = max(0.0, min(float(fin), duracion))
        if fin_c > ini_c:
            recortados.append((ini_c, fin_c))
    return recortados


def _cubierto(punto: float, intervalos: List[Tramo]) -> bool:
    """Indica si ``punto`` cae en el INTERIOR de algún intervalo (extremos abiertos).

    Se usan desigualdades estrictas porque ``punto`` es siempre el punto medio de
    un intervalo elemental, nunca un extremo; así se evitan ambigüedades de borde.
    """
    return any(lo < punto < hi for lo, hi in intervalos)


def _intervalos_elementales(
    borrados: List[Tramo], conservados: List[Tramo], duracion: float
) -> List[Tramo]:
    """Partición de ``[0, duracion]`` inducida por TODOS los extremos relevantes.

    Reúne ``0``, ``duracion`` y los extremos de los tramos borrados y conservados,
    y devuelve los subintervalos consecutivos no vacíos. Cada subintervalo es
    "homogéneo": o pertenece por completo al complemento o por completo a los
    borrados, de modo que basta muestrear su punto medio.
    """
    puntos = {0.0, float(duracion)}
    for lo, hi in borrados:
        puntos.add(lo)
        puntos.add(hi)
    for lo, hi in conservados:
        puntos.add(lo)
        puntos.add(hi)
    ordenados = sorted(p for p in puntos if 0.0 <= p <= duracion)
    elementales: List[Tramo] = []
    for a, b in zip(ordenados, ordenados[1:]):
        if b > a:
            elementales.append((a, b))
    return elementales


# ---------------------------------------------------------------------------
# Estrategia: (tramos_a_borrar, duracion) con los casos borde exigidos
# ---------------------------------------------------------------------------
@st.composite
def _caso_tramos_duracion(draw: st.DrawFn) -> Tuple[List[Tramo], float]:
    """Genera ``(tramos_a_borrar, duracion)`` cubriendo los casos borde de la tarea.

    Casos cubiertos: sin tramos, tramos solapados/adyacentes, tramos fuera de
    rango (que deben recortarse) y "borrar todo" (D-VACIO). Los extremos se
    extraen deliberadamente por debajo de 0 y por encima de ``duracion`` para
    ejercitar el clamp.

    Nota sobre ``allow_subnormal=False`` (justificación): TODAS las estrategias de
    ``floats`` de este generador excluyen los flotantes SUBNORMALES (los del rango
    de "underflow", magnitudes ~5e-324..2.2e-308). No son representativos de
    duraciones/tramos de vídeo reales (segundos) y, sobre todo, ROMPEN EL ORÁCULO
    de referencia de esta PBT, no la función de producción: cuando un tramo a
    borrar deja un complemento de anchura subnormal (p. ej. ``[(5e-324, 1.0)]`` con
    ``duracion=1.0`` deja el complemento ``(0.0, 5e-324)``), el punto medio
    ``(a+b)/2`` sufre *underflow* a un extremo (``5e-324/2 == 0.0``) y el muestreo
    de interior estricto deja de discriminar "borrado" vs "conservado". La función
    ``segmentos_conservar_desde_borrado`` calcula ese complemento de forma correcta;
    el fallo es una fragilidad del muestreo, no un bug. Excluir los subnormales
    elimina únicamente esos casos degenerados no representables, manteniendo intactas
    P5a–P5d para todo el rango normal (incluidos negativos, clamp y solapes).
    """
    duracion = draw(
        st.floats(
            min_value=0.1,
            max_value=3600.0,
            allow_nan=False,
            allow_infinity=False,
            allow_subnormal=False,
        )
    )
    modo = draw(
        st.sampled_from(["vacio", "normal", "solapados", "fuera_rango", "cubre_todo"])
    )

    if modo == "vacio":
        return [], duracion

    if modo == "cubre_todo":
        # D-VACIO: uno o varios tramos que en conjunto cubren [0, duracion].
        return [(-5.0, duracion + 5.0)], duracion

    # Extremos deliberadamente fuera de [0, duracion] para ejercitar el clamp.
    extremo = st.floats(
        min_value=-50.0,
        max_value=duracion + 50.0,
        allow_nan=False,
        allow_infinity=False,
        allow_subnormal=False,
    )

    if modo == "solapados":
        # Tramos con solapes/adyacencias: base + desplazamientos pequeños.
        base = draw(extremo)
        n = draw(st.integers(min_value=2, max_value=6))
        tramos: List[Tramo] = []
        cursor = base
        for _ in range(n):
            inicio = cursor - draw(
                st.floats(
                    min_value=0.0,
                    max_value=5.0,
                    allow_nan=False,
                    allow_infinity=False,
                    allow_subnormal=False,
                )
            )
            longitud = draw(
                st.floats(
                    min_value=0.0,
                    max_value=20.0,
                    allow_nan=False,
                    allow_infinity=False,
                    allow_subnormal=False,
                )
            )
            tramos.append((inicio, inicio + longitud))
            cursor = inicio + longitud
        return tramos, duracion

    # modo == "normal" o "fuera_rango": pares arbitrarios (inicio, inicio+longitud).
    n = draw(st.integers(min_value=0, max_value=8))
    tramos = []
    for _ in range(n):
        inicio = draw(extremo)
        longitud = draw(
            st.floats(
                min_value=0.0,
                max_value=duracion + 60.0,
                allow_nan=False,
                allow_infinity=False,
                allow_subnormal=False,
            )
        )
        tramos.append((inicio, inicio + longitud))
    return tramos, duracion


# ---------------------------------------------------------------------------
# P5 — Complemento de tramos a borrar
# Feature: edicion-avanzada-shorts, Property 5
# Valida: Requisitos 5.5, 5.8, 19.1, 19.2
# ---------------------------------------------------------------------------
@PBT
# Casos borde explícitos garantizados en cada ejecución:
@example(caso=([], 10.0))  # sin tramos -> se conserva todo
@example(caso=([(-5.0, 15.0)], 10.0))  # borrar todo (D-VACIO)
@example(caso=([(2.0, 5.0), (4.0, 7.0)], 10.0))  # solapados
@example(caso=([(3.0, 5.0), (5.0, 8.0)], 10.0))  # adyacentes
@example(caso=([(-4.0, 2.0), (8.0, 20.0)], 10.0))  # fuera de rango (clamp)
@given(caso=_caso_tramos_duracion())
def test_p5_complemento_tramos_a_borrar(caso: Tuple[List[Tramo], float]) -> None:
    """P5a/P5b/P5c/P5d de ``segmentos_conservar_desde_borrado`` (§7.1, §12).

    Valida: Requisitos 5.5, 5.8, 19.1, 19.2
    """
    tramos, duracion = caso
    segmentos = segmentos_conservar_desde_borrado(tramos, duracion)

    # --- P5d: la salida NUNCA es vacía ---
    assert segmentos, "P5d: la salida no puede ser una lista vacía"

    # --- P5c: todo segmento contenido en [0, duracion] (y no degenerado) ---
    for ini, fin in segmentos:
        assert 0.0 <= ini <= fin <= duracion, (
            f"P5c: segmento {(ini, fin)} fuera de [0, {duracion}]"
        )

    # --- P5b: ordenado y sin solapes ---
    for (_, fin_actual), (ini_siguiente, _) in zip(segmentos, segmentos[1:]):
        assert fin_actual <= ini_siguiente, (
            "P5b: los segmentos deben estar ordenados y sin solapes"
        )

    # --- P5a: complemento exacto (referencia independiente por muestreo) ---
    borrados = _clampear_tramos(tramos, duracion)
    elementales = _intervalos_elementales(borrados, segmentos, duracion)

    # ¿Caso D-VACIO? Lo es cuando NINGÚN intervalo elemental queda fuera de los
    # tramos borrados (el usuario marcó todo [0, duracion] para borrar).
    hay_complemento = any(
        not _cubierto((a + b) / 2.0, borrados) for a, b in elementales
    )

    if not hay_complemento:
        # D-VACIO: se conserva el vídeo entero para no producir duración cero.
        assert segmentos == [(0.0, duracion)], (
            "P5a (D-VACIO): al borrar todo debe conservarse [(0, duracion)]"
        )
    else:
        # En cada región elemental, "conservado" debe ser EXACTAMENTE lo contrario
        # de "borrado". Esto equivale a: conservados == [0,duracion] \ borrados.
        for a, b in elementales:
            medio = (a + b) / 2.0
            en_borrado = _cubierto(medio, borrados)
            en_conservado = _cubierto(medio, segmentos)
            assert en_conservado == (not en_borrado), (
                f"P5a: región {(a, b)} conservado={en_conservado} "
                f"pero borrado={en_borrado} (deberían ser opuestos)"
            )
