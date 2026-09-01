#!/usr/bin/env python3
"""Git credential helper that refreshes only the current job's assigned token."""

from __future__ import annotations

import os
import sys
from typing import TextIO
from urllib.parse import unquote

from software_github_credentials import request_repository_credentials
from software_project_credentials import base_role_environment


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def read_request(source: TextIO) -> dict[str, str]:
    request: dict[str, str] = {}
    for raw_line in source:
        line = raw_line.rstrip("\n")
        if not line:
            break
        key, separator, value = line.partition("=")
        if separator and key:
            request[key] = value
    return request


def normalized_repository_path(value: str) -> str:
    path = unquote(value).strip().strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    return path


def main(
    argv: list[str] | None = None,
    source: TextIO | None = None,
    destination: TextIO | None = None,
) -> int:
    arguments = argv or sys.argv
    source = source or sys.stdin
    destination = destination or sys.stdout
    operation = arguments[1] if len(arguments) > 1 else ""
    if operation in {"store", "erase"}:
        return 0
    if operation != "get":
        return 1

    request = read_request(source)
    if request.get("protocol") != "https" or request.get("host") != "github.com":
        return 1
    requested_repository = normalized_repository_path(request.get("path", ""))
    if not requested_repository:
        return 1

    try:
        with base_role_environment():
            credentials = request_repository_credentials(
                region=required_env("AWS_REGION"),
                function_name=required_env("GITHUB_TOKEN_BROKER_FUNCTION_NAME"),
                job_id=required_env("JOB_ID"),
                orchestrator_instance_id=required_env("ORCHESTRATOR_INSTANCE_ID"),
            )
        if requested_repository.casefold() != credentials.repository_full_name.casefold():
            return 1
        destination.write("username=x-access-token\n")
        destination.write(f"password={credentials.token}\n\n")
        destination.flush()
        return 0
    except Exception:
        # Git receives only a failure signal. Never print a token or a broker payload.
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
