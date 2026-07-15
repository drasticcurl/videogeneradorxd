"""Tests de los endpoints de la edición avanzada de shorts (tarea 5.5).

Cubre los códigos ``200/202/400/404/409`` de los tres endpoints de las pausas
de edición manual (spec ``edicion-avanzada-shorts``):

* ``GET/POST /silencios/{id}`` — timeline de silencios sobre el vídeo unido
  (Req 2, 5, 14, 15).
* ``GET/POST /subtitulos/{id}`` — revisión de subtítulos de SOLO TEXTO
  (Req 6, 7, 14).
* ``GET/POST /render/{id}`` — edición final con textos extra y render Remotion
  (Req 8, 10, 11, 14, 15).

Patrón de pruebas (reutilizado de ``test_endpoints_nuevos.py`` / ``test_api.py``):

* ``fastapi.testclient.TestClient`` con la verificación de dependencias del
  arranque sustituida por un doble que siempre pasa.
* Gestor de Jobs (:class:`~app.jobs.manager.JobManager`) y ejecutor
  (:class:`~app.jobs.runner.JobRunner`) inyectados vía ``app.dependency_overrides``.
* El ejecutor se sustituye por un **espía** (:class:`_RunnerEspia`) que NO lanza
  trabajo real: registra las reanudaciones solicitadas sin ejecutar el pipeline.
  Así las pruebas son deterministas y permiten verificar que **ninguna rama de
  error muta el estado del Job** ni dispara una reanudación.

Los Jobs se colocan en el estado de pausa requerido con los marcadores del
Gestor (``marcar_esperando_edicion_silencios``, ``marcar_esperando_revision``,
``marcar_esperando_edicion_final``), sin ejecutar el pipeline real.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator, List, Optional, Tuple

from fastapi.testclient import TestClient

import main
from app import config
from app.api import process as process_api
from app.api import render as render_api
from app.deps import checker as _deps_checker
from app.engine.ffprobe import ClipInfo
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.job import JobStatus
from app.models.settings import (
    Ajustes,
    AjustesGenerales,
    GrupoSubtitulo,
    Palabra,
    ResolucionObjetivo,
    TramoSilencio,
)


# ---------------------------------------------------------------------------
# Utilidades de arranque / inyección (mismo patrón que test_endpoints_nuevos.py)
# ---------------------------------------------------------------------------
def _verificacion_ok(*_a, **_k) -> _deps_checker.ResultadoVerificacion:
    """Doble del verificador de dependencias: todas disponibles (no bloquea)."""
    return _deps_checker.ResultadoVerificacion(
        resultados=[
            _deps_checker.ResultadoDependencia(nombre=n, disponible=True)
            for n in _deps_checker.DEPENDENCIAS
        ]
    )


class _RunnerEspia(JobRunner):
    """Ejecutor espía: registra las reanudaciones SIN ejecutar el pipeline real.

    Sobrescribe los tres lanzadores en background para que sean no-ops
    asíncronos que solo anotan la llamada recibida. De este modo los endpoints
    responden ``202`` de inmediato (como en producción) pero el Job NO cambia de
    estado por trabajo en segundo plano, lo que hace las pruebas deterministas y
    permite comprobar exactamente qué reanudación se disparó (o que no se disparó
    ninguna en las ramas de error).
    """

    def __init__(self, manager: JobManager) -> None:
        super().__init__(manager)
        self.silencios_lanzados: List[Tuple[str, list]] = []
        self.revisiones_lanzadas: List[Tuple[str, list]] = []
        self.renders_lanzados: List[Tuple[str, str]] = []

    async def lanzar_reanudacion_silencios(  # type: ignore[override]
        self, job_id: str, tramos_editados
    ) -> None:
        self.silencios_lanzados.append((job_id, list(tramos_editados)))

    async def lanzar_reanudacion(self, job_id: str, grupos) -> None:  # type: ignore[override]
        self.revisiones_lanzadas.append((job_id, list(grupos)))

    async def lanzar_reanudacion_render(  # type: ignore[override]
        self, job_id: str, motor: str = "remotion"
    ) -> None:
        self.renders_lanzados.append((job_id, motor))


@contextmanager
def _cliente(
    manager: JobManager, runner: Optional[JobRunner] = None
) -> Iterator[Tuple[TestClient, _RunnerEspia]]:
    """Cliente de pruebas con Gestor y ejecutor espía inyectados.

    Devuelve la tupla ``(client, runner)`` para poder inspeccionar en la prueba
    qué reanudaciones registró el espía.
    """
    ejecutor = runner if runner is not None else _RunnerEspia(manager)
    main.verificar_dependencias = _verificacion_ok  # type: ignore[assignment]
    main.app.dependency_overrides[process_api.obtener_gestor_jobs] = lambda: manager
    main.app.dependency_overrides[process_api.obtener_job_runner] = lambda: ejecutor
    try:
        yield TestClient(main.app), ejecutor  # type: ignore[misc]
    finally:
        main.app.dependency_overrides.pop(process_api.obtener_gestor_jobs, None)
        main.app.dependency_overrides.pop(process_api.obtener_job_runner, None)


def _url_workfile(job_id: str, nombre: str) -> str:
    """URL HTTP esperada del artefacto servido por ``GET /workfile/{id}/{nombre}``."""
    return (
        f"http://{config.BACKEND_HOST}:{config.BACKEND_PORT}"
        f"/workfile/{job_id}/{nombre}"
    )


# ---------------------------------------------------------------------------
# Helpers para colocar un Job en cada estado de pausa (sin ejecutar el pipeline)
# ---------------------------------------------------------------------------
def _job_en_edicion_silencios(
    manager: JobManager,
    job_id: str,
    *,
    duracion: float = 10.0,
    ajustes: Optional[Ajustes] = None,
) -> None:
    """Crea un Job y lo pausa en ``ESPERANDO_EDICION_SILENCIOS``.

    Persiste el vídeo unido, dos tramos de silencio detectados (ordenados y sin
    solapes) y la duración total, tal como haría el pipeline tras UNIR + detectar.
    """
    manager.crear_job(job_id, ["a"], ajustes or Ajustes(), workdir="wd")
    tramos = [
        TramoSilencio(inicio_s=1.0, fin_s=2.0),
        TramoSilencio(inicio_s=5.0, fin_s=6.5),
    ]
    manager.marcar_esperando_edicion_silencios(
        job_id, "/tmp/wd/unido.mp4", tramos, duracion
    )


def _job_en_revision(manager: JobManager, job_id: str) -> None:
    """Crea un Job y lo pausa en ``ESPERANDO_REVISION`` con dos grupos."""
    manager.crear_job(job_id, ["a"], Ajustes(), workdir="wd")
    grupos = [
        GrupoSubtitulo(texto="hola mundo", inicio_s=0.0, fin_s=1.0),
        GrupoSubtitulo(texto="segundo grupo", inicio_s=1.0, fin_s=2.0),
    ]
    manager.marcar_esperando_revision(job_id, "/tmp/wd/cortado.mp4", grupos)


def _job_en_edicion_final(
    manager: JobManager,
    job_id: str,
    *,
    cortado_path: str = "/tmp/wd/cortado.mp4",
    ajustes: Optional[Ajustes] = None,
) -> None:
    """Crea un Job y lo pausa en ``ESPERANDO_EDICION_FINAL`` con grupos finales."""
    manager.crear_job(job_id, ["a"], ajustes or Ajustes(), workdir="wd")
    grupos = [
        GrupoSubtitulo(
            texto="hola mundo",
            inicio_s=0.0,
            fin_s=1.0,
            palabras=[
                Palabra(texto="hola", inicio_s=0.0, fin_s=0.5),
                Palabra(texto="mundo", inicio_s=0.5, fin_s=1.0),
            ],
        ),
        GrupoSubtitulo(texto="segundo grupo", inicio_s=1.0, fin_s=2.0, palabras=None),
    ]
    manager.marcar_esperando_edicion_final(job_id, cortado_path, grupos)


def _inspector_ok(duracion_s: Optional[float]):
    """Inspector de clips falso que no lanza y expone ``duracion_s`` determinista."""

    def _fn(ruta: str) -> ClipInfo:
        return ClipInfo(
            ruta=ruta,
            ancho=1080,
            alto=1920,
            rotacion=0,
            fps=30.0,
            duracion_s=duracion_s,
            tiene_video=True,
            tiene_audio=True,
        )

    return _fn


@contextmanager
def _inspector_inyectado(fn) -> Iterator[None]:
    """Inyecta ``fn`` como inspector por defecto de ``construir_respuesta_render``.

    ``GET /render`` llama a ``construir_respuesta_render(job)`` con su inspector
    por defecto (``inspeccionar_clip``); para las pruebas se sustituye por un
    doble determinista y se restaura al salir del contexto.
    """
    original = render_api.construir_respuesta_render.__defaults__
    render_api.construir_respuesta_render.__defaults__ = (fn,)
    try:
        yield
    finally:
        render_api.construir_respuesta_render.__defaults__ = original


# ===========================================================================
# GET /silencios/{id} (Req 2.1-2.4)
# ===========================================================================
def test_get_silencios_en_pausa_devuelve_contrato_editable() -> None:
    """En ``ESPERANDO_EDICION_SILENCIOS`` devuelve tramos, duración, URL del vídeo
    unido, fps/ancho/alto y ``editable=true`` (Req 2.1, 2.3)."""
    manager = JobManager()
    ajustes = Ajustes(
        generales=AjustesGenerales(
            resolucion=ResolucionObjetivo(ancho=720, alto=1280), fps=24
        )
    )
    _job_en_edicion_silencios(manager, "job-sil", duracion=12.0, ajustes=ajustes)

    with _cliente(manager) as (client, _runner):
        resp = client.get("/silencios/job-sil")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["estado"] == "esperando_edicion_silencios"
    assert body["editable"] is True
    assert body["duracion_s"] == 12.0
    assert body["video_nombre"] == "unido.mp4"
    assert body["video_url"] == _url_workfile("job-sil", "unido.mp4")
    assert body["fps"] == 24
    assert body["ancho"] == 720
    assert body["alto"] == 1280
    # Tramos detectados, ordenados y sin solapes, con el contrato {inicio_s, fin_s}.
    assert body["tramos"] == [
        {"inicio_s": 1.0, "fin_s": 2.0},
        {"inicio_s": 5.0, "fin_s": 6.5},
    ]


def test_get_silencios_editable_false_en_otro_estado() -> None:
    """Si el Job NO está en la pausa de silencios, ``editable`` es ``false`` (Req 2.4)."""
    manager = JobManager()
    manager.crear_job("job-cola", ["a"], Ajustes(), workdir="wd")  # estado EN_COLA

    with _cliente(manager) as (client, _runner):
        resp = client.get("/silencios/job-cola")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["estado"] == "en_cola"
    assert body["editable"] is False


def test_get_silencios_job_inexistente_404() -> None:
    """``GET /silencios`` sobre un Job inexistente responde ``404 JOB_NOT_FOUND`` (Req 2.2)."""
    with _cliente(JobManager()) as (client, _runner):
        resp = client.get("/silencios/no-existe")

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"


# ---------------------------------------------------------------------------
# REGRESIÓN (bug de producción): el pipeline entrega los silencios como TUPLAS
# ``(inicio_s, fin_s)`` (no como ``TramoSilencio``). El runner real llama a
# ``marcar_esperando_edicion_silencios`` con esas tuplas y ``GET /silencios``
# rompía con ``AttributeError: 'tuple' object has no attribute 'model_dump'``.
# El fixture ``_job_en_edicion_silencios`` usaba ``TramoSilencio``, por eso NO
# cazaba el bug; aquí reproducimos la FORMA REAL del pipeline con tuplas.
# ---------------------------------------------------------------------------
def _job_en_edicion_silencios_tuplas(
    manager: JobManager,
    job_id: str,
    *,
    silencios: list,
    duracion: float = 15.0,
    ajustes: Optional[Ajustes] = None,
) -> None:
    """Pausa un Job en ``ESPERANDO_EDICION_SILENCIOS`` pasando TUPLAS de silencio.

    Reproduce exactamente cómo el runner real invoca al Gestor: los tramos vienen
    del pipeline como ``List[Tuple[float, float]]`` (no como ``TramoSilencio``).
    """
    manager.crear_job(job_id, ["a"], ajustes or Ajustes(), workdir="wd")
    manager.marcar_esperando_edicion_silencios(
        job_id, "/tmp/wd/unido.mp4", silencios, duracion
    )


def test_get_silencios_con_tuplas_del_pipeline_no_rompe_200() -> None:
    """REGRESIÓN: con tramos-tupla (forma real del pipeline) ``GET /silencios``
    responde ``200`` y serializa ``tramos`` como ``{inicio_s, fin_s}`` (bug #21).

    Antes del arreglo esto lanzaba ``AttributeError`` (500) porque
    ``silencios_detectados`` quedaban como tuplas y ``t.model_dump()`` fallaba.
    """
    manager = JobManager()
    _job_en_edicion_silencios_tuplas(
        manager, "job-sil-tuplas", silencios=[(1.0, 2.0), (5.0, 6.5)], duracion=15.0
    )

    with _cliente(manager) as (client, _runner):
        resp = client.get("/silencios/job-sil-tuplas")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["editable"] is True
    assert body["tramos"] == [
        {"inicio_s": 1.0, "fin_s": 2.0},
        {"inicio_s": 5.0, "fin_s": 6.5},
    ]


def test_marcar_esperando_edicion_silencios_coacciona_tuplas_a_tramosilencio() -> None:
    """REGRESIÓN (unitario del Gestor): tras pasar TUPLAS, ``silencios_detectados``
    queda como ``List[TramoSilencio]`` (cumple el tipo declarado del ``JobState``).
    """
    manager = JobManager()
    manager.crear_job("job-coacc", ["a"], Ajustes(), workdir="wd")
    manager.marcar_esperando_edicion_silencios(
        "job-coacc", "/tmp/wd/unido.mp4", [(1.0, 2.0), (5.0, 6.5)], 15.0
    )

    detectados = manager.obtener("job-coacc").silencios_detectados
    assert detectados is not None
    assert all(isinstance(t, TramoSilencio) for t in detectados)
    assert [(t.inicio_s, t.fin_s) for t in detectados] == [(1.0, 2.0), (5.0, 6.5)]


def test_marcar_esperando_edicion_silencios_idempotente_con_tramosilencio() -> None:
    """La coacción es idempotente: pasar ``TramoSilencio`` ya construidos también
    deja ``silencios_detectados`` como ``List[TramoSilencio]`` intacto."""
    manager = JobManager()
    manager.crear_job("job-idemp", ["a"], Ajustes(), workdir="wd")
    tramos = [TramoSilencio(inicio_s=1.0, fin_s=2.0)]
    manager.marcar_esperando_edicion_silencios(
        "job-idemp", "/tmp/wd/unido.mp4", tramos, 15.0
    )

    detectados = manager.obtener("job-idemp").silencios_detectados
    assert detectados is not None
    assert all(isinstance(t, TramoSilencio) for t in detectados)
    assert [(t.inicio_s, t.fin_s) for t in detectados] == [(1.0, 2.0)]


# ===========================================================================
# POST /silencios/{id} (Req 5.1-5.4, 15.1, 15.2)
# ===========================================================================
def test_post_silencios_valido_reanuda_202() -> None:
    """Con tramos válidos en la pausa correcta responde ``202`` + ``EN_EJECUCION``
    y dispara la reanudación desde silencios (Req 5.1)."""
    manager = JobManager()
    _job_en_edicion_silencios(manager, "job-sil-ok", duracion=10.0)

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/silencios/job-sil-ok",
            json={"tramos": [{"inicio_s": 1.0, "fin_s": 2.0}]},
        )

    assert resp.status_code == 202, resp.text
    assert resp.json()["estado"] == "en_ejecucion"
    # Se lanzó exactamente una reanudación de silencios con los tramos enviados.
    assert runner.silencios_lanzados == [("job-sil-ok", [(1.0, 2.0)])]


def test_post_silencios_lista_vacia_es_valida_202() -> None:
    """Una lista de tramos vacía es válida (no se borra nada) y reanuda (Req 1.4, 5.5)."""
    manager = JobManager()
    _job_en_edicion_silencios(manager, "job-sil-vacio", duracion=10.0)

    with _cliente(manager) as (client, runner):
        resp = client.post("/silencios/job-sil-vacio", json={"tramos": []})

    assert resp.status_code == 202, resp.text
    assert runner.silencios_lanzados == [("job-sil-vacio", [])]


def test_post_silencios_job_inexistente_404_sin_reanudar() -> None:
    """``POST /silencios`` sobre un Job inexistente responde ``404`` sin reanudar (Req 5.2)."""
    with _cliente(JobManager()) as (client, runner):
        resp = client.post(
            "/silencios/no-existe", json={"tramos": [{"inicio_s": 0.0, "fin_s": 1.0}]}
        )

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"
    assert runner.silencios_lanzados == []


def test_post_silencios_conflicto_si_no_esta_en_pausa() -> None:
    """Fuera de ``ESPERANDO_EDICION_SILENCIOS`` responde ``409 CONFLICT`` sin mutar
    el estado ni reanudar (Req 5.4)."""
    manager = JobManager()
    manager.crear_job("job-cola2", ["a"], Ajustes(), workdir="wd")  # EN_COLA

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/silencios/job-cola2", json={"tramos": [{"inicio_s": 0.0, "fin_s": 1.0}]}
        )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "CONFLICT"
    # El estado del Job no cambió y no se disparó ninguna reanudación.
    assert manager.obtener("job-cola2").progreso.estado == JobStatus.EN_COLA
    assert runner.silencios_lanzados == []


def test_post_silencios_tramo_fin_menor_que_inicio_400() -> None:
    """Un tramo con ``fin_s <= inicio_s`` es inválido => ``400 INVALID_REQUEST``
    sin mutar el estado ni reanudar (Req 5.3, 15.1)."""
    manager = JobManager()
    _job_en_edicion_silencios(manager, "job-sil-inv", duracion=10.0)

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/silencios/job-sil-inv",
            json={"tramos": [{"inicio_s": 5.0, "fin_s": 3.0}]},
        )

    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert body["error"]["details"]["tramos_invalidos"] == ["tramos[0]"]
    assert manager.obtener("job-sil-inv").progreso.estado == (
        JobStatus.ESPERANDO_EDICION_SILENCIOS
    )
    assert runner.silencios_lanzados == []


def test_post_silencios_tramo_fuera_de_duracion_400() -> None:
    """Un tramo fuera de ``[0, duración]`` es inválido => ``400`` sin reanudar (Req 5.3, 15.2)."""
    manager = JobManager()
    _job_en_edicion_silencios(manager, "job-sil-rango", duracion=10.0)

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/silencios/job-sil-rango",
            json={"tramos": [{"inicio_s": 8.0, "fin_s": 20.0}]},  # fin > duración
        )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_REQUEST"
    assert runner.silencios_lanzados == []


# ===========================================================================
# GET /subtitulos/{id} (Req 6.2, 6.5)
# ===========================================================================
def test_get_subtitulos_en_revision_editable() -> None:
    """En ``ESPERANDO_REVISION`` devuelve los grupos con texto y ``editable=true`` (Req 6.2)."""
    manager = JobManager()
    _job_en_revision(manager, "job-rev")

    with _cliente(manager) as (client, _runner):
        resp = client.get("/subtitulos/job-rev")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["estado"] == "esperando_revision"
    assert body["editable"] is True
    assert [g["texto"] for g in body["grupos"]] == ["hola mundo", "segundo grupo"]


def test_get_subtitulos_editable_false_en_otro_estado() -> None:
    """Si el Job no está en revisión, ``editable`` es ``false`` (Req 6.5)."""
    manager = JobManager()
    manager.crear_job("job-rev-cola", ["a"], Ajustes(), workdir="wd")

    with _cliente(manager) as (client, _runner):
        resp = client.get("/subtitulos/job-rev-cola")

    assert resp.status_code == 200, resp.text
    assert resp.json()["editable"] is False


def test_get_subtitulos_job_inexistente_404() -> None:
    """``GET /subtitulos`` sobre un Job inexistente responde ``404 JOB_NOT_FOUND``."""
    with _cliente(JobManager()) as (client, _runner):
        resp = client.get("/subtitulos/no-existe")

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"


# ===========================================================================
# POST /subtitulos/{id} (Req 7.1-7.3, 7.5)
# ===========================================================================
def test_post_subtitulos_texto_valido_reanuda_202() -> None:
    """Con el mismo número de grupos y textos no vacíos responde ``202`` y reanuda
    la fase 2 (Req 7.1)."""
    manager = JobManager()
    _job_en_revision(manager, "job-rev-ok")

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/subtitulos/job-rev-ok",
            json={"grupos": [{"texto": "Hola Mundo"}, {"texto": "Segundo Grupo"}]},
        )

    assert resp.status_code == 202, resp.text
    assert resp.json()["estado"] == "en_ejecucion"
    # Se lanzó una única reanudación con dos grupos (texto confirmado).
    assert len(runner.revisiones_lanzadas) == 1
    job_id, grupos = runner.revisiones_lanzadas[0]
    assert job_id == "job-rev-ok"
    assert [g.texto for g in grupos] == ["Hola Mundo", "Segundo Grupo"]


def test_post_subtitulos_conflicto_si_no_esta_en_revision() -> None:
    """Fuera de ``ESPERANDO_REVISION`` responde ``409 CONFLICT`` sin reanudar (Req 7.5)."""
    manager = JobManager()
    manager.crear_job("job-rev-x", ["a"], Ajustes(), workdir="wd")  # EN_COLA

    with _cliente(manager) as (client, runner):
        resp = client.post("/subtitulos/job-rev-x", json={"grupos": [{"texto": "x"}]})

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "CONFLICT"
    assert manager.obtener("job-rev-x").progreso.estado == JobStatus.EN_COLA
    assert runner.revisiones_lanzadas == []


def test_post_subtitulos_conteo_distinto_400() -> None:
    """Si la cantidad de grupos difiere de la propuesta => ``400`` sin reanudar (Req 7.2)."""
    manager = JobManager()
    _job_en_revision(manager, "job-rev-cnt")  # 2 grupos propuestos

    with _cliente(manager) as (client, runner):
        # Solo 1 grupo cuando había 2 propuestos.
        resp = client.post("/subtitulos/job-rev-cnt", json={"grupos": [{"texto": "uno"}]})

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_REQUEST"
    assert manager.obtener("job-rev-cnt").progreso.estado == (
        JobStatus.ESPERANDO_REVISION
    )
    assert runner.revisiones_lanzadas == []


def test_post_subtitulos_texto_vacio_tras_trim_400() -> None:
    """Si algún texto queda vacío tras ``trim`` => ``400`` sin reanudar (Req 7.3)."""
    manager = JobManager()
    _job_en_revision(manager, "job-rev-vacio")

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/subtitulos/job-rev-vacio",
            json={"grupos": [{"texto": "Hola"}, {"texto": "   "}]},  # 2º vacío tras trim
        )

    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert body["error"]["details"]["grupos_vacios"] == [1]
    assert runner.revisiones_lanzadas == []


def test_post_subtitulos_job_inexistente_404() -> None:
    """``POST /subtitulos`` sobre un Job inexistente responde ``404 JOB_NOT_FOUND``."""
    with _cliente(JobManager()) as (client, runner):
        resp = client.post("/subtitulos/no-existe", json={"grupos": [{"texto": "x"}]})

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"
    assert runner.revisiones_lanzadas == []


# ===========================================================================
# GET /render/{id} (Req 8.2, 10.1)
# ===========================================================================
def test_get_render_en_edicion_final_incluye_textos_extra_y_video() -> None:
    """En ``ESPERANDO_EDICION_FINAL`` incluye ``textos_extra`` (vacío por defecto),
    datos del vídeo cortado y ``editable=true`` (Req 8.2, 10.1)."""
    manager = JobManager()
    ajustes = Ajustes(
        generales=AjustesGenerales(
            resolucion=ResolucionObjetivo(ancho=720, alto=1280), fps=24
        )
    )
    _job_en_edicion_final(
        manager, "job-fin", cortado_path="/tmp/wd/cortado.mp4", ajustes=ajustes
    )

    with _inspector_inyectado(_inspector_ok(9.5)), _cliente(manager) as (client, _r):
        resp = client.get("/render/job-fin")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["estado"] == "esperando_edicion_final"
    assert body["editable"] is True
    # Textos extra vigentes: lista vacía cuando el usuario aún no añadió ninguno.
    assert body["textos_extra"] == []
    # Datos del vídeo cortado para la previsualización final.
    assert body["video_nombre"] == "cortado.mp4"
    assert body["video_url"] == _url_workfile("job-fin", "cortado.mp4")
    assert body["fps"] == 24
    assert body["ancho"] == 720
    assert body["alto"] == 1280
    assert body["duracion_s"] == 9.5


def test_get_render_editable_false_en_otro_estado() -> None:
    """Si el Job no está en la edición final, ``editable`` es ``false`` (Req 8.2)."""
    manager = JobManager()
    manager.crear_job("job-fin-cola", ["a"], Ajustes(), workdir="wd")  # EN_COLA

    with _cliente(manager) as (client, _runner):
        resp = client.get("/render/job-fin-cola")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["editable"] is False
    assert body["textos_extra"] == []


# ===========================================================================
# POST /render/{id} (Req 10.1, 10.5, 11.2-11.5, 15.3-15.5)
# ===========================================================================
def _texto_extra_valido(texto: str = "Hook", inicio_s: float = 0.0, fin_s: float = 1.0) -> dict:
    """Construye un texto extra válido (rango temporal y estilo dentro de rango)."""
    return {
        "texto": texto,
        "inicio_s": inicio_s,
        "fin_s": fin_s,
        "estilo": {
            "fuente": "Arial",
            "tamano": 64,
            "color": "#FFFFFF",
            "color_borde": "#000000",
            "grosor_borde": 6,
            "negrita": True,
            "pos_vertical_pct": 20.0,
            "pos_horizontal_pct": 50.0,
        },
    }


def test_post_render_valido_motor_omitido_reanuda_202() -> None:
    """Con textos válidos y ``motor`` omitido responde ``202``, persiste los textos
    y reanuda el render con Remotion (Req 10.1, 11.2, 11.4)."""
    manager = JobManager()
    _job_en_edicion_final(manager, "job-r-ok")

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/render/job-r-ok",
            json={"textos_extra": [_texto_extra_valido()]},
        )

    assert resp.status_code == 202, resp.text
    assert resp.json()["estado"] == "en_ejecucion"
    # Se reanudó SIEMPRE con Remotion.
    assert runner.renders_lanzados == [("job-r-ok", "remotion")]
    # Los textos extra quedaron persistidos en el Job (Req 10.1).
    textos = manager.obtener("job-r-ok").textos_extra
    assert textos is not None and len(textos) == 1
    assert textos[0].texto == "Hook"


def test_post_render_motor_remotion_explicito_202() -> None:
    """``motor="remotion"`` explícito es aceptado (Req 11.3)."""
    manager = JobManager()
    _job_en_edicion_final(manager, "job-r-rem")

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/render/job-r-rem",
            json={"textos_extra": [], "motor": "remotion"},
        )

    assert resp.status_code == 202, resp.text
    assert runner.renders_lanzados == [("job-r-rem", "remotion")]


def test_post_render_motor_invalido_400_sin_mutar() -> None:
    """Un ``motor`` distinto de ``"remotion"`` => ``400`` sin reanudar ni mutar (Req 11.5)."""
    manager = JobManager()
    _job_en_edicion_final(manager, "job-r-motor")

    with _cliente(manager) as (client, runner):
        resp = client.post("/render/job-r-motor", json={"motor": "ffmpeg"})

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_REQUEST"
    assert manager.obtener("job-r-motor").progreso.estado == (
        JobStatus.ESPERANDO_EDICION_FINAL
    )
    assert manager.obtener("job-r-motor").textos_extra is None
    assert runner.renders_lanzados == []


def test_post_render_motor_sensible_a_mayusculas_400() -> None:
    """La comparación de ``motor`` es sensible a mayúsculas: ``"Remotion"`` => ``400`` (Req 11.3)."""
    manager = JobManager()
    _job_en_edicion_final(manager, "job-r-may")

    with _cliente(manager) as (client, runner):
        resp = client.post("/render/job-r-may", json={"motor": "Remotion"})

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_REQUEST"
    assert runner.renders_lanzados == []


def test_post_render_mas_de_dos_textos_400() -> None:
    """Más de 2 textos extra => ``400 INVALID_REQUEST`` sin reanudar (Req 10.5, 15.3)."""
    manager = JobManager()
    _job_en_edicion_final(manager, "job-r-3")

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/render/job-r-3",
            json={
                "textos_extra": [
                    _texto_extra_valido("A"),
                    _texto_extra_valido("B"),
                    _texto_extra_valido("C"),
                ]
            },
        )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_REQUEST"
    assert manager.obtener("job-r-3").textos_extra is None
    assert runner.renders_lanzados == []


def test_post_render_texto_rango_temporal_invalido_400() -> None:
    """Un texto extra con ``inicio_s >= fin_s`` => ``400`` sin reanudar (Req 10.5, 15.4)."""
    manager = JobManager()
    _job_en_edicion_final(manager, "job-r-temp")

    with _cliente(manager) as (client, runner):
        resp = client.post(
            "/render/job-r-temp",
            json={"textos_extra": [_texto_extra_valido(inicio_s=5.0, fin_s=2.0)]},
        )

    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert "rango_temporal" in body["error"]["details"]["campos"]
    assert manager.obtener("job-r-temp").textos_extra is None
    assert runner.renders_lanzados == []


def test_post_render_texto_estilo_fuera_de_rango_400() -> None:
    """Un texto extra con estilo fuera de rango (``tamano`` < 12) => ``400`` (Req 10.5, 15.5)."""
    manager = JobManager()
    _job_en_edicion_final(manager, "job-r-estilo")

    texto = _texto_extra_valido()
    texto["estilo"]["tamano"] = 5  # fuera del rango del motor 12..200

    with _cliente(manager) as (client, runner):
        resp = client.post("/render/job-r-estilo", json={"textos_extra": [texto]})

    assert resp.status_code == 400
    body = resp.json()
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert "estilo.tamano" in body["error"]["details"]["campos"]
    assert runner.renders_lanzados == []


def test_post_render_conflicto_si_no_esta_en_edicion_final() -> None:
    """Fuera de ``ESPERANDO_EDICION_FINAL`` responde ``409 CONFLICT`` sin reanudar (Req 14.3)."""
    manager = JobManager()
    manager.crear_job("job-r-cola", ["a"], Ajustes(), workdir="wd")  # EN_COLA

    with _cliente(manager) as (client, runner):
        resp = client.post("/render/job-r-cola", json={"textos_extra": []})

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "CONFLICT"
    assert manager.obtener("job-r-cola").progreso.estado == JobStatus.EN_COLA
    assert runner.renders_lanzados == []


def test_post_render_job_inexistente_404() -> None:
    """``POST /render`` sobre un Job inexistente responde ``404`` sin reanudar (Req 14.2)."""
    with _cliente(JobManager()) as (client, runner):
        resp = client.post("/render/no-existe", json={"textos_extra": []})

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"
    assert runner.renders_lanzados == []
