"""Tests property-based del contrato de ``GET /render/{id}`` (spec
previsualizacion-video-real-remotion, tarea 1.3).

Propiedad bajo prueba (P: respuesta consistente y de solo lectura): para
``JobState`` arbitrarios —con o sin ``cortado_path``, distintos
``ajustes.generales`` y grupos con o sin ``palabras``—, la función pura
:func:`app.api.render.construir_respuesta_render` cumple:

* ``video_url``/``video_nombre`` son ``None`` **si y solo si** ``cortado_path``
  es ``None`` (Req 1.2, 1.3); cuando hay ``cortado_path``, la URL sigue el patrón
  ``http://{BACKEND_HOST}:{BACKEND_PORT}/workfile/{job_id}/{nombre}``.
* ``fps``/``ancho``/``alto`` reflejan exactamente ``ajustes.generales`` (Req 1.4).
* ``grupos`` conserva el campo ``palabras`` de cada grupo, con el mismo texto y
  los mismos tiempos que el ``JobState`` de origen (Req 1.6).
* la respuesta NO muta el ``job`` (operación de solo lectura, Req 1.7).

Se inyecta un inspector de clips falso (``inspeccionar_fn``) para no depender de
``ffprobe`` real; su valor de duración no afecta a las propiedades anteriores,
salvo que ``duracion_s`` debe ser ``None`` cuando no hay vídeo que inspeccionar.

Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6, 1.7
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app import config
from app.api.render import construir_respuesta_render
from app.engine.ffprobe import ClipInfo
from app.models.job import JobState, JobStatus, Progress
from app.models.settings import (
    Ajustes,
    AjustesGenerales,
    GrupoSubtitulo,
    Palabra,
    ResolucionObjetivo,
)

# ---------------------------------------------------------------------------
# Inspector de clips falso (evita depender de ffprobe real en el PBT)
# ---------------------------------------------------------------------------
_DURACION_FALSA = 12.3


def _inspector_falso(ruta: str) -> ClipInfo:
    """Inspector inyectable que devuelve un :class:`ClipInfo` fijo y determinista.

    No lanza nunca; su ``duracion_s`` es irrelevante para las propiedades de este
    test (solo se comprueba que ``duracion_s`` es ``None`` cuando NO hay
    ``cortado_path``).
    """
    return ClipInfo(
        ruta=ruta,
        ancho=1080,
        alto=1920,
        rotacion=0,
        fps=30.0,
        duracion_s=_DURACION_FALSA,
        tiene_video=True,
        tiene_audio=True,
    )


# ---------------------------------------------------------------------------
# Estrategias de generación
# ---------------------------------------------------------------------------
# Tiempos en segundos: finitos, no negativos y acotados (evita NaN/inf).
_tiempo = st.floats(
    min_value=0.0, max_value=100_000.0, allow_nan=False, allow_infinity=False
)
# Tiempo opcional (una palabra puede carecer de timestamps válidos).
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

    ``palabras`` puede ser ``None`` (grupo sin palabras), una lista vacía o una
    lista de palabras con o sin tiempos.
    """
    inicio = draw(_tiempo)
    delta = draw(st.floats(min_value=0.0, max_value=60.0, allow_nan=False, allow_infinity=False))
    palabras = draw(
        st.one_of(
            st.none(),
            st.lists(_estrategia_palabra(), max_size=5),
        )
    )
    return GrupoSubtitulo(
        texto=draw(st.text(max_size=40)),
        inicio_s=inicio,
        fin_s=inicio + delta,
        palabras=palabras,
    )


@st.composite
def _estrategia_generales(draw: st.DrawFn) -> AjustesGenerales:
    """Genera ``AjustesGenerales`` con fps/resolución dentro del rango del motor."""
    return AjustesGenerales(
        resolucion=ResolucionObjetivo(
            ancho=draw(st.integers(min_value=2, max_value=7680)),
            alto=draw(st.integers(min_value=2, max_value=7680)),
        ),
        fps=draw(st.integers(min_value=1, max_value=120)),
    )


