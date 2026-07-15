"""StorageBackend abstraction for the editor (Req 7, 10).

Defines the StorageBackend protocol and two implementations:
- LocalStorageBackend: reproduces today's on-disk behavior (default).
- VolumeStorageBackend: reads from / writes to the shared filesystem used by
  the two processes in the combined Cloud Run container.

Selection is driven by the VSE_STORAGE_BACKEND env var (default "local").

Requirements: 7.5, 7.6, 7.7, 10.2, 10.4
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import List, Optional, Protocol, runtime_checkable

from app import config

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


@runtime_checkable
class StorageBackend(Protocol):
    """Protocol for editor storage backends.

    Two methods:
    - materialize_input: copies an input reference into the job workdir so the
      pipeline can read it as a local file.
    - persist_output: takes the finished video from the workdir and writes it to
      a durable location (Output_Store / local output dir).
    """

    def materialize_input(
        self, edit_job_id: str, key: str, dest_dir: Path
    ) -> Path:
        """Materialize a single input into dest_dir as a real local file.

        Args:
            edit_job_id: The edit job identifier (used to namespace I/O).
            key: The relative key/filename of the input within the job inputs area.
            dest_dir: The local workdir directory to write the file into.

        Returns:
            The path of the materialized file inside dest_dir.

        Raises:
            FileNotFoundError: If the input is missing or unreadable.
            ValueError: If the key would escape the permitted prefix.
        """
        ...

    def persist_output(
        self, edit_job_id: str, source_path: Path
    ) -> Optional[str]:
        """Persist the finished video to the durable Output_Store.

        Args:
            edit_job_id: The edit job identifier.
            source_path: Local path of the finished video to persist.

        Returns:
            The output key for later retrieval, or None on failure.
        """
        ...


# ---------------------------------------------------------------------------
# Key validation helper
# ---------------------------------------------------------------------------


def _validate_edit_job_id(edit_job_id: str) -> None:
    if (
        not edit_job_id
        or edit_job_id in {".", ".."}
        or "/" in edit_job_id
        or "\\" in edit_job_id
        or os.path.isabs(edit_job_id)
    ):
        raise ValueError(f"Invalid edit job id: {edit_job_id!r}")


def _validate_key(edit_job_id: str, key: str) -> None:
    """Validate that a key is safe (no traversal, no absolute paths).

    Raises ValueError if the key would escape the expected prefix.
    """
    _validate_edit_job_id(edit_job_id)
    if not key or key.strip() == "":
        raise ValueError(f"Empty key for edit job {edit_job_id}")
    if "\\" in key:
        raise ValueError(f"Backslash in key: {key!r}")
    if os.path.isabs(key):
        raise ValueError(f"Absolute key not allowed: {key!r}")
    segments = key.replace("\\", "/").split("/")
    for seg in segments:
        if seg == "..":
            raise ValueError(f"Traversal segment in key: {key!r}")


# ---------------------------------------------------------------------------
# LocalStorageBackend
# ---------------------------------------------------------------------------


class LocalStorageBackend:
    """Local filesystem storage backend (default, standalone mode).

    materialize_input: copies the file from the ClipStore/MusicStore into the
    job workdir. The `key` is treated as a filesystem path relative to the
    clip store base directory.

    persist_output: copies the finished video to OUTPUT_ROOT/<edit_job_id>/final.mp4.
    """

    def materialize_input(
        self, edit_job_id: str, key: str, dest_dir: Path
    ) -> Path:
        """Copy a clip/input from its stored path into the workdir.

        For local mode, `key` is expected to be an absolute path to the actual
        file on disk (as resolved by the clip store or music store). If it's a
        relative path, it's resolved against the clip store base directory.
        """
        _validate_key(edit_job_id, os.path.basename(key))

        source = Path(key)
        if source.is_absolute():
            permitted = config.resolve_permitted_input_file(str(source))
            if permitted is None:
                raise ValueError(
                    f"Absolute input path is outside permitted local roots: {key!r}"
                )
            source = permitted
        else:
            from app.storage.clip_store import ClipStore

            source = (ClipStore().base_dir / key).resolve()
            try:
                source.relative_to(ClipStore().base_dir.resolve())
            except ValueError as exc:
                raise ValueError(f"Local input key escapes clip store: {key!r}") from exc

        if not source.exists() or not source.is_file():
            raise FileNotFoundError(
                f"Input missing for edit job {edit_job_id}: {key}"
            )

        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / source.name
        shutil.copy2(source, dest)
        return dest

    def persist_output(
        self, edit_job_id: str, source_path: Path
    ) -> Optional[str]:
        """Copy the finished video to the local output directory."""
        if not source_path.exists():
            logger.error(
                "Cannot persist output for edit job %s: source %s not found",
                edit_job_id,
                source_path,
            )
            return None

        output_dir = config.OUTPUT_ROOT / edit_job_id
        output_dir.mkdir(parents=True, exist_ok=True)
        dest = output_dir / config.FINAL_VIDEO_FILENAME
        shutil.copy2(source_path, dest)
        return str(dest)


# ---------------------------------------------------------------------------
# VolumeStorageBackend
# ---------------------------------------------------------------------------

# Path to the shared volume mount point. Configurable via env for testing.
SHARED_VOLUME_PATH = os.environ.get("SHARED_VOLUME_PATH", "/shared")


class VolumeStorageBackend:
    """Shared-filesystem storage backend for the combined cloud container.

    materialize_input: reads from edit-io/<editJobId>/inputs/<key> on the
    Shared_Volume into the workdir.

    persist_output: writes to edit-io/<editJobId>/outputs/ on the Shared_Volume
    AND delegates durable persist to the Output_Store (GCS via google-cloud-storage).

    Enforces:
    - Read-only under inputs/ (only reads, never writes there).
    - Write-only under outputs/ (only writes, never reads back).
    - Abort before pipeline if input is missing/unreadable.
    - No partial files on error.
    """

    def __init__(self, volume_path: Optional[str] = None):
        self._volume = Path(volume_path or SHARED_VOLUME_PATH)

    def _inputs_dir(self, edit_job_id: str) -> Path:
        return self._volume / "edit-io" / edit_job_id / "inputs"

    def _outputs_dir(self, edit_job_id: str) -> Path:
        return self._volume / "edit-io" / edit_job_id / "outputs"

    def materialize_input(
        self, edit_job_id: str, key: str, dest_dir: Path
    ) -> Path:
        """Copy an input from the Shared_Volume inputs area into the workdir."""
        _validate_key(edit_job_id, key)

        inputs_dir = self._inputs_dir(edit_job_id).resolve()
        source = (inputs_dir / key).resolve()
        try:
            source.relative_to(inputs_dir)
        except ValueError as exc:
            raise ValueError(f"Input key escapes job namespace: {key!r}") from exc
        if not source.exists() or not source.is_file():
            raise FileNotFoundError(
                f"Input missing on shared volume for edit job {edit_job_id}: {key} "
                f"(expected at {source})"
            )

        # Verify the source is actually readable
        if not os.access(source, os.R_OK):
            raise FileNotFoundError(
                f"Input unreadable on shared volume for edit job {edit_job_id}: {key}"
            )

        dest_dir = dest_dir.resolve()
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = (dest_dir / key).resolve()
        try:
            dest.relative_to(dest_dir)
        except ValueError as exc:
            raise ValueError(f"Destination key escapes workdir: {key!r}") from exc
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Atomic-ish write: write to temp then rename to avoid partial files
        tmp_dest = dest.with_suffix(dest.suffix + ".tmp")
        try:
            shutil.copy2(source, tmp_dest)
            tmp_dest.rename(dest)
        except Exception:
            # Clean up partial file
            if tmp_dest.exists():
                tmp_dest.unlink()
            raise

        return dest

    def persist_output(
        self, edit_job_id: str, source_path: Path
    ) -> Optional[str]:
        """Write output to the Shared_Volume outputs area and persist to Output_Store."""
        _validate_edit_job_id(edit_job_id)
        if not source_path.exists():
            logger.error(
                "Cannot persist output for edit job %s: source %s not found",
                edit_job_id,
                source_path,
            )
            return None

        # 1. Write to Shared_Volume outputs area
        outputs_dir = self._outputs_dir(edit_job_id)
        outputs_dir.mkdir(parents=True, exist_ok=True)
        volume_dest = outputs_dir / config.FINAL_VIDEO_FILENAME
        tmp_dest = volume_dest.with_suffix(volume_dest.suffix + ".tmp")
        try:
            shutil.copy2(source_path, tmp_dest)
            tmp_dest.rename(volume_dest)
        except Exception as exc:
            logger.error(
                "Failed to write output to shared volume for edit job %s: %s",
                edit_job_id,
                exc,
            )
            if tmp_dest.exists():
                tmp_dest.unlink()
            return None

        # 2. Persist to durable Output_Store (GCS)
        output_key = self._persist_to_output_store(edit_job_id, source_path)
        if output_key is None:
            # Volume write succeeded but durable persist failed
            logger.error(
                "Durable persist to Output_Store failed for edit job %s",
                edit_job_id,
            )
            return None

        return output_key

    def _persist_to_output_store(
        self, edit_job_id: str, source_path: Path
    ) -> Optional[str]:
        """Copy to the existing mounted durable output filesystem.

        ``VSE_OUTPUT`` points at the existing GCS FUSE edit-output directory in
        production. Returning a logical key keeps the generator contract
        independent of the mount's absolute path.
        """
        _validate_edit_job_id(edit_job_id)
        try:
            output_dir = config.OUTPUT_ROOT / edit_job_id
            output_dir.mkdir(parents=True, exist_ok=True)
            dest = output_dir / config.FINAL_VIDEO_FILENAME
            tmp_dest = dest.with_suffix(dest.suffix + ".tmp")
            shutil.copy2(source_path, tmp_dest)
            tmp_dest.replace(dest)
            return f"edit-output/{edit_job_id}/{config.FINAL_VIDEO_FILENAME}"
        except Exception as exc:
            logger.error(
                "Durable filesystem persist failed for edit job %s: %s",
                edit_job_id,
                exc,
            )
            return None


# ---------------------------------------------------------------------------
# Resolver helper for ordered materialization
# ---------------------------------------------------------------------------


def resolver_orden_clips(
    orden_clips: List[str],
    backend: StorageBackend,
    edit_job_id: str,
    workdir: Path,
) -> List[Path]:
    """Materialize an ordered list of input keys into the workdir.

    Preserves the order: the returned list has the same length and ordering as
    orden_clips. Aborts on the first missing/unreadable input (Req 7.7).

    Args:
        orden_clips: Ordered list of input keys to materialize.
        backend: The storage backend to use.
        edit_job_id: The edit job identifier.
        workdir: The local workdir directory to materialize into.

    Returns:
        Ordered list of local file paths (same length/order as orden_clips).

    Raises:
        FileNotFoundError: If any input is missing or unreadable (aborts early).
    """
    materialized: List[Path] = []
    for key in orden_clips:
        path = backend.materialize_input(edit_job_id, key, workdir)
        materialized.append(path)
    return materialized


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def get_storage_backend() -> StorageBackend:
    """Return the configured StorageBackend based on VSE_STORAGE_BACKEND env var.

    - "local" (default): LocalStorageBackend
    - "volume": VolumeStorageBackend
    """
    mode = config.get_storage_backend()
    if mode == "volume":
        return VolumeStorageBackend()
    return LocalStorageBackend()
