"""Tests del Verificador de Dependencias (Tarea 10, Req 12.1-12.5).

Contiene:

* **Propiedad 25** (Feature: vertical-shorts-editor, Property 25): para cualquier
  subconjunto de dependencias faltantes entre {ffmpeg, ffprobe, auto-editor,
  faster-whisper}, el verificador reporta por nombre **exactamente** ese
  subconjunto y bloquea el arranque **si y solo si** el subconjunto es no vacío.
  (Validates: Requisitos 12.2, 12.4, 12.5)
* Tests unitarios del **timeout** de comprobación: una comprobación que excede su
  plazo se marca como **no verificable / no disponible** (Validates: Req 12.1,
  12.3), tanto por ``TimeoutExpired`` de un comprobador individual como por
  agotamiento del presupuesto total de 10 s.

Los comprobadores se inyectan (no se depende de los binarios reales ffmpeg /
ffprobe / auto-editor ni del paquete faster-whisper instalado).
"""

from __future__ import annotations

import os
import stat
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Set

from hypothesis import given, settings
from hypothesis import strategies as st

from app import config
from app.deps.checker import (
    DEPENDENCIAS,
    Comprobador,
    DependenciasFaltantesError,
    ResultadoVerificacion,
    comprobar_binario,
    verificar_dependencias,
)
from app.deps import path_setup
from app.deps.path_setup import (
    RUTAS_LOCALES_MACOS,
    asegurar_confianza_auto_editor_macos,
    asegurar_path_local,
    asegurar_permisos_auto_editor,
    preparar_auto_editor,
)

# Mínimo 100 iteraciones por propiedad.
PBT = settings(max_examples=150, deadline=None)


def _comprobadores_desde_faltantes(faltantes: Set[str]) -> Dict[str, Comprobador]:
    """Construye un mapeo de comprobadores donde las dependencias en ``faltantes``
    no están disponibles y el resto sí, sin ejecutar binarios reales."""

    def _hacer(nombre: str) -> Comprobador:
        disponible = nombre not in faltantes

        def _comprobar(_timeout: float) -> bool:
            return disponible

        return _comprobar

    return {nombre: _hacer(nombre) for nombre in DEPENDENCIAS}


# ---------------------------------------------------------------------------
# Propiedad 25: Decisión del verificador de dependencias
# Feature: vertical-shorts-editor, Property 25
# Validates: Requisitos 12.2, 12.4, 12.5
# ---------------------------------------------------------------------------
@PBT
@given(faltantes=st.sets(st.sampled_from(DEPENDENCIAS)))
def test_propiedad_25_decision_del_verificador(faltantes: Set[str]) -> None:
    """Para cualquier subconjunto de dependencias faltantes, el verificador:

    * reporta por nombre **exactamente** ese subconjunto (Req 12.2), y
    * bloquea el arranque **si y solo si** el subconjunto es no vacío
      (Req 12.4 cuando falta alguna, Req 12.5 cuando no falta ninguna).
    """
    comprobadores = _comprobadores_desde_faltantes(faltantes)

    resultado = verificar_dependencias(comprobadores=comprobadores)

    # Reporta por nombre exactamente el subconjunto faltante.
    assert set(resultado.faltantes) == faltantes
    # Sin duplicados y solo nombres válidos.
    assert len(resultado.faltantes) == len(faltantes)
    assert set(resultado.faltantes).issubset(set(DEPENDENCIAS))

    # Bloquea si y solo si el subconjunto es no vacío.
    assert resultado.debe_bloquear == bool(faltantes)
    assert resultado.ok == (not faltantes)


@PBT
@given(faltantes=st.sets(st.sampled_from(DEPENDENCIAS)))
def test_propiedad_25_arranque_aborta_sii_falta_alguna(faltantes: Set[str]) -> None:
    """El arranque (lanzar :class:`DependenciasFaltantesError`) ocurre si y solo si
    falta alguna dependencia, y el error identifica exactamente las faltantes."""
    comprobadores = _comprobadores_desde_faltantes(faltantes)
    resultado = verificar_dependencias(comprobadores=comprobadores)

    if faltantes:
        error = DependenciasFaltantesError(resultado.faltantes)
        assert set(error.faltantes) == faltantes
        # El mensaje nombra cada dependencia faltante (Req 12.2).
        for nombre in faltantes:
            assert nombre in str(error)
    else:
        # Con todo disponible no debe bloquearse (Req 12.5).
        assert not resultado.debe_bloquear