@st.composite
def _estrategia_job(draw: st.DrawFn) -> JobState:
    """Genera un :class:`JobState` variado para ejercitar ``construir_respuesta_render``.

    Varía: presencia de ``cortado_path``, ``ajustes.generales``, la lista de
    ``grupos_finales`` (con/sin palabras, o ``None``) y el estado del Job.
    """
    ajustes = Ajustes(generales=draw(_estrategia_generales()))

    grupos = draw(
        st.one_of(
            st.none(),
            st.lists(_estrategia_grupo(), max_size=6),
        )
    )

    # ``cortado_path``: ausente (None) o un nombre de fichero de vídeo.
    cortado = draw(
        st.one_of(
            st.none(),
            st.builds(
                lambda carpeta, nombre: f"/tmp/{carpeta}/{nombre}.mp4",
                st.text(
                    alphabet="abcdefghijklmnopqrstuvwxyz0123456789_",
                    min_size=1,
                    max_size=8,
                ),
                st.text(
                    alphabet="abcdefghijklmnopqrstuvwxyz0123456789_",
                    min_size=1,
                    max_size=8,
                ),
            ),
        )
    )

    estado = draw(st.sampled_from(list(JobStatus)))
    job_id = draw(
        st.text(
            alphabet="abcdefghijklmnopqrstuvwxyz0123456789-",
            min_size=1,
            max_size=16,
        )
    )

    return JobState(
        id=job_id,
        orden_clips=["clip-a"],
        ajustes=ajustes,
        workdir="wd",
        progreso=Progress(estado=estado),
        grupos_finales=grupos,
        cortado_path=cortado,
    )


# ---------------------------------------------------------------------------
# Propiedad: respuesta consistente y de solo lectura
# ---------------------------------------------------------------------------
@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(job=_estrategia_job())
def test_respuesta_render_consistente_y_solo_lectura(job: JobState) -> None:
    """La respuesta de ``GET /render`` es consistente con el Job y no lo muta.

    Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6, 1.7
    """
    # Instantánea profunda del Job ANTES de construir la respuesta (Req 1.7).
    snapshot_antes = job.model_dump()

    respuesta = construir_respuesta_render(job, inspeccionar_fn=_inspector_falso)

    # --- Req 1.2/1.3: video_url/video_nombre son None sii cortado_path es None ---
    if job.cortado_path is None:
        assert respuesta["video_url"] is None
        assert respuesta["video_nombre"] is None
        # Sin vídeo que inspeccionar, la duración también es None (Req 1.5).
        assert respuesta["duracion_s"] is None
    else:
        nombre_esperado = Path(job.cortado_path).name
        url_esperada = (
            f"http://{config.BACKEND_HOST}:{config.BACKEND_PORT}"
            f"/workfile/{job.id}/{nombre_esperado}"
        )
        assert respuesta["video_nombre"] == nombre_esperado
        assert respuesta["video_url"] == url_esperada
        # Con inspector inyectado que no lanza, duracion_s refleja su valor.
        assert respuesta["duracion_s"] == _DURACION_FALSA

    # --- Req 1.4: fps/ancho/alto reflejan ajustes.generales ---
    generales = job.ajustes.generales
    assert respuesta["fps"] == generales.fps
    assert respuesta["ancho"] == generales.resolucion.ancho
    assert respuesta["alto"] == generales.resolucion.alto

    # --- Req 1.6: grupos conserva palabras (texto y tiempos) ---
    grupos_origen: List[GrupoSubtitulo] = job.grupos_finales or []
    assert len(respuesta["grupos"]) == len(grupos_origen)
    for grupo_dict, grupo_origen in zip(respuesta["grupos"], grupos_origen):
        # El campo 'palabras' SIEMPRE está presente (aserción de contrato).
        assert "palabras" in grupo_dict
        assert grupo_dict["texto"] == grupo_origen.texto

        palabras_origen: Optional[List[Palabra]] = grupo_origen.palabras
        if palabras_origen is None:
            assert grupo_dict["palabras"] is None
        else:
            assert len(grupo_dict["palabras"]) == len(palabras_origen)
            for palabra_dict, palabra_origen in zip(
                grupo_dict["palabras"], palabras_origen
            ):
                assert palabra_dict["texto"] == palabra_origen.texto
                assert palabra_dict["inicio_s"] == palabra_origen.inicio_s
                assert palabra_dict["fin_s"] == palabra_origen.fin_s

    # --- Req 1.1: la respuesta incluye todos los campos del contrato ampliado ---
    for campo in (
        "job_id",
        "estado",
        "editable",
        "motor_preferido",
        "grupos",
        "video_url",
        "video_nombre",
        "fps",
        "ancho",
        "alto",
        "duracion_s",
    ):
        assert campo in respuesta

    # --- Req 1.7: el job NO se muta (operación de solo lectura) ---
    assert job.model_dump() == snapshot_antes
