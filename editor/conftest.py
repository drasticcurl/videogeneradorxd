"""Configuración compartida de pytest para el backend.

Asegura que el directorio ``backend/`` esté en ``sys.path`` de modo que los
tests puedan importar el paquete de la aplicación con ``import app...``
independientemente del directorio desde el que se invoque pytest.
"""

from __future__ import annotations

import os
import sys

BACKEND_ROOT = os.path.dirname(os.path.abspath(__file__))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)
