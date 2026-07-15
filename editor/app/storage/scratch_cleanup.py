"""Shared_Volume scratch cleanup after output persistence (Req 7.8).

After persist_output succeeds, the per-job scratch directory on the Shared_Volume
(edit-io/<editJobId>/) should be removed. This module provides the cleanup logic.

Output retention follows the existing Output_Store lifecycle — no new rule is
introduced (Req 7.9).

Requirements: 7.8, 7.9
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)

# Path to the shared volume mount point
SHARED_VOLUME_PATH = os.environ.get("SHARED_VOLUME_PATH", "/shared")


def cleanup_job_scratch(edit_job_id: str, volume_path: str | None = None) -> bool:
    """Remove the per-job edit-io/<editJobId>/ directory from the Shared_Volume.

    Called after persist_output succeeds. The scratch directory contains both
    inputs/ and outputs/ sub-directories used during the edit job.

    Args:
        edit_job_id: The edit job identifier.
        volume_path: Override for the shared volume path (for testing).

    Returns:
        True if cleanup succeeded (or directory didn't exist), False on error.
    """
    vol = Path(volume_path or SHARED_VOLUME_PATH)
    job_dir = vol / "edit-io" / edit_job_id

    if not job_dir.exists():
        logger.debug(
            "Scratch directory for edit job %s does not exist; nothing to clean",
            edit_job_id,
        )
        return True

    try:
        shutil.rmtree(job_dir)
        logger.info(
            "Cleaned up scratch directory for edit job %s: %s",
            edit_job_id,
            job_dir,
        )
        return True
    except OSError as exc:
        logger.error(
            "Failed to clean up scratch directory for edit job %s: %s",
            edit_job_id,
            exc,
        )
        return False
