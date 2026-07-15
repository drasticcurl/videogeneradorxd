"""Ejecución de comandos externos aislada e inyectable (soporte del Motor).

Los pasos del pipeline que invocan herramientas externas (``ffmpeg``,
``ffprobe``, ``auto-editor``, Remotion/node) comparten la necesidad de lanzar un
proceso y recoger su código de salida y sus flujos de texto. Este módulo
concentra esa mecánica en:

* :class:`ResultadoComando`: resultado inmutable de ejecutar un comando.
* :class:`ComandoTimeoutError`: error accionable cuando un comando excede su
  plazo (subclase de :class:`OSError`, de modo que cada llamador lo envuelve en
  su error de paso —``NormalizacionError``/``ClipInspeccionError``/…— sin
  cambios y el pipeline lo propaga a ``FALLIDO {paso, motivo}``).
* :data:`Runner`: firma de un ejecutor de comandos **inyectable**.
* :func:`ejecutar_comando`: ejecutor por defecto basado en :class:`subprocess.Popen`
  que **no puede colgarse en silencio** (stdin del dispositivo nulo, drenaje
  concurrente de stdout/stderr, sesión/grupo de procesos propio y plazo acotado
  con muerte del grupo completo al expirar).
* :func:`invocar_runner`: adaptador que reenvía un ``timeout`` sólo a los runners
  que lo aceptan, preservando los dobles de un solo argumento de las pruebas.

Aislar la ejecución detrás de un ``Runner`` inyectable permite que los tests
verifiquen la **construcción de los comandos** y simulen éxitos/fallos sin
depender de que los binarios reales estén instalados en la máquina. Ningún
módulo del motor debe invocar :func:`subprocess.run`/:class:`subprocess.Popen`
directamente: siempre a través de un ``Runner`` (por defecto
:func:`ejecutar_comando`), reenviado con :func:`invocar_runner`.

Bugfix ``unir-step-hang``: la causa raíz del síntoma "atascado al 25 %, sin
logs" es una **espera no acotada** (``timeout=None``) sobre un hijo que se
bloquea (p. ej. lectura FUSE estancada, o herramienta bloqueada en un ``stdin``
heredado). La prevención primaria es ``stdin`` del dispositivo nulo; el plazo es
la red de seguridad que corta un cuelgue que jamás debería ocurrir para entradas
válidas pequeñas.

Referencias de requisitos: 2.1, 2.2, 2.3, 2.4, 2.6, 3.4, 3.5, 3.6.
"""

from __future__ import annotations

import functools
import inspect
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence


@dataclass(frozen=True)
class ResultadoComando:
    """Resultado de ejecutar un comando externo.

    Attributes:
        returncode: Código de salida del proceso (0 = éxito).
        stdout: Salida estándar capturada (texto).
        stderr: Salida de error capturada (texto).
        args: Argumentos exactos con los que se invocó el comando.
    """

    returncode: int
    stdout: str = ""
    stderr: str = ""
    args: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """``True`` si el proceso terminó con código de salida 0."""
        return self.returncode == 0


class ComandoTimeoutError(OSError):
    """Un comando externo excedió su plazo acotado y fue terminado (Req 2.2, 2.3).

    Es una subclase de :class:`OSError` **a propósito**: cada punto de llamada del
    motor ya envuelve ``OSError`` en su error específico de paso
    (``NormalizacionError``, ``ClipInspeccionError``, ``SilenceProcessingError``,
    …), de modo que un timeout se propaga a ``FALLIDO {paso, motivo}`` sin cambiar
    el manejo de excepciones de ningún llamador.

    Attributes:
        args_comando: Argumentos del comando que expiró.
        timeout: Plazo (segundos) que se excedió.
        stderr: Cola de ``stderr`` capturada antes de la muerte (si la hay).
    """

    def __init__(
        self,
        args_comando: Sequence[str],
        timeout: float,
        stderr: str = "",
    ) -> None:
        self.args_comando = list(args_comando)
        self.timeout = timeout
        self.stderr = stderr or ""
        nombre = os.path.basename(str(args_comando[0])) if args_comando else "comando"
        cola = self.stderr.strip()[-500:]
        detalle = f" | stderr: {cola}" if cola else ""
        super().__init__(
            f"El comando {nombre!r} superó el plazo de {timeout} s y fue "
            f"terminado (grupo de procesos){detalle}"
        )


