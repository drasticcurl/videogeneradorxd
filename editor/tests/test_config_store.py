"""Tests de la persistencia local de ajustes por defecto (config_store)."""

from __future__ import annotations

from pathlib import Path

from app import config
from app.models.settings import Ajustes
from app.storage import config_store


def _redirigir_config(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(config, "USER_CONFIG_ROOT", tmp_path / "cfg")


def test_cargar_sin_archivo_devuelve_none(tmp_path: Path, monkeypatch) -> None:
    _redirigir_config(tmp_path, monkeypatch)
    assert config_store.cargar_ajustes() is None


def test_guardar_y_cargar_round_trip(tmp_path: Path, monkeypatch) -> None:
    _redirigir_config(tmp_path, monkeypatch)
    ajustes = Ajustes()
    ajustes.silencios.umbral_db = -25.0
    ajustes.transiciones.tipo = "disolucion"
    ajustes.transiciones.duracion_ms = 350
    ajustes.subtitulos.revisar = True

    ruta = config_store.guardar_ajustes(ajustes)
    assert ruta.exists()

    cargado = config_store.cargar_ajustes()
    assert cargado is not None
    assert cargado.silencios.umbral_db == -25.0
    assert cargado.transiciones.tipo == "disolucion"
    assert cargado.transiciones.duracion_ms == 350
    assert cargado.subtitulos.revisar is True


def test_cargar_json_corrupto_devuelve_none(tmp_path: Path, monkeypatch) -> None:
    _redirigir_config(tmp_path, monkeypatch)
    ruta = config.user_config_path()
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text("{ esto no es json valido", encoding="utf-8")
    assert config_store.cargar_ajustes() is None


def test_borrar_ajustes(tmp_path: Path, monkeypatch) -> None:
    _redirigir_config(tmp_path, monkeypatch)
    config_store.guardar_ajustes(Ajustes())
    assert config_store.borrar_ajustes() is True
    # Segunda vez: ya no existe.
    assert config_store.borrar_ajustes() is False
    assert config_store.cargar_ajustes() is None
