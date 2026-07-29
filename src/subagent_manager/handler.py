"""Launch subagent EC2 instances and reconcile their termination events."""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError


_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_serializer = TypeSerializer()
_clients: dict[str, Any] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _client(name: str) -> Any:
    if name not in _clients:
        if name == "table":
            _clients[name] = boto3.resource("dynamodb").Table(os.environ["STATE_TABLE_NAME"])
        else:
            _clients[name] = boto3.client(name)
    return _clients[name]


def _ddb_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: _serializer.serialize(value) for key, value in item.items()}


def _response(status_code: int, **body: Any) -> dict[str, Any]:
    return {"statusCode": status_code, "body": body}


def _validate_id(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not _ID_PATTERN.fullmatch(value):
        raise ValueError(
            f"{field_name} must be 1-128 characters using letters, numbers, '.', '_', ':', or '-'"
        )
    return value


def _agent_key(orchestrator_id: str, agent_id: str) -> dict[str, str]:
    return {
        "pk": f"ORCHESTRATOR#{orchestrator_id}",
        "sk": f"AGENT#{agent_id}",
    }


def _counter_key(orchestrator_id: str) -> dict[str, str]:
    return {
        "pk": f"ORCHESTRATOR#{orchestrator_id}",
        "sk": "COUNTER",
    }


def _audit(event_name: str, record: dict[str, Any]) -> None:
    orchestrator_id = record["orchestrator_id"]
    agent_id = record["agent_id"]
    key = (
        f"orchestrators/{orchestrator_id}/agents/{agent_id}/"
        f"{event_name}-{uuid.uuid4()}.json"
    )
    _client("s3").put_object(
        Bucket=os.environ["AUDIT_BUCKET_NAME"],
        Key=key,
        Body=json.dumps(record, sort_keys=True, default=str).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256",
    )


def _existing_agent(orchestrator_id: str, agent_id: str) -> dict[str, Any] | None:
    result = _client("table").get_item(
        Key=_agent_key(orchestrator_id, agent_id),
        ConsistentRead=True,
    )
    return result.get("Item")


def _reserve_slot(orchestrator_id: str, agent_id: str, created_at: str) -> bool:
    table_name = os.environ["STATE_TABLE_NAME"]
    limit = int(os.environ.get("MAX_ACTIVE_SUBAGENTS", "8"))
    agent = {
        **_agent_key(orchestrator_id, agent_id),
        "orchestrator_id": orchestrator_id,
        "agent_id": agent_id,
        "ami_id": os.environ.get("SUBAGENT_AMI_ID", "unknown"),
        "instance_type": os.environ.get("SUBAGENT_INSTANCE_TYPE", "t3.large"),
        "ttl_seconds": int(os.environ.get("SUBAGENT_TTL_SECONDS", "1800")),
        "active": True,
        "state": "PROVISIONING",
        "created_at": created_at,
    }
    counter_key = _counter_key(orchestrator_id)

    try:
        _client("dynamodb").transact_write_items(
            TransactItems=[
                {
                    "Update": {
                        "TableName": table_name,
                        "Key": _ddb_item(counter_key),
                        "UpdateExpression": (
                            "SET active_count = if_not_exists(active_count, :zero) + :one, "
                            "updated_at = :now"
                        ),
                        "ConditionExpression": (
                            "attribute_not_exists(active_count) OR active_count < :limit"
                        ),
                        "ExpressionAttributeValues": _ddb_item(
                            {
                                ":zero": 0,
                                ":one": 1,
                                ":limit": limit,
                                ":now": created_at,
                            }
                        ),
                    }
                },
                {
                    "Put": {
                        "TableName": table_name,
                        "Item": _ddb_item(agent),
                        "ConditionExpression": "attribute_not_exists(pk)",
                    }
                },
            ]
        )
        return True
    except ClientError as error:
        if error.response["Error"]["Code"] == "TransactionCanceledException":
            return False
        raise


def _release_failed_launch(
    orchestrator_id: str,
    agent_id: str,
    failed_at: str,
    reason: str,
) -> None:
    table_name = os.environ["STATE_TABLE_NAME"]
    _client("dynamodb").transact_write_items(
        TransactItems=[
            {
                "Update": {
                    "TableName": table_name,
                    "Key": _ddb_item(_counter_key(orchestrator_id)),
                    "UpdateExpression": "SET active_count = active_count - :one, updated_at = :now",
                    "ConditionExpression": "active_count > :zero",
                    "ExpressionAttributeValues": _ddb_item(
                        {":one": 1, ":zero": 0, ":now": failed_at}
                    ),
                }
            },
            {
                "Update": {
                    "TableName": table_name,
                    "Key": _ddb_item(_agent_key(orchestrator_id, agent_id)),
                    "UpdateExpression": (
                        "SET active = :false, #state = :failed, failed_at = :now, "
                        "failure_reason = :reason"
                    ),
                    "ConditionExpression": "active = :true",
                    "ExpressionAttributeNames": {"#state": "state"},
                    "ExpressionAttributeValues": _ddb_item(
                        {
                            ":false": False,
                            ":true": True,
                            ":failed": "LAUNCH_FAILED",
                            ":now": failed_at,
                            ":reason": reason[:500],
                        }
                    ),
                }
            },
        ]
    )


def _mark_launch_unknown(
    orchestrator_id: str,
    agent_id: str,
    failed_at: str,
    reason: str,
) -> None:
    """Retain the slot when EC2 may have accepted a request that timed out."""
    _client("table").update_item(
        Key=_agent_key(orchestrator_id, agent_id),
        UpdateExpression=(
            "SET #state = :unknown, failed_at = :now, failure_reason = :reason"
        ),
        ConditionExpression="active = :true",
        ExpressionAttributeNames={"#state": "state"},
        ExpressionAttributeValues={
            ":unknown": "LAUNCH_OUTCOME_UNKNOWN",
            ":now": failed_at,
            ":reason": reason[:500],
            ":true": True,
        },
    )


def _subagent_user_data(agent_id: str, ttl_seconds: int) -> str:
    return f"""#!/bin/bash
set -euo pipefail
echo "subagent_id={agent_id}" > /var/log/subagent-bootstrap.log
echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /var/log/subagent-bootstrap.log
sleep {ttl_seconds}
shutdown -h now
"""


def _launch_instance(orchestrator_id: str, agent_id: str) -> str:
    ttl_seconds = int(os.environ.get("SUBAGENT_TTL_SECONDS", "1800"))
    response = _client("ec2").run_instances(
        ImageId=os.environ["SUBAGENT_AMI_ID"],
        InstanceType=os.environ.get("SUBAGENT_INSTANCE_TYPE", "t3.large"),
        MinCount=1,
        MaxCount=1,
        ClientToken=agent_id,
        IamInstanceProfile={"Name": os.environ["SUBAGENT_INSTANCE_PROFILE_NAME"]},
        NetworkInterfaces=[
            {
                "AssociatePublicIpAddress": True,
                "DeviceIndex": 0,
                "Groups": [os.environ["SUBAGENT_SECURITY_GROUP_ID"]],
                "SubnetId": os.environ["SUBAGENT_SUBNET_ID"],
            }
        ],
        InstanceInitiatedShutdownBehavior="terminate",
        UserData=_subagent_user_data(agent_id, ttl_seconds),
        MetadataOptions={
            "HttpEndpoint": "enabled",
            "HttpTokens": "required",
            "HttpPutResponseHopLimit": 1,
        },
        TagSpecifications=[
            {
                "ResourceType": "instance",
                "Tags": [
                    {"Key": "Name", "Value": f"subagent-{agent_id[:16]}"},
                    {"Key": "ManagedBy", "Value": "subagent-manager"},
                    {"Key": "OrchestratorId", "Value": orchestrator_id},
                    {"Key": "AgentId", "Value": agent_id},
                ],
            },
            {
                "ResourceType": "volume",
                "Tags": [
                    {"Key": "ManagedBy", "Value": "subagent-manager"},
                    {"Key": "AgentId", "Value": agent_id},
                ],
            },
        ],
    )
    return response["Instances"][0]["InstanceId"]


def _mark_launched(
    orchestrator_id: str,
    agent_id: str,
    instance_id: str,
    launched_at: str,
) -> None:
    _client("table").update_item(
        Key=_agent_key(orchestrator_id, agent_id),
        UpdateExpression=(
            "SET instance_id = :instance_id, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk, "
            "#state = :running, launched_at = :now"
        ),
        ConditionExpression="active = :true",
        ExpressionAttributeNames={"#state": "state"},
        ExpressionAttributeValues={
            ":instance_id": instance_id,
            ":gsi1pk": f"INSTANCE#{instance_id}",
            ":gsi1sk": "AGENT",
            ":running": "RUNNING",
            ":now": launched_at,
            ":true": True,
        },
    )


def _active_count(orchestrator_id: str) -> int:
    result = _client("table").get_item(
        Key=_counter_key(orchestrator_id),
        ConsistentRead=True,
        ProjectionExpression="active_count",
    )
    return int(result.get("Item", {}).get("active_count", Decimal(0)))


def _spawn(event: dict[str, Any]) -> dict[str, Any]:
    try:
        orchestrator_id = _validate_id(event.get("orchestrator_id"), "orchestrator_id")
        agent_id = _validate_id(event.get("request_id") or str(uuid.uuid4()), "request_id")
    except ValueError as error:
        return _response(400, accepted=False, error=str(error))

    existing = _existing_agent(orchestrator_id, agent_id)
    if existing:
        return _response(
            200,
            accepted=existing.get("state") in {"PROVISIONING", "RUNNING"},
            idempotent_replay=True,
            orchestrator_id=orchestrator_id,
            agent_id=agent_id,
            instance_id=existing.get("instance_id"),
            state=existing.get("state"),
        )

    created_at = _now()
    if not _reserve_slot(orchestrator_id, agent_id, created_at):
        existing = _existing_agent(orchestrator_id, agent_id)
        if existing:
            return _response(
                200,
                accepted=existing.get("state") in {"PROVISIONING", "RUNNING"},
                idempotent_replay=True,
                orchestrator_id=orchestrator_id,
                agent_id=agent_id,
                instance_id=existing.get("instance_id"),
                state=existing.get("state"),
            )
        return _response(
            429,
            accepted=False,
            error="active_subagent_limit_reached",
            orchestrator_id=orchestrator_id,
            max_active_subagents=int(os.environ.get("MAX_ACTIVE_SUBAGENTS", "8")),
        )

    try:
        instance_id = _launch_instance(orchestrator_id, agent_id)
    except ClientError as error:
        failed_at = _now()
        _release_failed_launch(orchestrator_id, agent_id, failed_at, str(error))
        _audit(
            "launch-failed",
            {
                "event": "launch_failed",
                "orchestrator_id": orchestrator_id,
                "agent_id": agent_id,
                "failed_at": failed_at,
                "reason": str(error)[:500],
            },
        )
        raise
    except Exception as error:
        failed_at = _now()
        _mark_launch_unknown(orchestrator_id, agent_id, failed_at, str(error))
        _audit(
            "launch-unknown",
            {
                "event": "launch_outcome_unknown",
                "orchestrator_id": orchestrator_id,
                "agent_id": agent_id,
                "failed_at": failed_at,
                "reason": str(error)[:500],
            },
        )
        raise

    try:
        launched_at = _now()
        _mark_launched(orchestrator_id, agent_id, instance_id, launched_at)
    except Exception as error:
        failed_at = _now()
        try:
            _client("ec2").terminate_instances(InstanceIds=[instance_id])
        except Exception:
            _mark_launch_unknown(orchestrator_id, agent_id, failed_at, str(error))
            raise
        _release_failed_launch(orchestrator_id, agent_id, failed_at, str(error))
        _audit(
            "launch-failed",
            {
                "event": "launched_instance_rolled_back",
                "orchestrator_id": orchestrator_id,
                "agent_id": agent_id,
                "instance_id": instance_id,
                "failed_at": failed_at,
                "reason": str(error)[:500],
            },
        )
        raise

    record = {
        "event": "instance_created",
        "orchestrator_id": orchestrator_id,
        "agent_id": agent_id,
        "instance_id": instance_id,
        "ami_id": os.environ.get("SUBAGENT_AMI_ID", "unknown"),
        "instance_type": os.environ.get("SUBAGENT_INSTANCE_TYPE", "t3.large"),
        "ttl_seconds": int(os.environ.get("SUBAGENT_TTL_SECONDS", "1800")),
        "created_at": created_at,
        "launched_at": launched_at,
    }
    _audit("created", record)
    return _response(
        201,
        accepted=True,
        orchestrator_id=orchestrator_id,
        agent_id=agent_id,
        instance_id=instance_id,
        active_count=_active_count(orchestrator_id),
    )


def _find_agent_by_instance(instance_id: str) -> dict[str, Any] | None:
    result = _client("table").query(
        IndexName="instance-index",
        KeyConditionExpression="gsi1pk = :instance",
        ExpressionAttributeValues={":instance": f"INSTANCE#{instance_id}"},
        Limit=1,
    )
    items = result.get("Items", [])
    return items[0] if items else None


def _handle_termination(event: dict[str, Any]) -> dict[str, Any]:
    instance_id = event["detail"]["instance-id"]
    agent = _find_agent_by_instance(instance_id)
    if not agent:
        return {"ignored": True, "reason": "instance_not_managed", "instance_id": instance_id}

    terminated_at = event.get("time") or _now()
    orchestrator_id = agent["orchestrator_id"]
    agent_id = agent["agent_id"]
    table_name = os.environ["STATE_TABLE_NAME"]
    try:
        _client("dynamodb").transact_write_items(
            TransactItems=[
                {
                    "Update": {
                        "TableName": table_name,
                        "Key": _ddb_item(_counter_key(orchestrator_id)),
                        "UpdateExpression": (
                            "SET active_count = active_count - :one, updated_at = :now"
                        ),
                        "ConditionExpression": "active_count > :zero",
                        "ExpressionAttributeValues": _ddb_item(
                            {":one": 1, ":zero": 0, ":now": terminated_at}
                        ),
                    }
                },
                {
                    "Update": {
                        "TableName": table_name,
                        "Key": _ddb_item(_agent_key(orchestrator_id, agent_id)),
                        "UpdateExpression": (
                            "SET active = :false, #state = :terminated, terminated_at = :now"
                        ),
                        "ConditionExpression": "active = :true",
                        "ExpressionAttributeNames": {"#state": "state"},
                        "ExpressionAttributeValues": _ddb_item(
                            {
                                ":false": False,
                                ":true": True,
                                ":terminated": "TERMINATED",
                                ":now": terminated_at,
                            }
                        ),
                    }
                },
            ]
        )
    except ClientError as error:
        if error.response["Error"]["Code"] == "TransactionCanceledException":
            return {"ignored": True, "reason": "already_reconciled", "instance_id": instance_id}
        raise

    _audit(
        "terminated",
        {
            "event": "instance_terminated",
            "orchestrator_id": orchestrator_id,
            "agent_id": agent_id,
            "instance_id": instance_id,
            "created_at": agent.get("created_at"),
            "launched_at": agent.get("launched_at"),
            "terminated_at": terminated_at,
        },
    )
    return {
        "reconciled": True,
        "orchestrator_id": orchestrator_id,
        "agent_id": agent_id,
        "instance_id": instance_id,
    }


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    if (
        event.get("source") == "aws.ec2"
        and event.get("detail-type") == "EC2 Instance State-change Notification"
        and event.get("detail", {}).get("state") == "terminated"
    ):
        return _handle_termination(event)

    if event.get("action", "spawn") != "spawn":
        return _response(400, accepted=False, error="unsupported_action")
    return _spawn(event)
