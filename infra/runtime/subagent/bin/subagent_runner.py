#!/usr/bin/env python3
"""Run one S3-delivered research subtask and publish its durable outputs."""

from __future__ import annotations

import json
import logging
import os
import re
import stat
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3


LOG = logging.getLogger("subagent-runner")
JOB_ID_PATTERN = re.compile(r"^job_[a-z0-9]{4,12}_[0-9a-f]{8}$")
AGENT_ID_PATTERN = re.compile(r"^agent-[0-9a-f]{24}$")
INSTANCE_ID_PATTERN = re.compile(r"^i-[0-9a-f]{8,17}$")
MAX_SUMMARY_BYTES = 1024 * 1024
MAX_RESULTS_BYTES = 50 * 1024 * 1024


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class SubagentRun:
    def __init__(self) -> None:
        self.region = required_env("AWS_REGION")
        self.workspace_bucket = required_env("AGENT_WORKSPACE_BUCKET_NAME")
        self.global_memory_bucket = required_env("GLOBAL_MEMORY_BUCKET_NAME")
        self.auth_parameter = required_env("CODEX_AUTH_SSM_PARAMETER_NAME")
        self.job_id = required_env("JOB_ID")
        self.agent_id = required_env("AGENT_ID")
        self.orchestrator_instance_id = required_env("ORCHESTRATOR_INSTANCE_ID")
        self.subagent_instance_id = required_env("SUBAGENT_INSTANCE_ID")
        self.model = required_env("SUBAGENT_MODEL")
        self.task_s3_key = required_env("TASK_S3_KEY")

        if not JOB_ID_PATTERN.fullmatch(self.job_id):
            raise RuntimeError("JOB_ID has an unexpected format")
        if not AGENT_ID_PATTERN.fullmatch(self.agent_id):
            raise RuntimeError("AGENT_ID has an unexpected format")
        if not INSTANCE_ID_PATTERN.fullmatch(self.orchestrator_instance_id):
            raise RuntimeError("ORCHESTRATOR_INSTANCE_ID has an unexpected format")
        if not INSTANCE_ID_PATTERN.fullmatch(self.subagent_instance_id):
            raise RuntimeError("SUBAGENT_INSTANCE_ID has an unexpected format")

        self.agent_prefix = f"jobs/{self.job_id}/agents/{self.agent_id}"
        expected_key = f"{self.agent_prefix}/input.json"
        if self.task_s3_key != expected_key:
            raise RuntimeError("TASK_S3_KEY does not match the trusted job and agent identity")

        self.work_dir = Path("/work")
        self.summary_dir = Path("/summary")
        self.result_dir = Path("/result")
        self.summary_file = self.summary_dir / "summary.md"
        self.results_file = self.summary_dir / f"results_{self.agent_id}.json"
        self.completed_file = self.result_dir / "completed.md"
        self.failure_file = self.result_dir / "failure.md"
        self.codex_final_message = self.work_dir / "codex-final-message.md"
        self.codex_home = Path("/var/lib/multi-agent/codex-home")

        self.s3 = boto3.client("s3", region_name=self.region)
        self.ssm = boto3.client("ssm", region_name=self.region)

    def prepare_directories(self) -> None:
        for directory in (
            self.work_dir,
            self.work_dir / "tmp",
            self.summary_dir,
            self.result_dir,
            self.codex_home,
        ):
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)
            os.chmod(directory, 0o700)

    def download_task(self) -> dict[str, Any]:
        response = self.s3.get_object(
            Bucket=self.workspace_bucket,
            Key=self.task_s3_key,
        )
        raw = response["Body"].read((64 * 1024) + 1)
        if len(raw) > 64 * 1024:
            raise RuntimeError("input.json exceeds the 64 KiB task specification limit")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise RuntimeError("input.json must contain a JSON object")
        if payload.get("schema_version") != 1:
            raise RuntimeError("input.json has an unsupported schema_version")

        expected = {
            "job_id": self.job_id,
            "agent_id": self.agent_id,
            "orchestrator_instance_id": self.orchestrator_instance_id,
            "model": self.model,
        }
        for field, value in expected.items():
            if payload.get(field) != value:
                raise RuntimeError(f"input.json {field} does not match the launch identity")

        task = payload.get("task")
        if not isinstance(task, str) or not task.strip():
            raise RuntimeError("input.json task must be a non-empty string")
        payload["task"] = task.strip()

        (self.work_dir / "input.json").write_bytes(raw)
        os.chmod(self.work_dir / "input.json", 0o600)
        return payload

    def install_auth(self) -> None:
        response = self.ssm.get_parameter(Name=self.auth_parameter, WithDecryption=True)
        value = response["Parameter"]["Value"]
        parsed = json.loads(value)
        if not isinstance(parsed, dict):
            raise RuntimeError("the Codex auth parameter must contain a JSON object")

        descriptor, temporary_name = tempfile.mkstemp(dir=self.codex_home)
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(value)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            temporary.replace(self.codex_home / "auth.json")
        finally:
            temporary.unlink(missing_ok=True)

    def write_codex_config(self) -> None:
        instructions = (
            "You are one data-mining subagent working on one focused task. Store every "
            "working artifact, code file, cloned repository, and internet download under "
            "/work only. Do not write working content elsewhere. Before finishing, create "
            "/summary/summary.md explaining the approach you took, sources and methods used, "
            "significant findings, useful artifacts in /work, and any caveats. Also create "
            f"/summary/results_{self.agent_id}.json containing the data you gathered as valid "
            "JSON. Prefer a JSON object with a records array plus source and field metadata "
            "when that shape fits the task. Do not use the summary as a substitute for the "
            "structured dataset. The supervisor validates and uploads both files, then writes "
            "/result/completed.md; if the run fails, it writes /result/failure.md instead. "
            "Those result-directory files are brief terminal markers, not research outputs. "
            "Do not create either marker yourself, and do not shut down or terminate the "
            "machine yourself. The service shuts the machine down after publication. "
            "GLOBAL_MEMORY_BUCKET_NAME identifies durable cross-job memory. It is read-only; "
            "never create, update, or delete objects in that bucket."
        )
        config = f"""\
model = {toml_string(self.model)}
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "live"
cli_auth_credentials_store = "file"
developer_instructions = {toml_string(instructions)}

[sandbox_workspace_write]
writable_roots = ["/summary"]
network_access = true
exclude_slash_tmp = true
exclude_tmpdir_env_var = true
"""
        destination = self.codex_home / "config.toml"
        destination.write_text(config, encoding="utf-8")
        os.chmod(destination, 0o600)

    def run_codex(self, task: str) -> None:
        self.write_codex_config()
        environment = os.environ.copy()
        environment["CODEX_HOME"] = str(self.codex_home)
        environment["TMPDIR"] = str(self.work_dir / "tmp")
        environment["TMP"] = str(self.work_dir / "tmp")
        environment["TEMP"] = str(self.work_dir / "tmp")
        command = [
            "codex",
            "--search",
            "--ask-for-approval",
            "never",
            "exec",
            "--model",
            self.model,
            "--sandbox",
            "workspace-write",
            "--skip-git-repo-check",
            "--ephemeral",
            "--cd",
            str(self.work_dir),
            "--output-last-message",
            str(self.codex_final_message),
            task,
        ]
        LOG.info("starting Codex for agent %s with model %s", self.agent_id, self.model)
        subprocess.run(command, env=environment, check=True)

        size_limits = {
            self.summary_file: MAX_SUMMARY_BYTES,
            self.results_file: MAX_RESULTS_BYTES,
        }
        for path, size_limit in size_limits.items():
            metadata = path.lstat() if path.exists() else None
            if (
                metadata is None
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_nlink != 1
                or metadata.st_size == 0
            ):
                raise RuntimeError(f"Codex completed without creating required file {path}")
            if metadata.st_size > size_limit:
                raise RuntimeError(f"{path} exceeds the {size_limit}-byte publication limit")

        try:
            summary_text = self.summary_file.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise RuntimeError(f"{self.summary_file} must contain valid UTF-8") from error
        if not summary_text.strip():
            raise RuntimeError(f"{self.summary_file} must not be blank")

        try:
            parsed_results = json.loads(self.results_file.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError(f"{self.results_file} must contain valid UTF-8 JSON") from error
        if not isinstance(parsed_results, (dict, list)):
            raise RuntimeError(f"{self.results_file} must contain a JSON object or array")

    def upload_data_outputs(self) -> dict[str, str]:
        destinations = {
            "summary_uri": (
                self.summary_file,
                f"{self.agent_prefix}/summary/summary.md",
                "text/markdown; charset=utf-8",
            ),
            "results_uri": (
                self.results_file,
                f"{self.agent_prefix}/summary/results_{self.agent_id}.json",
                "application/json",
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

    def terminal_marker_uri(self, state: str) -> str:
        if state not in {"completed", "failed"}:
            raise ValueError(f"unsupported terminal marker state: {state}")
        marker_name = "completed.md" if state == "completed" else "failure.md"
        return f"s3://{self.workspace_bucket}/{self.agent_prefix}/result/{marker_name}"

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
        key = f"{self.agent_prefix}/result/{marker.name}"
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
            "agent_id": self.agent_id,
            "subagent_instance_id": self.subagent_instance_id,
            "model": self.model,
            "recorded_at": utc_now(),
            **details,
        }
        self.s3.put_object(
            Bucket=self.workspace_bucket,
            Key=f"{self.agent_prefix}/status/{state}.json",
            Body=json.dumps(record, indent=2, sort_keys=True).encode("utf-8"),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    run: SubagentRun | None = None
    try:
        run = SubagentRun()
        run.prepare_directories()
        task_spec = run.download_task()
        run.install_auth()
        run.run_codex(task_spec["task"])
        outputs = run.upload_data_outputs()
        outputs["completion_marker_uri"] = run.terminal_marker_uri("completed")
        run.upload_status("completed", **outputs)
        run.upload_terminal_marker("completed")
        LOG.info("completed agent %s; service shutdown will terminate the instance", run.agent_id)
        return 0
    except Exception as error:
        LOG.exception("subagent run failed")
        if run is not None:
            try:
                run.upload_status(
                    "failed",
                    error_type=type(error).__name__,
                    error=str(error)[:1000],
                    failure_marker_uri=run.terminal_marker_uri("failed"),
                )
                run.upload_terminal_marker("failed")
            except Exception:
                LOG.exception("could not upload subagent failure status")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
