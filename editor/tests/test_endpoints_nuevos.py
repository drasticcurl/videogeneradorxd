"""Tests de los endpoints nuevos: /subtitulos/{id} y /configuracion.

Usan ``fastapi.testclient.TestClient`` con la verificación de dependencias del
arranque sustituida por un doble que siempre pasa, y el Gestor/ejecutor de Jobs
inyectados vía ``app.dependency_overrides`` (mismo patrón que ``test_api.py``).
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

from fastapi.testclient import TestClient

import main
from app import config
from app.api import process as process_api
from app.api import render as render_api
from app.deps import checker as _deps_checker
from app.engine.ffprobe import ClipInfo, ClipInspeccionError
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.job import JobStatus, PipelineStep
from app.models.settings import (
    Ajustes,
    AjustesGenerales,
    GrupoSubtitulo,
    Palabra,
    ResolucionObjetivo,
)
from app.storage import config_store
from app.storage.workdir import JobWorkdir


def _verificacion_ok(*_a, **_k) -> _deps_checker.ResultadoVerificacion:
    return _deps_checker.ResultadoVerificacion(
        resultados=[
            _deps_checker.ResultadoDependencia(nombre=n, disponible=True)
            for n in _deps_checker.DEPENDENCIAS
        ]
    )


def _fakes() -> Dict[str, object]:
    def fn_unir(job, orden, ancho, alto, fps, **kw):  # noqa: ANN001
        return job.resolve("unido.mp4")

    def fn_cortar(entrada, salida, **kw):  # noqa: ANN001
        return Path(salida)

    def fn_transcribir(entrada, at, audio, **kw):  # noqa: ANN001
        return []

    def fn_subtitulos(entrada, palabras, sub, res, ass, salida, **kw):  # noqa: ANN001
        return Path(salida)

    def fn_musica(entrada, mwav, mus, salida, **kw):  # noqa: ANN001
        return Path(salida)

    def fn_remotion(entrada, grupos, sub, res, fps, props, salida, **kw):  # noqa: ANN001
        # Doble del render Remotion: en el flujo de edición avanzada de shorts el
        # render es SIEMPRE con Remotion (Req 11.2). Devuelve la ruta de salida
        # sin invocar Node.
        return Path(salida)

    def fn_preservar(job, tmp):  # noqa: ANN001
        return job.output_path

    return dict(
        fn_unir=fn_unir,
        fn_cortar=fn_cortar,
        fn_transcribir=fn_transcribir,
        fn_subtitulos=fn_subtitulos,
        fn_musica=fn_musica,
        fn_remotion=fn_remotion,
        fn_preservar=fn_preservar,
    )


@contextmanager
def _cliente(
    manager: JobManager, runner: Optional[JobRunner] = None
) -> Iterator[TestClient]:
    ejecutor = runner if runner is not None else JobRunner(manager, **_fakes())
    main.verificar_dependencias = _verificacion_ok  # type: ignore[assignment]
    main.app.dependency_overrides[process_api.obtener_gestor_jobs] = lambda: manager
    main.app.dependency_overrides[process_api.obtener_job_runner] = lambda: ejecutor
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(process_api.obtener_gestor_jobs, None)
        main.app.dependency_overrides.pop(process_api.obtener_job_runner, None)


# ---------------------------------------------------------------------------
# /subtitulos/{id}
# ---------------------------------------------------------------------------
def _job_en_revision(manager: JobManager, job_id: str) -> None:
    manager.crear_job(job_id, ["a"], Ajustes(), workdir="wd")
    grupos = [
        GrupoSubtitulo(texto="hola mundo", inicio_s=0.0, fin_s=1.0),
        GrupoSubtitulo(texto="segundo grupo", inicio_s=1.0, fin_s=2.0),
    ]
    manager.marcar_esperando_revision(job_id, "/tmp/cortado.mp4", grupos)


def test_get_subtitulos_devuelve_grupos_editables() -> None:
    manager = JobManager()
    _job_en_revision(manager, "job-rev")
    with _cliente(manager) as client:
        resp = client.get("/subtitulos/job-rev")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["estado"] == "esperando_revision"
        assert body["editable"] is True
        assert [g["texto"] for g in body["grupos"]] == ["hola mundo", "segundo grupo"]


def test_get_subtitulos_job_inexistente_404() -> None:
    with _cliente(JobManager()) as client:
        resp = client.get("/subtitulos/no-existe")
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"


def test_post_subtitulos_conflicto_si_no_esta_en_revision() -> None:
    manager = JobManager()
    manager.crear_job("job-x", ["a"], Ajustes(), workdir="wd")  # estado en_cola
    with _cliente(manager) as client:
        resp = client.post("/subtitulos/job-x", json={"grupos": [{"texto": "x"}]})
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "CONFLICT"


def test_post_subtitulos_rechaza_conteo_distinto() -> None:
    manager = JobManager()
    _job_en_revision(manager, "job-rev2")
    with _cliente(manager) as client:
        # Solo 1 grupo cuando había 2 propuestos.
        resp = client.post("/subtitulos/job-rev2", json={"grupos": [{"texto": "uno"}]})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "INVALID_REQUEST"


def _esperar_estado(manager: JobManager, job_id: str, objetivos, timeout: float = 5.0):
    """Espera (con polling) hasta que el Job alcance uno de los estados objetivo."""
    fin = time.monotonic() + timeout
    while time.monotonic() < fin:
        estado = manager.obtener(job_id).progreso.estado
        if estado in objetivos:
            return estado
        time.sleep(0.05)
    return manager.obtener(job_id).progreso.estado


def test_post_subtitulos_reanuda_a_edicion_final(tmp_path: Path, monkeypatch) -> None:
    """Tras enviar los subtítulos editados, el Job se pausa en la edición final y,
    al confirmar vía ``POST /render/{id}``, se renderiza (Remotion) hasta completar.

    Refleja el nuevo flujo (spec edicion-avanzada-shorts): la revisión manual NO
    renderiza directamente, sino que prepara los grupos finales y pausa en
    ``ESPERANDO_EDICION_FINAL`` (antes ``ESPERANDO_ELECCION_RENDER``); el render
    efectivo —SIEMPRE con Remotion— lo dispara el endpoint de edición final.
    """
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")
    manager = JobManager()
    _job_en_revision(manager, "job-rev3")
    with _cliente(manager) as client:
        resp = client.post(
            "/subtitulos/job-rev3",
            json={"grupos": [{"texto": "Hola Mundo"}, {"texto": "Segundo Grupo"}]},
        )
        assert resp.status_code == 202, resp.text
        assert resp.json()["estado"] == "en_ejecucion"

        # La preparación corre en background: el Job debe pausarse en la edición
        # final (no completar directamente).
        estado = _esperar_estado(
            manager,
            "job-rev3",
            (JobStatus.ESPERANDO_EDICION_FINAL, JobStatus.FALLIDO),
        )
        assert estado == JobStatus.ESPERANDO_EDICION_FINAL

        # GET /render devuelve los grupos finales corregidos (solo lectura).
        resp = client.get("/render/job-rev3")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["estado"] == "esperando_edicion_final"
        assert body["editable"] is True
        assert [g["texto"] for g in body["grupos"]] == ["Hola Mundo", "Segundo Grupo"]

        # POST /render (edición final) reanuda el render con Remotion en background.
        resp = client.post("/render/job-rev3", json={})
        assert resp.status_code == 202, resp.text
        assert resp.json()["estado"] == "en_ejecucion"

    # El render corre en background: esperar a que alcance un estado terminal.
    estado = _esperar_estado(
        manager, "job-rev3", (JobStatus.COMPLETADO, JobStatus.FALLIDO)
    )
    assert estado == JobStatus.COMPLETADO


# ---------------------------------------------------------------------------
# /configuracion
# ---------------------------------------------------------------------------
def test_configuracion_get_vacia_put_y_delete(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(config, "USER_CONFIG_ROOT", tmp_path / "cfg")
    manager = JobManager()
    with _cliente(manager) as client:
        # GET inicial: sin ajustes guardados.
        resp = client.get("/configuracion")
        assert resp.status_code == 200
        assert resp.json()["ajustes"] is None

        # PUT: guardar ajustes válidos con transición y revisión.
        ajustes = Ajustes()
        ajustes.transiciones.tipo = "disolucion"
        ajustes.transiciones.duracion_ms = 350
        ajustes.subtitulos.revisar = True
        resp = client.put("/configuracion", json={"ajustes": ajustes.model_dump()})
        assert resp.status_code == 200, resp.text
        assert resp.json()["guardado"] is True

        # GET tras guardar: devuelve lo persistido.
        resp = client.get("/configuracion")
        body = resp.json()["ajustes"]
        assert body is not None
        assert body["transiciones"]["tipo"] == "disolucion"
        assert body["transiciones"]["duracion_ms"] == 350
        assert body["subtitulos"]["revisar"] is True

        # DELETE: restablecer.
        resp = client.delete("/configuracion")
        assert resp.status_code == 200
        assert resp.json()["borrado"] is True
        assert client.get("/configuracion").json()["ajustes"] is None


def test_configuracion_put_rechaza_invalido(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(config, "USER_CONFIG_ROOT", tmp_path / "cfg")
    manager = JobManager()
    with _cliente(manager) as client:
        ajustes = Ajustes().model_dump()
        ajustes["generales"]["fps"] = 0  # fuera de rango (1..120)
        resp = client.put("/configuracion", json={"ajustes": ajustes})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "INVALID_REQUEST"
        assert "generales.fps" in resp.json()["error"]["details"]["campos_invalidos"]
        # No se guardó nada.
        assert config_store.cargar_ajustes() is None



# ---------------------------------------------------------------------------
# GET /render/{id}: contrato ampliado con datos del vídeo real (spec
# previsualizacion-video-real-remotion, tarea 1.4; Req 1.1, 1.2, 1.3, 1.5, 1.7)
# ---------------------------------------------------------------------------
def _inspector_ok(duracion_s: Optional[float]):
    """Devuelve un inspector de clips falso que no lanza y expone ``duracion_s``.

    Se usa para simular una inspección exitosa del vídeo cortado sin depender de
    ``ffprobe`` real, de modo que ``GET /render`` devuelva un ``duracion_s``
    determinista.
    """

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


def _inspector_falla(ruta: str) -> ClipInfo:
    """Inspector que SIEMPRE falla (simula ffprobe ausente / clip corrupto).

    Permite verificar el comportamiento best-effort de ``GET /render``: la
    inspección de la duración falla pero el endpoint responde ``200`` con
    ``duracion_s = null`` sin propagar el error (Req 1.5).
    """
    raise ClipInspeccionError(ruta, "ffprobe no disponible")


@contextmanager
def _inspector_inyectado(fn) -> Iterator[None]:
    """Inyecta ``fn`` como inspector por defecto de ``construir_respuesta_render``.

    El endpoint ``GET /render`` llama a ``construir_respuesta_render(job)`` usando
    su inspector por defecto (``inspeccionar_clip``); para las pruebas de endpoint
    se sustituye ese valor por defecto por un doble determinista y se restaura al
    salir del contexto.
    """
    original = render_api.construir_respuesta_render.__defaults__
    render_api.construir_respuesta_render.__defaults__ = (fn,)
    try:
        yield
    finally:
        render_api.construir_respuesta_render.__defaults__ = original


def _job_en_edicion_final(
    manager: JobManager,
    job_id: str,
    cortado_path: str,
    ajustes: Optional[Ajustes] = None,
) -> None:
    """Crea un Job y lo pausa en ``ESPERANDO_EDICION_FINAL`` con ``cortado_path``.

    Los ``grupos_finales`` incluyen un grupo CON palabras (para el karaoke) y
    otro SIN palabras, de modo que la respuesta ejercite ambos casos del campo
    ``palabras`` (Req 1.6).
    """
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


def test_get_render_con_cortado_devuelve_video_url_y_dimensiones() -> None:
    """Con ``cortado_path`` definido, ``GET /render`` devuelve ``video_url``
    correcta, ``video_nombre``, dimensiones/fps de ``ajustes.generales`` y la
    duración inspeccionada; los grupos conservan ``palabras`` (Req 1.1, 1.2, 1.6)."""
    manager = JobManager()
    ajustes = Ajustes(
        generales=AjustesGenerales(
            resolucion=ResolucionObjetivo(ancho=720, alto=1280), fps=24
        )
    )
    _job_en_edicion_final(manager, "job-elec", "/tmp/wd/cortado.mp4", ajustes)

    with _inspector_inyectado(_inspector_ok(9.5)), _cliente(manager) as client:
        resp = client.get("/render/job-elec")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["estado"] == "esperando_edicion_final"
    assert body["editable"] is True
    # video_nombre / video_url derivados de cortado_path (Req 1.2).
    assert body["video_nombre"] == "cortado.mp4"
    assert body["video_url"] == (
        f"http://{config.BACKEND_HOST}:{config.BACKEND_PORT}"
        "/workfile/job-elec/cortado.mp4"
    )
    # fps/ancho/alto reflejan ajustes.generales (Req 1.4).
    assert body["fps"] == 24
    assert body["ancho"] == 720
    assert body["alto"] == 1280
    # duracion_s refleja la inspección exitosa (Req 1.5).
    assert body["duracion_s"] == 9.5
    # grupos conservan palabras: primero con palabras, segundo con null (Req 1.6).
    assert [g["texto"] for g in body["grupos"]] == ["hola mundo", "segundo grupo"]
    assert [p["texto"] for p in body["grupos"][0]["palabras"]] == ["hola", "mundo"]
    assert body["grupos"][1]["palabras"] is None


def test_get_render_sin_cortado_devuelve_nulls() -> None:
    """Sin ``cortado_path``, ``video_url``/``video_nombre``/``duracion_s`` son
    ``null`` y no se intenta inspeccionar vídeo alguno (Req 1.3, 1.5)."""
    manager = JobManager()
    manager.crear_job("job-sin", ["a"], Ajustes(), workdir="wd")

    with _cliente(manager) as client:
        resp = client.get("/render/job-sin")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["video_url"] is None
    assert body["video_nombre"] is None
    assert body["duracion_s"] is None


def test_get_render_inspector_falla_devuelve_duracion_null() -> None:
    """Si la inspección de la duración falla, ``GET /render`` responde ``200``
    con ``duracion_s = null`` sin propagar el error, conservando ``video_url``
    (best-effort, Req 1.5, 1.7)."""
    manager = JobManager()
    _job_en_edicion_final(manager, "job-fallo", "/tmp/wd/cortado.mp4")

    with _inspector_inyectado(_inspector_falla), _cliente(manager) as client:
        resp = client.get("/render/job-fallo")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["video_url"] == (
        f"http://{config.BACKEND_HOST}:{config.BACKEND_PORT}"
        "/workfile/job-fallo/cortado.mp4"
    )
    assert body["video_nombre"] == "cortado.mp4"
    # La inspección falló: duracion_s es null sin lanzar (Req 1.5).
    assert body["duracion_s"] is None


def test_get_render_job_inexistente_404() -> None:
    """``GET /render`` sobre un Job inexistente responde ``404 JOB_NOT_FOUND``."""
    with _cliente(JobManager()) as client:
        resp = client.get("/render/no-existe")

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "JOB_NOT_FOUND"
