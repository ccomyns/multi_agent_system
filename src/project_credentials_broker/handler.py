"""Issue short-lived AWS credentials scoped to one assigned S3 project."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from typing import Any

import boto3


JOB_ID_PATTERN = re.compile(r"^job_[a-z0-9]{4,12}_[0-9a-f]{8}$")
INSTANCE_ID_PATTERN = re.compile(r"^i-[0-9a-f]{8,17}$")
MAX_PROJECT_NAME_LENGTH = 80
PROJECT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.:=+@ -]+$")

_clients: dict[str, Any] = {}


class BrokerError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def _client(name: str) -> Any:
    if name not in _clients:
        _clients[name] = boto3.client(name)
    return _clients[name]


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise BrokerError(
            500,
            "broker_not_configured",
            f"The project credential broker is missing {name}.",
        )
    return value


def _string_attribute(item: dict[str, Any] | None, name: str) -> str | None:
    value = (item or {}).get(name)
    if not isinstance(value, dict) or set(value) != {"S"}:
        return None
    text = value.get("S")
    return text if isinstance(text, str) else None


def _get_item(table_name: str, key: dict[str, dict[str, str]]) -> dict[str, Any] | None:
    response = _client("dynamodb").get_item(
        TableName=table_name,
        Key=key,
        ConsistentRead=True,
    )
    item = response.get("Item")
    return item if isinstance(item, dict) else None


def _parse_request(event: Any) -> tuple[str, str]:
    if not isinstance(event, dict):
        raise BrokerError(400, "invalid_request", "The broker request must be an object.")
    forbidden = {"bucket", "prefix", "project", "project_name"}
    if forbidden.intersection(event):
        raise BrokerError(
            400,
            "project_scope_not_accepted",
            "Project scope is derived from the trusted job assignment, not broker input.",
        )
    job_id = event.get("job_id")
    instance_id = event.get("orchestrator_instance_id")
    if not isinstance(job_id, str) or not JOB_ID_PATTERN.fullmatch(job_id):
        raise BrokerError(400, "invalid_job_id", "job_id is invalid.")
    if not isinstance(instance_id, str) or not INSTANCE_ID_PATTERN.fullmatch(instance_id):
        raise BrokerError(
            400,
            "invalid_orchestrator_instance_id",
            "orchestrator_instance_id is invalid.",
        )
    return job_id, instance_id


def _assigned_project(job_id: str, instance_id: str) -> str:
    jobs_table = _required_environment("JOBS_TABLE_NAME")
    assignments_table = _required_environment(
        "GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME"
    )
    active_lock = _get_item(jobs_table, {"pk": {"S": "ACTIVE_JOB"}})
    job = _get_item(jobs_table, {"pk": {"S": f"JOB#{job_id}"}})
    assignment = _get_item(assignments_table, {"job_id": {"S": job_id}})

    if _string_attribute(active_lock, "active_job_id") != f"JOB#{job_id}":
        raise BrokerError(
            403,
            "job_not_active",
            "The requested job does not own the active-job lock.",
        )
    if _string_attribute(job, "job_id") != job_id:
        raise BrokerError(404, "job_not_found", "The requested job was not found.")
    if _string_attribute(job, "type_of_job") != "software_builder":
        raise BrokerError(
            403,
            "wrong_job_type",
            "Project credentials are only available to software-builder jobs.",
        )
    if _string_attribute(job, "status") != "running":
        raise BrokerError(
            409,
            "job_not_running",
            "Project credentials are only available while the assigned job is running.",
        )
    if _string_attribute(job, "orchestrator_instance_id") != instance_id:
        raise BrokerError(
            403,
            "orchestrator_mismatch",
            "The requesting orchestrator is not assigned to this job.",
        )
    if _string_attribute(assignment, "job_id") != job_id:
        raise BrokerError(
            409,
            "project_not_assigned",
            "The software-builder job has no global-memory project assignment.",
        )

    project_name = _string_attribute(assignment, "global_memory_project_name")
    if (
        not project_name
        or project_name != project_name.strip()
        or len(project_name) > MAX_PROJECT_NAME_LENGTH
        or project_name in {".", ".."}
        or not PROJECT_NAME_PATTERN.fullmatch(project_name)
    ):
        raise BrokerError(
            409,
            "project_not_assigned",
            "The software-builder job has no valid global-memory project assignment.",
        )
    return project_name


def _expiration(value: Any) -> str:
    if not isinstance(value, datetime):
        raise BrokerError(
            502,
            "invalid_sts_response",
            "AWS STS returned an invalid credential expiration.",
        )
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _issue_credentials(job_id: str, project_name: str) -> dict[str, Any]:
    role_arn = _required_environment("PROJECT_WORKSPACE_ROLE_ARN")
    bucket = _required_environment("GLOBAL_MEMORY_BUCKET_NAME")
    response = _client("sts").assume_role(
        RoleArn=role_arn,
        RoleSessionName=f"project-{job_id.removeprefix('job_')}",
        DurationSeconds=3600,
        Tags=[{"Key": "ProjectName", "Value": project_name}],
    )
    credentials = response.get("Credentials")
    if not isinstance(credentials, dict):
        raise BrokerError(
            502,
            "invalid_sts_response",
            "AWS STS returned no project credentials.",
        )
    access_key_id = credentials.get("AccessKeyId")
    secret_access_key = credentials.get("SecretAccessKey")
    session_token = credentials.get("SessionToken")
    if not all(isinstance(value, str) and value for value in (
        access_key_id,
        secret_access_key,
        session_token,
    )):
        raise BrokerError(
            502,
            "invalid_sts_response",
            "AWS STS returned invalid project credentials.",
        )

    prefix = f"{project_name}/"
    return {
        "credentials": {
            "access_key_id": access_key_id,
            "secret_access_key": secret_access_key,
            "session_token": session_token,
            "expiration": _expiration(credentials.get("Expiration")),
        },
        "project": {
            "name": project_name,
            "bucket": bucket,
            "prefix": prefix,
            "s3_uri": f"s3://{bucket}/{prefix}",
        },
    }


def lambda_handler(event: Any, _context: Any) -> dict[str, Any]:
    try:
        job_id, instance_id = _parse_request(event)
        project_name = _assigned_project(job_id, instance_id)
        return {
            "statusCode": 200,
            "body": _issue_credentials(job_id, project_name),
        }
    except BrokerError as error:
        print(json.dumps({
            "event": "project_credential_request_failed",
            "code": error.code,
            "message": str(error),
        }, sort_keys=True))
        return {
            "statusCode": error.status_code,
            "body": {"error": error.code, "message": str(error)},
        }
    except Exception as error:
        print(json.dumps({
            "event": "project_credential_request_failed",
            "error_type": type(error).__name__,
        }, sort_keys=True))
        return {
            "statusCode": 500,
            "body": {
                "error": "internal_error",
                "message": "Project credentials could not be issued.",
            },
        }
