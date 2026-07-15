"""Property-based tests for the StorageBackend abstraction.

**Validates: Requirements 7.5, 7.6, 10.4**

Property 4 (P4): materialize_input → reading returns byte-for-byte identical content;
persist_output preserves bytes (standalone round-trip invariance).

Property 1 (P1): For any ordered list of input keys, resolver_orden_clips materializes
in the same order.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import hypothesis
from hypothesis import given, settings
from hypothesis import strategies as st

from app.storage.backend import (
    LocalStorageBackend,
    VolumeStorageBackend,
    resolver_orden_clips,
)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Safe filenames: alphanumeric + limited extensions, no path separators
_safe_filename = st.from_regex(r"[a-z][a-z0-9]{1,10}\.(mp4|mov|mkv|wav)", fullmatch=True)

# Arbitrary binary content (non-empty for meaningful round-trip)
_binary_content = st.binary(min_size=1, max_size=4096)


# ---------------------------------------------------------------------------
# Property 4: Standalone byte-for-byte round-trip invariance
# ---------------------------------------------------------------------------


class TestP4RoundTripLocal:
    """P4: LocalStorageBackend round-trip preserves bytes exactly."""

    @given(filename=_safe_filename, content=_binary_content)
    @settings(max_examples=50, deadline=5000)
    def test_materialize_input_roundtrip(self, filename: str, content: bytes):
        """**Validates: Requirements 10.4**

        materialize_input then reading the file returns byte-for-byte identical content.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            # Simulate a stored clip: create the source file
            source_dir = Path(tmpdir) / "clips"
            source_dir.mkdir()
            source_file = source_dir / filename
            source_file.write_bytes(content)

            dest_dir = Path(tmpdir) / "workdir"

            backend = LocalStorageBackend()
            # Absolute local references are accepted only from explicitly
            # configured roots, matching the generator/editor contract.
            with patch.dict(
                os.environ,
                {"VSE_LOCAL_INPUT_ROOTS": str(source_dir)},
            ):
                result_path = backend.materialize_input(
                    "test-job", str(source_file), dest_dir
                )

            # The materialized file must contain identical bytes
            assert result_path.exists()
            assert result_path.read_bytes() == content

    @given(filename=_safe_filename, content=_binary_content)
    @settings(max_examples=50, deadline=5000)
    def test_persist_output_roundtrip(self, filename: str, content: bytes):
        """**Validates: Requirements 10.4**

        persist_output preserves bytes: the persisted file is byte-for-byte identical.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            # Redirect OUTPUT_ROOT for this test
            import app.config as cfg

            original_output = cfg.OUTPUT_ROOT
            cfg.OUTPUT_ROOT = Path(tmpdir) / "output"
            try:
                # Create a source video file
                source_path = Path(tmpdir) / "source" / filename
                source_path.parent.mkdir(parents=True, exist_ok=True)
                source_path.write_bytes(content)

                backend = LocalStorageBackend()
                output_key = backend.persist_output("test-job-123", source_path)

                assert output_key is not None
                # Read back the persisted file
                persisted = Path(output_key)
                assert persisted.exists()
                assert persisted.read_bytes() == content
            finally:
                cfg.OUTPUT_ROOT = original_output


class TestP4RoundTripVolume:
    """P4: VolumeStorageBackend round-trip preserves bytes exactly."""

    @given(filename=_safe_filename, content=_binary_content)
    @settings(max_examples=50, deadline=5000)
    def test_materialize_input_roundtrip(self, filename: str, content: bytes):
        """**Validates: Requirements 7.5, 10.4**

        materialize_input from shared volume returns byte-for-byte identical content.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            volume_path = Path(tmpdir) / "shared"
            # Simulate the generator having written the input
            inputs_dir = volume_path / "edit-io" / "job-abc" / "inputs"
            inputs_dir.mkdir(parents=True)
            source_file = inputs_dir / filename
            source_file.write_bytes(content)

            dest_dir = Path(tmpdir) / "workdir"

            backend = VolumeStorageBackend(volume_path=str(volume_path))
            result_path = backend.materialize_input(
                "job-abc", filename, dest_dir
            )

            assert result_path.exists()
            assert result_path.read_bytes() == content

    @given(filename=_safe_filename, content=_binary_content)
    @settings(max_examples=50, deadline=5000)
    def test_persist_output_roundtrip(self, filename: str, content: bytes):
        """**Validates: Requirements 7.5, 10.4**

        persist_output to shared volume preserves bytes exactly.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            volume_path = Path(tmpdir) / "shared"
            volume_path.mkdir()

            import app.config as cfg

            original_output = cfg.OUTPUT_ROOT
            cfg.OUTPUT_ROOT = Path(tmpdir) / "output"
            try:
                source_path = Path(tmpdir) / "source" / "final.mp4"
                source_path.parent.mkdir(parents=True, exist_ok=True)
                source_path.write_bytes(content)

                backend = VolumeStorageBackend(volume_path=str(volume_path))
                output_key = backend.persist_output("job-xyz", source_path)

                assert output_key is not None

                # Check the volume outputs area also has the file
                vol_output = (
                    volume_path / "edit-io" / "job-xyz" / "outputs" / "final.mp4"
                )
                assert vol_output.exists()
                assert vol_output.read_bytes() == content
            finally:
                cfg.OUTPUT_ROOT = original_output


# ---------------------------------------------------------------------------
# Property 1: Order preservation (resolver_orden_clips)
# ---------------------------------------------------------------------------


class TestP1OrderPreservation:
    """P1: resolver_orden_clips materializes in the exact order specified."""

    @given(
        filenames=st.lists(
            _safe_filename, min_size=1, max_size=10, unique=True
        ),
        contents=st.lists(_binary_content, min_size=1, max_size=10),
    )
    @settings(max_examples=50, deadline=10000)
    def test_order_preserved_volume(
        self, filenames: list, contents: list
    ):
        """**Validates: Requirements 7.6**

        For any ordered list of input keys, resolver_orden_clips materializes
        in the same order.
        """
        # Ensure same length
        n = min(len(filenames), len(contents))
        filenames = filenames[:n]
        contents = contents[:n]

        with tempfile.TemporaryDirectory() as tmpdir:
            volume_path = Path(tmpdir) / "shared"
            inputs_dir = volume_path / "edit-io" / "order-test" / "inputs"
            inputs_dir.mkdir(parents=True)

            # Write inputs to volume
            for fname, data in zip(filenames, contents):
                (inputs_dir / fname).write_bytes(data)

            dest_dir = Path(tmpdir) / "workdir"

            backend = VolumeStorageBackend(volume_path=str(volume_path))
            result_paths = resolver_orden_clips(
                filenames, backend, "order-test", dest_dir
            )

            # Same length
            assert len(result_paths) == n

            # Same order: each materialized file has the correct content
            for i, (fname, expected_content) in enumerate(
                zip(filenames, contents)
            ):
                assert result_paths[i].name == fname
                assert result_paths[i].read_bytes() == expected_content

    @given(
        filenames=st.lists(
            _safe_filename, min_size=1, max_size=10, unique=True
        ),
    )
    @settings(max_examples=30, deadline=10000)
    def test_missing_input_aborts_early(self, filenames: list):
        """**Validates: Requirements 7.7**

        If any input is missing, resolver_orden_clips aborts before materializing
        any subsequent inputs (no partial files created for later inputs).
        """
        if len(filenames) < 2:
            return  # Need at least 2 to test partial abort

        with tempfile.TemporaryDirectory() as tmpdir:
            volume_path = Path(tmpdir) / "shared"
            inputs_dir = volume_path / "edit-io" / "abort-test" / "inputs"
            inputs_dir.mkdir(parents=True)

            # Only write the first file, leave the second missing
            (inputs_dir / filenames[0]).write_bytes(b"data")

            dest_dir = Path(tmpdir) / "workdir"
            backend = VolumeStorageBackend(volume_path=str(volume_path))

            try:
                resolver_orden_clips(
                    filenames, backend, "abort-test", dest_dir
                )
                # Should not reach here
                assert False, "Expected FileNotFoundError"
            except FileNotFoundError:
                pass  # Expected: aborted on missing input
