"""Directorio de trabajo temporal por Job y su limpieza (Req 13).

Este módulo gestiona el ciclo de vida en disco de los artefactos temporales de
un Job del Motor de Procesamiento:

* **Creación (Req 13.3):** al iniciar un Job se crea el directorio de trabajo
  ``{WORKDIR_ROOT}/jobs/{job_id}/`` y toda ruta de artefacto se resuelve
  **siempre dentro** de ese directorio (contención por prefijo). Cualquier
  intento de escapar del workdir (por ejemplo con ``..`` o una ruta absoluta) se
  rechaza con :class:`WorkdirContainmentError`.
* **Limpieza (Req 13.4, 13.5):** al finalizar el Job —tanto en éxito como en
  error o cancelación— se eliminan todos los archivos temporales del Job.
* **Política de reintentos (Req 13.6):** si la eliminación de un archivo falla,
  se reintenta hasta :data:`MAX_CLEANUP_RETRIES` veces; si el fallo persiste, se
  registra una indicación que identifica el archivo afectado y la limpieza
  continúa con el resto **sin interrumpir** el procesamiento de otros Jobs.
* **Conservación del resultado (Req 13.4, 13.5):** el ``Video_Final`` se copia a
  una ruta de salida separada del directorio temporal
  (:func:`app.config.job_output_path`), de modo que persista tras la limpieza.

El módulo referencia las rutas base a través del módulo :mod:`app.config` en
tiempo de llamada (no las captura como constantes locales), de modo que las
pruebas puedan redirigir ``WORKDIR_ROOT`` / ``OUTPUT_ROOT`` mediante monkeypatch.

Referencias de requisitos: 13.3, 13.4, 13.5, 13.6.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List

from app import config

logger = logging.getLogger(__name__)

# Número máximo de reintentos de eliminación por archivo antes de darse por
# vencido y registrar el archivo afectado (Req 13.6).
MAX_CLEANUP_RETRIES: int = 3

# Firma del removedor de archivos individual, inyectable para pruebas. Recibe la
# ruta del archivo a eliminar y debe lanzar una excepción si no puede eliminarlo.
Remover = Callable[[Path], None]


class WorkdirError(Exception):
    """Error base de la gestión del directorio de trabajo."""


class WorkdirContainmentError(WorkdirError):
    """Se intentó resolver una ruta que escapa del directorio de trabajo del Job."""


def _default_remover(path: Path) -> None:
    """Elimina un único archivo (o enlace) del disco."""
    os.remove(path)


@dataclass
class CleanupResult:
    """Resultado de una operación de limpieza del directorio de trabajo.

    Attributes:
        removed: Archivos eliminados correctamente.
        failed: Archivos cuya eliminación falló de forma persistente tras agotar
            los reintentos (Req 13.6).
        attempts: Número de intentos de eliminación realizados por cada ruta
            (clave = ruta en texto). Útil para verificar la política de
            reintentos acotada.
    """

    removed: List[Path] = field(default_factory=list)
    failed: List[Path] = field(default_factory=list)
    attempts: Dict[str, int] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        """``True`` si no quedó ningún archivo sin eliminar."""
        return not self.failed


class JobWorkdir:
    """Directorio de trabajo temporal asociado a un Job (Req 13).

    Encapsula la creación del directorio, la resolución contenida de rutas de
    artefactos y la limpieza con política de reintentos acotada.
    """

    def __init__(self, job_id: str) -> None:
        if not job_id or os.sep in job_id or (os.altsep and os.altsep in job_id):
            raise WorkdirError(f"job_id inválido para el directorio de trabajo: {job_id!r}")
        self.job_id = job_id
        # Se resuelve a ruta absoluta canónica para poder comprobar contención.
        self._root = config.job_workdir(job_id).resolve()

    # ------------------------------------------------------------------
    # Propiedades de rutas
    # ------------------------------------------------------------------
    @property
    def root(self) -> Path:
        """Directorio de trabajo temporal del Job (``{WORKDIR}/jobs/{job_id}``)."""
        return self._root

    @property
    def output_path(self) -> Path:
        """Ruta de salida donde se conserva el ``Video_Final`` (fuera del temporal)."""
        return config.job_output_path(self.job_id).resolve()

    # ------------------------------------------------------------------
    # Creación
    # ------------------------------------------------------------------
    def create(self) -> Path:
        """Crea el directorio de trabajo del Job (idempotente) y lo devuelve.

        Cumple Req 13.3: al iniciar un Job se dispone de su directorio temporal.
        """
        self._root.mkdir(parents=True, exist_ok=True)
        return self._root

    # ------------------------------------------------------------------
    # Resolución contenida de artefactos (Req 13.3, Propiedad 26)
    # ------------------------------------------------------------------
    def resolve(self, *parts: str) -> Path:
        """Resuelve la ruta de un artefacto **siempre dentro** del workdir.

        La ruta resultante se normaliza y se comprueba que esté contenida por
        prefijo en :attr:`root`. Se rechaza cualquier intento de escapar del
        directorio (por ejemplo mediante ``..`` o una ruta absoluta) lanzando
        :class:`WorkdirContainmentError`.

        Args:
            *parts: Segmentos relativos de la ruta del artefacto.

        Returns:
            La ruta absoluta canónica del artefacto dentro del workdir.

        Raises:
            WorkdirContainmentError: Si la ruta resultante escaparía del workdir.
        """
        if not parts:
            return self._root

        # Una parte absoluta reiniciaría la ruta y escaparía del workdir.
        for part in parts:
            if os.path.isabs(part):
                raise WorkdirContainmentError(
                    f"Ruta absoluta no permitida dentro del workdir del Job: {part!r}"
                )

        candidate = self._root.joinpath(*parts)
        # ``os.path.normpath`` colapsa segmentos ``..`` sin tocar el disco;
        # ``resolve`` canonicaliza igual que ``root`` para comparar prefijos.
        resolved = Path(os.path.normpath(str(candidate))).resolve()

        if not self._is_contained(resolved):
            raise WorkdirContainmentError(
                f"La ruta {resolved} escaparía del workdir del Job {self._root}"
            )
        return resolved

    def is_contained(self, path: os.PathLike | str) -> bool:
        """Indica si ``path`` está contenida por prefijo en el workdir del Job."""
        resolved = Path(os.path.normpath(str(path)))
        if resolved.is_absolute():
            resolved = resolved.resolve()
        else:
            resolved = (self._root / resolved).resolve()
        return self._is_contained(resolved)

    def _is_contained(self, resolved: Path) -> bool:
        if resolved == self._root:
            return True
        try:
            return resolved.is_relative_to(self._root)  # type: ignore[attr-defined]
        except AttributeError:  # pragma: no cover - Python < 3.9
            try:
                resolved.relative_to(self._root)
                return True
            except ValueError:
                return False

    # ------------------------------------------------------------------
    # Limpieza (Req 13.4, 13.5, 13.6, Propiedades 27 y 28)
    # ------------------------------------------------------------------
    def cleanup(
        self,
        remover: Remover = _default_remover,
        max_retries: int = MAX_CLEANUP_RETRIES,
    ) -> CleanupResult:
        """Elimina todos los archivos temporales del Job.

        Recorre el árbol del workdir de abajo hacia arriba, eliminando cada
        archivo con la política de reintentos acotada (Req 13.6). Los directorios
        vacíos se eliminan tras sus contenidos. Un fallo persistente en un
        archivo se registra y no interrumpe la eliminación del resto ni de otros
        Jobs.

        Args:
            remover: Función de eliminación de un archivo individual (inyectable
                para pruebas). Por defecto elimina del disco real.
            max_retries: Número máximo de reintentos por archivo (Req 13.6).

        Returns:
            :class:`CleanupResult` con los archivos eliminados, los fallidos de
            forma persistente y el número de intentos por ruta.
        """
        result = CleanupResult()

        if not self._root.exists():
            return result

        # Recolectar archivos primero (de más profundo a menos) para eliminar
        # contenidos antes que sus contenedores.
        archivos: List[Path] = []
        directorios: List[Path] = []
        for dirpath, dirnames, filenames in os.walk(self._root, topdown=False):
            base = Path(dirpath)
            for nombre in filenames:
                archivos.append(base / nombre)
            directorios.append(base)

        for archivo in archivos:
            self._eliminar_con_reintentos(archivo, remover, max_retries, result)

        # Eliminar directorios vacíos (los que aún existan). No se aplican
        # reintentos a directorios: solo se retiran si quedaron vacíos.
        for directorio in directorios:
            try:
                if directorio.exists():
                    os.rmdir(directorio)
            except OSError:
                # Un directorio no vacío (por un archivo que persistió) o un
                # fallo transitorio no debe interrumpir la limpieza de otros Jobs.
                logger.warning(
                    "No se pudo eliminar el directorio del workdir del Job %s: %s",
                    self.job_id,
                    directorio,
                )

        return result

    def _eliminar_con_reintentos(
        self,
        archivo: Path,
        remover: Remover,
        max_retries: int,
        result: CleanupResult,
    ) -> None:
        clave = str(archivo)
        # 1 intento inicial + ``max_retries`` reintentos.
        total_intentos = max_retries + 1
        ultimo_error: BaseException | None = None

        for intento in range(1, total_intentos + 1):
            result.attempts[clave] = intento
            try:
                remover(archivo)
                result.removed.append(archivo)
                return
            except FileNotFoundError:
                # Ya no existe: se considera eliminado correctamente.
                result.removed.append(archivo)
                return
            except OSError as exc:
                ultimo_error = exc
                continue

        # Fallo persistente tras agotar los reintentos (Req 13.6): se registra el
        # archivo afectado y se continúa sin interrumpir otros Jobs.
        result.failed.append(archivo)
        logger.error(
            "Fallo persistente al eliminar el archivo temporal del Job %s tras %d "
            "intentos: %s (%s)",
            self.job_id,
            total_intentos,
            archivo,
            ultimo_error,
        )


def preservar_video_final(job: JobWorkdir, ruta_temporal: os.PathLike | str) -> Path:
    """Copia el ``Video_Final`` a la ruta de salida persistente del Job.

    El archivo de origen debe estar contenido en el workdir del Job; el destino
    (``job.output_path``) vive fuera del directorio temporal, de modo que
    sobreviva a la limpieza (Req 13.4, 13.5).

    Args:
        job: Directorio de trabajo del Job.
        ruta_temporal: Ruta del video final dentro del workdir del Job.

    Returns:
        La ruta de salida persistente donde quedó copiado el video.

    Raises:
        WorkdirContainmentError: Si la ruta de origen no está contenida en el
            workdir del Job.
    """
    origen = Path(os.path.normpath(str(ruta_temporal)))
    if not origen.is_absolute():
        origen = (job.root / origen).resolve()
    else:
        origen = origen.resolve()

    if not job.is_contained(origen):
        raise WorkdirContainmentError(
            f"El video de origen {origen} no está contenido en el workdir del Job"
        )

    destino = job.output_path
    destino.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(origen, destino)
    return destino
