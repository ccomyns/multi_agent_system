#!/usr/bin/env python3
"""Local MCP server for spawning subagents and collecting their datasets."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from mcp.server.fastmcp import FastMCP


MAX_TASK_LENGTH = 12_000
MAX_AGENTS_PER_WAIT = 12
MAX_SUMMARY_BYTES = 1024 * 1024
MAX_RESULTS_BYTES = 50 * 1024 * 1024
AGENT_ID_PATTERN = re.compile(r"^agent-[0-9a-f]{24}$")

mcp = FastMCP(
    "EC2 subagent manager",
    instructions=(
        "Use spawn_agent(task) only after the orchestration plan has been written. "
        "Each call stores a versioned task specification and asks the configured "
        "Lambda to reserve capacity and launch one EC2 subagent. Retrying the exact "
        "same task within a job is idempotent. Keep track of every accepted, non-terminal "
        "agent ID and pass those IDs to wait_on_any(agent_ids). Each wait returns as soon "
        "as one agent becomes terminal, downloads that agent's explanatory summary and "
        "structured JSON data when it completed successfully, and returns the IDs that "
        "still need another wait. Handle the event, refill the freed capacity when work "
        "remains, then call wait_on_any again immediately while any accepted agent is "
        "still non-terminal. The tool uses completed.md or failure.md as the terminal flag "
        "but does not download either marker."
    ),
)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required by the subagent-manager MCP server")
    return value


def stable_agent_id(job_id: str, task: str) -> str:
    digest = hashlib.sha256(f"{job_id}\0{task}".encode("utf-8")).hexdigest()[:24]
    return f"agent-{digest}"


def decode_lambda_response(response: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    if response.get("FunctionError"):
        payload = response["Payload"].read().decode("utf-8", errors="replace")
        raise RuntimeError(f"subagent-manager Lambda failed: {payload[:1000]}")

    raw_payload = response["Payload"].read()
    decoded = json.loads(raw_payload)
    if not isinstance(decoded, dict) or not isinstance(decoded.get("statusCode"), int):
        raise RuntimeError("subagent-manager Lambda returned an unexpected response")

    body = decoded.get("body", {})
    if isinstance(body, str):
        body = json.loads(body)
    if not isinstance(body, dict):
        raise RuntimeError("subagent-manager Lambda returned an unexpected response body")
    return decoded["statusCode"], body


def object_is_missing(error: Exception) -> bool:
    response = getattr(error, "response", {})
    error_record = response.get("Error", {}) if isinstance(response, dict) else {}
    metadata = response.get("ResponseMetadata", {}) if isinstance(response, dict) else {}
    return error_record.get("Code") in {"404", "NoSuchKey", "NotFound"} or metadata.get(
        "HTTPStatusCode"
    ) == 404


def read_s3_object(s3: Any, bucket: str, key: str, limit: int) -> bytes:
    response = s3.get_object(Bucket=bucket, Key=key)
    content_length = response.get("ContentLength")
    if isinstance(content_length, int) and content_length > limit:
        raise RuntimeError(f"s3://{bucket}/{key} exceeds the {limit}-byte collection limit")
    content = response["Body"].read(limit + 1)
    if len(content) > limit:
        raise RuntimeError(f"s3://{bucket}/{key} exceeds the {limit}-byte collection limit")
    return content


def s3_object_exists(s3: Any, bucket: str, key: str) -> bool:
    try:
        s3.head_object(Bucket=bucket, Key=key)
    except Exception as error:
        if object_is_missing(error):
            return False
        raise
    return True


def read_status(s3: Any, bucket: str, key: str) -> dict[str, Any] | None:
    try:
        raw = read_s3_object(s3, bucket, key, 64 * 1024)
    except Exception as error:
        if object_is_missing(error):
            return None
        raise
    decoded = json.loads(raw)
    if not isinstance(decoded, dict):
        raise RuntimeError(f"s3://{bucket}/{key} must contain a JSON object")
    return decoded


def atomic_write(destination: Path, content: bytes) -> None:
    destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def validate_status(
    status: dict[str, Any], state: str, job_id: str, orchestrator_instance_id: str, agent_id: str
) -> None:
    expected = {
        "schema_version": 1,
        "state": state,
        "job_id": job_id,
        "orchestrator_instance_id": orchestrator_instance_id,
        "agent_id": agent_id,
    }
    for field, value in expected.items():
        if status.get(field) != value:
            raise RuntimeError(f"subagent {agent_id} {state} status has invalid {field}")


def download_agent_data(
    s3: Any,
    bucket: str,
    job_id: str,
    agent_id: str,
    collection_root: Path,
) -> dict[str, str]:
    prefix = f"jobs/{job_id}/agents/{agent_id}/summary"
    summary = read_s3_object(s3, bucket, f"{prefix}/summary.md", MAX_SUMMARY_BYTES)
    results_name = f"results_{agent_id}.json"
    results = read_s3_object(s3, bucket, f"{prefix}/{results_name}", MAX_RESULTS_BYTES)

    try:
        summary_text = summary.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError(f"subagent {agent_id} summary is not valid UTF-8") from error
    if not summary_text.strip():
        raise RuntimeError(f"subagent {agent_id} summary is empty")
    try:
        parsed_results = json.loads(results)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"subagent {agent_id} results are not valid UTF-8 JSON") from error
    if not isinstance(parsed_results, (dict, list)):
        raise RuntimeError(f"subagent {agent_id} results must be a JSON object or array")

    agent_directory = collection_root / agent_id
    summary_path = agent_directory / "summary.md"
    results_path = agent_directory / results_name
    atomic_write(summary_path, summary)
    atomic_write(results_path, results)
    return {
        "agent_id": agent_id,
        "summary_path": str(summary_path),
        "results_path": str(results_path),
    }


@mcp.tool()
def spawn_agent(task: str) -> dict[str, Any]:
    """Launch one research subagent for a focused task.

    The caller supplies only the research task. Job identity, orchestrator
    identity, model selection, request id, storage location, and Lambda routing
    are trusted server configuration and cannot be overridden by the model.
    """

    normalized_task = task.strip()
    if not normalized_task:
        raise ValueError("task must not be empty")
    if len(normalized_task) > MAX_TASK_LENGTH:
        raise ValueError(f"task must not exceed {MAX_TASK_LENGTH} characters")

    region = required_env("AWS_REGION")
    function_name = required_env("FUNCTION_NAME")
    workspace_bucket = required_env("AGENT_WORKSPACE_BUCKET_NAME")
    job_id = required_env("JOB_ID")
    orchestrator_instance_id = required_env("ORCHESTRATOR_INSTANCE_ID")
    model = required_env("SUBAGENT_MODEL")

    agent_id = stable_agent_id(job_id, normalized_task)
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    input_key = f"jobs/{job_id}/agents/{agent_id}/input.json"
    input_uri = f"s3://{workspace_bucket}/{input_key}"
    input_record = {
        "schema_version": 1,
        "job_id": job_id,
        "orchestrator_instance_id": orchestrator_instance_id,
        "agent_id": agent_id,
        "model": model,
        "task": normalized_task,
        "created_at": created_at,
    }

    boto3.client("s3", region_name=region).put_object(
        Bucket=workspace_bucket,
        Key=input_key,
        Body=json.dumps(input_record, sort_keys=True).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256",
    )

    response = boto3.client("lambda", region_name=region).invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(
            {
                "action": "spawn",
                # The Lambda's generic grouping parameter is the orchestrator's
                # concrete EC2 instance ID for real jobs.
                "orchestrator_id": orchestrator_instance_id,
                "request_id": agent_id,
                "job_id": job_id,
                "task_s3_uri": input_uri,
                "model": model,
            }
        ).encode("utf-8"),
    )
    status_code, body = decode_lambda_response(response)

    return {
        "accepted": bool(body.get("accepted")),
        "status_code": status_code,
        "job_id": job_id,
        "orchestrator_instance_id": orchestrator_instance_id,
        "agent_id": body.get("agent_id", agent_id),
        "instance_id": body.get("instance_id"),
        "state": body.get("state"),
        "active_count": body.get("active_count"),
        "max_active_subagents": body.get("max_active_subagents"),
        "idempotent_replay": bool(body.get("idempotent_replay", False)),
        "error": body.get("error"),
        "model": model,
        "task_s3_uri": input_uri,
        "task_delivery": "stored_for_subagent_runtime",
    }


@mcp.tool()
def wait_on_any(
    agent_ids: list[str], timeout_seconds: int = 900, poll_interval_seconds: int = 5
) -> dict[str, Any]:
    """Wait until any one subagent is terminal and return that single event.

    Pass every accepted agent that has not produced a terminal event yet. completed.md
    or failure.md is the readiness flag. The first terminal agent observed is returned;
    a successful agent's data is downloaded beneath
    <orchestrator workspace>/subagents/<agent_id>/. The marker is checked with S3
    metadata and is not downloaded. remaining_agent_ids must be passed to the next
    wait, together with any newly accepted agent IDs. If the timeout expires without
    an event, call this tool again with the same IDs while agents are still active.
    """

    if not agent_ids:
        raise ValueError("agent_ids must not be empty")
    if len(agent_ids) > MAX_AGENTS_PER_WAIT:
        raise ValueError(
            f"agent_ids must contain no more than {MAX_AGENTS_PER_WAIT} entries"
        )
    if len(set(agent_ids)) != len(agent_ids):
        raise ValueError("agent_ids must not contain duplicates")
    for agent_id in agent_ids:
        if not AGENT_ID_PATTERN.fullmatch(agent_id):
            raise ValueError(f"invalid agent_id: {agent_id}")
    if not isinstance(timeout_seconds, int) or not 0 <= timeout_seconds <= 3500:
        raise ValueError("timeout_seconds must be an integer between 0 and 3500")
    if not isinstance(poll_interval_seconds, int) or not 1 <= poll_interval_seconds <= 60:
        raise ValueError("poll_interval_seconds must be an integer between 1 and 60")

    region = required_env("AWS_REGION")
    bucket = required_env("AGENT_WORKSPACE_BUCKET_NAME")
    job_id = required_env("JOB_ID")
    orchestrator_instance_id = required_env("ORCHESTRATOR_INSTANCE_ID")
    workspace = Path(required_env("ORCHESTRATOR_WORKSPACE")).resolve()
    collection_root = workspace / "subagents"
    collection_root.mkdir(parents=True, mode=0o700, exist_ok=True)

    s3 = boto3.client("s3", region_name=region)
    remaining_agent_ids = list(agent_ids)
    terminal: dict[str, Any] | None = None
    deadline = time.monotonic() + timeout_seconds

    while terminal is None:
        for agent_id in remaining_agent_ids:
            prefix = f"jobs/{job_id}/agents/{agent_id}"
            if s3_object_exists(s3, bucket, f"{prefix}/result/completed.md"):
                try:
                    completed_status = read_status(
                        s3, bucket, f"{prefix}/status/completed.json"
                    )
                    if completed_status is None:
                        raise RuntimeError(
                            f"subagent {agent_id} has a completion marker but no status record"
                        )
                    validate_status(
                        completed_status,
                        "completed",
                        job_id,
                        orchestrator_instance_id,
                        agent_id,
                    )
                    terminal = {
                        "state": "completed",
                        **download_agent_data(
                            s3, bucket, job_id, agent_id, collection_root
                        ),
                    }
                except Exception as error:
                    terminal = {
                        "agent_id": agent_id,
                        "state": "collection_failed",
                        "error": str(error)[:1000],
                    }
                break

            if s3_object_exists(s3, bucket, f"{prefix}/result/failure.md"):
                try:
                    failed_status = read_status(
                        s3, bucket, f"{prefix}/status/failed.json"
                    )
                    if failed_status is None:
                        raise RuntimeError(
                            f"subagent {agent_id} has a failure marker but no status record"
                        )
                    validate_status(
                        failed_status,
                        "failed",
                        job_id,
                        orchestrator_instance_id,
                        agent_id,
                    )
                    terminal = {
                        "agent_id": agent_id,
                        "state": "failed",
                        "error_type": failed_status.get("error_type"),
                        "error": failed_status.get("error"),
                    }
                except Exception as error:
                    terminal = {
                        "agent_id": agent_id,
                        "state": "collection_failed",
                        "error": str(error)[:1000],
                    }
                break

        if terminal is not None or time.monotonic() >= deadline:
            break
        time.sleep(min(poll_interval_seconds, max(0.0, deadline - time.monotonic())))

    if terminal is not None:
        remaining_agent_ids.remove(terminal["agent_id"])
    return {
        "event_received": terminal is not None,
        "timed_out": terminal is None,
        "terminal": terminal,
        "remaining_agent_ids": remaining_agent_ids,
        "all_terminal": not remaining_agent_ids,
        "terminal_markers_downloaded": False,
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