# ---------------------------------------------------------------------------
# Tarea 10.4: Timeout de comprobación de dependencia
# Validates: Requisitos 12.1, 12.3
# ---------------------------------------------------------------------------
def test_timeout_individual_marca_no_verificable_y_no_disponible() -> None:
    """Una comprobación que excede su plazo (``TimeoutExpired``) se trata como no
    verificable y, por tanto, no disponible (Req 12.3)."""

    def _lento(timeout: float) -> bool:
        raise subprocess.TimeoutExpired(cmd="ffmpeg --version", timeout=timeout)

    comprobadores: Dict[str, Comprobador] = {
        "ffmpeg": _lento,
        "ffprobe": lambda _t: True,
        "auto-editor": lambda _t: True,
        "faster-whisper": lambda _t: True,
    }

    resultado = verificar_dependencias(comprobadores=comprobadores)

    ffmpeg = next(r for r in resultado.resultados if r.nombre == "ffmpeg")
    assert ffmpeg.verificable is False
    assert ffmpeg.disponible is False
    # No verificable => contabilizada como faltante y bloquea el arranque.
    assert "ffmpeg" in resultado.faltantes
    assert "ffmpeg" in resultado.no_verificables
    assert resultado.debe_bloquear is True


def test_timeout_error_generico_tambien_marca_no_verificable() -> None:
    """Un ``TimeoutError`` genérico también marca la dependencia como no verificable."""

    def _lento(_timeout: float) -> bool:
        raise TimeoutError("la comprobación tardó demasiado")

    comprobadores: Dict[str, Comprobador] = {
        nombre: (lambda _t: True) for nombre in DEPENDENCIAS
    }
    comprobadores["faster-whisper"] = _lento

    resultado = verificar_dependencias(comprobadores=comprobadores)

    fw = next(r for r in resultado.resultados if r.nombre == "faster-whisper")
    assert fw.verificable is False
    assert fw.disponible is False
    assert resultado.debe_bloquear is True


def test_agotamiento_del_presupuesto_total_marca_no_verificable() -> None:
    """Si el plazo total de 10 s se agota, las comprobaciones restantes se marcan
    como no verificables (Req 12.1, 12.3)."""
    # Reloj simulado: cada llamada avanza 6 s. Tras la primera comprobación el
    # tiempo transcurrido supera el plazo total, por lo que las siguientes
    # dependencias quedan sin presupuesto.
    tiempos = iter([0.0, 6.0, 12.0, 18.0, 24.0, 30.0, 36.0])

    def _reloj() -> float:
        return next(tiempos)

    comprobadores: Dict[str, Comprobador] = {
        nombre: (lambda _t: True) for nombre in DEPENDENCIAS
    }

    resultado = verificar_dependencias(
        comprobadores=comprobadores,
        timeout_total=config.DEPENDENCY_CHECK_TIMEOUT_S,
        reloj=_reloj,
    )

    # La primera dependencia sí se verifica; las siguientes se quedan sin plazo.
    assert resultado.resultados[0].nombre == DEPENDENCIAS[0]
    assert resultado.resultados[0].disponible is True
    for r in resultado.resultados[1:]:
        assert r.verificable is False
        assert r.disponible is False
    assert resultado.debe_bloquear is True


def test_todo_disponible_permite_el_arranque() -> None:
    """Cuando todas las dependencias están disponibles, no se bloquea (Req 12.5)."""
    comprobadores: Dict[str, Comprobador] = {
        nombre: (lambda _t: True) for nombre in DEPENDENCIAS
    }
    resultado = verificar_dependencias(comprobadores=comprobadores)
    assert isinstance(resultado, ResultadoVerificacion)
    assert resultado.ok is True
    assert resultado.faltantes == []
    assert resultado.debe_bloquear is False


