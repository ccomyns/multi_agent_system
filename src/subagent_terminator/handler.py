"""Terminate a subagent after its durable terminal artifacts reach S3."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote_plus

import boto3
from botocore.exceptions import ClientError


_REQUEST_KEY_PATTERN = re.compile(
    r"^jobs/(?P<job_id>job_[a-z0-9]{4,12}_[0-9a-f]{8})/"
    r"agents/(?P<agent_id>agent-[0-9a-f]{24})/termination/request\.json$"
)
_INSTANCE_ID_PATTERN = re.compile(r"^i-[0-9a-f]{8,17}$")
_MAX_JSON_BYTES = 64 * 1024
_clients: dict[str, Any] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _client(name: str) -> Any:
    if name not in _clients:
        if name == "table":
            _clients[name] = boto3.resource("dynamodb").Table(
                os.environ["STATE_TABLE_NAME"]
            )
        else:
            _clients[name] = boto3.client(name)
    return _clients[name]


def _read_json_object(
    bucket: str,
    key: str,
    *,
    version_id: str | None = None,
) -> dict[str, Any]:
    request: dict[str, Any] = {"Bucket": bucket, "Key": key}
    if version_id:
        request["VersionId"] = version_id
    response = _client("s3").get_object(**request)
    content_length = response.get("ContentLength")
    if isinstance(content_length, int) and content_length > _MAX_JSON_BYTES:
        raise RuntimeError(f"S3 object {key} exceeds {_MAX_JSON_BYTES} bytes")
    raw = response["Body"].read(_MAX_JSON_BYTES + 1)
    if len(raw) > _MAX_JSON_BYTES:
        raise RuntimeError(f"S3 object {key} exceeds {_MAX_JSON_BYTES} bytes")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise RuntimeError(f"S3 object {key} must contain a JSON object")
    return payload


def _request_identity(key: str, request: dict[str, Any]) -> dict[str, str]:
    match = _REQUEST_KEY_PATTERN.fullmatch(key)
    if match is None:
        raise ValueError("unexpected termination-request key")
    if request.get("schema_version") != 1:
        raise ValueError("unsupported termination-request schema_version")

    state = request.get("state")
    if state not in {"completed", "failed"}:
        raise ValueError("termination-request state must be completed or failed")
    marker_name = "completed.md" if state == "completed" else "failure.md"
    prefix = f"jobs/{match['job_id']}/agents/{match['agent_id']}"
    expected = {
        "job_id": match["job_id"],
        "agent_id": match["agent_id"],
        "status_key": f"{prefix}/status/{state}.json",
        "terminal_marker_key": f"{prefix}/result/{marker_name}",
    }
    for field, value in expected.items():
        if request.get(field) != value:
            raise ValueError(f"termination-request {field} does not match its S3 key")

    orchestrator_id = request.get("orchestrator_instance_id")
    instance_id = request.get("subagent_instance_id")
    if not isinstance(orchestrator_id, str) or not _INSTANCE_ID_PATTERN.fullmatch(
        orchestrator_id
    ):
        raise ValueError("termination-request orchestrator_instance_id is invalid")
    if not isinstance(instance_id, str) or not _INSTANCE_ID_PATTERN.fullmatch(instance_id):
        raise ValueError("termination-request subagent_instance_id is invalid")
    recorded_at = request.get("recorded_at")
    if not isinstance(recorded_at, str) or not recorded_at:
        raise ValueError("termination-request recorded_at is required")

    return {
        **expected,
        "state": state,
        "orchestrator_instance_id": orchestrator_id,
        "subagent_instance_id": instance_id,
        "recorded_at": recorded_at,
    }


def _validate_terminal_artifacts(bucket: str, identity: dict[str, str]) -> dict[str, Any]:
    _client("s3").head_object(
        Bucket=bucket,
        Key=identity["terminal_marker_key"],
    )
    status = _read_json_object(bucket, identity["status_key"])
    expected = {
        "state": identity["state"],
        "job_id": identity["job_id"],
        "agent_id": identity["agent_id"],
        "orchestrator_instance_id": identity["orchestrator_instance_id"],
        "subagent_instance_id": identity["subagent_instance_id"],
    }
    for field, value in expected.items():
        if status.get(field) != value:
            raise ValueError(f"terminal status {field} does not match the request")
    return status


def _agent_record(identity: dict[str, str]) -> dict[str, Any] | None:
    response = _client("table").get_item(
        Key={
            "pk": f"ORCHESTRATOR#{identity['orchestrator_instance_id']}",
            "sk": f"AGENT#{identity['agent_id']}",
        },
        ConsistentRead=True,
    )
    return response.get("Item")


def _validate_agent_record(agent: dict[str, Any], identity: dict[str, str]) -> None:
    expected = {
        "job_id": identity["job_id"],
        "agent_id": identity["agent_id"],
        "orchestrator_id": identity["orchestrator_instance_id"],
        "instance_id": identity["subagent_instance_id"],
    }
    for field, value in expected.items():
        if agent.get(field) != value:
            raise ValueError(f"DynamoDB agent {field} does not match the request")


def _record_termination_request(
    identity: dict[str, str],
    requested_at: str,
) -> bool:
    expression = (
        "SET termination_requested_at = :requested_at, "
        "termination_source = :source, terminal_marker_recorded_at = :recorded_at"
    )
    values: dict[str, Any] = {
        ":requested_at": requested_at,
        ":source": "s3_terminal_request",
        ":recorded_at": identity["recorded_at"],
        ":true": True,
        ":instance_id": identity["subagent_instance_id"],
    }

    try:
        _client("table").update_item(
            Key={
                "pk": f"ORCHESTRATOR#{identity['orchestrator_instance_id']}",
                "sk": f"AGENT#{identity['agent_id']}",
            },
            UpdateExpression=expression,
            ConditionExpression=(
                "active = :true AND instance_id = :instance_id AND "
                "attribute_not_exists(termination_requested_at)"
            ),
            ExpressionAttributeValues=values,
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise
    return True


def _handle_record(record: dict[str, Any]) -> dict[str, Any]:
    if record.get("eventSource") != "aws:s3":
        raise ValueError("unsupported event source")
    bucket = record.get("s3", {}).get("bucket", {}).get("name")
    if bucket != os.environ["AGENT_WORKSPACE_BUCKET_NAME"]:
        raise ValueError("termination request came from an unexpected bucket")
    object_record = record.get("s3", {}).get("object", {})
    raw_key = object_record.get("key")
    if not isinstance(raw_key, str):
        raise ValueError("S3 event object key is missing")
    key = unquote_plus(raw_key)
    version_id = object_record.get("versionId")
    if not isinstance(version_id, str):
        version_id = None

    request = _read_json_object(bucket, key, version_id=version_id)
    identity = _request_identity(key, request)
    _validate_terminal_artifacts(bucket, identity)
    agent = _agent_record(identity)
    if agent is None:
        raise ValueError("termination request has no matching DynamoDB agent")
    _validate_agent_record(agent, identity)
    if agent.get("active") is not True:
        return {
            "ignored": True,
            "reason": "agent_already_inactive",
            "agent_id": identity["agent_id"],
            "instance_id": identity["subagent_instance_id"],
        }
    if agent.get("termination_requested_at"):
        return {
            "ignored": True,
            "reason": "termination_already_requested",
            "agent_id": identity["agent_id"],
            "instance_id": identity["subagent_instance_id"],
        }

    requested_at = _now()
    _client("ec2").terminate_instances(
        InstanceIds=[identity["subagent_instance_id"]]
    )
    recorded = _record_termination_request(identity, requested_at)
    result = {
        "termination_requested": True,
        "request_recorded": recorded,
        "agent_id": identity["agent_id"],
        "instance_id": identity["subagent_instance_id"],
        "result_status": identity["state"],
        "termination_requested_at": requested_at,
    }
    print(json.dumps(result, sort_keys=True))
    return result


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    records = event.get("Records")
    if not isinstance(records, list) or not records:
        raise ValueError("S3 event must contain at least one record")
    return {"results": [_handle_record(record) for record in records]}
