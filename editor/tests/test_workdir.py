"""Tests del almacén de trabajo por Job y su limpieza (Tarea 9, Req 13.3-13.6).

Contiene los tests property-based (Hypothesis, >= 100 iteraciones) de las
Propiedades 26, 27 y 28 del diseño, más tests unitarios de apoyo:

* **Propiedad 26** (Feature: vertical-shorts-editor, Property 26): toda ruta de
  artefacto resuelta está contenida por prefijo en el workdir del Job, y todo
  intento de escapar del workdir se rechaza (Req 13.3).
* **Propiedad 27** (Feature: vertical-shorts-editor, Property 27): tras la
  limpieza de un Job que finaliza (éxito o error/cancelación) no queda ningún
  archivo temporal del Job, mientras que el ``Video_Final`` conservado en la
  ruta de salida separada persiste (Req 13.4, 13.5).
* **Propiedad 28** (Feature: vertical-shorts-editor, Property 28): ante un fallo
  de eliminación persistente se realizan como máximo 3 reintentos (4 intentos en
  total) y se registra el archivo afectado, sin interrumpir otros Jobs (Req
  13.6).

Se usan directorios temporales (``tmp_path`` + monkeypatch de ``WORKDIR_ROOT`` /
``OUTPUT_ROOT``) para no ensuciar el repositorio.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, List

import pytest
from hypothesis import assume, given, settings
from hypothesis import strategies as st

from app import config
from app.storage import workdir as wd
from app.storage.workdir import (
    JobWorkdir,
    MAX_CLEANUP_RETRIES,
    WorkdirContainmentError,
    preservar_video_final,
)

# Mínimo 100 iteraciones por propiedad (aquí 150).
PBT = settings(max_examples=150, deadline=None)


@contextmanager
def isolated_config_dirs() -> Iterator[None]:
    """Aísla ``WORKDIR_ROOT``/``OUTPUT_ROOT`` en un directorio temporal único.

    Se usa por cada ejemplo de Hypothesis para evitar fugas de estado entre
    ejecuciones (los ``job_id`` generados pueden repetirse). El directorio se
    elimina al salir.
    """
    old_work = config.WORKDIR_ROOT
    old_out = config.OUTPUT_ROOT
    base = Path(tempfile.mkdtemp(prefix="vse_wd_test_"))
    config.WORKDIR_ROOT = (base / "work").resolve()
    config.OUTPUT_ROOT = (base / "out").resolve()
    try:
        yield
    finally:
        config.WORKDIR_ROOT = old_work
        config.OUTPUT_ROOT = old_out
        shutil.rmtree(base, ignore_errors=True)

# Segmento de nombre de archivo/directorio seguro (sin separadores ni caracteres
# problemáticos para el sistema de archivos).
NOMBRE_SEGURO = st.text(
    alphabet=st.characters(
        whitelist_categories=("Lu", "Ll", "Nd"),
        whitelist_characters="_-",
    ),
    min_size=1,
    max_size=12,
).filter(lambda s: s not in {".", ".."})

# Segmento que puede incluir intentos de traversal para la Propiedad 26.
SEGMENTO_CON_TRAVERSAL = st.one_of(NOMBRE_SEGURO, st.just(".."), st.just("."))


@pytest.fixture()
def base_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirige WORKDIR_ROOT y OUTPUT_ROOT a directorios temporales aislados."""
    work = (tmp_path / "work").resolve()
    out = (tmp_path / "out").resolve()
    monkeypatch.setattr(config, "WORKDIR_ROOT", work)
    monkeypatch.setattr(config, "OUTPUT_ROOT", out)
    return tmp_path


