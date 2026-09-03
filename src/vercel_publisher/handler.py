"""Publish one trusted software-builder Git commit to Vercel."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from hashlib import sha256
from typing import Any
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

import boto3


VERCEL_API_ROOT = "https://api.vercel.com"
VERCEL_USER_AGENT = "multi-agent-research-system-vercel-publisher"
JOB_ID_PATTERN = re.compile(r"^job_[a-z0-9]{4,12}_[0-9a-f]{8}$")
INSTANCE_ID_PATTERN = re.compile(r"^i-[0-9a-f]{8,17}$")
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
DEPLOYMENT_ID_PATTERN = re.compile(r"^dpl_[A-Za-z0-9]+$")
BRANCH_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
TEAM_ID_PATTERN = re.compile(r"^team_[A-Za-z0-9]+$")
ORGANIZATION_PATTERN = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$"
)
PROJECT_NAME_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$")
MAX_RESPONSE_BYTES = 1024 * 1024
TERMINAL_STATES = {"CANCELED", "ERROR", "READY"}

_clients: dict[str, Any] = {}
_token_cache: dict[str, str] = {}


class PublisherError(RuntimeError):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


@dataclass(frozen=True)
class PublishRequest:
    action: str
    job_id: str
    instance_id: str
    branch: str
    commit_sha: str
    deployment_id: str | None = None


@dataclass(frozen=True)
class RepositoryAssignment:
    repository_id: int
    full_name: str

    @property
    def name(self) -> str:
        return self.full_name.split("/", 1)[1]


@dataclass(frozen=True)
class Configuration:
    jobs_table: str
    assignments_table: str
    organization: str
    team_id: str
    token_parameter: str


def _client(name: str) -> Any:
    if name not in _clients:
        _clients[name] = boto3.client(name)
    return _clients[name]


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise PublisherError(
            500,
            "publisher_not_configured",
            f"The Vercel publisher is missing {name}.",
        )
    return value


def _configuration() -> Configuration:
    organization = _required_environment("GITHUB_ORGANIZATION")
    team_id = _required_environment("VERCEL_TEAM_ID")
    token_parameter = _required_environment(
        "VERCEL_ACCESS_TOKEN_SSM_PARAMETER_NAME"
    )
    if not ORGANIZATION_PATTERN.fullmatch(organization):
        raise PublisherError(
            500,
            "publisher_not_configured",
            "GITHUB_ORGANIZATION is invalid.",
        )
    if not TEAM_ID_PATTERN.fullmatch(team_id):
        raise PublisherError(
            500,
            "publisher_not_configured",
            "VERCEL_TEAM_ID is invalid.",
        )
    if not token_parameter.startswith("/") or len(token_parameter) > 2048:
        raise PublisherError(
            500,
            "publisher_not_configured",
            "VERCEL_ACCESS_TOKEN_SSM_PARAMETER_NAME is invalid.",
        )
    return Configuration(
        jobs_table=_required_environment("JOBS_TABLE_NAME"),
        assignments_table=_required_environment(
            "GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME"
        ),
        organization=organization,
        team_id=team_id,
        token_parameter=token_parameter,
    )


def _valid_branch(branch: Any) -> bool:
    return (
        isinstance(branch, str)
        and bool(BRANCH_PATTERN.fullmatch(branch))
        and ".." not in branch
        and "//" not in branch
        and "@{" not in branch
        and not branch.endswith(("/", ".", ".lock"))
    )


def _parse_request(event: Any) -> PublishRequest:
    if not isinstance(event, dict):
        raise PublisherError(400, "invalid_request", "The request must be an object.")

    forbidden = {
        "environment",
        "environment_variables",
        "project",
        "project_id",
        "project_name",
        "repository",
        "repository_id",
        "repository_name",
        "team_id",
        "token",
    }
    if forbidden.intersection(event):
        raise PublisherError(
            400,
            "deployment_scope_not_accepted",
            "Deployment scope is derived from trusted configuration and job records.",
        )

    action = event.get("action")
    allowed = {
        "publish": {
            "action",
            "job_id",
            "orchestrator_instance_id",
            "branch",
            "commit_sha",
        },
        "status": {
            "action",
            "job_id",
            "orchestrator_instance_id",
            "branch",
            "commit_sha",
            "deployment_id",
        },
    }
    if action not in allowed:
        raise PublisherError(
            400,
            "invalid_action",
            "action must be publish or status.",
        )
    if set(event) != allowed[action]:
        raise PublisherError(
            400,
            "invalid_request",
            f"The {action} request has missing or unexpected fields.",
        )

    job_id = event.get("job_id")
    instance_id = event.get("orchestrator_instance_id")
    branch = event.get("branch")
    commit_sha = event.get("commit_sha")
    deployment_id = event.get("deployment_id")
    if not isinstance(job_id, str) or not JOB_ID_PATTERN.fullmatch(job_id):
        raise PublisherError(400, "invalid_job_id", "job_id is invalid.")
    if not isinstance(instance_id, str) or not INSTANCE_ID_PATTERN.fullmatch(instance_id):
        raise PublisherError(
            400,
            "invalid_orchestrator_instance_id",
            "orchestrator_instance_id is invalid.",
        )
    if not _valid_branch(branch):
        raise PublisherError(400, "invalid_branch", "branch is invalid.")
    if not isinstance(commit_sha, str) or not COMMIT_SHA_PATTERN.fullmatch(commit_sha):
        raise PublisherError(400, "invalid_commit_sha", "commit_sha is invalid.")
    if action == "status" and (
        not isinstance(deployment_id, str)
        or not DEPLOYMENT_ID_PATTERN.fullmatch(deployment_id)
    ):
        raise PublisherError(
            400,
            "invalid_deployment_id",
            "deployment_id is invalid.",
        )
    return PublishRequest(
        action=action,
        job_id=job_id,
        instance_id=instance_id,
        branch=branch,
        commit_sha=commit_sha,
        deployment_id=deployment_id,
    )


def _string_attribute(item: dict[str, Any] | None, name: str) -> str | None:
    value = (item or {}).get(name)
    if not isinstance(value, dict) or set(value) != {"S"}:
        return None
    text = value.get("S")
    return text if isinstance(text, str) else None


def _positive_integer_attribute(
    item: dict[str, Any] | None, name: str
) -> int | None:
    value = (item or {}).get(name)
    if not isinstance(value, dict) or set(value) != {"N"}:
        return None
    try:
        parsed = int(value["N"])
    except (KeyError, TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _get_item(table_name: str, key: dict[str, dict[str, str]]) -> dict[str, Any] | None:
    response = _client("dynamodb").get_item(
        TableName=table_name,
        Key=key,
        ConsistentRead=True,
    )
    item = response.get("Item")
    return item if isinstance(item, dict) else None


def _assigned_repository(
    request: PublishRequest, configuration: Configuration
) -> RepositoryAssignment:
    active_lock = _get_item(configuration.jobs_table, {"pk": {"S": "ACTIVE_JOB"}})
    job = _get_item(
        configuration.jobs_table,
        {"pk": {"S": f"JOB#{request.job_id}"}},
    )
    assignment = _get_item(
        configuration.assignments_table,
        {"job_id": {"S": request.job_id}},
    )

    if _string_attribute(active_lock, "active_job_id") != f"JOB#{request.job_id}":
        raise PublisherError(
            403,
            "job_not_active",
            "The requested job does not own the active-job lock.",
        )
    if _string_attribute(job, "job_id") != request.job_id:
        raise PublisherError(404, "job_not_found", "The requested job was not found.")
    if _string_attribute(job, "type_of_job") != "software_builder":
        raise PublisherError(
            403,
            "wrong_job_type",
            "Vercel publication is only available to software-builder jobs.",
        )
    if _string_attribute(job, "status") != "running":
        raise PublisherError(
            409,
            "job_not_running",
            "Vercel publication is only available while the job is running.",
        )
    if _string_attribute(job, "orchestrator_instance_id") != request.instance_id:
        raise PublisherError(
            403,
            "orchestrator_mismatch",
            "The requesting orchestrator is not assigned to this job.",
        )
    if _string_attribute(assignment, "job_id") != request.job_id:
        raise PublisherError(
            409,
            "repository_not_assigned",
            "The software-builder job has no trusted GitHub repository assignment.",
        )

    repository_id = _positive_integer_attribute(assignment, "github_repository_id")
    full_name = _string_attribute(assignment, "github_repository_full_name")
    if repository_id is None or not full_name:
        raise PublisherError(
            409,
            "repository_not_assigned",
            "The software-builder job has no valid GitHub repository assignment.",
        )
    parts = full_name.split("/")
    if (
        len(parts) != 2
        or parts[0].lower() != configuration.organization.lower()
        or not parts[1]
    ):
        raise PublisherError(
            403,
            "repository_outside_organization",
            "The assigned repository is outside the configured GitHub organization.",
        )
    return RepositoryAssignment(repository_id=repository_id, full_name=full_name)


def _vercel_token(parameter_name: str) -> str:
    if parameter_name not in _token_cache:
        response = _client("ssm").get_parameter(
            Name=parameter_name,
            WithDecryption=True,
        )
        parameter = response.get("Parameter")
        token = parameter.get("Value") if isinstance(parameter, dict) else None
        if (
            not isinstance(token, str)
            or len(token) < 20
            or len(token) > 512
            or any(character.isspace() for character in token)
        ):
            raise PublisherError(
                500,
                "vercel_token_unavailable",
                "The configured Vercel access-token parameter is empty or invalid.",
            )
        _token_cache[parameter_name] = token
    return _token_cache[parameter_name]


def _upstream_message(payload: Any, fallback: str) -> str:
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"][:500]
        if isinstance(payload.get("message"), str):
            return payload["message"][:500]
    return fallback


def _decode_json(raw: bytes) -> Any:
    if not raw:
        return None
    if len(raw) > MAX_RESPONSE_BYTES:
        raise PublisherError(
            502,
            "invalid_vercel_response",
            "Vercel returned an unexpectedly large response.",
        )
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PublisherError(
            502,
            "invalid_vercel_response",
            "Vercel returned an invalid response.",
        ) from error


def _vercel_json(
    method: str,
    path: str,
    token: str,
    team_id: str,
    *,
    query: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    allow_not_found: bool = False,
) -> Any:
    parameters = {"teamId": team_id, **(query or {})}
    url = f"{VERCEL_API_ROOT}{path}?{urllib_parse.urlencode(parameters)}"
    data = None
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    request = urllib_request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": VERCEL_USER_AGENT,
        },
    )
    try:
        with urllib_request.urlopen(request, timeout=12) as response:
            return _decode_json(response.read(MAX_RESPONSE_BYTES + 1))
    except urllib_error.HTTPError as error:
        payload = _decode_json(error.read(MAX_RESPONSE_BYTES + 1))
        if allow_not_found and error.code == 404:
            return None
        raise PublisherError(
            502,
            "vercel_rejected_request",
            _upstream_message(
                payload,
                f"Vercel rejected the request with HTTP {error.code}.",
            ),
        ) from error
    except (TimeoutError, urllib_error.URLError) as error:
        raise PublisherError(
            502,
            "vercel_unavailable",
            "The Vercel API could not be reached.",
        ) from error


def _project_name(repository: RepositoryAssignment) -> str:
    original = repository.name.lower()
    if PROJECT_NAME_PATTERN.fullmatch(original):
        return original
    normalized = re.sub(r"[^a-z0-9]+", "-", original).strip("-") or "site"
    digest = sha256(repository.full_name.lower().encode("utf-8")).hexdigest()[:8]
    prefix = normalized[: 100 - len(digest) - 1].rstrip("-") or "site"
    return f"{prefix}-{digest}"


def _project_id(
    project: Any,
    expected_name: str,
    repository: RepositoryAssignment,
    organization: str,
) -> str:
    if not isinstance(project, dict):
        raise PublisherError(
            502,
            "invalid_vercel_response",
            "Vercel returned an invalid project.",
        )
    project_id = project.get("id")
    link = project.get("link")
    if (
        not isinstance(project_id, str)
        or not project_id.startswith("prj_")
        or project.get("name") != expected_name
        or not isinstance(link, dict)
        or link.get("type") != "github"
        or str(link.get("repoId")) != str(repository.repository_id)
        or not isinstance(link.get("org"), str)
        or link["org"].lower() != organization.lower()
        or link.get("repo") not in {repository.name, repository.full_name}
    ):
        raise PublisherError(
            409,
            "vercel_project_scope_mismatch",
            "The Vercel project is not linked to the assigned GitHub repository.",
        )
    return project_id


def _get_or_create_project(
    token: str,
    configuration: Configuration,
    repository: RepositoryAssignment,
) -> tuple[str, str]:
    name = _project_name(repository)
    encoded_name = urllib_parse.quote(name, safe="")
    project = _vercel_json(
        "GET",
        f"/v9/projects/{encoded_name}",
        token,
        configuration.team_id,
        allow_not_found=True,
    )
    if project is None:
        project = _vercel_json(
            "POST",
            "/v11/projects",
            token,
            configuration.team_id,
            body={
                "name": name,
                "gitRepository": {
                    "type": "github",
                    "repo": repository.full_name,
                },
            },
        )
    return (
        _project_id(project, name, repository, configuration.organization),
        name,
    )


def _deployment_summary(
    deployment: Any,
    *,
    project_id: str,
    project_name: str,
    request: PublishRequest,
    require_git_source: bool,
) -> dict[str, Any]:
    if not isinstance(deployment, dict):
        raise PublisherError(
            502,
            "invalid_vercel_response",
            "Vercel returned an invalid deployment.",
        )
    deployment_id = deployment.get("id") or deployment.get("uid")
    ready_state = deployment.get("readyState") or deployment.get("state")
    returned_project_id = deployment.get("projectId")
    target = deployment.get("target")
    if (
        not isinstance(deployment_id, str)
        or not DEPLOYMENT_ID_PATTERN.fullmatch(deployment_id)
        or not isinstance(ready_state, str)
        or (returned_project_id is not None and returned_project_id != project_id)
        or (target is not None and target != "production")
    ):
        raise PublisherError(
            502,
            "invalid_vercel_response",
            "Vercel returned deployment metadata outside the requested project.",
        )

    git_source = deployment.get("gitSource")
    if require_git_source and (
        not isinstance(git_source, dict)
        or git_source.get("type") != "github"
        or git_source.get("sha") != request.commit_sha
        or git_source.get("ref") != request.branch
    ):
        raise PublisherError(
            409,
            "vercel_deployment_scope_mismatch",
            "The Vercel deployment does not match the requested Git commit.",
        )

    aliases: list[str] = []
    for value in deployment.get("alias") or []:
        candidate = value if isinstance(value, str) else None
        if isinstance(value, dict):
            candidate = value.get("domain")
        if (
            isinstance(candidate, str)
            and len(candidate) <= 253
            and re.fullmatch(r"[A-Za-z0-9.-]+", candidate)
            and candidate not in aliases
        ):
            aliases.append(candidate)
    preferred_alias = next(
        (alias for alias in aliases if alias.endswith(".vercel.app")),
        aliases[0] if aliases else None,
    )
    deployment_url = deployment.get("url")
    if not isinstance(deployment_url, str) or not re.fullmatch(
        r"[A-Za-z0-9.-]+", deployment_url
    ):
        deployment_url = None

    return {
        "id": deployment_id,
        "ready_state": ready_state,
        "terminal": ready_state in TERMINAL_STATES,
        "target": target or "production",
        "project_id": project_id,
        "project_name": project_name,
        "commit_sha": request.commit_sha,
        "branch": request.branch,
        "deployment_url": (
            f"https://{deployment_url}" if deployment_url else None
        ),
        "public_url": f"https://{preferred_alias}" if preferred_alias else None,
        "alias_assigned": bool(deployment.get("aliasAssigned") and preferred_alias),
        "error_code": (
            str(deployment["errorCode"])[:100]
            if deployment.get("errorCode") is not None
            else None
        ),
        "error_message": (
            str(deployment["errorMessage"])[:500]
            if deployment.get("errorMessage") is not None
            else None
        ),
    }


def _publish(
    request: PublishRequest,
    configuration: Configuration,
    repository: RepositoryAssignment,
    token: str,
) -> dict[str, Any]:
    project_id, project_name = _get_or_create_project(
        token,
        configuration,
        repository,
    )
    deployment = _vercel_json(
        "POST",
        "/v13/deployments",
        token,
        configuration.team_id,
        body={
            "name": project_name,
            "project": project_id,
            "target": "production",
            "gitSource": {
                "type": "github",
                "repoId": repository.repository_id,
                "ref": request.branch,
                "sha": request.commit_sha,
            },
        },
    )
    return _deployment_summary(
        deployment,
        project_id=project_id,
        project_name=project_name,
        request=request,
        require_git_source=False,
    )


def _status(
    request: PublishRequest,
    configuration: Configuration,
    repository: RepositoryAssignment,
    token: str,
) -> dict[str, Any]:
    project_name = _project_name(repository)
    project = _vercel_json(
        "GET",
        f"/v9/projects/{urllib_parse.quote(project_name, safe='')}",
        token,
        configuration.team_id,
        allow_not_found=True,
    )
    if project is None:
        raise PublisherError(
            404,
            "vercel_project_not_found",
            "The assigned repository has no Vercel project.",
        )
    project_id = _project_id(
        project,
        project_name,
        repository,
        configuration.organization,
    )
    deployment = _vercel_json(
        "GET",
        f"/v13/deployments/{urllib_parse.quote(request.deployment_id or '', safe='')}",
        token,
        configuration.team_id,
        query={"withGitRepoInfo": "true"},
        allow_not_found=True,
    )
    if deployment is None:
        raise PublisherError(
            404,
            "vercel_deployment_not_found",
            "The Vercel deployment was not found.",
        )
    return _deployment_summary(
        deployment,
        project_id=project_id,
        project_name=project_name,
        request=request,
        require_git_source=True,
    )


def lambda_handler(event: Any, _context: Any) -> dict[str, Any]:
    try:
        request = _parse_request(event)
        configuration = _configuration()
        repository = _assigned_repository(request, configuration)
        token = _vercel_token(configuration.token_parameter)
        if request.action == "publish":
            deployment = _publish(request, configuration, repository, token)
        else:
            deployment = _status(request, configuration, repository, token)
        print(json.dumps({
            "event": "vercel_publication_request_succeeded",
            "action": request.action,
            "job_id": request.job_id,
            "deployment_id": deployment["id"],
            "ready_state": deployment["ready_state"],
        }, sort_keys=True))
        return {
            "statusCode": 200,
            "body": {
                "repository": {
                    "id": repository.repository_id,
                    "full_name": repository.full_name,
                },
                "deployment": deployment,
            },
        }
    except PublisherError as error:
        print(json.dumps({
            "event": "vercel_publication_request_failed",
            "code": error.code,
            "message": str(error),
        }, sort_keys=True))
        return {
            "statusCode": error.status_code,
            "body": {"error": error.code, "message": str(error)},
        }
    except Exception as error:
        print(json.dumps({
            "event": "vercel_publication_request_failed",
            "error_type": type(error).__name__,
        }, sort_keys=True))
        return {
            "statusCode": 500,
            "body": {
                "error": "internal_error",
                "message": "The Vercel publication request could not be completed.",
            },
        }