# Un ``Runner`` recibe la lista de argumentos del comando (y, opcionalmente, un
# ``timeout: Optional[float]`` por palabra clave) y devuelve su
# :class:`ResultadoComando`. Es el punto de inyección para las pruebas. La firma
# se amplía a ``Callable[..., ResultadoComando]`` para admitir tanto el ejecutor
# real con plazo como los dobles de un solo argumento; el reenvío del plazo lo
# gestiona :func:`invocar_runner`.
Runner = Callable[..., ResultadoComando]

# Segundos de cortesía tras ``SIGTERM`` antes de escalar a ``SIGKILL`` sobre el
# grupo de procesos, y plazo máximo para drenar la salida residual tras matar.
_KILL_GRACE_S: float = 3.0
_DRAIN_GRACE_S: float = 5.0


def _matar_grupo(proceso: "subprocess.Popen", sig: int) -> None:
    """Envía ``sig`` a todo el grupo de procesos del hijo (POSIX) o lo mata (Windows).

    En POSIX, el hijo se lanzó con ``start_new_session=True``, por lo que es líder
    de sesión/grupo y ``os.killpg`` alcanza al hijo **y a todos sus descendientes**
    (p. ej. ``ffmpeg`` lanzado por ``auto-editor``). Si el grupo ya no existe, se
    ignora silenciosamente.
    """
    if os.name == "posix":
        try:
            os.killpg(os.getpgid(proceso.pid), sig)
            return
        except (ProcessLookupError, PermissionError, OSError):
            # El grupo pudo desaparecer entre medias; como último recurso, señal
            # directa al hijo.
            try:
                proceso.send_signal(sig)
            except (ProcessLookupError, OSError):
                pass
    else:  # pragma: no cover - ruta Windows (no ejercitada en CI POSIX)
        try:
            proceso.kill()
        except OSError:
            pass


def _terminar_proceso(proceso: "subprocess.Popen") -> None:
    """Termina el grupo con ``SIGTERM`` y escala a ``SIGKILL`` tras una cortesía."""
    _matar_grupo(proceso, signal.SIGTERM)
    limite = time.monotonic() + _KILL_GRACE_S
    while time.monotonic() < limite:
        if proceso.poll() is not None:
            return
        time.sleep(0.05)
    # Sigue vivo tras la cortesía: escalada dura al grupo completo.
    _matar_grupo(proceso, signal.SIGKILL)


