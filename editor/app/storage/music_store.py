"""Almacén de música de fondo del backend (Req 8.1, 8.2).

Almacena el archivo WAV de música recibido por ``POST /musica`` y devuelve un
identificador único (``musica_id``). La **validación** de formato y tamaño se
realiza en la capa API **antes** de invocar el almacén, de modo que un archivo
inválido se rechaza conservando el audio y el video originales sin modificar
(Req 8.2).

El almacén es inyectable/testeable igual que :mod:`app.storage.clip_store`.

Referencias de requisitos: 8.1, 8.2.
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from app import config

logger = logging.getLogger(__name__)

Escritor = Callable[[Path, bytes], None]


@dataclass
class MusicaAlmacenada:
    """Resultado de almacenar un archivo de música."""

    musica_id: str
    nombre_original: str
    ruta_almacenada: str
    tamano_bytes: int


@dataclass
class MusicStorageError(Exception):
    """Fallo al almacenar el archivo de música."""

    motivo: str

    def __str__(self) -> str:  # pragma: no cover - representación trivial
        return f"No se pudo almacenar la música: {self.motivo}"


def _default_escritor(ruta: Path, contenido: bytes) -> None:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with open(ruta, "wb") as fh:
        fh.write(contenido)


def _generar_id() -> str:
    """Genera un identificador único de música."""
    return f"mus_{uuid.uuid4().hex}"


class MusicStore:
    """Almacén del archivo WAV de música (Req 8.1)."""

    def __init__(
        self,
        base_dir: Optional[Path] = None,
        escritor: Escritor = _default_escritor,
    ) -> None:
        self._base_dir = base_dir
        self._escritor = escritor

    @property
    def base_dir(self) -> Path:
        """Directorio base donde se almacena la música."""
        if self._base_dir is not None:
            return self._base_dir
        return (config.WORKDIR_ROOT / "musica").resolve()

    def guardar(self, nombre_original: str, contenido: bytes) -> MusicaAlmacenada:
        """Almacena el archivo de música y devuelve su identificador.

        Raises:
            MusicStorageError: Si la escritura falla; no queda almacenamiento
                parcial (se revierte el archivo si se llegó a crear).
        """
        musica_id = _generar_id()
        ext = os.path.splitext(nombre_original)[1].lower() or ".wav"
        ruta = self.base_dir / f"{musica_id}{ext}"
        try:
            self._escritor(ruta, contenido)
        except Exception as exc:  # noqa: BLE001
            try:
                if ruta.exists():
                    os.remove(ruta)
            except OSError:  # pragma: no cover - defensivo
                pass
            logger.error("Fallo de almacenamiento de música (%s): %s", nombre_original, exc)
            raise MusicStorageError(motivo=str(exc) or exc.__class__.__name__) from exc

        return MusicaAlmacenada(
            musica_id=musica_id,
            nombre_original=nombre_original,
            ruta_almacenada=str(ruta),
            tamano_bytes=len(contenido),
        )
