"""Ejecución de comandos externos aislada e inyectable (soporte del Motor).

Los pasos del pipeline que invocan herramientas externas (``ffmpeg``,
``ffprobe``, ``auto-editor``) comparten la necesidad de lanzar un proceso y
recoger su código de salida y sus flujos de texto. Este módulo concentra esa
mecánica en:

* :class:`ResultadoComando`: resultado inmutable de ejecutar un comando.
* :data:`Runner`: firma de un ejecutor de comandos **inyectable**.
* :func:`ejecutar_comando`: ejecutor por defecto basado en :mod:`subprocess`.

Aislar la ejecución detrás de un ``Runner`` inyectable permite que los tests
verifiquen la **construcción de los comandos** y simulen éxitos/fallos sin
depender de que los binarios reales estén instalados en la máquina. Ningún
módulo del motor debe invocar :func:`subprocess.run` directamente: siempre a
través de un ``Runner`` (por defecto :func:`ejecutar_comando`).

Referencias de requisitos: 3.6, 4.5, 5.7, 7.10, 8.7 (todos requieren detectar y
reportar fallos de ejecución de herramientas externas).
"""

from __future__ import annotations

import subprocess
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


# Un ``Runner`` recibe la lista de argumentos del comando y devuelve su
# :class:`ResultadoComando`. Es el punto de inyección para las pruebas.
Runner = Callable[[Sequence[str]], ResultadoComando]


def ejecutar_comando(
    args: Sequence[str], timeout: Optional[float] = None
) -> ResultadoComando:
    """Ejecuta un comando externo con :mod:`subprocess` capturando su salida.

    Args:
        args: Argumentos del comando (el primero es el ejecutable).
        timeout: Plazo opcional en segundos.

    Returns:
        El :class:`ResultadoComando` con el código de salida y los flujos.
    """
    proceso = subprocess.run(  # noqa: S603 - comandos construidos por el motor
        list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    return ResultadoComando(
        returncode=proceso.returncode,
        stdout=proceso.stdout or "",
        stderr=proceso.stderr or "",
        args=list(args),
    )


__all__ = ["ResultadoComando", "Runner", "ejecutar_comando"]