# ---------------------------------------------------------------------------
# Propiedad 26: Contención de archivos temporales en el workdir del Job
# Feature: vertical-shorts-editor, Property 26
# Validates: Requirements 13.3
# ---------------------------------------------------------------------------
@PBT
@given(
    job_id=NOMBRE_SEGURO,
    partes=st.lists(SEGMENTO_CON_TRAVERSAL, min_size=1, max_size=6),
)
def test_propiedad_26_contencion_de_temporales(
    job_id: str, partes: List[str]
) -> None:
    """Toda ruta resuelta está contenida por prefijo en el workdir; los intentos
    de escapar del workdir se rechazan (nunca se devuelve una ruta externa)."""
    with isolated_config_dirs():
        job = JobWorkdir(job_id)
        job.create()

        try:
            ruta = job.resolve(*partes)
        except WorkdirContainmentError:
            # Rechazo aceptable: el intento de traversal fue detectado (Req 13.3).
            return

        # Si se resolvió, DEBE estar contenida por prefijo en el workdir del Job.
        assert job.is_contained(ruta)
        root_str = str(job.root)
        ruta_str = str(ruta)
        assert ruta_str == root_str or ruta_str.startswith(root_str + os.sep)


@PBT
@given(
    job_id=NOMBRE_SEGURO,
    partes=st.lists(NOMBRE_SEGURO, min_size=1, max_size=5),
)
def test_propiedad_26_artefactos_benignos_siempre_contenidos(
    job_id: str, partes: List[str]
) -> None:
    """Cualquier ruta de artefacto sin traversal se resuelve dentro del workdir
    y puede escribirse ahí físicamente."""
    with isolated_config_dirs():
        job = JobWorkdir(job_id)
        job.create()

        ruta = job.resolve(*partes)
        assert job.is_contained(ruta)
        assert str(ruta).startswith(str(job.root) + os.sep)

        # El artefacto puede materializarse dentro del workdir. Si un prefijo de
        # la ruta ya existe como archivo, no es un fallo de contención: se omite.
        try:
            ruta.parent.mkdir(parents=True, exist_ok=True)
        except (FileExistsError, NotADirectoryError):
            return
        if ruta.exists() and ruta.is_dir():
            # Otro segmento generado creó un directorio con este nombre; válido.
            return
        ruta.write_text("contenido")
        assert ruta.exists()
        assert job.is_contained(ruta)


# ---------------------------------------------------------------------------
# Propiedad 27: Toda terminación de Job limpia los temporales
# Feature: vertical-shorts-editor, Property 27
# Validates: Requirements 13.4, 13.5
# ---------------------------------------------------------------------------
@st.composite
def _arbol_de_temporales(draw: st.DrawFn) -> List[List[str]]:
    """Genera una lista de rutas relativas (segmentos) de archivos temporales."""
    n = draw(st.integers(min_value=1, max_value=8))
    rutas: List[List[str]] = []
    for _ in range(n):
        profundidad = draw(st.integers(min_value=1, max_value=3))
        segmentos = draw(
            st.lists(NOMBRE_SEGURO, min_size=profundidad, max_size=profundidad)
        )
        rutas.append(segmentos)
    return rutas


