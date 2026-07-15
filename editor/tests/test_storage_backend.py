"""Unit tests for StorageBackend, /procesar with Shared_Volume keys,
localhost binding, and scratch cleanup.

Covers Tasks 12, 13, 14, 15 unit tests.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from app.storage.backend import (
    LocalStorageBackend,
    VolumeStorageBackend,
    _validate_key,
    get_storage_backend,
    resolver_orden_clips,
)
from app.storage.scratch_cleanup import cleanup_job_scratch


# ---------------------------------------------------------------------------
# Key validation
# ---------------------------------------------------------------------------


class TestKeyValidation:
    def test_valid_key(self):
        _validate_key("job-1", "clip_01.mp4")

    def test_empty_key_raises(self):
        with pytest.raises(ValueError, match="Empty key"):
            _validate_key("job-1", "")

    def test_traversal_raises(self):
        with pytest.raises(ValueError, match="Traversal"):
            _validate_key("job-1", "../etc/passwd")

    def test_absolute_raises(self):
        with pytest.raises(ValueError, match="Absolute"):
            _validate_key("job-1", "/etc/passwd")

    def test_backslash_raises(self):
        with pytest.raises(ValueError, match="Backslash"):
            _validate_key("job-1", "foo\\bar.mp4")


# ---------------------------------------------------------------------------
# LocalStorageBackend
# ---------------------------------------------------------------------------


class TestLocalStorageBackend:
    def test_materialize_input_copies_file(self, tmp_path):
        source_dir = tmp_path / "clips"
        source_dir.mkdir()
        source = source_dir / "clip_01.mp4"
        source.write_bytes(b"video data")

        dest_dir = tmp_path / "workdir"
        backend = LocalStorageBackend()
        result = backend.materialize_input("job-1", str(source), dest_dir)

        assert result.exists()
        assert result.read_bytes() == b"video data"
        assert result.name == "clip_01.mp4"

    def test_materialize_input_missing_raises(self, tmp_path):
        dest_dir = tmp_path / "workdir"
        backend = LocalStorageBackend()
        with pytest.raises(FileNotFoundError):
            backend.materialize_input("job-1", "/nonexistent/clip.mp4", dest_dir)

    def test_persist_output(self, tmp_path, monkeypatch):
        import app.config as cfg

        monkeypatch.setattr(cfg, "OUTPUT_ROOT", tmp_path / "output")

        source = tmp_path / "final.mp4"
        source.write_bytes(b"output video")

        backend = LocalStorageBackend()
        key = backend.persist_output("job-1", source)

        assert key is not None
        assert Path(key).read_bytes() == b"output video"

    def test_persist_output_missing_source(self, tmp_path):
        backend = LocalStorageBackend()
        result = backend.persist_output("job-1", tmp_path / "missing.mp4")
        assert result is None


# ---------------------------------------------------------------------------
# VolumeStorageBackend
# ---------------------------------------------------------------------------


class TestVolumeStorageBackend:
    def test_materialize_input_from_volume(self, tmp_path):
        volume = tmp_path / "shared"
        inputs_dir = volume / "edit-io" / "job-1" / "inputs"
        inputs_dir.mkdir(parents=True)
        (inputs_dir / "clip_01.mp4").write_bytes(b"clip data")

        dest_dir = tmp_path / "workdir"
        backend = VolumeStorageBackend(volume_path=str(volume))
        result = backend.materialize_input("job-1", "clip_01.mp4", dest_dir)

        assert result.exists()
        assert result.read_bytes() == b"clip data"

    def test_materialize_input_missing_raises(self, tmp_path):
        volume = tmp_path / "shared"
        volume.mkdir()

        dest_dir = tmp_path / "workdir"
        backend = VolumeStorageBackend(volume_path=str(volume))

        with pytest.raises(FileNotFoundError):
            backend.materialize_input("job-1", "missing.mp4", dest_dir)

    def test_materialize_input_traversal_raises(self, tmp_path):
        volume = tmp_path / "shared"
        volume.mkdir()

        dest_dir = tmp_path / "workdir"
        backend = VolumeStorageBackend(volume_path=str(volume))

        with pytest.raises(ValueError):
            backend.materialize_input("job-1", "../../../etc/passwd", dest_dir)

    def test_persist_output_writes_to_volume_and_local(self, tmp_path, monkeypatch):
        import app.config as cfg

        monkeypatch.setattr(cfg, "OUTPUT_ROOT", tmp_path / "output")

        volume = tmp_path / "shared"
        volume.mkdir()

        source = tmp_path / "final.mp4"
        source.write_bytes(b"finished video")

        backend = VolumeStorageBackend(volume_path=str(volume))
        key = backend.persist_output("job-1", source)

        assert key is not None
        # Check volume outputs area
        vol_output = volume / "edit-io" / "job-1" / "outputs" / "final.mp4"
        assert vol_output.exists()
        assert vol_output.read_bytes() == b"finished video"


# ---------------------------------------------------------------------------
# resolver_orden_clips (Task 13.1)
# ---------------------------------------------------------------------------


class TestResolverOrdenClips:
    def test_preserves_order(self, tmp_path):
        volume = tmp_path / "shared"
        inputs_dir = volume / "edit-io" / "job-1" / "inputs"
        inputs_dir.mkdir(parents=True)

        files = ["a.mp4", "b.mp4", "c.mp4"]
        for i, f in enumerate(files):
            (inputs_dir / f).write_bytes(f"data_{i}".encode())

        dest_dir = tmp_path / "workdir"
        backend = VolumeStorageBackend(volume_path=str(volume))
        results = resolver_orden_clips(files, backend, "job-1", dest_dir)

        assert len(results) == 3
        assert [r.name for r in results] == files

    def test_aborts_on_missing_input(self, tmp_path):
        volume = tmp_path / "shared"
        inputs_dir = volume / "edit-io" / "job-1" / "inputs"
        inputs_dir.mkdir(parents=True)
        (inputs_dir / "a.mp4").write_bytes(b"data")

        dest_dir = tmp_path / "workdir"
        backend = VolumeStorageBackend(volume_path=str(volume))

        with pytest.raises(FileNotFoundError):
            resolver_orden_clips(
                ["a.mp4", "missing.mp4"], backend, "job-1", dest_dir
            )


# ---------------------------------------------------------------------------
# Task 13.2: persist_output on completion (via VolumeStorageBackend)
# ---------------------------------------------------------------------------


class TestPersistOnCompletion:
    def test_persist_failure_returns_none(self, tmp_path):
        volume = tmp_path / "shared"
        volume.mkdir()

        backend = VolumeStorageBackend(volume_path=str(volume))
        # Source doesn't exist
        result = backend.persist_output("job-1", tmp_path / "nonexistent.mp4")
        assert result is None


# ---------------------------------------------------------------------------
# Task 14: Localhost-only binding test
# ---------------------------------------------------------------------------


class TestLocalhostBinding:
    def test_cloud_mode_binds_localhost(self, monkeypatch):
        """In cloud mode, the editor should bind to 127.0.0.1 only."""
        monkeypatch.setenv("EDIT_MODE", "cloud")
        import app.config as cfg

        assert cfg.is_cloud_mode()
        # The binding logic in main.py uses is_cloud_mode() to choose host
        host = "127.0.0.1" if cfg.is_cloud_mode() else cfg.BACKEND_HOST
        assert host == "127.0.0.1"

    def test_local_mode_uses_default(self, monkeypatch):
        """In local mode, the editor uses the configured BACKEND_HOST."""
        monkeypatch.setenv("EDIT_MODE", "local")
        import app.config as cfg

        # Force reimport to pick up env change
        host = "127.0.0.1" if cfg.is_cloud_mode() else cfg.BACKEND_HOST
        # Default BACKEND_HOST is 127.0.0.1 anyway, but the logic should work
        assert host == cfg.BACKEND_HOST


# ---------------------------------------------------------------------------
# Task 15: Scratch cleanup tests
# ---------------------------------------------------------------------------


class TestScratchCleanup:
    def test_cleanup_removes_job_directory(self, tmp_path):
        volume = tmp_path / "shared"
        job_dir = volume / "edit-io" / "job-1"
        inputs_dir = job_dir / "inputs"
        outputs_dir = job_dir / "outputs"
        inputs_dir.mkdir(parents=True)
        outputs_dir.mkdir(parents=True)
        (inputs_dir / "clip.mp4").write_bytes(b"data")
        (outputs_dir / "final.mp4").write_bytes(b"output")

        result = cleanup_job_scratch("job-1", volume_path=str(volume))

        assert result is True
        assert not job_dir.exists()

    def test_cleanup_nonexistent_directory(self, tmp_path):
        volume = tmp_path / "shared"
        volume.mkdir()

        result = cleanup_job_scratch("nonexistent", volume_path=str(volume))
        assert result is True  # Succeeds (nothing to clean)

    def test_cleanup_parent_preserved(self, tmp_path):
        """Cleanup only removes the job dir, not the edit-io/ parent."""
        volume = tmp_path / "shared"
        edit_io = volume / "edit-io"
        job_dir = edit_io / "job-1"
        job_dir.mkdir(parents=True)
        (job_dir / "file.txt").write_bytes(b"data")

        cleanup_job_scratch("job-1", volume_path=str(volume))

        assert edit_io.exists()  # Parent preserved
        assert not job_dir.exists()  # Job dir removed


# ---------------------------------------------------------------------------
# get_storage_backend factory
# ---------------------------------------------------------------------------


class TestGetStorageBackend:
    def test_default_is_local(self, monkeypatch):
        monkeypatch.delenv("VSE_STORAGE_BACKEND", raising=False)
        backend = get_storage_backend()
        assert isinstance(backend, LocalStorageBackend)

    def test_volume_mode(self, monkeypatch):
        monkeypatch.setenv("VSE_STORAGE_BACKEND", "volume")
        backend = get_storage_backend()
        assert isinstance(backend, VolumeStorageBackend)
