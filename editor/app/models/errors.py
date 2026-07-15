"""Modelo de error homogéneo del backend.

Todos los endpoints devuelven los errores con el mismo envoltorio:

    { "error": { "code": "STRING_CODE", "message": "...", "details": { } } }

Referencias de requisitos: 1.6, 8.2, 10.2, 10.4, 10.7, 11.3, 11.4.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, Field


class ApiError(BaseModel):
    """Representación estructurada de un error de la API.

    Atributos:
        code: código legible por máquina (p. ej. ``INVALID_REQUEST``).
        message: descripción legible por humanos.
        details: información adicional opcional (campo inválido, clips afectados, ...).
    """

    code: str = Field(..., description="Código de error legible por máquina")
    message: str = Field(..., description="Descripción legible por humanos")
    details: Optional[Dict[str, Any]] = Field(
        default=None, description="Detalles adicionales opcionales del error"
    )


def error_envelope(
    code: str, message: str, details: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Construye el envoltorio de error homogéneo ``{"error": {...}}``.

    Facilita que la capa API devuelva errores con una forma consistente.
    """

    return {"error": ApiError(code=code, message=message, details=details).model_dump()}