@PBT
@given(
    job_id=NOMBRE_SEGURO,
    arbol=_arbol_de_temporales(),
    es_terminacion_por_error=st.booleans(),
)
def test_propiedad_27_toda_terminacion_limpia_temporales(
    job_id: str,
    arbol: List[List[str]],
    es_terminacion_por_error: bool,
) -> None:
    """Tras la limpieza (en éxito o en error/cancelación) no queda ningún archivo
    temporal del Job, y el ``Video_Final`` conservado aparte persiste."""
    with isolated_config_dirs():
        job = JobWorkdir(job_id)
        job.create()

        # Materializar el árbol de archivos temporales dentro del workdir. Un
        # segmento puede coincidir con un directorio ya creado por otra ruta del
        # mismo árbol; en ese caso se omite ese archivo (sigue siendo un temporal
        # válido contenido en el workdir).
        for segmentos in arbol:
            ruta = job.resolve(*segmentos)
            assert job.is_contained(ruta)
            try:
                ruta.parent.mkdir(parents=True, exist_ok=True)
            except (FileExistsError, NotADirectoryError):
                continue
            if ruta.exists() and ruta.is_dir():
                continue
            ruta.write_text("temporal")

        # Simular la producción del Video_Final dentro del workdir y su
        # conservación en la ruta de salida separada (independiente del
        # resultado del Job).
        final_tmp = job.resolve("final.mp4")
        if not (final_tmp.exists() and final_tmp.is_dir()):
            final_tmp.write_bytes(b"video-final")
            salida = preservar_video_final(job, final_tmp)
            assert salida.exists()
            # La salida vive fuera del directorio temporal.
            assert not job.is_contained(salida)
        else:
            salida = None

        # La terminación (éxito o error/cancelación) invoca la misma limpieza.
        _ = es_terminacion_por_error
        resultado = job.cleanup()

        # No queda ningún archivo temporal del Job.
        assert resultado.ok
        assert resultado.failed == []
        restantes = [
            Path(dirpath) / nombre
            for dirpath, _dirs, archivos in os.walk(job.root)
            for nombre in archivos
        ]
        assert restantes == []
        # El directorio de trabajo queda vacío o eliminado.
        assert not job.root.exists() or not any(job.root.iterdir())

        # El Video_Final conservado persiste tras la limpieza (Req 13.4, 13.5).
        if salida is not None:
            assert salida.exists()
            assert salida.read_bytes() == b"video-final"


# ---------------------------------------------------------------------------
# Propiedad 28: Política de reintento de limpieza acotada
# Feature: vertical-shorts-editor, Property 28
# Validates: Requirements 13.6
# ---------------------------------------------------------------------------
class _RemovedorFallido:
    """Removedor que siempre falla, contando los intentos por ruta."""

    def __init__(self) -> None:
        self.intentos: dict = {}

    def __call__(self, path: Path) -> None:
        self.intentos[str(path)] = self.intentos.get(str(path), 0) + 1
        raise OSError(f"fallo persistente simulado al eliminar {path}")


@PBT
@given(
    job_id=NOMBRE_SEGURO,
    n_archivos=st.integers(min_value=1, max_value=6),
    max_retries=st.integers(min_value=0, max_value=5),
)
def test_propiedad_28_reintentos_acotados_y_registro(
    job_id: str, n_archivos: int, max_retries: int
) -> None:
    """Ante fallo persistente se realizan como máximo ``max_retries`` reintentos
    (``max_retries + 1`` intentos) por archivo y todos quedan registrados como
    fallidos, sin lanzar excepción que interrumpa el proceso."""
    with isolated_config_dirs():
        job = JobWorkdir(job_id)
        job.create()

        archivos = []
        for i in range(n_archivos):
            ruta = job.resolve(f"temp_{i}.bin")
            ruta.write_bytes(b"x")
            archivos.append(ruta)

        removedor = _RemovedorFallido()
        resultado = job.cleanup(remover=removedor, max_retries=max_retries)

        # Cada archivo se intentó exactamente ``max_retries + 1`` veces (1 intento
        # inicial + los reintentos), nunca más.
        for ruta in archivos:
            assert removedor.intentos[str(ruta)] == max_retries + 1
            assert resultado.attempts[str(ruta)] == max_retries + 1

        # Todos los archivos con fallo persistente quedan registrados como fallidos.
        assert set(resultado.failed) == set(archivos)
        assert resultado.removed == []
        assert not resultado.ok


