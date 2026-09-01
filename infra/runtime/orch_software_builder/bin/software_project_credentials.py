#!/usr/bin/env python3
"""Refresh AWS credentials scoped to the current job's assigned S3 project."""

from __future__ import annotations

import json
import os
import re
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import boto3


PROJECT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.:=+@ -]{1,80}$")
BUCKET_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")


@dataclass(frozen=True)
class ProjectCredentials:
    access_key_id: str
    secret_access_key: str
    session_token: str
    expiration: str
    project_name: str
    bucket: str
    prefix: str
    s3_uri: str


def _decode_lambda_payload(response: dict[str, Any]) -> dict[str, Any]:
    stream = response.get("Payload")
    if stream is None or not hasattr(stream, "read"):
        raise RuntimeError("the project credential broker returned no payload")
    raw = stream.read()
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    try:
        payload = json.loads(raw)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("the project credential broker returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError("the project credential broker returned an invalid response")
    return payload


def _response_body(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    status_code = payload.get("statusCode")
    body = payload.get("body")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError as error:
            raise RuntimeError("the project credential broker returned an invalid body") from error
    if not isinstance(status_code, int) or not isinstance(body, dict):
        raise RuntimeError("the project credential broker returned an invalid response shape")
    return status_code, body


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or "\n" in value or "\r" in value:
        raise RuntimeError(f"the project credential broker returned an invalid {label}")
    return value


def _validate_credentials(body: dict[str, Any]) -> ProjectCredentials:
    credentials = body.get("credentials")
    project = body.get("project")
    if not isinstance(credentials, dict) or not isinstance(project, dict):
        raise RuntimeError("the project credential broker returned an invalid response")

    access_key_id = _required_string(credentials.get("access_key_id"), "access key")
    secret_access_key = _required_string(
        credentials.get("secret_access_key"), "secret access key"
    )
    session_token = _required_string(credentials.get("session_token"), "session token")
    expiration = _required_string(credentials.get("expiration"), "expiration")
    try:
        expiry = datetime.fromisoformat(expiration.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError("the project credential broker returned an invalid expiration") from error
    if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc) + timedelta(minutes=1):
        raise RuntimeError("the project credential broker returned expired credentials")

    project_name = _required_string(project.get("name"), "project name")
    bucket = _required_string(project.get("bucket"), "bucket")
    prefix = _required_string(project.get("prefix"), "prefix")
    s3_uri = _required_string(project.get("s3_uri"), "S3 URI")
    if (
        not PROJECT_NAME_PATTERN.fullmatch(project_name)
        or project_name.strip() != project_name
        or project_name in {".", ".."}
    ):
        raise RuntimeError("the project credential broker returned an invalid project name")
    if not BUCKET_NAME_PATTERN.fullmatch(bucket):
        raise RuntimeError("the project credential broker returned an invalid bucket")
    if prefix != f"{project_name}/" or s3_uri != f"s3://{bucket}/{prefix}":
        raise RuntimeError("the project credential broker returned inconsistent project scope")

    return ProjectCredentials(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        session_token=session_token,
        expiration=expiry.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        project_name=project_name,
        bucket=bucket,
        prefix=prefix,
        s3_uri=s3_uri,
    )


def request_project_credentials(
    *,
    region: str,
    function_name: str,
    job_id: str,
    orchestrator_instance_id: str,
    allow_unassigned: bool = False,
    lambda_client: Any | None = None,
) -> ProjectCredentials | None:
    client = lambda_client or boto3.client("lambda", region_name=region)
    response = client.invoke(
        FunctionName=function_name,
        InvocationType="RequestResponse",
        Payload=json.dumps(
            {
                "job_id": job_id,
                "orchestrator_instance_id": orchestrator_instance_id,
            },
            separators=(",", ":"),
        ).encode("utf-8"),
    )
    payload = _decode_lambda_payload(response)
    if response.get("FunctionError"):
        raise RuntimeError("the project credential broker failed")
    status_code, body = _response_body(payload)
    if (
        allow_unassigned
        and status_code == 409
        and body.get("error") == "project_not_assigned"
    ):
        return None
    if status_code != 200:
        code = body.get("error")
        message = body.get("message")
        safe_code = code if isinstance(code, str) else "request_failed"
        safe_message = message if isinstance(message, str) else "credential request failed"
        raise RuntimeError(
            f"Project credential broker rejected the request ({safe_code}): {safe_message}"
        )
    return _validate_credentials(body)


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


@contextmanager
def base_role_environment() -> Iterator[None]:
    names = (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_CONFIG_FILE",
        "AWS_SHARED_CREDENTIALS_FILE",
        "AWS_EC2_METADATA_DISABLED",
    )
    original = {name: os.environ.get(name) for name in names}
    try:
        for name in names:
            os.environ.pop(name, None)
        yield
    finally:
        for name, value in original.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def main() -> int:
    try:
        with base_role_environment():
            credentials = request_project_credentials(
                region=_required_environment("AWS_REGION"),
                function_name=_required_environment(
                    "PROJECT_CREDENTIALS_BROKER_FUNCTION_NAME"
                ),
                job_id=_required_environment("JOB_ID"),
                orchestrator_instance_id=_required_environment(
                    "ORCHESTRATOR_INSTANCE_ID"
                ),
            )
        if credentials is None:
            return 1
        json.dump(
            {
                "Version": 1,
                "AccessKeyId": credentials.access_key_id,
                "SecretAccessKey": credentials.secret_access_key,
                "SessionToken": credentials.session_token,
                "Expiration": credentials.expiration,
            },
            sys.stdout,
            separators=(",", ":"),
        )
        sys.stdout.write("\n")
        sys.stdout.flush()
        return 0
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
