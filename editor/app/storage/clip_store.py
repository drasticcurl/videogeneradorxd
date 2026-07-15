"""Almacén de clips de video del backend (Req 1.2, 1.3, 1.6).

Este módulo implementa un **almacén de clips** inyectable y testeable que
almacena los archivos de video recibidos por ``POST /clips`` preservando el
orden de recepción y devolviendo un :class:`~app.models.clip.Clip` por cada uno
con un identificador único y su posición ``1..n``.

Garantías principales:

* **Identidad y orden (Req 1.2, 1.3):** cada clip almacenado recibe un ``id``
  único y una ``posicion`` que reproduce exactamente el orden en que fue
  recibido en la petición.
* **Atomicidad (Req 1.6):** la operación de guardado es *todo o nada*. Si el
  almacenamiento de cualquier clip falla, se revierten (eliminan) los clips ya
  escritos de esa misma petición, de modo que **no quede almacenamiento
  parcial**, y se lanza :class:`ClipStorageError` identificando el/los clip(s)
  que no pudieron almacenarse.

El almacén escribe bajo un directorio base (por defecto ``<WORKDIR_ROOT>/clips``)
y admite inyectar el ``escritor`` de archivos individual, lo que permite a las
pruebas provocar fallos deterministas en una posición concreta sin depender del
sistema de archivos real.

Referencias de requisitos: 1.2, 1.3, 1.6.
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple

from app import config
from app.models.clip import Clip

logger = logging.getLogger(__name__)

# Un ``escritor`` recibe la ruta destino y el contenido en bytes y debe
# persistir el archivo, lanzando una excepción si no puede hacerlo. Es inyectable
# para poder provocar fallos deterministas en las pruebas de atomicidad.
Escritor = Callable[[Path, bytes], None]

# Entrada de guardado: (nombre_original, contenido_en_bytes).
EntradaClip = Tuple[str, bytes]


@dataclass
class ClipStorageError(Exception):
    """Fallo de almacenamiento de uno o más clips (Req 1.6).

    Attributes:
        clips_fallidos: Nombres/posiciones de los clips que no pudieron
            almacenarse (identificación para el error de la API).
        motivo: Descripción legible del fallo subyacente.
    """

    clips_fallidos: List[str]
    motivo: str

    def __str__(self) -> str:  # pragma: no cover - representación trivial
        return f"No se pudieron almacenar los clips {self.clips_fallidos}: {self.motivo}"


def _default_escritor(ruta: Path, contenido: bytes) -> None:
    """Escritor por defecto: persiste el contenido en disco."""
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with open(ruta, "wb") as fh:
        fh.write(contenido)


def _extension(nombre: str) -> str:
    """Devuelve la extensión en minúsculas (con punto) del nombre de archivo."""
    return os.path.splitext(nombre)[1].lower()


def _generar_id() -> str:
    """Genera un identificador único de clip (Req 1.2)."""
    return f"clip_{uuid.uuid4().hex}"


class ClipStore:
    """Almacén de clips de video con guardado atómico (Req 1.2, 1.3, 1.6)."""

    def __init__(
        self,
        base_dir: Optional[Path] = None,
        escritor: Escritor = _default_escritor,
    ) -> None:
        # Se resuelve en tiempo de llamada a través de ``config`` para permitir
        # que las pruebas redirijan ``WORKDIR_ROOT`` mediante monkeypatch.
        self._base_dir = base_dir
        self._escritor = escritor

    @property
    def base_dir(self) -> Path:
        """Directorio base donde se almacenan los clips."""
        if self._base_dir is not None:
            return self._base_dir
        return (config.WORKDIR_ROOT / "clips").resolve()

    def guardar(self, entradas: Sequence[EntradaClip]) -> List[Clip]:
        """Almacena atómicamente los clips recibidos preservando el orden.

        Args:
            entradas: Secuencia ordenada de ``(nombre_original, contenido)`` en
                el orden exacto de recepción de la petición.

        Returns:
            Lista de :class:`Clip` en el mismo orden, con ``id`` único y
            ``posicion`` ``1..n`` (Req 1.2, 1.3).

        Raises:
            ClipStorageError: Si el almacenamiento de cualquier clip falla; en tal
                caso se revierten los clips ya escritos y no queda almacenamiento
                parcial (Req 1.6).
        """
        base = self.base_dir
        rutas_escritas: List[Path] = []
        clips: List[Clip] = []

        try:
            for posicion, (nombre_original, contenido) in enumerate(entradas, start=1):
                clip_id = _generar_id()
                ext = _extension(nombre_original)
                ruta = base / f"{clip_id}{ext}"

                self._escritor(ruta, contenido)
                rutas_escritas.append(ruta)

                clips.append(
                    Clip(
                        id=clip_id,
                        nombre_original=nombre_original,
                        ruta_almacenada=str(ruta),
                        posicion=posicion,
                        tamano_bytes=len(contenido),
                        duracion_s=None,
                        formato=ext.lstrip(".") or "desconocido",
                    )
                )
        except Exception as exc:  # noqa: BLE001 - se traduce a ClipStorageError
            # Atomicidad (Req 1.6): revertir todo lo escrito hasta ahora.
            posicion_fallo = len(rutas_escritas) + 1
            self._rollback(rutas_escritas)
            # Identificar el clip que falló (el de la posición en curso) y,
            # dado que la operación es atómica, ninguno queda almacenado.
            fallido = (
                entradas[posicion_fallo - 1][0]
                if posicion_fallo - 1 < len(entradas)
                else f"posicion_{posicion_fallo}"
            )
            logger.error(
                "Fallo de almacenamiento del clip en posición %d (%s); se revirtieron "
                "%d clips ya escritos (Req 1.6).",
                posicion_fallo,
                fallido,
                len(rutas_escritas),
            )
            raise ClipStorageError(
                clips_fallidos=[fallido],
                motivo=str(exc) or exc.__class__.__name__,
            ) from exc

        return clips

    def _rollback(self, rutas: List[Path]) -> None:
        """Elimina los archivos ya escritos para no dejar almacenamiento parcial."""
        for ruta in rutas:
            try:
                if ruta.exists():
                    os.remove(ruta)
            except OSError:  # pragma: no cover - defensivo
                logger.warning("No se pudo revertir el clip parcial: %s", ruta)
