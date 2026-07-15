"""Verificador de Dependencias al iniciar (Req 12).

Este módulo comprueba, al arrancar el Backend, la disponibilidad de las
herramientas externas que necesita el Motor de Procesamiento:

* ``ffmpeg``, ``ffprobe`` y ``auto-editor``: se comprueban localizando el
  ejecutable en el ``PATH`` con :func:`shutil.which` (instantáneo, sin ejecutar
  ``--version``, evitando así el coste de arranque de herramientas lentas).
* ``faster-whisper``: se comprueba la **importabilidad** del módulo
  (``import faster_whisper``) sin cargar ningún modelo.

Antes de resolver los binarios se asegura que el ``PATH`` del proceso incluya
las rutas de Homebrew/macOS (:func:`app.deps.path_setup.asegurar_path_local`),
de modo que los binarios instalados con ``brew`` se encuentren aunque el backend
se haya lanzado desde la GUI (doble clic).

Reglas (Req 12.1-12.5):

* Todas las comprobaciones deben caber dentro de un **plazo total** de 10 s
  (:data:`app.config.DEPENDENCY_CHECK_TIMEOUT_S`); cada comprobación individual
  se acota al presupuesto de tiempo restante (Req 12.1).
* Si una comprobación **excede** su plazo, la dependencia se trata como **no
  disponible** y se registra como **no verificable** (Req 12.3).
* Si **una o más** dependencias no están disponibles, se registra un mensaje que
  identifica **por su nombre** cada dependencia faltante (Req 12.2) y se decide
  **bloquear** el arranque (Req 12.4).
* Si **todas** están disponibles, se permite continuar el arranque (Req 12.5).

Las funciones de comprobación individuales son **inyectables/mockeables**: el
punto de entrada :func:`verificar_dependencias` acepta un mapeo
``nombre -> comprobador`` para poder probar la lógica de decisión sin depender de
los binarios reales instalados en la máquina.

Referencias de requisitos: 12.1, 12.2, 12.3, 12.4, 12.5.
"""

from __future__ import annotations

import importlib.util
import logging
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Mapping, Optional

from app import config
from app.deps.path_setup import asegurar_path_local

logger = logging.getLogger(__name__)

# Nombres canónicos de las dependencias en el orden en que se comprueban
# (y en que se reportan). Estos son exactamente los nombres exigidos por el
# Req 12.1/12.2.
DEP_FFMPEG = "ffmpeg"
DEP_FFPROBE = "ffprobe"
DEP_AUTO_EDITOR = "auto-editor"
DEP_FASTER_WHISPER = "faster-whisper"

DEPENDENCIAS: tuple[str, ...] = (
    DEP_FFMPEG,
    DEP_FFPROBE,
    DEP_AUTO_EDITOR,
    DEP_FASTER_WHISPER,
)

# Un comprobador recibe el timeout individual disponible (segundos) y devuelve
# ``True`` si la dependencia está disponible o ``False`` si no lo está. Para
# señalar que la comprobación no finalizó a tiempo debe lanzar
# ``subprocess.TimeoutExpired`` o ``TimeoutError`` (Req 12.3).
Comprobador = Callable[[float], bool]

# Reloj monótono inyectable (facilita las pruebas del presupuesto de tiempo).
Reloj = Callable[[], float]


class DependenciasFaltantesError(RuntimeError):
    """Se lanza cuando falta al menos una dependencia y debe abortarse el arranque.

    Contiene la lista de nombres de las dependencias faltantes (Req 12.2, 12.4).
    """

    def __init__(self, faltantes: List[str]) -> None:
        self.faltantes = list(faltantes)
        super().__init__(
            "No se puede iniciar el Backend: faltan dependencias requeridas: "
            + ", ".join(self.faltantes)
        )


@dataclass
class ResultadoDependencia:
    """Resultado de comprobar una única dependencia.

    Attributes:
        nombre: Nombre canónico de la dependencia (p. ej. ``"ffmpeg"``).
        disponible: ``True`` si la dependencia está disponible.
        verificable: ``False`` si la comprobación no pudo finalizar dentro del
            plazo (timeout); en ese caso la dependencia se considera **no
            disponible** (Req 12.3).
        detalle: Mensaje descriptivo del resultado (para el registro).
    """

    nombre: str
    disponible: bool
    verificable: bool = True
    detalle: str = ""


