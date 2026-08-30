#!/usr/bin/env python3
"""Start the isolated Software Builder runner for a trusted job type."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path


LOG = logging.getLogger("software-builder-entrypoint")
EXPECTED_JOB_TYPE = "software_builder"
RUNNER_FILENAME = "orchestrator_software_runner.py"


def runner_path(job_type: str, bin_dir: Path | None = None) -> Path:
    if job_type != EXPECTED_JOB_TYPE:
        raise RuntimeError(f"unsupported TYPE_OF_JOB: {job_type!r}")
    return (bin_dir or Path(__file__).resolve().parent) / RUNNER_FILENAME


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    job_type = os.environ.get("TYPE_OF_JOB", "").strip()
    try:
        selected_runner = runner_path(job_type)
    except RuntimeError as error:
        LOG.error("%s", error)
        return 2
    if not selected_runner.is_file():
        LOG.error("software-builder runner is missing: %s", selected_runner)
        return 2

    LOG.info("starting software-builder orchestrator runner")
    os.execv(sys.executable, [sys.executable, str(selected_runner)])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