def test_comprobar_binario_detecta_ejecutable_ausente() -> None:
    """El comprobador de binarios trata un ejecutable inexistente como no disponible."""
    comando_inexistente = "binario-que-no-existe-vse-xyz"
    comprobadores: Dict[str, Comprobador] = {
        nombre: (lambda _t: True) for nombre in DEPENDENCIAS
    }
    comprobadores["ffmpeg"] = comprobar_binario(comando_inexistente)

    resultado = verificar_dependencias(comprobadores=comprobadores)

    ffmpeg = next(r for r in resultado.resultados if r.nombre == "ffmpeg")
    assert ffmpeg.disponible is False
    # Ejecutable ausente es "no disponible" pero sí verificable (no es timeout).
    assert ffmpeg.verificable is True
    assert "ffmpeg" in resultado.faltantes



# ---------------------------------------------------------------------------
# Bugfix: comprobador por defecto basado en shutil.which (unit)
# Validates: Req 12.1, 12.5 (detección fiable y rápida sin ejecutar --version)
# ---------------------------------------------------------------------------
def test_comprobador_por_defecto_usa_shutil_which_presente(monkeypatch) -> None:
    """El comprobador por defecto marca un binario como disponible cuando
    ``shutil.which`` devuelve una ruta (sin ejecutar el binario)."""
    monkeypatch.setattr(
        "app.deps.checker.shutil.which",
        lambda cmd: f"/opt/homebrew/bin/{cmd}",
    )

    comprobar = comprobar_binario("ffmpeg")
    assert comprobar(0.0) is True


def test_comprobador_por_defecto_usa_shutil_which_ausente(monkeypatch) -> None:
    """El comprobador por defecto marca un binario como no disponible cuando
    ``shutil.which`` devuelve ``None``."""
    monkeypatch.setattr("app.deps.checker.shutil.which", lambda cmd: None)

    comprobar = comprobar_binario("ffmpeg")
    assert comprobar(0.0) is False


def test_verificacion_completa_rapida_con_which(monkeypatch) -> None:
    """Con los comprobadores por defecto (which + find_spec), la verificación
    completa es prácticamente instantánea y NO agota el presupuesto de 10 s."""
    # ffmpeg/ffprobe/auto-editor -> presentes vía which; faster_whisper -> import.
    monkeypatch.setattr(
        "app.deps.checker.shutil.which",
        lambda cmd: f"/usr/local/bin/{cmd}",
    )
    monkeypatch.setattr(
        "app.deps.checker.importlib.util.find_spec",
        lambda modulo: object(),
    )

    inicio = time.monotonic()
    resultado = verificar_dependencias()  # usa comprobadores por defecto
    transcurrido = time.monotonic() - inicio

    assert resultado.ok is True
    assert resultado.faltantes == []
    # Muy por debajo del presupuesto total (10 s): la detección es instantánea.
    assert transcurrido < 1.0


