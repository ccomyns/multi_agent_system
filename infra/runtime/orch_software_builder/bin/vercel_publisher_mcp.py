#!/usr/bin/env python3
"""Publish the software builder's current pushed commit through the trusted Lambda."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import boto3
from mcp.server.fastmcp import FastMCP

from software_project_credentials import base_role_environment


COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
DEPLOYMENT_ID_PATTERN = re.compile(r"^dpl_[A-Za-z0-9]+$")
PROJECT_ID_PATTERN = re.compile(r"^prj_[A-Za-z0-9]+$")
BRANCH_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
REPOSITORY_PART_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
VERCEL_URL_PATTERN = re.compile(r"^https://[A-Za-z0-9.-]+$")
POLL_INTERVAL_SECONDS = 3
PUBLISH_TIMEOUT_SECONDS = 600
TERMINAL_FAILURE_STATES = {"CANCELED", "ERROR"}

_deployment_ids: dict[tuple[str, str, str], str] = {}

mcp = FastMCP(
    "Vercel site publisher",
    instructions=(
        "Use publish_site() only when the user asks for a public Vercel deployment. "
        "Commit and push every intended repository change before calling it. The tool "
        "accepts no deployment scope from the model: it derives the current branch and "
        "commit from the trusted repository workspace, verifies that exact commit at "
        "origin, invokes the assignment-validating publisher Lambda, waits for Vercel, "
        "and returns the public production URL."
    ),
)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required by the Vercel publisher MCP server")
    return value


def _git(repository: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[-500:]
        operation = arguments[0] if arguments else "command"
        raise RuntimeError(
            f"git {operation} failed" + (f": {detail}" if detail else "")
        )
    return completed.stdout.strip()


def _valid_branch(branch: str) -> bool:
    return (
        bool(BRANCH_PATTERN.fullmatch(branch))
        and ".." not in branch
        and "//" not in branch
        and "@{" not in branch
        and not branch.endswith(("/", ".", ".lock"))
    )


def _repository_full_name(remote_url: str) -> str:
    prefix = "https://github.com/"
    if not remote_url.startswith(prefix):
        raise RuntimeError("origin must be the assigned HTTPS GitHub repository")
    path = remote_url[len(prefix) :]
    if path.endswith(".git"):
        path = path[:-4]
    parts = path.split("/")
    if (
        len(parts) != 2
        or not all(REPOSITORY_PART_PATTERN.fullmatch(part) for part in parts)
        or parts[0] in {".", ".."}
        or parts[1] in {".", ".."}
    ):
        raise RuntimeError("origin must be the assigned HTTPS GitHub repository")
    return path


def current_pushed_commit(repository: Path) -> dict[str, str]:
    repository = repository.resolve()
    if not (repository / ".git").is_dir():
        raise RuntimeError("the configured software-builder workspace is not a Git repository")
    if _git(repository, "status", "--porcelain"):
        raise RuntimeError("commit every intended change and leave the working tree clean first")

    branch = _git(repository, "symbolic-ref", "--quiet", "--short", "HEAD")
    commit_sha = _git(repository, "rev-parse", "--verify", "HEAD")
    repository_full_name = _repository_full_name(
        _git(repository, "remote", "get-url", "origin")
    )
    if not _valid_branch(branch):
        raise RuntimeError("the current Git branch is invalid for publication")
    if not COMMIT_SHA_PATTERN.fullmatch(commit_sha):
        raise RuntimeError("the current Git commit SHA is invalid")

    remote_ref = f"refs/heads/{branch}"
    remote_lines = _git(
        repository,
        "ls-remote",
        "--exit-code",
        "origin",
        remote_ref,
    ).splitlines()
    remote_commit = next(
        (
            fields[0]
            for line in remote_lines
            if len(fields := line.split()) == 2 and fields[1] == remote_ref
        ),
        "",
    )
    if remote_commit != commit_sha:
        raise RuntimeError("push the current branch and commit to origin before publishing")
    return {
        "repository_full_name": repository_full_name,
        "branch": branch,
        "commit_sha": commit_sha,
    }


def _decode_lambda_response(response: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    stream = response.get("Payload")
    if stream is None or not hasattr(stream, "read"):
        raise RuntimeError("the Vercel publisher Lambda returned no payload")
    raw = stream.read()
    try:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="strict")
        payload = json.loads(raw)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("the Vercel publisher Lambda returned invalid JSON") from error
    if response.get("FunctionError"):
        raise RuntimeError("the Vercel publisher Lambda failed")
    if not isinstance(payload, dict):
        raise RuntimeError("the Vercel publisher Lambda returned an invalid response")
    status_code = payload.get("statusCode")
    body = payload.get("body")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError as error:
            raise RuntimeError("the Vercel publisher Lambda returned an invalid body") from error
    if not isinstance(status_code, int) or not isinstance(body, dict):
        raise RuntimeError("the Vercel publisher Lambda returned an invalid response shape")
    return status_code, body


def _invoke_publisher(
    *,
    action: str,
    deployment_id: str | None,
    branch: str,
    commit_sha: str,
) -> dict[str, Any]:
    event = {
        "action": action,
        "job_id": required_env("JOB_ID"),
        "orchestrator_instance_id": required_env("ORCHESTRATOR_INSTANCE_ID"),
        "branch": branch,
        "commit_sha": commit_sha,
    }
    if deployment_id is not None:
        event["deployment_id"] = deployment_id

    with base_role_environment():
        response = boto3.client(
            "lambda",
            region_name=required_env("AWS_REGION"),
        ).invoke(
            FunctionName=required_env("VERCEL_PUBLISHER_FUNCTION_NAME"),
            InvocationType="RequestResponse",
            Payload=json.dumps(event, separators=(",", ":")).encode("utf-8"),
        )
    status_code, body = _decode_lambda_response(response)
    if status_code != 200:
        code = body.get("error")
        message = body.get("message")
        safe_code = code if isinstance(code, str) else "request_failed"
        safe_message = message if isinstance(message, str) else "publication failed"
        raise RuntimeError(
            f"Vercel publisher rejected the request ({safe_code}): {safe_message}"
        )
    return body


def _optional_url(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not VERCEL_URL_PATTERN.fullmatch(value):
        raise RuntimeError(f"the Vercel publisher returned an invalid {label}")
    return value


def _deployment(
    body: dict[str, Any],
    *,
    repository_full_name: str,
    branch: str,
    commit_sha: str,
    expected_deployment_id: str | None = None,
) -> dict[str, Any]:
    repository = body.get("repository")
    deployment = body.get("deployment")
    if not isinstance(repository, dict) or not isinstance(deployment, dict):
        raise RuntimeError("the Vercel publisher returned invalid publication metadata")
    repository_id = repository.get("id")
    deployment_id = deployment.get("id")
    project_id = deployment.get("project_id")
    project_name = deployment.get("project_name")
    ready_state = deployment.get("ready_state")
    if (
        not isinstance(repository_id, int)
        or repository_id <= 0
        or not isinstance(repository.get("full_name"), str)
        or repository["full_name"].casefold() != repository_full_name.casefold()
        or not isinstance(deployment_id, str)
        or not DEPLOYMENT_ID_PATTERN.fullmatch(deployment_id)
        or (expected_deployment_id is not None and deployment_id != expected_deployment_id)
        or not isinstance(project_id, str)
        or not PROJECT_ID_PATTERN.fullmatch(project_id)
        or not isinstance(project_name, str)
        or not project_name
        or len(project_name) > 100
        or not isinstance(ready_state, str)
        or not re.fullmatch(r"[A-Z_]{3,32}", ready_state)
        or deployment.get("target") != "production"
        or deployment.get("branch") != branch
        or deployment.get("commit_sha") != commit_sha
    ):
        raise RuntimeError("the Vercel publisher returned mismatched publication metadata")
    return {
        "repository": repository["full_name"],
        "deployment_id": deployment_id,
        "project_id": project_id,
        "project_name": project_name,
        "ready_state": ready_state,
        "branch": branch,
        "commit_sha": commit_sha,
        "deployment_url": _optional_url(
            deployment.get("deployment_url"),
            "deployment URL",
        ),
        "public_url": _optional_url(deployment.get("public_url"), "public URL"),
        "error_code": (
            str(deployment["error_code"])[:100]
            if deployment.get("error_code") is not None
            else None
        ),
        "error_message": (
            str(deployment["error_message"])[:500]
            if deployment.get("error_message") is not None
            else None
        ),
    }


@mcp.tool()
def publish_site() -> dict[str, Any]:
    """Publish the current clean, pushed Git commit to the public Vercel URL.

    This tool accepts no arguments. Repository, branch, commit, project, team,
    and credential scope are derived from the trusted job and local workspace.
    It waits for the production deployment and returns only after a public URL
    is available, Vercel reports a terminal failure, or ten minutes elapse.
    """

    source = current_pushed_commit(
        Path(required_env("SOFTWARE_BUILDER_REPOSITORY_ROOT"))
    )
    branch = source["branch"]
    commit_sha = source["commit_sha"]
    repository_full_name = source["repository_full_name"]
    cache_key = (required_env("JOB_ID"), branch, commit_sha)
    deployment_id = _deployment_ids.get(cache_key)
    if deployment_id is None:
        body = _invoke_publisher(
            action="publish",
            deployment_id=None,
            branch=branch,
            commit_sha=commit_sha,
        )
        deployment = _deployment(
            body,
            repository_full_name=repository_full_name,
            branch=branch,
            commit_sha=commit_sha,
        )
        deployment_id = deployment["deployment_id"]
        _deployment_ids[cache_key] = deployment_id
    else:
        body = _invoke_publisher(
            action="status",
            deployment_id=deployment_id,
            branch=branch,
            commit_sha=commit_sha,
        )
        deployment = _deployment(
            body,
            repository_full_name=repository_full_name,
            branch=branch,
            commit_sha=commit_sha,
            expected_deployment_id=deployment_id,
        )

    deadline = time.monotonic() + PUBLISH_TIMEOUT_SECONDS
    while True:
        state = deployment["ready_state"]
        if state in TERMINAL_FAILURE_STATES:
            detail = deployment.get("error_message") or deployment.get("error_code")
            raise RuntimeError(
                f"Vercel deployment {deployment_id} ended in {state}"
                + (f": {detail}" if detail else "")
            )
        if state == "READY" and deployment.get("public_url"):
            return {"published": True, **deployment}
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"Vercel deployment {deployment_id} did not produce a public URL "
                f"within {PUBLISH_TIMEOUT_SECONDS} seconds"
            )

        time.sleep(POLL_INTERVAL_SECONDS)
        body = _invoke_publisher(
            action="status",
            deployment_id=deployment_id,
            branch=branch,
            commit_sha=commit_sha,
        )
        deployment = _deployment(
            body,
            repository_full_name=repository_full_name,
            branch=branch,
            commit_sha=commit_sha,
            expected_deployment_id=deployment_id,
        )


if __name__ == "__main__":
    mcp.run(transport="stdio")
