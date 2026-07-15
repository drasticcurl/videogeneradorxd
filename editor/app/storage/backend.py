"""StorageBackend abstraction for the editor (Req 7, 10).

Defines the StorageBackend protocol and two implementations:
- LocalStorageBackend: reproduces today's on-disk behavior (default).
- VolumeStorageBackend: reads from / writes to the Shared_Volume used when deployed
  as a sidecar in the single multi-container Cloud Run service.

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


def _validate_key(edit_job_id: str, key: str) -> None:
    """Validate that a key is safe (no traversal, no absolute paths).

    Raises ValueError if the key would escape the expected prefix.
    """
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
        if not source.is_absolute():
            from app.storage.clip_store import ClipStore

            source = ClipStore().base_dir / key

        if not source.exists():
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
    """Shared_Volume storage backend (cloud/sidecar mode).

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

        source = self._inputs_dir(edit_job_id) / key
        if not source.exists():
            raise FileNotFoundError(
                f"Input missing on shared volume for edit job {edit_job_id}: {key} "
                f"(expected at {source})"
            )

        # Verify the source is actually readable
        if not os.access(source, os.R_OK):
            raise FileNotFoundError(
                f"Input unreadable on shared volume for edit job {edit_job_id}: {key}"
            )

        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / key
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
        """Persist to the existing Output_Store (GCS or local fallback).

        Uses google-cloud-storage if available (guarded import), otherwise
        falls back to local filesystem copy to OUTPUT_ROOT.
        """
        try:
            from google.cloud import storage as gcs_storage  # type: ignore

            # Use the existing bucket configuration from the generator
            bucket_name = os.environ.get("GCS_BUCKET")
            if bucket_name:
                client = gcs_storage.Client()
                bucket = client.bucket(bucket_name)
                blob_name = f"edit-output/{edit_job_id}/{config.FINAL_VIDEO_FILENAME}"
                blob = bucket.blob(blob_name)
                blob.upload_from_filename(str(source_path))
                logger.info(
                    "Persisted output for edit job %s to GCS: gs://%s/%s",
                    edit_job_id,
                    bucket_name,
                    blob_name,
                )
                return blob_name
        except ImportError:
            logger.debug(
                "google-cloud-storage not available; falling back to local persist"
            )
        except Exception as exc:
            logger.error(
                "GCS persist failed for edit job %s: %s", edit_job_id, exc
            )
            # Fall through to local fallback

        # Local fallback: copy to OUTPUT_ROOT
        try:
            output_dir = config.OUTPUT_ROOT / edit_job_id
            output_dir.mkdir(parents=True, exist_ok=True)
            dest = output_dir / config.FINAL_VIDEO_FILENAME
            shutil.copy2(source_path, dest)
            return str(dest)
        except Exception as exc:
            logger.error(
                "Local persist fallback failed for edit job %s: %s",
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