# ---------------------------------------------------------------------------
# Bugfix: ajuste del PATH de Homebrew/macOS (unit)
# Validates: los binarios de Homebrew se localizan al arrancar desde la GUI.
# ---------------------------------------------------------------------------
def test_asegurar_path_local_agrega_rutas_homebrew(monkeypatch) -> None:
    """Tras ``asegurar_path_local()``, el PATH contiene las rutas de Homebrew."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")

    asegurar_path_local()

    entradas = os.environ["PATH"].split(os.pathsep)
    assert "/opt/homebrew/bin" in entradas
    assert "/usr/local/bin" in entradas
    # Las rutas preexistentes se conservan.
    assert "/usr/bin" in entradas
    assert "/bin" in entradas


def test_asegurar_path_local_es_idempotente(monkeypatch) -> None:
    """Llamar dos veces no duplica las rutas añadidas (idempotencia)."""
    monkeypatch.setenv("PATH", "/usr/bin")

    asegurar_path_local()
    primero = os.environ["PATH"]
    asegurar_path_local()
    segundo = os.environ["PATH"]

    assert primero == segundo
    for ruta in RUTAS_LOCALES_MACOS:
        assert primero.split(os.pathsep).count(ruta) == 1


def test_asegurar_path_local_no_falla_con_path_vacio(monkeypatch) -> None:
    """No falla si ``PATH`` no está definido o está vacío."""
    monkeypatch.delenv("PATH", raising=False)

    resultado = asegurar_path_local()

    entradas = resultado.split(os.pathsep)
    for ruta in RUTAS_LOCALES_MACOS:
        assert ruta in entradas



# ---------------------------------------------------------------------------
# Bugfix: permisos de ejecución del binario empaquetado de auto-editor (unit)
# Validates: corrige "[Errno 13] Permission denied" al cortar silencios.
# ---------------------------------------------------------------------------
def _sin_ejecucion(modo: int) -> int:
    """Devuelve ``modo`` sin ningún bit de ejecución (usuario/grupo/otros)."""
    return modo & ~(stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def test_asegurar_permisos_auto_editor_agrega_bit_ejecucion(tmp_path, monkeypatch) -> None:
    """Un binario en ``auto_editor/bin/`` sin bit de ejecución queda ejecutable."""
    bin_dir = tmp_path / "auto_editor" / "bin"
    bin_dir.mkdir(parents=True)
    binario = bin_dir / "auto-editor"
    binario.write_bytes(b"#!/bin/sh\necho hola\n")
    # Quitar todos los bits de ejecución para simular el empaquetado defectuoso.
    os.chmod(binario, _sin_ejecucion(binario.stat().st_mode))
    assert binario.stat().st_mode & stat.S_IXUSR == 0

    # Monkeypatch de la localización del paquete para apuntar al bin temporal.
    monkeypatch.setattr(path_setup, "_localizar_bin_auto_editor", lambda: bin_dir)

    corregidos = asegurar_permisos_auto_editor()

    assert corregidos == 1
    modo = binario.stat().st_mode
    assert modo & stat.S_IXUSR
    assert modo & stat.S_IXGRP
    assert modo & stat.S_IXOTH


def test_asegurar_permisos_auto_editor_es_idempotente(tmp_path, monkeypatch) -> None:
    """Si el binario ya es ejecutable, no se cuenta como corregido (idempotencia)."""
    bin_dir = tmp_path / "auto_editor" / "bin"
    bin_dir.mkdir(parents=True)
    binario = bin_dir / "auto-editor"
    binario.write_bytes(b"#!/bin/sh\necho hola\n")
    os.chmod(binario, binario.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    monkeypatch.setattr(path_setup, "_localizar_bin_auto_editor", lambda: bin_dir)

    # Primera llamada: ya ejecutable => nada que corregir.
    assert asegurar_permisos_auto_editor() == 0
    # Segunda llamada: sigue siendo idempotente.
    assert asegurar_permisos_auto_editor() == 0


def test_asegurar_permisos_auto_editor_no_falla_sin_paquete(monkeypatch) -> None:
    """Si el paquete auto_editor no está instalado, no lanza y devuelve 0."""
    monkeypatch.setattr(path_setup, "_localizar_bin_auto_editor", lambda: None)
    assert asegurar_permisos_auto_editor() == 0


def test_asegurar_permisos_auto_editor_find_spec_ausente(monkeypatch) -> None:
    """Con ``find_spec`` devolviendo ``None`` (no instalado), no rompe."""
    monkeypatch.setattr(
        "app.deps.path_setup.importlib.util.find_spec", lambda nombre: None
    )
    # No debe lanzar aunque se ejecute la localización real.
    assert asegurar_permisos_auto_editor() == 0


# ---------------------------------------------------------------------------
# Bugfix macOS "Killed: 9": mitigaciones de confianza (xattr/codesign)
# Validates: evita que macOS mate el binario de auto-editor con SIGKILL.
# ---------------------------------------------------------------------------
def test_confianza_macos_es_noop_fuera_de_darwin(monkeypatch) -> None:
    """Fuera de macOS, ``asegurar_confianza_auto_editor_macos`` no hace nada."""
    monkeypatch.setattr(path_setup.sys, "platform", "linux")

    llamadas: list = []
    monkeypatch.setattr(
        path_setup.subprocess, "run", lambda *a, **k: llamadas.append((a, k))
    )
    # También forzamos que localizar el paquete devolvería algo, para asegurar
    # que el corto-circuito ocurre por la plataforma y no por ausencia de paquete.
    monkeypatch.setattr(
        path_setup, "_localizar_paquete_auto_editor", lambda: path_setup.Path("/x")
    )

    asegurar_confianza_auto_editor_macos()

    # No se ejecutó ningún subprocess (ni xattr ni codesign).
    assert llamadas == []


def test_confianza_macos_ejecuta_xattr_y_codesign(tmp_path, monkeypatch) -> None:
    """En macOS, se ejecuta ``xattr`` sobre el paquete y ``codesign`` por binario.

    Se mockea ``subprocess.run`` para no ejecutar binarios reales inexistentes."""
    monkeypatch.setattr(path_setup.sys, "platform", "darwin")

    paquete = tmp_path / "auto_editor"
    bin_dir = paquete / "bin"
    bin_dir.mkdir(parents=True)
    binario = bin_dir / "auto-editor"
    binario.write_bytes(b"#!/bin/sh\necho hola\n")

    monkeypatch.setattr(
        path_setup, "_localizar_paquete_auto_editor", lambda: paquete
    )
    monkeypatch.setattr(path_setup, "_localizar_bin_auto_editor", lambda: bin_dir)

    llamadas: list = []

    def _fake_run(args, **kwargs):
        llamadas.append(list(args))

        class _R:
            returncode = 0

        return _R()

    monkeypatch.setattr(path_setup.subprocess, "run", _fake_run)

    asegurar_confianza_auto_editor_macos()

    # Se ejecutó xattr para quitar la cuarentena del paquete.
    assert any(a[:3] == ["xattr", "-dr", "com.apple.quarantine"] for a in llamadas)
    # Se re-firmó ad-hoc el binario con codesign.
    assert any(
        a[:4] == ["codesign", "--force", "--sign", "-"] for a in llamadas
    )


def test_confianza_macos_tolerante_a_fallos(tmp_path, monkeypatch) -> None:
    """Si ``subprocess.run`` lanza (p. ej. binario ausente), no propaga la excepción."""
    monkeypatch.setattr(path_setup.sys, "platform", "darwin")

    paquete = tmp_path / "auto_editor"
    bin_dir = paquete / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "auto-editor").write_bytes(b"bin")

    monkeypatch.setattr(
        path_setup, "_localizar_paquete_auto_editor", lambda: paquete
    )
    monkeypatch.setattr(path_setup, "_localizar_bin_auto_editor", lambda: bin_dir)

    def _boom(*_a, **_k):
        raise FileNotFoundError("xattr/codesign no está instalado")

    monkeypatch.setattr(path_setup.subprocess, "run", _boom)

    # No debe lanzar pese a que cada subprocess falla.
    asegurar_confianza_auto_editor_macos()


def test_confianza_macos_sin_paquete_no_rompe(monkeypatch) -> None:
    """Si el paquete auto_editor no está instalado, la función no rompe (macOS)."""
    monkeypatch.setattr(path_setup.sys, "platform", "darwin")
    monkeypatch.setattr(path_setup, "_localizar_paquete_auto_editor", lambda: None)

    llamadas: list = []
    monkeypatch.setattr(
        path_setup.subprocess, "run", lambda *a, **k: llamadas.append(a)
    )

    asegurar_confianza_auto_editor_macos()
    assert llamadas == []


def test_preparar_auto_editor_compone_permisos_y_confianza(monkeypatch) -> None:
    """``preparar_auto_editor`` invoca permisos + confianza de macOS."""
    orden: list = []
    monkeypatch.setattr(
        path_setup,
        "asegurar_permisos_auto_editor",
        lambda: orden.append("permisos") or 0,
    )
    monkeypatch.setattr(
        path_setup,
        "asegurar_confianza_auto_editor_macos",
        lambda: orden.append("confianza"),
    )

    preparar_auto_editor()

    assert orden == ["permisos", "confianza"]