def ejecutar_comando(
    args: Sequence[str], timeout: Optional[float] = None
) -> ResultadoComando:
    """Ejecuta un comando externo de forma que **no pueda colgarse en silencio**.

    Estrategia (bugfix ``unir-step-hang``, diseño §"Fix Implementation / Change 1"):

    1. ``stdin`` del **dispositivo nulo** (``subprocess.DEVNULL``): ninguna
       herramienta se bloquea esperando entrada (prevención primaria).
    2. **Sesión/grupo de procesos propio** (``start_new_session=True`` en POSIX;
       ``CREATE_NEW_PROCESS_GROUP`` en Windows) para poder terminar el hijo y
       todos sus descendientes como una unidad.
    3. **Drenaje concurrente** de ``stdout`` y ``stderr`` vía
       ``proceso.communicate(timeout=...)`` (invariante de no-deadlock, Propiedad
       3): un volumen de salida enorme nunca puede bloquear al hijo mientras el
       padre lee.
    4. **Plazo acotado**: al expirar, se mata el **grupo completo**, se drena la
       salida residual y se lanza :class:`ComandoTimeoutError` accionable.

    En éxito devuelve un :class:`ResultadoComando` idéntico byte a byte al
    anterior (mismo ``returncode``/``stdout``/``stderr``/``args``), preservando el
    comportamiento para entradas no problemáticas (Propiedad 2).

    Args:
        args: Argumentos del comando (el primero es el ejecutable).
        timeout: Plazo opcional en segundos. ``None`` = sin plazo (los puntos de
            llamada del motor pasan siempre un plazo por paso vía
            :func:`invocar_runner`).

    Returns:
        El :class:`ResultadoComando` con el código de salida y los flujos.

    Raises:
        ComandoTimeoutError: Si el comando excede ``timeout`` (tras matar el grupo).
    """
    kwargs = {}
    if os.name == "posix":
        kwargs["start_new_session"] = True
    else:  # pragma: no cover - ruta Windows
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if creationflags:
            kwargs["creationflags"] = creationflags

    proceso = subprocess.Popen(  # noqa: S603 - comandos construidos por el motor
        list(args),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **kwargs,
    )

    try:
        stdout, stderr = proceso.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Matar el grupo completo (hijo + descendientes) y drenar lo que quede.
        _terminar_proceso(proceso)
        stderr_residual = ""
        try:
            _out, _err = proceso.communicate(timeout=_DRAIN_GRACE_S)
            stderr_residual = _err or ""
        except subprocess.TimeoutExpired:
            proceso.kill()
            try:
                _out, _err = proceso.communicate()
                stderr_residual = _err or ""
            except Exception:  # noqa: BLE001 - el drenaje final nunca debe enmascarar el timeout
                stderr_residual = ""
        raise ComandoTimeoutError(list(args), float(timeout), stderr_residual)

    return ResultadoComando(
        returncode=proceso.returncode,
        stdout=stdout or "",
        stderr=stderr or "",
        args=list(args),
    )


@functools.lru_cache(maxsize=512)
def _acepta_timeout_cacheado(runner: Runner) -> bool:
    """Versión cacheada de :func:`_detectar_timeout` (por objeto ``runner``)."""
    return _detectar_timeout(runner)


def _detectar_timeout(runner: Runner) -> bool:
    """Indica si ``runner`` acepta un parámetro ``timeout`` (o ``**kwargs``).

    Un doble de un solo argumento (``def _cmd(args): ...`` / ``__call__(self, args)``)
    no lo acepta y debe invocarse exactamente como hoy (``runner(args)``).
    """
    try:
        firma = inspect.signature(runner)
    except (ValueError, TypeError):
        # No se pudo introspectar: se asume el contrato mínimo (un solo argumento).
        return False
    for parametro in firma.parameters.values():
        if parametro.name == "timeout":
            return True
        if parametro.kind is inspect.Parameter.VAR_KEYWORD:
            # Acepta ``**kwargs``: podrá recibir ``timeout=...`` sin TypeError.
            return True
    return False


def _acepta_timeout(runner: Runner) -> bool:
    """Detección con caché y respaldo si el ``runner`` no es hashable."""
    try:
        return _acepta_timeout_cacheado(runner)
    except TypeError:
        return _detectar_timeout(runner)


def invocar_runner(
    runner: Runner, args: Sequence[str], timeout: Optional[float] = None
) -> ResultadoComando:
    """Invoca ``runner`` reenviando ``timeout`` sólo si lo acepta (Propiedad 5).

    Es la costura crítica de preservación: para el ejecutor real
    (:func:`ejecutar_comando`, que acepta ``timeout``) se aplica el plazo; para un
    doble de un solo argumento la llamada es idéntica a ``runner(args)`` de hoy,
    sin ``TypeError``.

    Args:
        runner: Ejecutor de comandos inyectable.
        args: Argumentos del comando.
        timeout: Plazo por paso a reenviar si el runner lo admite.

    Returns:
        El :class:`ResultadoComando` producido por el runner.
    """
    if timeout is not None and _acepta_timeout(runner):
        return runner(args, timeout=timeout)
    return runner(args)


__all__ = [
    "ResultadoComando",
    "ComandoTimeoutError",
    "Runner",
    "ejecutar_comando",
    "invocar_runner",
]
