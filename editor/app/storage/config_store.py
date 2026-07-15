"""Persistencia local de los ajustes por defecto del usuario (JSON en disco).

Permite que la Interfaz "Guarde como predeterminado" el conjunto completo de
:class:`~app.models.settings.Ajustes` y lo recupere al abrir la aplicación. Es
un único archivo JSON local en la máquina del usuario (operación 100% local),
cuya ruta la resuelve :func:`app.config.user_config_path` (redirigible en
pruebas mediante monkeypatch de ``config.USER_CONFIG_ROOT``).

Garantías:

* **Tolerancia a fallos de lectura:** si el archivo no existe, está corrupto o no
  valida contra el modelo, :func:`cargar_ajustes` devuelve ``None`` (se registra
  una advertencia) en lugar de propagar el error, de modo que la app pueda
  arrancar con los valores por defecto de fábrica.
* **Escritura atómica:** :func:`guardar_ajustes` escribe primero en un archivo
  temporal y lo renombra sobre el destino, evitando dejar un JSON a medias si el
  proceso se interrumpe.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

from app import config
from app.models.settings import Ajustes

logger = logging.getLogger(__name__)


def cargar_ajustes() -> Optional[Ajustes]:
    """Carga los ajustes por defecto guardados, o ``None`` si no hay/es inválido.

    Returns:
        Los :class:`Ajustes` deserializados si el archivo existe y valida; en
        cualquier otro caso (ausente, JSON corrupto, esquema inválido) ``None``.
    """
    ruta = config.user_config_path()
    if not ruta.exists():
        return None
    try:
        datos = json.loads(ruta.read_text(encoding="utf-8"))
        return Ajustes.model_validate(datos)
    except Exception as exc:  # noqa: BLE001 - lectura tolerante a fallos
        logger.warning(
            "No se pudieron cargar los ajustes guardados (%s): %s", ruta, exc
        )
        return None


def guardar_ajustes(ajustes: Ajustes) -> Path:
    """Guarda los ajustes por defecto del usuario en el JSON local (atómico).

    Args:
        ajustes: Conjunto completo de ajustes a persistir.

    Returns:
        La ruta del archivo JSON escrito.
    """
    ruta = config.user_config_path()
    ruta.parent.mkdir(parents=True, exist_ok=True)
    contenido = json.dumps(ajustes.model_dump(), ensure_ascii=False, indent=2)

    # Escritura atómica: escribir en un temporal y renombrar sobre el destino.
    tmp = ruta.with_suffix(ruta.suffix + ".tmp")
    tmp.write_text(contenido, encoding="utf-8")
    os.replace(tmp, ruta)
    return ruta


def borrar_ajustes() -> bool:
    """Borra el JSON de ajustes por defecto si existe.

    Returns:
        ``True`` si había un archivo y se eliminó; ``False`` si no existía.
    """
    ruta = config.user_config_path()
    if ruta.exists():
        ruta.unlink()
        return True
    return False


__all__ = ["cargar_ajustes", "guardar_ajustes", "borrar_ajustes"]
