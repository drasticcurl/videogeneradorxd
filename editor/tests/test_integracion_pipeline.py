"""Pruebas de integración del pipeline extendido (spec subtitulos-ia-remotion, Tarea 10).

Cubre las sub-tareas de integración 10.1, 10.2 y 10.3, ejercitando el flujo
completo con **dobles inyectados** (sin red externa ni binarios reales):

* **10.1 — Property 8: el motor ejecutado es exactamente el elegido.**
  Con dobles de OpenAI (cliente inyectado en ``corregir_grupos_ia`` vía
  ``_crear_cliente_por_defecto``) y de ambos motores de render (``fn_subtitulos``
  y ``fn_remotion`` que registran si se invocaron), se verifica que el pipeline
  se pausa en ``ESPERANDO_ELECCION_RENDER`` y que, al elegir un motor, se ejecuta
  EXACTAMENTE ese motor y el OTRO **no** se invoca. Se prueba tanto a nivel de
  las funciones del pipeline como a través de la API (``TestClient`` +
  ``JobRunner``).
  **Validates: Requirements 6.1, 7.1, 7.2, 7.3**

* **10.2 — Property 10: sin fallback — fallo propaga a FALLIDO.**
  Con el doble del motor elegido lanzando error (``RemotionError`` para
  ``remotion``; ``SubtitulosError`` para ``ass``), se verifica que el Job termina
  ``FALLIDO`` con ``error = {"paso": "SUBTITULOS", "motivo": ...}`` accionable y
  que el OTRO motor **no** se invoca (no hay fallback automático).
  **Validates: Requirements 7.4, 13.2**

* **10.3 — Property 6 (no persistencia de la clave) · Property 15 (round-trip).**
  ``POST /procesar`` con ``openai_api_key`` responde ``202``; ni ``config_store``
  ni ``PUT /configuracion`` escriben la clave; el ``model_dump`` del ``JobState``
  no la contiene; y ``Ajustes`` serializado/deserializado es equivalente y
  excluye la clave.
  **Validates: Requirements 2.3, 2.4, 2.6, 8.3, 15.2, 15.3**

Los dobles siguen el patrón de ``tests/test_api.py`` /
``tests/test_endpoints_nuevos.py`` (inyección de pasos en el ``JobRunner`` y
``app.dependency_overrides`` para las dependencias compartidas).
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

import main
from app import config
from app.api import process as process_api
from app.deps import checker as _deps_checker
from app.engine import ai_review
from app.engine.pipeline import ejecutar_pipeline, reanudar_pipeline
from app.engine.remotion import RemotionError
from app.engine.subtitles import SubtitulosError
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.job import JobStatus, PipelineStep
from app.models.settings import (
    Ajustes,
    AjustesRevisionIA,
    GrupoSubtitulo,
    Palabra,
    validar_ajustes,
)
from app.storage import config_store
from app.storage.workdir import JobWorkdir

# Clave de OpenAI ficticia y distintiva, usada para comprobar que NUNCA se
# serializa/persistas (Property 6). No es una credencial real.
CLAVE_FICTICIA = "sk-INTEGRACION-secreta-1234567890"

MOTORES = ["ass", "remotion"]


# ===========================================================================
# Dobles compartidos
# ===========================================================================
def _fake_unir(job: JobWorkdir, orden, ancho, alto, fps, **kw) -> Path:  # noqa: ANN001
    return job.resolve("unido.mp4")


def _fake_cortar(entrada, salida, **kw) -> Path:  # noqa: ANN001
    return Path(salida)


def _fake_transcribir(entrada, ajustes_t, audio, **kw) -> List[Palabra]:  # noqa: ANN001
    # Dos palabras con timestamps válidos → un grupo "hola mundo".
    return [
        Palabra(texto="hola", inicio_s=0.0, fin_s=0.5),
        Palabra(texto="mundo", inicio_s=0.5, fin_s=1.0),
    ]


def _fake_preservar(job: JobWorkdir, tmp) -> Path:  # noqa: ANN001
    # No copia archivos reales: basta devolver una ruta de salida.
    return job.output_path


class _SpyMotor:
    """Doble de un motor de render que registra si fue invocado y devuelve la salida."""

    def __init__(self, nombre: str, *, error: Optional[Exception] = None) -> None:
        self.nombre = nombre
        self.invocado = 0
        self._error = error

    def como_ass(self):
        """Devuelve un callable con la firma de ``fn_subtitulos``."""

        def fn_subtitulos(
            cortado, palabras, subtitulos, resolucion, ass_path, salida,
            *, runner=None, existe_salida=None, grupos=None,
        ):  # noqa: ANN001
            self.invocado += 1
            if self._error is not None:
                raise self._error
            return Path(salida)

        return fn_subtitulos

    def como_remotion(self):
        """Devuelve un callable con la firma de ``fn_remotion`` (renderizar_con_remotion)."""

        def fn_remotion(
            entrada, grupos, subtitulos, resolucion, fps, props_path, salida,
            *, runner=None, existe_salida=None, combine_tokens_ms=None, **kw,
        ):  # noqa: ANN001
            self.invocado += 1
            if self._error is not None:
                raise self._error
            return Path(salida)

        return fn_remotion


class _FakeOpenAI:
    """Cliente de OpenAI doble (protocolo ``OpenAIClienteProto``).

    Registra la invocación y devuelve el mismo número de líneas que la entrada
    (corrección "de identidad" válida), de modo que la corrección con IA se
    ejerza de verdad sin tocar la red.
    """

    def __init__(self) -> None:
        self.invocado = 0

    def crear_correccion(
        self, *, modelo: str, system: str, contenido_usuario: str, timeout_s: float
    ) -> str:
        self.invocado += 1
        textos = json.loads(contenido_usuario)
        # Devuelve un objeto JSON con la clave "lineas" y la MISMA cardinalidad.
        return json.dumps({"lineas": [str(t) for t in textos]}, ensure_ascii=False)


def _fakes_render(spy_ass: _SpyMotor, spy_remotion: _SpyMotor) -> Dict[str, object]:
    """Conjunto de dobles de pasos para el ``JobRunner`` (fase 1 y fase 2)."""
    return dict(
        fn_unir=_fake_unir,
        fn_cortar=_fake_cortar,
        fn_transcribir=_fake_transcribir,
        fn_subtitulos=spy_ass.como_ass(),
        fn_remotion=spy_remotion.como_remotion(),
        fn_musica=lambda entrada, mwav, mus, salida, **kw: Path(salida),  # noqa: ANN001
        fn_preservar=_fake_preservar,
    )


def _fakes_fase1() -> Dict[str, object]:
    """Dobles que acepta ``ejecutar_pipeline`` (fase 1, sin ``fn_remotion``)."""
    return dict(
        fn_unir=_fake_unir,
        fn_cortar=_fake_cortar,
        fn_transcribir=_fake_transcribir,
        fn_subtitulos=lambda *a, **k: Path("no-usado"),  # no se invoca en fase 1
        fn_musica=lambda entrada, mwav, mus, salida, **kw: Path(salida),  # noqa: ANN001
        fn_preservar=_fake_preservar,
    )


# ===========================================================================
# Infraestructura de la API (verificación de dependencias + overrides)
# ===========================================================================
def _verificacion_ok(*_a, **_k) -> _deps_checker.ResultadoVerificacion:
    return _deps_checker.ResultadoVerificacion(
        resultados=[
            _deps_checker.ResultadoDependencia(nombre=n, disponible=True)
            for n in _deps_checker.DEPENDENCIAS
        ]
    )


@contextmanager
def _cliente(
    manager: JobManager, runner: Optional[JobRunner] = None
) -> Iterator[TestClient]:
    ejecutor = runner if runner is not None else JobRunner(manager)
    main.verificar_dependencias = _verificacion_ok  # type: ignore[assignment]
    main.app.dependency_overrides[process_api.obtener_gestor_jobs] = lambda: manager
    main.app.dependency_overrides[process_api.obtener_job_runner] = lambda: ejecutor
    try:
        yield TestClient(main.app)
    finally:
        main.app.dependency_overrides.pop(process_api.obtener_gestor_jobs, None)
        main.app.dependency_overrides.pop(process_api.obtener_job_runner, None)


def _esperar_estado(
    manager: JobManager, job_id: str, objetivos, timeout: float = 5.0
) -> JobStatus:
    """Espera (polling) hasta que el Job alcance uno de los estados objetivo."""
    fin = time.monotonic() + timeout
    while time.monotonic() < fin:
        estado = manager.obtener(job_id).progreso.estado
        if estado in objetivos:
            return estado
        time.sleep(0.02)
    return manager.obtener(job_id).progreso.estado


def _isolar_workdir(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "wk")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")


def _grupos_finales() -> List[GrupoSubtitulo]:
    return [
        GrupoSubtitulo(texto="hola mundo", inicio_s=0.0, fin_s=1.0),
        GrupoSubtitulo(texto="segundo grupo", inicio_s=1.0, fin_s=2.0),
    ]


# ===========================================================================
# Tarea 10.1 — Property 8: el motor ejecutado es exactamente el elegido
# Feature: subtitulos-ia-remotion, Property 8
# Validates: Requirements 6.1, 7.1, 7.2, 7.3
# ===========================================================================
@pytest.mark.parametrize("motor", MOTORES)
def test_10_1_pipeline_completo_ejecuta_solo_el_motor_elegido(
    tmp_path: Path, monkeypatch, motor: str
) -> None:
    """Flujo completo a nivel de pipeline con dobles de OpenAI y de ambos motores.

    Verifica: (a) la fase 1 se **pausa** en ``ESPERANDO_ELECCION_RENDER`` sin
    renderizar ni invocar ningún motor; (b) la corrección con IA se ejecuta (con
    el cliente doble); (c) al reanudar con ``motor``, se invoca EXACTAMENTE ese
    motor y el OTRO **no** se invoca (Property 8, Req 7.1-7.3).
    """
    _isolar_workdir(monkeypatch, tmp_path)

    # Cliente de OpenAI doble inyectado en corregir_grupos_ia (sin red).
    fake_openai = _FakeOpenAI()
    monkeypatch.setattr(
        ai_review, "_crear_cliente_por_defecto", lambda _api_key: fake_openai
    )

    spy_ass = _SpyMotor("ass")
    spy_remotion = _SpyMotor("remotion")

    ajustes = Ajustes(revision_ia=AjustesRevisionIA(activado=True))
    # El corte de silencios se desactiva (Req 1.5): este test verifica la elección
    # de motor a NIVEL DE PIPELINE (que sí sigue soportando ambos motores), no la
    # pausa de edición de silencios. Así ``ejecutar_pipeline`` continúa a
    # TRANSCRIBIR y se pausa directamente en la edición final.
    ajustes.silencios.activado = False
    job = JobWorkdir("job-10-1-pipe")

    # --- Fase 1: preparar grupos (IA) y PAUSAR sin renderizar (Req 6.1) ---
    r1 = ejecutar_pipeline(
        job,
        ["/clips/a.mp4"],
        ajustes,
        musica_wav=None,
        api_key=CLAVE_FICTICIA,
        **_fakes_fase1(),
    )
    assert r1.pendiente_eleccion_render is True
    assert r1.exito is False
    assert r1.grupos is not None and len(r1.grupos) == 1
    # La corrección con IA se ejecutó con el cliente doble (Req 1.2).
    assert fake_openai.invocado == 1
    # Ningún motor de render se invocó durante la pausa.
    assert spy_ass.invocado == 0
    assert spy_remotion.invocado == 0

    # --- Fase 2: reanudar con EXACTAMENTE el motor elegido (Req 7.1-7.3) ---
    resultado = reanudar_pipeline(
        job,
        r1.cortado,
        ajustes,
        grupos=r1.grupos,
        motor=motor,
        musica_wav=None,
        fn_subtitulos=spy_ass.como_ass(),
        fn_remotion=spy_remotion.como_remotion(),
        fn_preservar=_fake_preservar,
    )
    assert resultado.exito is True

    if motor == "ass":
        assert spy_ass.invocado == 1
        assert spy_remotion.invocado == 0, "Remotion NO debe invocarse con motor=ass"
    else:
        assert spy_remotion.invocado == 1
        assert spy_ass.invocado == 0, "El quemado ASS NO debe invocarse con motor=remotion"


def test_10_1_api_reanuda_y_ejecuta_siempre_remotion(
    tmp_path: Path, monkeypatch
) -> None:
    """Vía API: un Job pausado en ``ESPERANDO_EDICION_FINAL`` se reanuda con
    ``POST /render/{id}`` renderizando SIEMPRE con Remotion (spec
    edicion-avanzada-shorts, Req 11.2).

    En el nuevo flujo se elimina la elección de motor: ``POST /render`` no acepta
    ``motor="ass"`` (sólo ``"remotion"`` u omitido). ``GET /render/{id}`` muestra
    los grupos finales en solo lectura y el render corre en background con
    Remotion (nunca el quemado ASS).
    """
    _isolar_workdir(monkeypatch, tmp_path)

    spy_ass = _SpyMotor("ass")
    spy_remotion = _SpyMotor("remotion")

    manager = JobManager()
    manager.crear_job("job-10-1-api", ["a"], Ajustes(), workdir="wd")
    # Pre-situar el Job en la pausa de edición final con grupos finales.
    manager.marcar_esperando_edicion_final(
        "job-10-1-api", str(tmp_path / "cortado.mp4"), _grupos_finales()
    )

    runner = JobRunner(manager, **_fakes_render(spy_ass, spy_remotion))
    with _cliente(manager, runner) as client:
        # GET /render: grupos finales, editable (esperando edición final).
        resp = client.get("/render/job-10-1-api")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["estado"] == "esperando_edicion_final"
        assert body["editable"] is True
        assert [g["texto"] for g in body["grupos"]] == ["hola mundo", "segundo grupo"]

        # POST /render (edición final, sin motor) → 202 y reanuda en background.
        resp = client.post("/render/job-10-1-api", json={})
        assert resp.status_code == 202, resp.text
        assert resp.json()["estado"] == "en_ejecucion"

    estado = _esperar_estado(
        manager, "job-10-1-api", (JobStatus.COMPLETADO, JobStatus.FALLIDO)
    )
    assert estado == JobStatus.COMPLETADO

    # El render es SIEMPRE con Remotion; el quemado ASS nunca se invoca (Req 11.2).
    assert spy_remotion.invocado == 1
    assert spy_ass.invocado == 0


def test_10_1_api_render_rechaza_motor_distinto_de_remotion(
    tmp_path: Path, monkeypatch
) -> None:
    """``POST /render`` con ``motor`` distinto de ``"remotion"`` responde
    ``400 INVALID_REQUEST`` sin renderizar (spec edicion-avanzada-shorts, Req 11.3, 11.5)."""
    _isolar_workdir(monkeypatch, tmp_path)

    spy_ass = _SpyMotor("ass")
    spy_remotion = _SpyMotor("remotion")

    manager = JobManager()
    manager.crear_job("job-10-1-motor", ["a"], Ajustes(), workdir="wd")
    manager.marcar_esperando_edicion_final(
        "job-10-1-motor", str(tmp_path / "cortado.mp4"), _grupos_finales()
    )

    runner = JobRunner(manager, **_fakes_render(spy_ass, spy_remotion))
    with _cliente(manager, runner) as client:
        resp = client.post("/render/job-10-1-motor", json={"motor": "ass"})
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "INVALID_REQUEST"

    # El Job no cambió de estado ni se renderizó (Req 11.5).
    assert manager.obtener("job-10-1-motor").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL
    assert spy_ass.invocado == 0
    assert spy_remotion.invocado == 0


def test_10_1_api_flujo_completo_pausa_en_edicion_final(
    tmp_path: Path, monkeypatch
) -> None:
    """El flujo completo ``POST /procesar`` (con clave) se PAUSA en
    ``ESPERANDO_EDICION_FINAL`` sin renderizar, y ``POST /render`` lo completa con
    Remotion (spec edicion-avanzada-shorts, Req 8.1, 11.2).

    NOTA: el corte de silencios se desactiva en los ajustes porque el endpoint
    ``POST /silencios`` (tarea 5.1) aún no está integrado; así el pipeline
    continúa directamente a la edición final sin la pausa de silencios (Req 1.5).
    """
    _isolar_workdir(monkeypatch, tmp_path)

    spy_ass = _SpyMotor("ass")
    spy_remotion = _SpyMotor("remotion")

    manager = JobManager()
    # El runner inicial (fase ejecutar_job) NO admite ``fn_remotion`` en
    # ``ejecutar_pipeline``; se inyectan los pasos de la fase inicial y, como el
    # render es siempre Remotion, también ``fn_remotion`` para la reanudación.
    # ``ejecutar_pipeline`` (fase inicial) NO acepta ``fn_remotion``; se inyecta
    # sólo con los pasos de esa fase. El doble de Remotion se añade a las
    # inyecciones del runner DESPUÉS de la pausa (antes de la reanudación del
    # render), que es cuando ``reanudar_pipeline`` lo consume.
    runner = JobRunner(
        manager,
        fn_unir=_fake_unir,
        fn_cortar=_fake_cortar,
        fn_transcribir=_fake_transcribir,
        fn_subtitulos=spy_ass.como_ass(),
        fn_musica=lambda entrada, mwav, mus, salida, **kw: Path(salida),  # noqa: ANN001
        fn_preservar=_fake_preservar,
    )
    ajustes = Ajustes()
    ajustes.silencios.activado = False  # sin pausa de silencios (endpoint 5.1 no integrado)
    with _cliente(manager, runner) as client:
        resp = client.post(
            "/procesar",
            json={
                "orden_clips": ["a", "b"],
                "musica_id": None,
                "ajustes": ajustes.model_dump(),
                "openai_api_key": CLAVE_FICTICIA,
            },
        )
        assert resp.status_code == 202, resp.text
        job_id = resp.json()["job_id"]

        # El pipeline en background debe pausar en ESPERANDO_EDICION_FINAL.
        estado = _esperar_estado(
            manager,
            job_id,
            (JobStatus.ESPERANDO_EDICION_FINAL, JobStatus.FALLIDO),
        )
        assert estado == JobStatus.ESPERANDO_EDICION_FINAL
        # Aún no se renderizó nada.
        assert spy_ass.invocado == 0
        assert spy_remotion.invocado == 0

        # Ahora que la fase inicial terminó, se añade el doble de Remotion para
        # la reanudación del render (no interfiere con ``ejecutar_pipeline``).
        runner._inyecciones["fn_remotion"] = spy_remotion.como_remotion()

        # Confirmar la edición final reanuda y completa (siempre Remotion).
        resp = client.post(f"/render/{job_id}", json={})
        assert resp.status_code == 202, resp.text

    estado = _esperar_estado(
        manager, job_id, (JobStatus.COMPLETADO, JobStatus.FALLIDO)
    )
    assert estado == JobStatus.COMPLETADO
    assert spy_remotion.invocado == 1
    assert spy_ass.invocado == 0


# ===========================================================================
# Tarea 10.2 — Property 10: sin fallback — fallo propaga a FALLIDO
# Feature: subtitulos-ia-remotion, Property 10
# Validates: Requirements 7.4, 13.2
# ===========================================================================
def test_10_2_fallo_de_remotion_termina_fallido_sin_fallback(
    tmp_path: Path, monkeypatch
) -> None:
    """Si el render Remotion falla, el Job termina ``FALLIDO`` con error accionable
    ``{"paso": "SUBTITULOS", "motivo": ...}`` y NO se recurre al quemado ASS.

    En el nuevo flujo (spec edicion-avanzada-shorts) el render es SIEMPRE con
    Remotion y su fallo NO tiene fallback a otro motor (Req 11.6, y Property 10 de
    subtitulos-ia-remotion, Req 7.4, 13.2).
    """
    _isolar_workdir(monkeypatch, tmp_path)
    # Asegurar que el fail-soft de subtítulos está desactivado (comportamiento
    # por defecto): el fallo de Remotion debe propagar a FALLIDO.
    monkeypatch.delenv("VSE_SUBTITLES_FAILSOFT", raising=False)

    spy_ass = _SpyMotor("ass")  # no debe invocarse (render siempre Remotion)
    spy_remotion = _SpyMotor("remotion", error=RemotionError("Node ausente"))

    manager = JobManager()
    manager.crear_job("job-10-2", ["a"], Ajustes(), workdir="wd")
    manager.marcar_esperando_edicion_final(
        "job-10-2", str(tmp_path / "cortado.mp4"), _grupos_finales()
    )

    runner = JobRunner(manager, **_fakes_render(spy_ass, spy_remotion))
    with _cliente(manager, runner) as client:
        resp = client.post("/render/job-10-2", json={})
        assert resp.status_code == 202, resp.text

    estado = _esperar_estado(
        manager, "job-10-2", (JobStatus.COMPLETADO, JobStatus.FALLIDO)
    )
    assert estado == JobStatus.FALLIDO

    # Error accionable con paso SUBTITULOS y motivo no vacío (Req 7.4).
    prog = manager.obtener("job-10-2").progreso
    assert prog.error is not None
    assert prog.error["paso"] == PipelineStep.SUBTITULOS.value
    assert prog.error["motivo"]

    # Sin fallback: el quemado ASS nunca se invoca (Req 11.6, Property 10).
    assert spy_remotion.invocado == 1
    assert spy_ass.invocado == 0, "No debe haber fallback al quemado ASS"


# ===========================================================================
# Tarea 10.3 — Property 6 (no persistencia de la clave) · Property 15 (round-trip)
# Feature: subtitulos-ia-remotion, Property 6 · Property 15
# Validates: Requirements 2.3, 2.4, 2.6, 8.3, 15.2, 15.3
# ===========================================================================
def test_10_3_procesar_con_clave_no_persiste_ni_serializa(
    tmp_path: Path, monkeypatch
) -> None:
    """``POST /procesar`` acepta ``openai_api_key`` (202) sin persistirla nunca.

    Comprueba (Property 6, Req 2.3, 2.4, 8.3):
      * la respuesta es ``202``;
      * la clave se guarda en el mapa EN MEMORIA del Gestor (``obtener_api_key``),
        pero el ``model_dump`` del ``JobState`` NO la contiene;
      * ``config_store`` no escribió ningún archivo con la clave;
      * al alcanzar un estado terminal la clave se elimina de memoria (Req 2.5).
    """
    _isolar_workdir(monkeypatch, tmp_path)
    monkeypatch.setattr(config, "USER_CONFIG_ROOT", tmp_path / "cfg")

    spy_ass = _SpyMotor("ass")
    spy_remotion = _SpyMotor("remotion")
    manager = JobManager()
    # ``ejecutar_pipeline`` (fase inicial) NO acepta ``fn_remotion``; el doble de
    # Remotion se añade a las inyecciones del runner tras la pausa (antes del render).
    runner = JobRunner(
        manager,
        fn_unir=_fake_unir,
        fn_cortar=_fake_cortar,
        fn_transcribir=_fake_transcribir,
        fn_subtitulos=spy_ass.como_ass(),
        fn_musica=lambda entrada, mwav, mus, salida, **kw: Path(salida),  # noqa: ANN001
        fn_preservar=_fake_preservar,
    )
    # El corte de silencios se desactiva (Req 1.5): el endpoint POST /silencios
    # (tarea 5.1) aún no está integrado, así que el pipeline continúa directamente
    # a la edición final sin la pausa de silencios.
    ajustes = Ajustes(revision_ia=AjustesRevisionIA(activado=True))
    ajustes.silencios.activado = False
    with _cliente(manager, runner) as client:
        resp = client.post(
            "/procesar",
            json={
                "orden_clips": ["a", "b"],
                "ajustes": ajustes.model_dump(),
                "openai_api_key": CLAVE_FICTICIA,
            },
        )
        assert resp.status_code == 202, resp.text  # Req 8.3
        job_id = resp.json()["job_id"]

        # Pausa en edición final (estado NO terminal): la clave sigue en el mapa
        # en memoria del Gestor, pero FUERA del JobState serializado.
        estado = _esperar_estado(
            manager,
            job_id,
            (JobStatus.ESPERANDO_EDICION_FINAL, JobStatus.FALLIDO),
        )
        assert estado == JobStatus.ESPERANDO_EDICION_FINAL

        # La clave vive en memoria (Req 2.4) pero NO en el volcado del JobState.
        assert manager.obtener_api_key(job_id) == CLAVE_FICTICIA
        volcado = json.dumps(manager.obtener(job_id).model_dump(), default=str)
        assert CLAVE_FICTICIA not in volcado
        assert "openai_api_key" not in volcado

        # config_store no escribió la clave (ni ningún archivo de config aún).
        assert config_store.cargar_ajustes() is None

        # Añadir el doble de Remotion para la reanudación del render (la fase
        # inicial ya terminó, así que no interfiere con ``ejecutar_pipeline``).
        runner._inyecciones["fn_remotion"] = spy_remotion.como_remotion()

        # Confirmar la edición final (render Remotion) → estado terminal.
        resp = client.post(f"/render/{job_id}", json={})
        assert resp.status_code == 202, resp.text

    estado = _esperar_estado(
        manager, job_id, (JobStatus.COMPLETADO, JobStatus.FALLIDO)
    )
    assert estado == JobStatus.COMPLETADO
    # Estado terminal: la clave se eliminó de memoria (Req 2.5).
    assert manager.obtener_api_key(job_id) is None


def test_10_3_put_configuracion_ignora_clave_y_no_la_persiste(
    tmp_path: Path, monkeypatch
) -> None:
    """``PUT /configuracion`` persiste solo ``Ajustes`` y nunca la clave (Req 2.6, 15.3).

    Aunque el cuerpo incluya un campo ``openai_api_key`` espurio, este se ignora
    (no forma parte de ``Ajustes``) y el JSON persistido no lo contiene.
    """
    monkeypatch.setattr(config, "USER_CONFIG_ROOT", tmp_path / "cfg")
    manager = JobManager()

    ajustes = Ajustes(revision_ia=AjustesRevisionIA(activado=True, modelo="gpt-4.1"))
    with _cliente(manager) as client:
        resp = client.put(
            "/configuracion",
            json={
                "ajustes": ajustes.model_dump(),
                # Campo espurio: debe ignorarse por completo.
                "openai_api_key": CLAVE_FICTICIA,
            },
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["guardado"] is True

        # La respuesta no expone la clave.
        assert CLAVE_FICTICIA not in json.dumps(resp.json())

    # El archivo persistido en disco no contiene la clave (Req 2.6, 15.3).
    ruta = config.user_config_path()
    assert ruta.exists()
    contenido = ruta.read_text(encoding="utf-8")
    assert CLAVE_FICTICIA not in contenido
    assert "openai_api_key" not in contenido
    assert "api_key" not in contenido

    # Los ajustes recargados son válidos y no aportan ninguna clave.
    recargado = config_store.cargar_ajustes()
    assert recargado is not None
    assert recargado.revision_ia.activado is True
    assert recargado.revision_ia.modelo == "gpt-4.1"


def test_10_3_ajustes_roundtrip_equivalente_y_sin_clave() -> None:
    """``Ajustes`` con IA activa serializa/deserializa de forma equivalente y su
    representación excluye la clave (Property 15, Req 15.2, 15.3)."""
    ajustes = Ajustes(
        revision_ia=AjustesRevisionIA(
            activado=True, modelo="gpt-4.1-mini", timeout_s=15.0, max_reintentos=2
        )
    )
    # Precondición: los ajustes son válidos.
    assert validar_ajustes(ajustes) == []

    contenido = json.dumps(ajustes.model_dump(), ensure_ascii=False)
    # Req 15.2: round-trip equivalente.
    reconstruido = Ajustes.model_validate(json.loads(contenido))
    assert reconstruido == ajustes
    assert reconstruido.model_dump() == ajustes.model_dump()

    # Req 15.3: la representación serializada excluye cualquier clave de API.
    assert "openai_api_key" not in contenido
    assert "api_key" not in contenido
    assert CLAVE_FICTICIA not in contenido
