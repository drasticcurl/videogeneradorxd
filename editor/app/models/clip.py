"""Modelo de dominio `Clip`.

Representa un archivo de video individual seleccionado por el usuario y
almacenado por el Backend, preservando el orden de recepción (Req 1.2, 1.3).
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class Clip(BaseModel):
    """Un clip de video de entrada almacenado por el backend.

    Referencias de requisitos: 1.2 (identificador único), 1.3 (orden de
    recepción), 1.4 (tamaño <= 500 MB, validado en la capa API/ajustes).
    """

    id: str = Field(..., description="Identificador único del clip (Req 1.2)")
    nombre_original: str = Field(..., description="Nombre del archivo original")
    ruta_almacenada: str = Field(
        ..., description="Ruta dentro del almacén de clips del backend"
    )
    posicion: int = Field(
        ..., ge=1, description="Posición 1..n en el orden de recepción (Req 1.3)"
    )
    tamano_bytes: int = Field(..., ge=0, description="Tamaño del archivo en bytes")
    duracion_s: Optional[float] = Field(
        default=None, description="Duración en segundos, si se conoce"
    )
    formato: str = Field(..., description="Formato/extensión del clip (p. ej. 'mp4')")
