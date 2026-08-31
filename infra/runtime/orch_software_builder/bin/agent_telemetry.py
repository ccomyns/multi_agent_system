"""Durable, live telemetry for one Codex CLI process."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


LOG = logging.getLogger("agent-telemetry")
SCHEMA_VERSION = 1
PUBLISH_INTERVAL_SECONDS = 3.0
USAGE_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class TelemetryRecorder:
    """Append checkpoints locally and publish a compact live snapshot to S3."""

    def __init__(
        self,
        *,
        s3: Any,
        bucket: str,
        prefix: str,
        local_dir: Path,
        actor_type: str,
        job_id: str,
        orchestrator_instance_id: str,
        agent_id: str | None = None,
        subagent_instance_id: str | None = None,
    ) -> None:
        self.s3 = s3
        self.bucket = bucket
        self.prefix = prefix.rstrip("/")
        self.local_dir = local_dir
        self.events_file = local_dir / "events.jsonl"
        self.latest_file = local_dir / "latest.json"
        self.raw_events_file = local_dir / "codex-events.jsonl"
        self.last_publish_monotonic = 0.0
        self.identity = {
            "schema_version": SCHEMA_VERSION,
            "actor_type": actor_type,
            "job_id": job_id,
            "orchestrator_instance_id": orchestrator_instance_id,
            "agent_id": agent_id,
            "subagent_instance_id": subagent_instance_id,
        }
        self.latest: dict[str, Any] = {
            **self.identity,
            "current_checkpoint": None,
            "detail": None,
            "updated_at": None,
            "last_activity_at": None,
            "codex_started_at": None,
            "codex_finished_at": None,
            "codex_exit_code": None,
            "usage": {field: None for field in USAGE_FIELDS} | {"total_tokens": None},
        }

    def prepare(self) -> None:
        self.local_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(self.local_dir, 0o700)

    def record(
        self,
        checkpoint: str,
        detail: str,
        *,
        publish: bool = True,
        **updates: Any,
    ) -> None:
        self.prepare()
        timestamp = utc_now()
        event = {
            **self.identity,
            "timestamp": timestamp,
            "checkpoint": checkpoint,
            "detail": detail,
        }
        with self.events_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":"), sort_keys=True))
            handle.write("\n")

        self.latest.update(
            current_checkpoint=checkpoint,
            detail=detail,
            updated_at=timestamp,
            last_activity_at=timestamp,
        )
        self.latest.update(updates)
        self._write_latest()
        if publish:
            self.publish(strict=False)

    def append_raw_event(self, raw_line: str) -> dict[str, Any] | None:
        self.prepare()
        with self.raw_events_file.open("a", encoding="utf-8") as handle:
            handle.write(raw_line.rstrip("\n"))
            handle.write("\n")
        try:
            parsed = json.loads(raw_line)
        except json.JSONDecodeError:
            parsed = None
        self.note_activity(parsed if isinstance(parsed, dict) else None)
        return parsed if isinstance(parsed, dict) else None

    def note_activity(self, event: dict[str, Any] | None = None) -> None:
        timestamp = utc_now()
        self.latest["last_activity_at"] = timestamp
        self.latest["updated_at"] = timestamp
        usage = self._usage_from_event(event)
        if isinstance(usage, dict):
            self._merge_usage(usage)
        self._write_latest()
        now = time.monotonic()
        if isinstance(usage, dict) or now - self.last_publish_monotonic >= PUBLISH_INTERVAL_SECONDS:
            self.publish(strict=False)

    @staticmethod
    def _usage_from_event(event: dict[str, Any] | None) -> dict[str, Any] | None:
        if not event:
            return None
        candidates: list[Any] = [event.get("usage")]
        info = event.get("info")
        if isinstance(info, dict):
            candidates.extend(
                [info.get("total_token_usage"), info.get("last_token_usage"), info.get("usage")]
            )
        token_count = event.get("token_count")
        if isinstance(token_count, dict):
            candidates.extend(
                [token_count.get("total_token_usage"), token_count.get("usage"), token_count]
            )
        return next((value for value in candidates if isinstance(value, dict)), None)

    def _merge_usage(self, usage: dict[str, Any]) -> None:
        normalized: dict[str, int | None] = {}
        for field in USAGE_FIELDS:
            value = usage.get(field)
            normalized[field] = value if isinstance(value, int) and value >= 0 else None
        explicit_total = usage.get("total_tokens")
        if isinstance(explicit_total, int) and explicit_total >= 0:
            normalized["total_tokens"] = explicit_total
        elif normalized["input_tokens"] is not None and normalized["output_tokens"] is not None:
            normalized["total_tokens"] = (
                normalized["input_tokens"] + normalized["output_tokens"]
            )
        else:
            normalized["total_tokens"] = None
        self.latest["usage"] = normalized

    def _write_latest(self) -> None:
        self.prepare()
        temporary = self.latest_file.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(self.latest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(self.latest_file)

    def publish(self, *, strict: bool) -> None:
        self.prepare()
        errors: list[Exception] = []
        for path, key, content_type in (
            (self.events_file, f"{self.prefix}/events.jsonl", "application/x-ndjson"),
            (self.latest_file, f"{self.prefix}/latest.json", "application/json"),
        ):
            if not path.is_file():
                continue
            try:
                self.s3.put_object(
                    Bucket=self.bucket,
                    Key=key,
                    Body=path.read_bytes(),
                    ContentType=content_type,
                    ServerSideEncryption="AES256",
                )
            except Exception as error:
                errors.append(error)
                LOG.warning("could not publish live telemetry %s: %s", key, error)
        self.last_publish_monotonic = time.monotonic()
        if errors and strict:
            raise RuntimeError("could not publish final telemetry") from errors[0]

    def publish_raw_events(self, *, strict: bool) -> None:
        if not self.raw_events_file.is_file():
            return
        try:
            self.s3.put_object(
                Bucket=self.bucket,
                Key=f"{self.prefix.rsplit('/telemetry', 1)[0]}/debug/codex-events.jsonl",
                Body=self.raw_events_file.read_bytes(),
                ContentType="application/x-ndjson",
                ServerSideEncryption="AES256",
            )
        except Exception as error:
            if strict:
                raise RuntimeError("could not publish raw Codex event stream") from error
            LOG.warning("could not publish raw Codex event stream: %s", error)
