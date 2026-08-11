#!/usr/bin/env python3
"""Run one real orchestrator job from EC2 user-data supplied configuration."""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3


LOG = logging.getLogger("orchestrator-runner")
JOB_ID_PATTERN = re.compile(r"^job_[a-z0-9]{4,12}_[0-9a-f]{8}$")
MAX_TEXT_OUTPUT_BYTES = 1024 * 1024
MAX_FINAL_RESULT_BYTES = 512 * 1024 * 1024


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def toml_string(value: str) -> str:
    # JSON strings use the same quoting and escaping needed by TOML basic strings.
    return json.dumps(value, ensure_ascii=False)


def reject_nonstandard_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant {value!r} is not allowed")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_utf8(path: Path, size_limit: int, label: str) -> str:
    if not path.is_file():
        raise RuntimeError(f"Codex completed without writing {label}")
    size = path.stat().st_size
    if size == 0:
        raise RuntimeError(f"{label} must not be empty")
    if size > size_limit:
        raise RuntimeError(f"{label} exceeds the {size_limit}-byte publication limit")
    try:
        value = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError(f"{label} must contain valid UTF-8") from error
    if not value.strip():
        raise RuntimeError(f"{label} must not be blank")
    return value


class OrchestratorRun:
    def __init__(self) -> None:
        self.region = required_env("AWS_REGION")
        self.job_id = required_env("JOB_ID")
        if not JOB_ID_PATTERN.fullmatch(self.job_id):
            raise RuntimeError("JOB_ID has an unexpected format")

        self.orchestrator_instance_id = required_env("ORCHESTRATOR_INSTANCE_ID")
        self.jobs_table = required_env("JOBS_TABLE_NAME")
        self.workspace_bucket = required_env("AGENT_WORKSPACE_BUCKET_NAME")
        self.global_memory_bucket = required_env("GLOBAL_MEMORY_BUCKET_NAME")
        self.auth_parameter = required_env("CODEX_AUTH_SSM_PARAMETER_NAME")
        self.orchestrator_model = required_env("ORCHESTRATOR_MODEL")
        self.subagent_model = required_env("SUBAGENT_MODEL")
        self.mcp_command = Path(required_env("SPAWN_AGENT_MCP_COMMAND"))
        self.documentation_dir = Path(required_env("ORCHESTRATOR_DOCUMENTATION_DIR"))

        self.job_pk = f"JOB#{self.job_id}"
        self.workspace = Path("/var/lib/multi-agent/jobs") / self.job_id
        # Keep account credentials outside the model-writable job workspace.
        self.codex_home = Path("/var/lib/multi-agent/codex-home")
        self.plan_file = self.workspace / "plan.md"
        self.final_message = self.workspace / "final.md"
        self.final_result = self.workspace / "final_result.json"
        self.result_dir = Path("/var/lib/multi-agent/results") / self.job_id
        self.completed_file = self.result_dir / "completed.md"
        self.failure_file = self.result_dir / "failure.md"
        self.bootstrap_log = Path(
            os.environ.get(
                "BOOTSTRAP_LOG_PATH",
                "/var/log/multi-agent/orchestrator-bootstrap.log",
            )
        )
        self.codex_log = Path(
            os.environ.get(
                "CODEX_LOG_PATH",
                "/var/log/multi-agent/orchestrator-codex.log",
            )
        )

        self.ddb = boto3.client("dynamodb", region_name=self.region)
        self.s3 = boto3.client("s3", region_name=self.region)
        self.ssm = boto3.client("ssm", region_name=self.region)

        self.original_auth = ""

    def prepare_directories(self) -> None:
        for directory in (self.workspace, self.codex_home, self.result_dir):
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
            os.chmod(directory, 0o700)

    def load_task(self) -> str:
        response = self.ddb.get_item(
            TableName=self.jobs_table,
            Key={"pk": {"S": self.job_pk}},
            ConsistentRead=True,
        )
        item = response.get("Item")
        if not item:
            raise RuntimeError(f"job record {self.job_pk} does not exist")

        status = item.get("status", {}).get("S")
        stored_orchestrator = item.get("orchestrator_instance_id", {}).get("S")
        task = item.get("original_task", {}).get("S", "").strip()
        if status not in {"initializing", "running"}:
            raise RuntimeError(f"job is not active (status={status!r})")
        if stored_orchestrator and stored_orchestrator != self.orchestrator_instance_id:
            raise RuntimeError("job belongs to a different orchestrator")
        if not task:
            raise RuntimeError("job has no original_task")
        return task

    def install_auth(self) -> None:
        response = self.ssm.get_parameter(Name=self.auth_parameter, WithDecryption=True)
        value = response["Parameter"]["Value"]
        parsed = json.loads(value)
        if not isinstance(parsed, dict):
            raise RuntimeError("the Codex auth parameter must contain a JSON object")

        self.original_auth = value
        self.codex_home.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(self.codex_home, 0o700)
        self._atomic_secret_write(self.codex_home / "auth.json", value)

    @staticmethod
    def _atomic_secret_write(destination: Path, value: str) -> None:
        descriptor, temporary_name = tempfile.mkstemp(dir=destination.parent)
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(value)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)

    def write_codex_config(self, developer_instructions: str) -> None:
        if not self.mcp_command.is_file() or not os.access(self.mcp_command, os.X_OK):
            raise RuntimeError(
                f"the required spawn_agent MCP executable is missing: {self.mcp_command}"
            )

        self.codex_home.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(self.codex_home, 0o700)

        config = f"""\
model = {toml_string(self.orchestrator_model)}
cli_auth_credentials_store = "file"
developer_instructions = {toml_string(developer_instructions)}

[mcp_servers.subagent_manager]
command = {toml_string(str(self.mcp_command))}
required = true
startup_timeout_sec = 30
tool_timeout_sec = 3600
env_vars = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "FUNCTION_NAME",
  "AGENT_WORKSPACE_BUCKET_NAME",
  "JOB_ID",
  "ORCHESTRATOR_INSTANCE_ID",
  "ORCHESTRATOR_WORKSPACE",
  "SUBAGENT_MODEL",
]
default_tools_approval_mode = "approve"

[mcp_servers.subagent_manager.tools.spawn_agent]
approval_mode = "approve"

[mcp_servers.subagent_manager.tools.collect_agent_results]
approval_mode = "approve"
"""
        destination = self.codex_home / "config.toml"
        destination.write_text(config, encoding="utf-8")
        os.chmod(destination, 0o600)

    def run_codex(self, task: str) -> None:
        self.workspace.mkdir(parents=True, mode=0o700, exist_ok=True)
        if self.documentation_dir.is_dir():
            shutil.copytree(
                self.documentation_dir,
                self.workspace / "documentation",
                dirs_exist_ok=True,
            )
        developer_instructions = (
            f"You have been given the following task: {task}. "
            "You have access to codex's native search tool, along with a "
            "local subagent-manager MCP server exposing spawn_agent(task) and "
            "collect_agent_results(agent_ids, timeout_seconds, poll_interval_seconds). "
            "To begin, you must "
            "create a plan.md file to brainstorm and figure out how you will best "
            "curate a response to the original_task. You should also use the plan.md "
            "to map out the subtasks that you will allocate to subagents. Please use "
            "the search tool during the planning phase if you think that it would help "
            "you accomplish your task/help you brainstorm different questions for the "
            "subagents to investigate. You may call spawn in subagents after you have "
            "created your plan.md file. Launch the planned subagents before waiting for "
            "them and retain every accepted agent_id. A subagent should have ownership over "
            "a single URL. Include the URL of the website you want the subagent to webscrape "
            "in the task that you give it. Every web-scraping task passed to spawn_agent "
            "must instruct the subagent to use Playwright with Chromium to inspect and "
            "navigate the target website. Tell the subagent to click through and explore "
            "relevant pagination, filters, expandable sections, directory and detail pages, "
            "and other first-party pages within that website as needed to find the requested "
            "data. Require a strong but bounded effort: inspect a few likely relevant pages "
            "and controls, but if the requested data or a particular field is not present "
            "after that reasonable exploration, stop searching rather than repeatedly "
            "traversing the site. The subagent should record the data as unavailable or not "
            "publicly listed, explain which pages it checked and any coverage limitations in "
            "its results and summary, and then finish normally. The single URL is the "
            "subagent's starting point and ownership boundary, not a prohibition on following "
            "relevant same-site links. "
            "Do not perform web scraping in the orchestrator; delegate each target URL to a "
            "subagent. At most eight subagents can be active "
            "at once. If a spawn request is rejected with active_subagent_limit_reached, "
            "retain that rejected task and do not pass its unaccepted agent_id to the "
            "collection tool. Once the accepted first batch of up to eight agents has "
            "completed and been collected, retry the rejected task until its spawn request "
            "is accepted. If capacity reconciliation has not finished and a retry is still "
            "rejected, wait briefly before retrying again. After the later task is accepted, "
            "collect its result as a subsequent batch. Repeat this process for every task; "
            "a capacity rejection must never cause a planned task to be abandoned. For each "
            "accepted batch, call collect_agent_results with all accepted IDs in that batch "
            "so their data collection runs in parallel. The collection tool returns local "
            "paths to summary.md and "
            "results_<agent_id>.json; read both for every completed subagent. It does not "
            "download terminal marker files. If collection times out with pending agents, "
            "call it again for only those agents when appropriate. The system documentation "
            "supplied with this "
            "orchestrator is available in the documentation/ directory; read the "
            "relevant files before querying or interpreting system data. The "
            "GLOBAL_MEMORY_BUCKET_NAME environment variable identifies durable "
            "cross-job memory. Read relevant memory during planning. Global memory "
            "is read-only for this orchestrator and all subagents; do not attempt to "
            "create, update, or delete objects there. Before finishing, create "
            "final_result.json in the orchestrator workspace containing all aggregated "
            "data needed to answer the task. Choose the JSON structure that best represents "
            "the research and the subagent datasets; do not omit relevant collected data. "
            "The file must be valid JSON containing an object or array."
        )
        self.write_codex_config(developer_instructions)

        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(self.codex_home)
        environment["ORCHESTRATOR_WORKSPACE"] = str(self.workspace)
        command = [
            "codex",
            "--search",
            "--ask-for-approval",
            "never",
            "exec",
            "--model",
            self.orchestrator_model,
            "--sandbox",
            "workspace-write",
            "--skip-git-repo-check",
            "--ephemeral",
            "--cd",
            str(self.workspace),
            "--output-last-message",
            str(self.final_message),
            task,
        ]
        LOG.info("starting Codex for job %s with model %s", self.job_id, self.orchestrator_model)
        self.codex_log.parent.mkdir(parents=True, exist_ok=True)
        with self.codex_log.open("ab") as codex_log:
            subprocess.run(
                command,
                env=environment,
                check=True,
                stdout=codex_log,
                stderr=subprocess.STDOUT,
            )

        read_utf8(self.plan_file, MAX_TEXT_OUTPUT_BYTES, "plan.md")
        read_utf8(self.final_message, MAX_TEXT_OUTPUT_BYTES, "final.md")
        self.validate_final_result()

    def validate_final_result(self) -> Any:
        raw = read_utf8(
            self.final_result,
            MAX_FINAL_RESULT_BYTES,
            "final_result.json",
        )
        try:
            draft = json.loads(raw, parse_constant=reject_nonstandard_json_constant)
        except ValueError as error:
            raise RuntimeError("final_result.json must contain valid JSON") from error
        if not isinstance(draft, (dict, list)):
            raise RuntimeError("final_result.json must contain a JSON object or array")
        return draft

    def upload_outputs(self) -> dict[str, str]:
        destinations = {
            "plan_uri": (
                self.plan_file,
                f"jobs/{self.job_id}/result/plan.md",
                "text/markdown; charset=utf-8",
            ),
            "final_result_uri": (
                self.final_result,
                f"jobs/{self.job_id}/result/final_result.json",
                "application/json",
            ),
            "final_uri": (
                self.final_message,
                f"jobs/{self.job_id}/result/final.md",
                "text/markdown; charset=utf-8",
            ),
        }
        uploaded: dict[str, str] = {}
        for name, (source, key, content_type) in destinations.items():
            self.s3.put_object(
                Bucket=self.workspace_bucket,
                Key=key,
                Body=source.read_bytes(),
                ContentType=content_type,
                ServerSideEncryption="AES256",
            )
            uploaded[name] = f"s3://{self.workspace_bucket}/{key}"
        return uploaded

    def _upload_file(self, source: Path, key: str, content_type: str | None = None) -> str:
        metadata = source.lstat()
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError(f"refusing to upload non-regular artifact {source}")
        guessed_type = mimetypes.guess_type(source.name)[0]
        with source.open("rb") as body:
            self.s3.put_object(
                Bucket=self.workspace_bucket,
                Key=key,
                Body=body,
                ContentLength=metadata.st_size,
                ContentType=content_type or guessed_type or "application/octet-stream",
                ServerSideEncryption="AES256",
            )
        return f"s3://{self.workspace_bucket}/{key}"

    def upload_debug_artifacts(self, *, strict: bool = True) -> dict[str, Any]:
        """Upload logs and the complete model-writable workspace before termination."""
        prefix = f"jobs/{self.job_id}/orchestrator"
        uploaded_count = 0
        errors: list[str] = []

        named_artifacts = (
            (self.bootstrap_log, f"{prefix}/debug/bootstrap.log"),
            (self.codex_log, f"{prefix}/debug/codex.log"),
        )
        for source, key in named_artifacts:
            try:
                self._upload_file(source, key, "text/plain; charset=utf-8")
                uploaded_count += 1
            except Exception as error:
                errors.append(f"{source}: {type(error).__name__}: {error}")

        if self.workspace.is_dir():
            try:
                sources = sorted(self.workspace.rglob("*"))
            except Exception as error:
                errors.append(f"{self.workspace}: {type(error).__name__}: {error}")
                sources = []
            for source in sources:
                try:
                    metadata = source.lstat()
                    if not stat.S_ISREG(metadata.st_mode):
                        continue
                    relative = source.relative_to(self.workspace).as_posix()
                    self._upload_file(source, f"{prefix}/workspace/{relative}")
                    uploaded_count += 1
                except Exception as error:
                    errors.append(f"{source}: {type(error).__name__}: {error}")

        if errors and strict:
            raise RuntimeError("could not upload all debugging artifacts: " + "; ".join(errors))
        return {
            "debug_prefix_uri": f"s3://{self.workspace_bucket}/{prefix}/debug/",
            "workspace_prefix_uri": f"s3://{self.workspace_bucket}/{prefix}/workspace/",
            "debug_artifact_count": uploaded_count,
            "artifact_upload_errors": errors,
        }

    def terminal_marker_uri(self, state: str) -> str:
        if state not in {"completed", "failed"}:
            raise ValueError(f"unsupported terminal marker state: {state}")
        marker_name = "completed.md" if state == "completed" else "failure.md"
        return (
            f"s3://{self.workspace_bucket}/jobs/{self.job_id}/"
            f"orchestrator/result/{marker_name}"
        )

    def upload_terminal_marker(self, state: str) -> str:
        if state == "completed":
            marker = self.completed_file
            message = "Completed successfully.\n"
        elif state == "failed":
            marker = self.failure_file
            message = "Run failed.\n"
        else:
            raise ValueError(f"unsupported terminal marker state: {state}")

        marker.write_text(message, encoding="utf-8")
        os.chmod(marker, 0o600)
        key = f"jobs/{self.job_id}/orchestrator/result/{marker.name}"
        self.s3.put_object(
            Bucket=self.workspace_bucket,
            Key=key,
            Body=marker.read_bytes(),
            ContentType="text/markdown; charset=utf-8",
            ServerSideEncryption="AES256",
        )
        return f"s3://{self.workspace_bucket}/{key}"

    def upload_status(self, state: str, **details: Any) -> None:
        record = {
            "schema_version": 1,
            "state": state,
            "job_id": self.job_id,
            "orchestrator_instance_id": self.orchestrator_instance_id,
            "model": self.orchestrator_model,
            "recorded_at": utc_now(),
            **details,
        }
        self.s3.put_object(
            Bucket=self.workspace_bucket,
            Key=f"jobs/{self.job_id}/orchestrator/status/{state}.json",
            Body=json.dumps(record, indent=2, sort_keys=True).encode("utf-8"),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )

    def finish_job(self, status: str) -> None:
        finished_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        values: dict[str, Any] = {
            ":orchestrator_instance_id": {"S": self.orchestrator_instance_id},
            ":running": {"S": "running"},
            ":status": {"S": status},
            ":now": {"S": finished_at},
        }
        assignments = ["#status = :status", "finished_at = :now", "updated_at = :now"]
        self.ddb.transact_write_items(
            TransactItems=[
                {
                    "Delete": {
                        "TableName": self.jobs_table,
                        "Key": {"pk": {"S": "ACTIVE_JOB"}},
                        "ConditionExpression": "active_job_id = :job_pk",
                        "ExpressionAttributeValues": {":job_pk": {"S": self.job_pk}},
                    }
                },
                {
                    "Update": {
                        "TableName": self.jobs_table,
                        "Key": {"pk": {"S": self.job_pk}},
                        "UpdateExpression": f"SET {', '.join(assignments)}",
                        "ConditionExpression": (
                            "orchestrator_instance_id = :orchestrator_instance_id AND #status = :running"
                        ),
                        "ExpressionAttributeNames": {"#status": "status"},
                        "ExpressionAttributeValues": values,
                    }
                },
            ]
        )

    def persist_refreshed_auth(self) -> None:
        auth_path = self.codex_home / "auth.json"
        if not self.original_auth or not auth_path.is_file():
            return
        refreshed = auth_path.read_text(encoding="utf-8").strip()
        json.loads(refreshed)
        if refreshed == self.original_auth.strip():
            return

        # Avoid overwriting a manual rotation that happened while this job ran.
        current = self.ssm.get_parameter(Name=self.auth_parameter, WithDecryption=True)
        if current["Parameter"]["Value"].strip() != self.original_auth.strip():
            LOG.warning("Codex auth changed in SSM during the run; not overwriting it")
            return
        self.ssm.put_parameter(
            Name=self.auth_parameter,
            Value=refreshed,
            Type="SecureString",
            Overwrite=True,
        )
        LOG.info("persisted refreshed Codex authentication for the next job")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    run: OrchestratorRun | None = None
    try:
        run = OrchestratorRun()
        run.prepare_directories()
        task = run.load_task()
        run.install_auth()
        run.run_codex(task)
        output_uris = run.upload_outputs()
        output_uris.update(run.upload_debug_artifacts())
        run.finish_job("completed")
        try:
            run.persist_refreshed_auth()
        except Exception:
            LOG.exception("could not persist refreshed Codex authentication")
        output_uris["completion_marker_uri"] = run.terminal_marker_uri("completed")
        run.upload_status("completed", **output_uris)
        # The marker is deliberately the final S3 write before service exit/shutdown.
        run.upload_terminal_marker("completed")
        LOG.info("completed job %s; outputs=%s", run.job_id, output_uris)
        return 0
    except Exception as error:
        LOG.exception("orchestrator job failed")
        if run is not None:
            try:
                artifacts = run.upload_debug_artifacts(strict=False)
            except Exception as artifact_error:
                LOG.exception("could not upload orchestrator debugging artifacts")
                artifacts = {
                    "artifact_upload_errors": [
                        f"{type(artifact_error).__name__}: {artifact_error}"
                    ]
                }
            try:
                run.finish_job("failed")
            except Exception:
                LOG.exception("could not mark the job failed or release its lock")
            try:
                run.persist_refreshed_auth()
            except Exception:
                LOG.exception("could not persist refreshed Codex authentication")
            try:
                run.upload_status(
                    "failed",
                    error_type=type(error).__name__,
                    error=str(error)[:1000],
                    failure_marker_uri=run.terminal_marker_uri("failed"),
                    **artifacts,
                )
            except Exception:
                LOG.exception("could not upload orchestrator failure status")
            try:
                # Preserve a final failure marker even when Codex exits early.
                run.upload_terminal_marker("failed")
            except Exception:
                LOG.exception("could not upload orchestrator failure marker")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