@PBT
@given(
    job_a=NOMBRE_SEGURO,
    job_b=NOMBRE_SEGURO,
    n_archivos=st.integers(min_value=1, max_value=4),
)
def test_propiedad_28_fallo_no_interrumpe_otros_jobs(
    job_a: str, job_b: str, n_archivos: int
) -> None:
    """El fallo persistente de limpieza de un Job no impide limpiar otro Job."""
    assume(job_a != job_b)

    with isolated_config_dirs():
        a = JobWorkdir(job_a)
        a.create()
        b = JobWorkdir(job_b)
        b.create()

        for i in range(n_archivos):
            ruta_a = a.resolve(f"a_{i}.bin")
            ruta_a.write_bytes(b"x")
            ruta_b = b.resolve(f"b_{i}.bin")
            ruta_b.write_bytes(b"y")

        # El Job A falla de forma persistente...
        resultado_a = a.cleanup(remover=_RemovedorFallido())
        assert not resultado_a.ok
        assert len(resultado_a.failed) == n_archivos

        # ...y sin embargo el Job B se limpia por completo sin verse afectado.
        resultado_b = b.cleanup()
        assert resultado_b.ok
        assert resultado_b.failed == []
        restantes_b = [
            Path(dirpath) / nombre
            for dirpath, _dirs, archivos in os.walk(b.root)
            for nombre in archivos
        ]
        assert restantes_b == []


# ---------------------------------------------------------------------------
# Tests unitarios de apoyo
# ---------------------------------------------------------------------------
def test_create_es_idempotente(base_dirs: Path) -> None:
    job = JobWorkdir("job-idem")
    p1 = job.create()
    p2 = job.create()
    assert p1 == p2 == job.root
    assert job.root.is_dir()
    assert job.root == (config.WORKDIR_ROOT / "jobs" / "job-idem")


def test_resolve_rechaza_traversal_explicito(base_dirs: Path) -> None:
    job = JobWorkdir("job-esc")
    job.create()
    with pytest.raises(WorkdirContainmentError):
        job.resolve("..", "..", "etc", "passwd")


def test_resolve_rechaza_ruta_absoluta(base_dirs: Path) -> None:
    job = JobWorkdir("job-abs")
    job.create()
    with pytest.raises(WorkdirContainmentError):
        job.resolve("/etc/passwd")


def test_job_id_invalido_se_rechaza(base_dirs: Path) -> None:
    with pytest.raises(wd.WorkdirError):
        JobWorkdir("con/separador")
    with pytest.raises(wd.WorkdirError):
        JobWorkdir("")


def test_cleanup_sin_workdir_es_noop(base_dirs: Path) -> None:
    job = JobWorkdir("job-inexistente")
    resultado = job.cleanup()
    assert resultado.ok
    assert resultado.removed == []
    assert resultado.failed == []


def test_cleanup_exitoso_elimina_todo(base_dirs: Path) -> None:
    job = JobWorkdir("job-ok")
    job.create()
    for nombre in ("a.mp4", "b.wav", "c.ass"):
        job.resolve(nombre).write_text("x")
    sub = job.resolve("sub", "d.mp4")
    sub.parent.mkdir(parents=True, exist_ok=True)
    sub.write_text("x")

    resultado = job.cleanup()
    assert resultado.ok
    assert len(resultado.removed) == 4
    assert not job.root.exists()


def test_preservar_video_final_persiste_tras_limpieza(base_dirs: Path) -> None:
    job = JobWorkdir("job-final")
    job.create()
    final = job.resolve("final.mp4")
    final.write_bytes(b"resultado")

    salida = preservar_video_final(job, final)
    assert salida == job.output_path
    assert salida.exists()

    job.cleanup()
    assert not job.root.exists()
    assert salida.exists()
    assert salida.read_bytes() == b"resultado"


def test_preservar_video_final_rechaza_origen_externo(base_dirs: Path, tmp_path: Path) -> None:
    job = JobWorkdir("job-ext")
    job.create()
    externo = tmp_path / "externo.mp4"
    externo.write_bytes(b"x")
    with pytest.raises(WorkdirContainmentError):
        preservar_video_final(job, externo)


def test_max_cleanup_retries_por_defecto_es_tres() -> None:
    assert MAX_CLEANUP_RETRIES == 3
