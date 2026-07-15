"""Endpoints de configuración por defecto del usuario (``/configuracion``).

Permiten a la Interfaz "Guardar como predeterminado" el conjunto completo de
:class:`~app.models.settings.Ajustes` en un JSON local del backend y recuperarlo
al abrir la aplicación (persistencia local, un solo usuario):

* ``GET /configuracion``: devuelve ``{"ajustes": <Ajustes|null>}`` con los
  ajustes guardados, o ``null`` si aún no se guardó ninguno.
* ``PUT /configuracion``: valida y guarda los ajustes recibidos como
  predeterminados. Rechaza con ``400 INVALID_REQUEST`` (identificando los campos)
  si algún ajuste está fuera de rango.
* ``DELETE /configuracion``: borra los ajustes guardados (restablece a fábrica).
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.models.errors import error_envelope
from app.models.settings import Ajustes, validar_ajustes
from app.storage import config_store

router = APIRouter(tags=["configuracion"])


class GuardarConfigRequest(BaseModel):
    """Cuerpo de ``PUT /configuracion``: el conjunto completo de ajustes."""

    ajustes: Ajustes = Field(default_factory=Ajustes)


@router.get("/configuracion")
async def obtener_configuracion() -> JSONResponse:
    """Devuelve los ajustes por defecto guardados (o ``null`` si no hay)."""
    ajustes = config_store.cargar_ajustes()
    return JSONResponse(
        status_code=200,
        content={"ajustes": ajustes.model_dump() if ajustes is not None else None},
    )


@router.put("/configuracion")
async def guardar_configuracion(peticion: GuardarConfigRequest) -> JSONResponse:
    """Valida y guarda los ajustes recibidos como predeterminados del usuario."""
    invalidos = validar_ajustes(peticion.ajustes)
    if invalidos:
        return JSONResponse(
            status_code=400,
            content=error_envelope(
                "INVALID_REQUEST",
                "Uno o más ajustes están fuera de rango o no son válidos.",
                {"campos_invalidos": invalidos},
            ),
        )
    config_store.guardar_ajustes(peticion.ajustes)
    return JSONResponse(
        status_code=200,
        content={"guardado": True, "ajustes": peticion.ajustes.model_dump()},
    )


@router.delete("/configuracion")
async def borrar_configuracion() -> JSONResponse:
    """Borra los ajustes por defecto guardados (restablece a los de fábrica)."""
    borrado = config_store.borrar_ajustes()
    return JSONResponse(status_code=200, content={"borrado": borrado})
