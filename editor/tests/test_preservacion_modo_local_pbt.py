"""Task 2.2 (Property 2: Preservation) — local mode is independent of Cloud Run.

**Validates: Requirements 3.3, 3.4**

Observation-first baseline pinning that standalone/local operation behaves
**independently of Cloud Run metadata or services** (design §"Preservation
Requirements / Local mode"). The diagnostic-first instrumentation of Task 3 adds
``K_REVISION`` only to server-side diagnostics; these properties guarantee that
mode/backend **selection** keeps depending ONLY on the explicit ``EDIT_MODE`` /
``VSE_STORAGE_BACKEND`` flags — never on the presence or value of Cloud Run
platform variables (``K_REVISION``, ``K_SERVICE``, ``K_CONFIGURATION``).

EXPECTED OUTCOME on UNFIXED code: PASS.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Dict
from unittest import mock

from hypothesis import given, settings
from hypothesis import strategies as st

from app import config
from app.storage.backend import (
    LocalStorageBackend,
    VolumeStorageBackend,
    get_storage_backend,
)

# Cloud Run platform metadata variables that MUST NOT influence local-mode
# selection (they are injected by the platform, absent when standalone).
_CLOUD_RUN_METADATA = ("K_REVISION", "K_SERVICE", "K_CONFIGURATION", "K_PORT")


def _clear_mode_env() -> Dict[str, str]:
    """Return an env override dict that clears mode/backend + Cloud Run vars."""
    overrides = {"EDIT_MODE": "", "VSE_STORAGE_BACKEND": ""}
    for name in _CLOUD_RUN_METADATA:
        overrides[name] = ""
    return overrides


# ---------------------------------------------------------------------------
# Defaults: unset → local, standalone (Req 3.3)
# ---------------------------------------------------------------------------
def test_defaults_son_local_sin_variables() -> None:
    with mock.patch.dict(os.environ, _clear_mode_env(), clear=False):
        for name in ("EDIT_MODE", "VSE_STORAGE_BACKEND", *_CLOUD_RUN_METADATA):
            os.environ.pop(name, None)
        assert config.get_edit_mode() == "local"
        assert config.get_storage_backend() == "local"
        assert config.is_cloud_mode() is False
        assert config.is_volume_backend() is False
        assert isinstance(get_storage_backend(), LocalStorageBackend)


# ---------------------------------------------------------------------------
# Explicit flags select the backend/mode (both directions)
# ---------------------------------------------------------------------------
def test_flags_explicitos_seleccionan_backend() -> None:
    with mock.patch.dict(os.environ, {"VSE_STORAGE_BACKEND": "volume"}, clear=False):
        assert config.get_storage_backend() == "volume"
        assert isinstance(get_storage_backend(), VolumeStorageBackend)
    with mock.patch.dict(os.environ, {"VSE_STORAGE_BACKEND": "local"}, clear=False):
        assert config.get_storage_backend() == "local"
        assert isinstance(get_storage_backend(), LocalStorageBackend)
    with mock.patch.dict(os.environ, {"EDIT_MODE": "cloud"}, clear=False):
        assert config.is_cloud_mode() is True
    with mock.patch.dict(os.environ, {"EDIT_MODE": "local"}, clear=False):
        assert config.is_cloud_mode() is False


# ---------------------------------------------------------------------------
# Property: Cloud Run metadata NEVER changes local-mode/backend selection
# ---------------------------------------------------------------------------
@settings(max_examples=80, deadline=None)
@given(
    # Arbitrary presence/values for each Cloud Run metadata variable.
    metadata=st.dictionaries(
        keys=st.sampled_from(_CLOUD_RUN_METADATA),
        # Values that a real environment variable can hold (no NUL bytes).
        values=st.text(
            alphabet=st.characters(blacklist_categories=("Cc", "Cs")),
            min_size=0,
            max_size=20,
        ),
        max_size=len(_CLOUD_RUN_METADATA),
    ),
    edit_mode=st.sampled_from(["local", "cloud", "", "LOCAL", "  local  "]),
    backend=st.sampled_from(["local", "volume", "", "VOLUME", "  local  "]),
)
def test_metadata_cloud_run_no_afecta_seleccion(
    metadata: Dict[str, str], edit_mode: str, backend: str
) -> None:
    """The chosen edit mode / storage backend is a pure function of the explicit
    ``EDIT_MODE`` / ``VSE_STORAGE_BACKEND`` flags, regardless of any Cloud Run
    platform metadata that may (or may not) be present."""
    overrides = _clear_mode_env()
    overrides.update(metadata)
    overrides["EDIT_MODE"] = edit_mode
    overrides["VSE_STORAGE_BACKEND"] = backend

    with mock.patch.dict(os.environ, overrides, clear=False):
        esperado_cloud = edit_mode.strip().lower() == "cloud"
        esperado_volume = backend.strip().lower() == "volume"
        assert config.is_cloud_mode() is esperado_cloud
        assert config.is_volume_backend() is esperado_volume
        # Factory follows the config predicate.
        adaptador = get_storage_backend()
        if esperado_volume:
            assert isinstance(adaptador, VolumeStorageBackend)
        else:
            assert isinstance(adaptador, LocalStorageBackend)


# ---------------------------------------------------------------------------
# Local backend materializes inputs purely on the filesystem (no cloud services)
# ---------------------------------------------------------------------------
def test_local_backend_materializa_sin_servicios_cloud(tmp_path: Path, monkeypatch) -> None:
    """``LocalStorageBackend`` copies an input from a permitted local root into
    the workdir with no Cloud Run metadata present — pure filesystem I/O."""
    src_root = tmp_path / "gen_output"
    src_root.mkdir(parents=True, exist_ok=True)
    src = src_root / "clip.mp4"
    payload = b"local-mode-payload"
    src.write_bytes(payload)

    # Permit the source root and clear any Cloud Run metadata.
    monkeypatch.setenv("VSE_LOCAL_INPUT_ROOTS", str(src_root))
    for name in _CLOUD_RUN_METADATA:
        monkeypatch.delenv(name, raising=False)

    dest_dir = tmp_path / "workdir"
    backend = LocalStorageBackend()
    dest = backend.materialize_input("edit-job-local", str(src), dest_dir)

    assert dest.is_file()
    assert dest.read_bytes() == payload
    # Input left byte-for-byte unchanged (read-only) and destination is separate.
    assert src.read_bytes() == payload
    assert dest.resolve() != src.resolve()
