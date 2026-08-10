#!/usr/bin/env python3
"""Local MCP server exposing a narrow, idempotent subagent spawn tool."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any

import boto3
from mcp.server.fastmcp import FastMCP


MAX_TASK_LENGTH = 12_000

mcp = FastMCP(
    "EC2 subagent manager",
    instructions=(
        "Use spawn_agent(task) only after the orchestration plan has been written. "
        "Each call stores a versioned task specification and asks the configured "
        "Lambda to reserve capacity and launch one EC2 subagent. Retrying the exact "
        "same task within a job is idempotent. The EC2 subagent downloads the stored "
        "task and publishes summary and result Markdown files beneath its job prefix."
    ),
)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required by the spawn_agent MCP server")
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


if __name__ == "__main__":
    mcp.run(transport="stdio")
