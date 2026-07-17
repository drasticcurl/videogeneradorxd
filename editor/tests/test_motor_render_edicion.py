"""Tests de :func:`app.config.motor_render_edicion`.

El subproyecto ``remotion/`` ya está commiteado en el repo y la imagen Docker
hornea un Chromium headless (``npm ci`` + ``npx remotion browser ensure`` en la
etapa ``runner``), por lo que el render final usa **Remotion por defecto** tanto
en la nube como en local. ``VSE_RENDER_ENGINE=ass`` sigue siendo un fallback
soportado al motor ffmpeg/libass (válvula de seguridad documentada de Cloud Run).

Orden de resolución:
  1. ``VSE_RENDER_ENGINE`` (si está y no es blanco): ``"ass"``/``"remotion"``
     se usan verbatim; cualquier otro valor (inválido) se ignora.
  2. Sin/blanco/inválido: ``"remotion"`` por defecto (cloud y local).
"""

import pytest

from app import config


def _limpiar_env(monkeypatch):
    """Deja el entorno sin las variables que influyen en el motor de render."""
    monkeypatch.delenv("VSE_RENDER_ENGINE", raising=False)
    monkeypatch.delenv("EDIT_MODE", raising=False)


class TestMotorRenderEdicion:
    def test_cloud_sin_env_es_remotion(self, monkeypatch):
        """Modo cloud + ``VSE_RENDER_ENGINE`` sin definir → ``"remotion"``."""
        _limpiar_env(monkeypatch)
        monkeypatch.setenv("EDIT_MODE", "cloud")
        assert config.is_cloud_mode() is True
        assert config.motor_render_edicion() == "remotion"

    def test_local_sin_env_es_remotion(self, monkeypatch):
        """Modo local + ``VSE_RENDER_ENGINE`` sin definir → ``"remotion"``."""
        _limpiar_env(monkeypatch)
        assert config.is_cloud_mode() is False
        assert config.motor_render_edicion() == "remotion"

    def test_override_ass_fuerza_ass(self, monkeypatch):
        """``VSE_RENDER_ENGINE=ass`` fuerza el motor ffmpeg/libass (fallback)."""
        _limpiar_env(monkeypatch)
        monkeypatch.setenv("VSE_RENDER_ENGINE", "ass")
        assert config.motor_render_edicion() == "ass"
        # El override manda incluso en modo cloud.
        monkeypatch.setenv("EDIT_MODE", "cloud")
        assert config.motor_render_edicion() == "ass"

    def test_override_remotion_fuerza_remotion(self, monkeypatch):
        """``VSE_RENDER_ENGINE=remotion`` fuerza el motor Remotion."""
        _limpiar_env(monkeypatch)
        monkeypatch.setenv("VSE_RENDER_ENGINE", "remotion")
        assert config.motor_render_edicion() == "remotion"

    def test_override_invalido_cae_al_default_remotion(self, monkeypatch):
        """Un valor inválido se ignora y cae al default ``"remotion"``."""
        _limpiar_env(monkeypatch)
        monkeypatch.setenv("VSE_RENDER_ENGINE", "no-existe")
        assert config.motor_render_edicion() == "remotion"
        # También en cloud el inválido cae al default remotion.
        monkeypatch.setenv("EDIT_MODE", "cloud")
        assert config.motor_render_edicion() == "remotion"

    @pytest.mark.parametrize("valor", ["ASS", " ass ", "Remotion", "  REMOTION"])
    def test_override_case_insensitive_y_trim(self, monkeypatch, valor):
        """El override se normaliza (strip + lower) antes de validar."""
        _limpiar_env(monkeypatch)
        monkeypatch.setenv("VSE_RENDER_ENGINE", valor)
        assert config.motor_render_edicion() == valor.strip().lower()