@dataclass
class ResultadoVerificacion:
    """Resultado agregado de la verificación de todas las dependencias."""

    resultados: List[ResultadoDependencia] = field(default_factory=list)

    @property
    def faltantes(self) -> List[str]:
        """Nombres de las dependencias no disponibles, en orden de comprobación."""
        return [r.nombre for r in self.resultados if not r.disponible]

    @property
    def no_verificables(self) -> List[str]:
        """Nombres de las dependencias cuya comprobación excedió el plazo."""
        return [r.nombre for r in self.resultados if not r.verificable]

    @property
    def debe_bloquear(self) -> bool:
        """``True`` si y solo si falta al menos una dependencia (Req 12.4, 12.5)."""
        return bool(self.faltantes)

    @property
    def ok(self) -> bool:
        """``True`` si todas las dependencias están disponibles (Req 12.5)."""
        return not self.faltantes


# ---------------------------------------------------------------------------
# Comprobadores por defecto (dependen de los binarios/paquetes reales)
# ---------------------------------------------------------------------------
def comprobar_binario(comando: str) -> Comprobador:
    """Crea un comprobador que localiza ``comando`` en el ``PATH`` con ``shutil.which``.

    La comprobación es **instantánea**: no ejecuta el binario (evita el coste de
    arranque de herramientas lentas como ``auto-editor``, que tardaba ~10 s en
    responder a ``--version`` y agotaba el presupuesto total de verificación).
    La dependencia se considera **disponible** si :func:`shutil.which` encuentra
    el ejecutable en el ``PATH``; en caso contrario, **no disponible**.

    Se conserva el parámetro ``timeout`` para respetar la firma
    :data:`Comprobador` (los comprobadores inyectados en los tests pueden seguir
    simulando timeouts), pero al no lanzar ningún ``subprocess`` este comprobador
    nunca lo agota.
    """

    def _comprobar(_timeout: float) -> bool:
        return shutil.which(comando) is not None

    return _comprobar


def comprobar_importable(modulo: str) -> Comprobador:
    """Crea un comprobador de importabilidad de un módulo Python.

    Comprueba que el módulo se pueda localizar (``import``) sin llegar a
    ejecutar/cargar recursos pesados (p. ej. modelos), usado para
    ``faster-whisper`` (Req 12.1).
    """

    def _comprobar(_timeout: float) -> bool:
        return importlib.util.find_spec(modulo) is not None

    return _comprobar


def _comprobadores_por_defecto() -> Dict[str, Comprobador]:
    """Devuelve el mapeo de comprobadores reales para producción."""
    return {
        DEP_FFMPEG: comprobar_binario("ffmpeg"),
        DEP_FFPROBE: comprobar_binario("ffprobe"),
        DEP_AUTO_EDITOR: comprobar_binario("auto-editor"),
        # faster-whisper se importa como ``faster_whisper``.
        DEP_FASTER_WHISPER: comprobar_importable("faster_whisper"),
    }


