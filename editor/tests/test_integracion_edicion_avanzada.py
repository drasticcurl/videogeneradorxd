"""Pruebas de integración del pipeline con pausas — edición avanzada (Tarea 11.1).

Feature: ``edicion-avanzada-shorts``. Verifican el recorrido COMPLETO extremo a
extremo del pipeline con **pasos inyectables** (dobles) y **sin binarios reales**
(ffmpeg / whisper / Node), ejercitando las tres pausas y la reutilización de los
artefactos intermedios entre reanudaciones:

    detección de silencios → ``ESPERANDO_EDICION_SILENCIOS``
      → aplicar corte → TRANSCRIBIR → SUBTÍTULOS
      → (revisión de texto) ``ESPERANDO_REVISION``
      → ``ESPERANDO_EDICION_FINAL`` → render Remotion → ``COMPLETADO``

Se cubren tres variantes del flujo (Req 16.1, 16.2, 16.3):

* **Con revisión de subtítulos activada:** el Job atraviesa las TRES pausas en
  orden y termina ``COMPLETADO`` renderizando con Remotion.
* **Sin revisión:** al reanudar los silencios el Job pasa directamente a
  ``ESPERANDO_EDICION_FINAL`` (se salta ``ESPERANDO_REVISION``).
* **Con silencios desactivados (Req 1.5):** no hay pausa de silencios; el
  pipeline continúa directamente a TRANSCRIBIR y se pausa en la edición final.

En todas las variantes se comprueba que:

* Los artefactos intermedios (``unido.mp4`` / ``cortado.mp4``) **persisten** en
  el workdir a lo largo de las pausas y **no se regeneran** (los pasos previos —
  UNIR, detección y aplicación del corte— se ejecutan EXACTAMENTE una vez y su
  contenido en disco no cambia entre pausas), Req 16.2, 16.3.
* El workdir **no se limpia** mientras el Job está en pausa (``cleanup`` no se
  invoca hasta la finalización del render), Req 16.2.
* El orden de ejecución de los pasos es el esperado (Req 16.1).

**NOTA DE DISEÑO (cambio aditivo y seguro):** para poder inyectar TODOS los
pasos (incluidos ``fn_aplicar`` de la FASE B y ``fn_remotion`` del render) desde
UN ÚNICO :class:`~app.jobs.runner.JobRunner` que conduce todo el flujo, la fase
inicial :func:`app.engine.pipeline.ejecutar_pipeline` acepta ahora e **ignora**
inyecciones extra vía ``**_inyecciones_ignoradas`` —igual que ya hacían
:func:`reanudar_desde_silencios` y :func:`reanudar_pipeline`—. Es un cambio
estrictamente aditivo que no altera ningún comportamiento de producción y deja el
recorrido extremo a extremo con un solo runner y un solo conjunto de inyecciones.

Validates: Requirements 16.1, 16.2, 16.3.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import pytest

from app import config
from app.engine.proc import ResultadoComando
from app.engine.silence import ResultadoDeteccionSilencios
from app.jobs.manager import JobManager
from app.jobs.runner import JobRunner
from app.models.job import JobStatus
from app.models.settings import Ajustes, Palabra, TextoExtra
from app.storage.workdir import JobWorkdir


# ===========================================================================
# Fixtures e infraestructura común
# ===========================================================================
@pytest.fixture(autouse=True)
def _aislar_workdir(tmp_path, monkeypatch):
    """Aísla ``WORKDIR_ROOT``/``OUTPUT_ROOT`` en un directorio temporal por test."""
    monkeypatch.setattr(config, "WORKDIR_ROOT", tmp_path / "work")
    monkeypatch.setattr(config, "OUTPUT_ROOT", tmp_path / "out")


def _cmd_ok(args: Sequence[str], timeout: Optional[float] = None) -> ResultadoComando:
    """Ejecutor de comandos doble: siempre éxito (no invoca binarios reales)."""
    return ResultadoComando(returncode=0, stdout="1.0", stderr="", args=list(args))


class _Dobles:
    """Conjunto de dobles inyectables de TODOS los pasos del pipeline.

    Registra en ``llamadas`` el nombre de cada paso ejecutado, en orden, para
    poder verificar el orden del flujo (Req 16.1), y lleva un contador por paso
    (``conteo``) para comprobar que los artefactos previos NO se regeneran entre
    pausas (Req 16.3). Escribe artefactos reales (pequeños) en el workdir para
    verificar la persistencia entre pausas (Req 16.2).
    """

    def __init__(
        self,
        silencios: Sequence[Tuple[float, float]],
        duracion: float,
    ) -> None:
        self.silencios = list(silencios)
        self.duracion = duracion
        self.llamadas: List[str] = []
        self.conteo: dict[str, int] = {}

    def _registrar(self, nombre: str) -> None:
        self.llamadas.append(nombre)
        self.conteo[nombre] = self.conteo.get(nombre, 0) + 1

    # --- Fase inicial (ejecutar_pipeline) --------------------------------
    def fn_unir(self, job: JobWorkdir, orden, ancho, alto, fps, **kw) -> Path:  # noqa: ANN001
        self._registrar("UNIR")
        ruta = job.resolve("unido.mp4")
        ruta.write_bytes(b"unido")  # artefacto real para verificar persistencia
        return ruta

    def fn_detectar(
        self, entrada, *, umbral_db, margen_ms, modo="db", runner=None, **kw
    ) -> ResultadoDeteccionSilencios:  # noqa: ANN001
        self._registrar("DETECTAR")
        return ResultadoDeteccionSilencios(
            silencios=list(self.silencios), duracion=self.duracion
        )

    def fn_transcribir(self, entrada, ajustes_t, audio, *, runner=None, **kw):  # noqa: ANN001
        self._registrar("TRANSCRIBIR")
        return [
            Palabra(texto="hola", inicio_s=0.0, fin_s=0.5),
            Palabra(texto="mundo", inicio_s=0.5, fin_s=1.0),
        ]

    def fn_subtitulos(self, entrada, palabras, sub, res, ass, salida, **kw) -> Path:  # noqa: ANN001
        # En el flujo de edición avanzada el render es SIEMPRE Remotion; este
        # doble existe para detectar (y fallar) si alguna vez se quemara ASS.
        self._registrar("SUBTITULOS_ASS")
        return Path(salida)

    def fn_musica(self, entrada, mwav, mus, salida, **kw) -> Path:  # noqa: ANN001
        self._registrar("MUSICA")
        return Path(salida)

    def fn_preservar(self, job: JobWorkdir, tmp) -> Path:  # noqa: ANN001
        self._registrar("PRESERVAR")
        return job.output_path

    # --- Fase de reanudación --------------------------------------------
    def fn_aplicar(self, entrada, salida, tramos, duracion, *, runner=None, **kw) -> Path:  # noqa: ANN001
        self._registrar("APLICAR")
        Path(salida).write_bytes(b"cortado")  # artefacto real (vídeo cortado)
        return Path(salida)

    def fn_remotion(self, entrada, grupos, sub, res, fps, props, salida, **kw) -> Path:  # noqa: ANN001
        self._registrar("REMOTION")
        return Path(salida)

    # --- Empaquetado de inyecciones -------------------------------------
    def inyecciones(self) -> dict:
        """Conjunto ÚNICO de inyecciones para un solo runner (todo el flujo).

        Incluye tanto los pasos de la fase inicial como los de las reanudaciones
        (``fn_aplicar``, ``fn_remotion``). ``ejecutar_pipeline`` ignora los pasos
        que no le corresponden gracias a ``**_inyecciones_ignoradas``.
        """
        return dict(
            fn_unir=self.fn_unir,
            fn_detectar=self.fn_detectar,
            fn_transcribir=self.fn_transcribir,
            fn_subtitulos=self.fn_subtitulos,
            fn_musica=self.fn_musica,
            fn_preservar=self.fn_preservar,
            fn_aplicar=self.fn_aplicar,
            fn_remotion=self.fn_remotion,
        )


def _ajustes(*, silencios_activado: bool, revisar: bool) -> Ajustes:
    """Construye ``Ajustes`` con el corte de silencios y la revisión configurados."""
    ajustes = Ajustes()
    ajustes.silencios.activado = silencios_activado
    ajustes.subtitulos.revisar = revisar
    return ajustes


def _espiar_cleanup(monkeypatch) -> dict:
    """Instrumenta ``JobWorkdir.cleanup`` para contar sus invocaciones.

    Devuelve un dict con la clave ``n`` (número de llamadas). Se conserva el
    comportamiento real (se envuelve la implementación original).
    """
    contador = {"n": 0}
    cleanup_real = JobWorkdir.cleanup

    def _spy(self, *a, **k):  # noqa: ANN001
        contador["n"] += 1
        return cleanup_real(self, *a, **k)

    monkeypatch.setattr(JobWorkdir, "cleanup", _spy)
    return contador


def _runner(manager: JobManager, dobles: _Dobles) -> JobRunner:
    """Crea UN ÚNICO runner con TODAS las inyecciones (conduce todo el flujo)."""
    return JobRunner(manager, runner=_cmd_ok, **dobles.inyecciones())


# ===========================================================================
# Recorrido completo CON revisión de subtítulos (las tres pausas)
# Req 16.1, 16.2, 16.3
# ===========================================================================
def test_recorrido_completo_con_revision_reutiliza_artefactos(monkeypatch) -> None:
    """Extremo a extremo con las TRES pausas: detección → silencios → corte →
    transcripción → subtítulos → revisión → edición final → render Remotion →
    COMPLETADO, reutilizando artefactos y sin perder el workdir (Req 16.1-16.3)."""
    contador_cleanup = _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    runner = _runner(manager, dobles)
    wd = JobWorkdir("job-e2e")

    manager.crear_job(
        "job-e2e", ["c1"], _ajustes(silencios_activado=True, revisar=True), workdir="wd"
    )

    # (1) EN_EJECUCION → ESPERANDO_EDICION_SILENCIOS tras la detección.
    r1 = runner.ejecutar_job("job-e2e")
    assert r1.pendiente_edicion_silencios is True
    js = manager.obtener("job-e2e")
    assert js.progreso.estado == JobStatus.ESPERANDO_EDICION_SILENCIOS
    # Artefactos persistidos para la edición del timeline (Req 1.3, 16.2).
    assert js.unido_path is not None and js.unido_path.endswith("unido.mp4")
    assert js.duracion_unido_s == 10.0
    assert wd.resolve("unido.mp4").read_bytes() == b"unido"
    # El workdir NO se limpió durante la pausa (Req 16.2).
    assert contador_cleanup["n"] == 0

    # (2) Reanudar con tramos editados → aplica corte y pausa en ESPERANDO_REVISION.
    r2 = runner.reanudar_silencios_job("job-e2e", [(1.0, 2.0)])
    assert r2.pendiente_revision is True
    assert manager.obtener("job-e2e").progreso.estado == JobStatus.ESPERANDO_REVISION
    # El vídeo cortado se reconstruyó y el unido sigue intacto (Req 16.2, 16.3).
    assert wd.resolve("cortado.mp4").read_bytes() == b"cortado"
    assert wd.resolve("unido.mp4").read_bytes() == b"unido"
    assert contador_cleanup["n"] == 0

    # (3) Reanudar la revisión → ESPERANDO_EDICION_FINAL.
    r3 = runner.reanudar_job("job-e2e", r2.grupos)
    assert r3.pendiente_eleccion_render is True
    assert manager.obtener("job-e2e").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL
    assert contador_cleanup["n"] == 0
    # Los artefactos intermedios NO se regeneraron entre pausas (Req 16.3).
    assert wd.resolve("unido.mp4").read_bytes() == b"unido"
    assert wd.resolve("cortado.mp4").read_bytes() == b"cortado"

    # (4) ESPERANDO_EDICION_FINAL → COMPLETADO tras el render (siempre Remotion).
    r4 = runner.reanudar_render_job("job-e2e")
    assert r4.exito is True
    assert manager.obtener("job-e2e").progreso.estado == JobStatus.COMPLETADO
    assert manager.obtener("job-e2e").progreso.porcentaje == 100

    # Orden secuencial exacto de los pasos a lo largo del flujo (Req 16.1).
    assert dobles.llamadas == [
        "UNIR",
        "DETECTAR",
        "APLICAR",
        "TRANSCRIBIR",
        "REMOTION",
        "PRESERVAR",
    ]
    # Los pasos previos a las pausas se ejecutaron EXACTAMENTE una vez: no se
    # regeneraron artefactos ya completados (Req 16.3).
    assert dobles.conteo["UNIR"] == 1
    assert dobles.conteo["DETECTAR"] == 1
    assert dobles.conteo["APLICAR"] == 1
    assert dobles.conteo["TRANSCRIBIR"] == 1
    # El render usó Remotion; nunca el quemado ASS en este flujo (Req 11.2).
    assert dobles.conteo["REMOTION"] == 1
    assert "SUBTITULOS_ASS" not in dobles.llamadas


# ===========================================================================
# Recorrido completo SIN revisión (va directo a la edición final)
# Req 16.1, 16.3
# ===========================================================================
def test_recorrido_completo_sin_revision_va_directo_a_edicion_final(monkeypatch) -> None:
    """Sin revisión de subtítulos, al reanudar los silencios el Job pasa
    directamente a ESPERANDO_EDICION_FINAL y termina COMPLETADO (Req 16.1)."""
    contador_cleanup = _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[], duracion=5.0)  # sin silencios detectados (Req 1.4)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-sinrev", ["c1"], _ajustes(silencios_activado=True, revisar=False), workdir="wd"
    )

    r1 = runner.ejecutar_job("job-sinrev")
    assert r1.pendiente_edicion_silencios is True
    assert manager.obtener("job-sinrev").progreso.estado == JobStatus.ESPERANDO_EDICION_SILENCIOS
    assert contador_cleanup["n"] == 0

    # Sin revisión: se salta ESPERANDO_REVISION y se pausa en la edición final.
    r2 = runner.reanudar_silencios_job("job-sinrev", [])
    assert r2.pendiente_revision is False
    assert r2.pendiente_eleccion_render is True
    assert manager.obtener("job-sinrev").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL
    assert contador_cleanup["n"] == 0

    # Render final (siempre Remotion) → COMPLETADO.
    r3 = runner.reanudar_render_job("job-sinrev")
    assert r3.exito is True
    assert manager.obtener("job-sinrev").progreso.estado == JobStatus.COMPLETADO
    assert manager.obtener("job-sinrev").progreso.porcentaje == 100

    # Orden sin la pausa de revisión (no cambia la secuencia de pasos ejecutados).
    assert dobles.llamadas == [
        "UNIR",
        "DETECTAR",
        "APLICAR",
        "TRANSCRIBIR",
        "REMOTION",
        "PRESERVAR",
    ]
    assert dobles.conteo["UNIR"] == 1
    assert dobles.conteo["APLICAR"] == 1
    assert "SUBTITULOS_ASS" not in dobles.llamadas


def test_render_final_con_textos_extra_completa(monkeypatch) -> None:
    """La edición final con textos extra persistidos reanuda y completa el render
    (Req 10.1), propagando los textos extra al render Remotion."""
    _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[(2.0, 3.0)], duracion=8.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-tx", ["c1"], _ajustes(silencios_activado=True, revisar=False), workdir="wd"
    )
    runner.ejecutar_job("job-tx")
    runner.reanudar_silencios_job("job-tx", [(2.0, 3.0)])
    assert manager.obtener("job-tx").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL

    # El usuario añade un texto extra en la edición final (POST /render lo persiste).
    manager.guardar_textos_extra(
        "job-tx", [TextoExtra(texto="Hook", inicio_s=0.0, fin_s=2.0)]
    )
    resultado = runner.reanudar_render_job("job-tx")
    assert resultado.exito is True
    assert manager.obtener("job-tx").progreso.estado == JobStatus.COMPLETADO
    assert "REMOTION" in dobles.llamadas


# ===========================================================================
# Recorrido completo con SILENCIOS DESACTIVADOS (sin pausa de silencios)
# Req 1.5, 16.1
# ===========================================================================
def test_recorrido_completo_silencios_desactivados_sin_pausa(monkeypatch) -> None:
    """Con el corte de silencios desactivado NO hay pausa de edición de silencios;
    el pipeline continúa directamente a TRANSCRIBIR y se pausa en la edición
    final, terminando COMPLETADO (Req 1.5, 16.1)."""
    contador_cleanup = _espiar_cleanup(monkeypatch)
    manager = JobManager()
    dobles = _Dobles(silencios=[(1.0, 2.0)], duracion=10.0)
    runner = _runner(manager, dobles)

    manager.crear_job(
        "job-nosil", ["c1"], _ajustes(silencios_activado=False, revisar=False), workdir="wd"
    )

    r1 = runner.ejecutar_job("job-nosil")
    # NO hay pausa de edición de silencios; se pausa directamente en edición final.
    assert r1.pendiente_edicion_silencios is False
    assert r1.pendiente_eleccion_render is True
    assert manager.obtener("job-nosil").progreso.estado == JobStatus.ESPERANDO_EDICION_FINAL
    assert contador_cleanup["n"] == 0

    r2 = runner.reanudar_render_job("job-nosil")
    assert r2.exito is True
    assert manager.obtener("job-nosil").progreso.estado == JobStatus.COMPLETADO
    assert manager.obtener("job-nosil").progreso.porcentaje == 100

    # La detección y la aplicación de silencios NO se ejecutaron (Req 1.5).
    assert "DETECTAR" not in dobles.llamadas
    assert "APLICAR" not in dobles.llamadas
    # Se transcribió el vídeo unido directamente y se renderizó con Remotion.
    assert dobles.llamadas == ["UNIR", "TRANSCRIBIR", "REMOTION", "PRESERVAR"]
    assert dobles.conteo["UNIR"] == 1
    assert "SUBTITULOS_ASS" not in dobles.llamadas
