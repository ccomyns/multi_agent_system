"""Request and validate one-repository GitHub credentials from the trusted broker."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import boto3


REPOSITORY_COMPONENT_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
MIN_INSTALLATION_TOKEN_LENGTH = 20
MAX_INSTALLATION_TOKEN_LENGTH = 8192


@dataclass(frozen=True)
class RepositoryCredentials:
    token: str
    expires_at: str
    repository_id: int
    repository_full_name: str

    @property
    def owner(self) -> str:
        return self.repository_full_name.split("/", 1)[0]

    @property
    def name(self) -> str:
        return self.repository_full_name.split("/", 1)[1]


def _decode_lambda_payload(response: dict[str, Any]) -> dict[str, Any]:
    stream = response.get("Payload")
    if stream is None or not hasattr(stream, "read"):
        raise RuntimeError("the GitHub token broker returned no payload")
    raw = stream.read()
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    try:
        payload = json.loads(raw)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("the GitHub token broker returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError("the GitHub token broker returned an invalid response")
    return payload


def _response_body(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    status_code = payload.get("statusCode")
    body = payload.get("body")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError as error:
            raise RuntimeError("the GitHub token broker returned an invalid body") from error
    if not isinstance(status_code, int) or not isinstance(body, dict):
        raise RuntimeError("the GitHub token broker returned an invalid response shape")
    return status_code, body


def _validate_credentials(body: dict[str, Any]) -> RepositoryCredentials:
    token = body.get("token")
    expires_at = body.get("expires_at")
    repository = body.get("repository")
    permissions = body.get("permissions")
    if (
        not isinstance(token, str)
        or not token.startswith("ghs_")
        or not MIN_INSTALLATION_TOKEN_LENGTH <= len(token) <= MAX_INSTALLATION_TOKEN_LENGTH
        or not token.isascii()
        or any(not 0x21 <= ord(character) <= 0x7E for character in token)
    ):
        raise RuntimeError("the GitHub token broker returned an invalid token")
    if not isinstance(expires_at, str):
        raise RuntimeError("the GitHub token broker returned an invalid expiry")
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError("the GitHub token broker returned an invalid expiry") from error
    if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc) + timedelta(minutes=1):
        raise RuntimeError("the GitHub token broker returned an expired token")
    if not isinstance(repository, dict):
        raise RuntimeError("the GitHub token broker returned no repository")
    repository_id = repository.get("id")
    full_name = repository.get("fullName")
    if not isinstance(repository_id, int) or isinstance(repository_id, bool) or repository_id <= 0:
        raise RuntimeError("the GitHub token broker returned an invalid repository id")
    if not isinstance(full_name, str):
        raise RuntimeError("the GitHub token broker returned an invalid repository name")
    parts = full_name.split("/")
    if (
        len(parts) != 2
        or any(part in {"", ".", ".."} for part in parts)
        or any(not REPOSITORY_COMPONENT_PATTERN.fullmatch(part) for part in parts)
    ):
        raise RuntimeError("the GitHub token broker returned an invalid repository name")
    if permissions != {"contents": "write", "metadata": "read"}:
        raise RuntimeError("the GitHub token broker returned unexpected permissions")
    return RepositoryCredentials(
        token=token,
        expires_at=expires_at,
        repository_id=repository_id,
        repository_full_name=full_name,
    )


def request_repository_credentials(
    *,
    region: str,
    function_name: str,
    job_id: str,
    orchestrator_instance_id: str,
    lambda_client: Any | None = None,
) -> RepositoryCredentials:
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
        raise RuntimeError("the GitHub token broker failed")
    status_code, body = _response_body(payload)
    if status_code != 200:
        code = body.get("error")
        message = body.get("message")
        safe_code = code if isinstance(code, str) else "request_failed"
        safe_message = message if isinstance(message, str) else "credential request failed"
        raise RuntimeError(f"GitHub token broker rejected the request ({safe_code}): {safe_message}")
    return _validate_credentials(body)
