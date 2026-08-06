#!/usr/bin/env python3
"""Run one real orchestrator job from EC2 user-data supplied configuration."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError


LOG = logging.getLogger("orchestrator-runner")
JOB_ID_PATTERN = re.compile(r"^job_[a-z0-9]{4,12}_[0-9a-f]{8}$")


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def toml_string(value: str) -> str:
    # JSON strings use the same quoting and escaping needed by TOML basic strings.
    return json.dumps(value, ensure_ascii=False)


class OrchestratorRun:
    def __init__(self) -> None:
        self.region = required_env("AWS_REGION")
        self.job_id = required_env("JOB_ID")
        if not JOB_ID_PATTERN.fullmatch(self.job_id):
            raise RuntimeError("JOB_ID has an unexpected format")

        self.orchestrator_instance_id = required_env("ORCHESTRATOR_INSTANCE_ID")
        self.jobs_table = required_env("JOBS_TABLE_NAME")
        self.audit_bucket = required_env("AUDIT_BUCKET_NAME")
        self.auth_parameter = required_env("CODEX_AUTH_SSM_PARAMETER_NAME")
        self.orchestrator_model = required_env("ORCHESTRATOR_MODEL")
        self.subagent_model = required_env("SUBAGENT_MODEL")
        self.mcp_command = Path(required_env("SPAWN_AGENT_MCP_COMMAND"))
        self.documentation_dir = Path(required_env("ORCHESTRATOR_DOCUMENTATION_DIR"))

        self.job_pk = f"JOB#{self.job_id}"
        self.workspace = Path("/var/lib/multi-agent/jobs") / self.job_id
        # Keep account credentials outside the model-writable job workspace.
        self.codex_home = Path("/var/lib/multi-agent/codex-home")
        self.final_message = self.workspace / "final.md"

        self.ddb = boto3.client("dynamodb", region_name=self.region)
        self.s3 = boto3.client("s3", region_name=self.region)
        self.ssm = boto3.client("ssm", region_name=self.region)

        self.original_auth = ""

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
  "AUDIT_BUCKET_NAME",
  "JOB_ID",
  "ORCHESTRATOR_INSTANCE_ID",
  "SUBAGENT_MODEL",
]
default_tools_approval_mode = "approve"

[mcp_servers.subagent_manager.tools.spawn_agent]
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
            "custom-designed spawn_agent(task) local MCP tool. To begin, you must "
            "create a plan.md file to brainstorm and figure out how you will best "
            "curate a response to the original_task. You should also use the plan.md "
            "to map out the subtasks that you will allocate to subagents. Please use "
            "the search tool during the planning phase if you think that it would help "
            "you accomplish your task/help you brainstorm different questions for the "
            "subagents to investigate. You may call spawn in subagents after you have "
            "created your plan.md file. The system documentation supplied with this "
            "orchestrator is available in the documentation/ directory; read the "
            "relevant files before querying or interpreting system data."
        )
        self.write_codex_config(developer_instructions)

        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(self.codex_home)
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
        subprocess.run(command, env=environment, check=True)

        if not self.final_message.is_file() or self.final_message.stat().st_size == 0:
            raise RuntimeError("Codex completed without writing a final message")

    def upload_result(self) -> str:
        key = f"jobs/{self.job_id}/result/final.md"
        self.s3.put_object(
            Bucket=self.audit_bucket,
            Key=key,
            Body=self.final_message.read_bytes(),
            ContentType="text/markdown; charset=utf-8",
            ServerSideEncryption="AES256",
        )
        return f"s3://{self.audit_bucket}/{key}"

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
        task = run.load_task()
        run.install_auth()
        run.run_codex(task)
        result_uri = run.upload_result()
        run.finish_job("completed")
        LOG.info("completed job %s; result=%s", run.job_id, result_uri)
        return 0
    except Exception as error:
        LOG.exception("orchestrator job failed")
        if run is not None:
            try:
                run.finish_job("failed")
            except ClientError:
                LOG.exception("could not mark the job failed or release its lock")
        return 1
    finally:
        if run is not None:
            try:
                run.persist_refreshed_auth()
            except Exception:
                LOG.exception("could not persist refreshed Codex authentication")


if __name__ == "__main__":
    raise SystemExit(main())
