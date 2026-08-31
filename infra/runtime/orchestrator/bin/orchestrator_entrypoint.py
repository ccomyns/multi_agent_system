#!/usr/bin/env python3
"""Dispatch an orchestrator instance to the runner for its trusted job type."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path


LOG = logging.getLogger("orchestrator-entrypoint")
RUNNER_FILENAMES = {
    "data_mining": "orchestrator_runner.py",
}


def runner_path(job_type: str, bin_dir: Path | None = None) -> Path:
    filename = RUNNER_FILENAMES.get(job_type)
    if filename is None:
        raise RuntimeError(f"unsupported TYPE_OF_JOB: {job_type!r}")
    return (bin_dir or Path(__file__).resolve().parent) / filename


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
        LOG.error("orchestrator runner is missing: %s", selected_runner)
        return 2

    runtime_root = Path(__file__).resolve().parents[1]
    os.environ["SPAWN_AGENT_MCP_COMMAND"] = str(
        runtime_root / "bin" / "spawn-agent-mcp"
    )
    os.environ["ORCHESTRATOR_DOCUMENTATION_DIR"] = str(runtime_root / "docs")
    LOG.info("starting %s orchestrator runner", job_type)
    os.execv(
        sys.executable,
        [sys.executable, str(selected_runner)],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