# ---------------------------------------------------------------------------
# Punto de entrada de la verificación
# ---------------------------------------------------------------------------
def verificar_dependencias(
    comprobadores: Optional[Mapping[str, Comprobador]] = None,
    timeout_total: Optional[float] = None,
    reloj: Reloj = time.monotonic,
) -> ResultadoVerificacion:
    """Verifica la disponibilidad de todas las dependencias requeridas.

    Cada dependencia se comprueba en el orden de :data:`DEPENDENCIAS`. El plazo
    total (por defecto :data:`app.config.DEPENDENCY_CHECK_TIMEOUT_S`) se reparte
    de forma acumulativa: cada comprobación individual se acota al presupuesto de
    tiempo **restante**, de modo que la suma de todas las comprobaciones nunca
    exceda el plazo total (Req 12.1). Una comprobación que agota su plazo (o el
    presupuesto restante ya es 0) marca la dependencia como **no verificable** y,
    por tanto, **no disponible** (Req 12.3).

    Args:
        comprobadores: Mapeo inyectable ``nombre -> comprobador``. Si es ``None``
            se usan los comprobadores reales (binarios + importación). Permite
            probar la lógica de decisión sin depender de las herramientas reales.
        timeout_total: Plazo total en segundos. Si es ``None`` se toma de
            :data:`app.config.DEPENDENCY_CHECK_TIMEOUT_S`.
        reloj: Reloj monótono inyectable para medir el tiempo transcurrido.

    Returns:
        :class:`ResultadoVerificacion` con el detalle por dependencia y la
        decisión de bloqueo del arranque.
    """
    # Asegura que el PATH incluya las rutas de Homebrew/macOS antes de resolver
    # los binarios (por si se invoca sin pasar por main.py). Idempotente.
    asegurar_path_local()

    if comprobadores is None:
        comprobadores = _comprobadores_por_defecto()
    if timeout_total is None:
        timeout_total = config.DEPENDENCY_CHECK_TIMEOUT_S

    resultado = ResultadoVerificacion()
    inicio = reloj()

    for nombre in DEPENDENCIAS:
        transcurrido = reloj() - inicio
        restante = timeout_total - transcurrido

        comprobador = comprobadores.get(nombre)
        if comprobador is None:
            # Sin comprobador definido: se considera no disponible (defensivo).
            resultado.resultados.append(
                ResultadoDependencia(
                    nombre=nombre,
                    disponible=False,
                    verificable=True,
                    detalle="sin comprobador definido",
                )
            )
            logger.error("Dependencia '%s' no disponible: sin comprobador definido", nombre)
            continue

        if restante <= 0:
            # El presupuesto total ya se agotó antes de esta comprobación:
            # se trata como no verificable / no disponible (Req 12.3).
            resultado.resultados.append(
                ResultadoDependencia(
                    nombre=nombre,
                    disponible=False,
                    verificable=False,
                    detalle="no verificable: se agotó el plazo total de verificación",
                )
            )
            logger.error(
                "Dependencia '%s' no verificable: se agotó el plazo total de %.1f s",
                nombre,
                timeout_total,
            )
            continue

        resultado.resultados.append(
            _comprobar_una(nombre, comprobador, restante)
        )

    _registrar_resumen(resultado, timeout_total)
    return resultado


def _comprobar_una(
    nombre: str, comprobador: Comprobador, timeout: float
) -> ResultadoDependencia:
    """Ejecuta un comprobador individual traduciendo timeouts/errores.

    Un timeout (``subprocess.TimeoutExpired`` / ``TimeoutError``) marca la
    dependencia como **no verificable** y por tanto **no disponible** (Req 12.3).
    Cualquier otro fallo (binario ausente, error de ejecución) se traduce a **no
    disponible pero verificable**.
    """
    try:
        disponible = comprobador(timeout)
    except (subprocess.TimeoutExpired, TimeoutError):
        logger.error(
            "Dependencia '%s' no verificable: la comprobación excedió el plazo de %.1f s",
            nombre,
            timeout,
        )
        return ResultadoDependencia(
            nombre=nombre,
            disponible=False,
            verificable=False,
            detalle="no verificable: la comprobación excedió su plazo",
        )
    except FileNotFoundError:
        logger.error("Dependencia '%s' no disponible: ejecutable no encontrado", nombre)
        return ResultadoDependencia(
            nombre=nombre,
            disponible=False,
            verificable=True,
            detalle="no disponible: ejecutable no encontrado",
        )
    except OSError as exc:
        logger.error("Dependencia '%s' no disponible: %s", nombre, exc)
        return ResultadoDependencia(
            nombre=nombre,
            disponible=False,
            verificable=True,
            detalle=f"no disponible: {exc}",
        )

    if disponible:
        return ResultadoDependencia(
            nombre=nombre, disponible=True, verificable=True, detalle="disponible"
        )
    return ResultadoDependencia(
        nombre=nombre,
        disponible=False,
        verificable=True,
        detalle="no disponible",
    )


def _registrar_resumen(resultado: ResultadoVerificacion, timeout_total: float) -> None:
    """Registra un resumen legible del resultado de la verificación."""
    if resultado.ok:
        logger.info(
            "Verificación de dependencias correcta (plazo %.1f s): %s disponibles",
            timeout_total,
            ", ".join(DEPENDENCIAS),
        )
        return

    # Req 12.2: identificar por nombre cada dependencia faltante.
    logger.error(
        "Verificación de dependencias fallida: faltan %s",
        ", ".join(resultado.faltantes),
    )
