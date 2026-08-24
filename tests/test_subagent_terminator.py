from __future__ import annotations

import io
import json
import os
import sys
import types
import unittest
from unittest.mock import Mock, patch

if "boto3" not in sys.modules:
    boto3_stub = types.ModuleType("boto3")
    boto3_stub.client = Mock()
    boto3_stub.resource = Mock()
    sys.modules["boto3"] = boto3_stub

if "botocore.exceptions" not in sys.modules:
    botocore_stub = types.ModuleType("botocore")
    exceptions_stub = types.ModuleType("botocore.exceptions")

    class StubClientError(Exception):
        def __init__(self, response, operation_name):
            super().__init__(response.get("Error", {}).get("Message", operation_name))
            self.response = response
            self.operation_name = operation_name

    exceptions_stub.ClientError = StubClientError
    botocore_stub.exceptions = exceptions_stub
    sys.modules["botocore"] = botocore_stub
    sys.modules["botocore.exceptions"] = exceptions_stub

from src.subagent_terminator import handler


class SubagentTerminatorTests(unittest.TestCase):
    job_id = "job_abc1_1234abcd"
    agent_id = "agent-0123456789abcdef01234567"
    orchestrator_id = "i-1234567890abcdef0"
    instance_id = "i-abcdef01234567890"

    def setUp(self) -> None:
        self.environment = patch.dict(
            os.environ,
            {
                "AGENT_WORKSPACE_BUCKET_NAME": "agent-workspace-bucket",
                "STATE_TABLE_NAME": "state-table",
            },
            clear=False,
        )
        self.environment.start()
        handler._clients.clear()

    def tearDown(self) -> None:
        handler._clients.clear()
        self.environment.stop()

    @property
    def prefix(self) -> str:
        return f"jobs/{self.job_id}/agents/{self.agent_id}"

    def request(self, state: str = "completed") -> dict[str, object]:
        marker = "completed.md" if state == "completed" else "failure.md"
        return {
            "schema_version": 1,
            "state": state,
            "job_id": self.job_id,
            "orchestrator_instance_id": self.orchestrator_id,
            "agent_id": self.agent_id,
            "subagent_instance_id": self.instance_id,
            "status_key": f"{self.prefix}/status/{state}.json",
            "terminal_marker_key": f"{self.prefix}/result/{marker}",
            "recorded_at": "2026-01-01T00:10:00Z",
        }

    def status(self, state: str = "completed") -> dict[str, object]:
        return {
            "schema_version": 1,
            "state": state,
            "job_id": self.job_id,
            "orchestrator_instance_id": self.orchestrator_id,
            "agent_id": self.agent_id,
            "subagent_instance_id": self.instance_id,
            "recorded_at": "2026-01-01T00:09:59Z",
        }

    def event(self) -> dict[str, object]:
        return {
            "Records": [
                {
                    "eventSource": "aws:s3",
                    "s3": {
                        "bucket": {"name": "agent-workspace-bucket"},
                        "object": {
                            "key": f"{self.prefix}/termination/request.json",
                            "versionId": "request-version",
                        },
                    },
                }
            ]
        }

    @staticmethod
    def json_response(payload: dict[str, object]) -> dict[str, object]:
        raw = json.dumps(payload).encode("utf-8")
        return {"Body": io.BytesIO(raw), "ContentLength": len(raw)}

    def clients(
        self,
        *,
        request: dict[str, object] | None = None,
        status: dict[str, object] | None = None,
        agent: dict[str, object] | None = None,
    ) -> tuple[Mock, Mock, Mock]:
        s3 = Mock()
        table = Mock()
        ec2 = Mock()
        request_payload = request or self.request()
        status_payload = status or self.status()

        def get_object(**kwargs):
            if kwargs["Key"].endswith("/termination/request.json"):
                self.assertEqual(kwargs["VersionId"], "request-version")
                return self.json_response(request_payload)
            if "/status/" in kwargs["Key"]:
                self.assertNotIn("VersionId", kwargs)
                return self.json_response(status_payload)
            self.fail(f"unexpected S3 key: {kwargs['Key']}")

        s3.get_object.side_effect = get_object
        table.get_item.return_value = {
            "Item": agent
            or {
                "job_id": self.job_id,
                "agent_id": self.agent_id,
                "orchestrator_id": self.orchestrator_id,
                "instance_id": self.instance_id,
                "active": True,
                "state": "RUNNING",
            }
        }
        return s3, table, ec2

    def test_terminal_request_terminates_exact_validated_instance(self) -> None:
        s3, table, ec2 = self.clients()

        def client(name: str):
            return {"s3": s3, "table": table, "ec2": ec2}[name]

        with (
            patch.object(handler, "_client", side_effect=client),
            patch.object(handler, "_now", return_value="2026-01-01T00:10:01Z"),
        ):
            result = handler.lambda_handler(self.event(), None)

        ec2.terminate_instances.assert_called_once_with(InstanceIds=[self.instance_id])
        table.update_item.assert_called_once()
        update = table.update_item.call_args.kwargs
        self.assertIn("termination_requested_at", update["UpdateExpression"])
        self.assertNotIn("result_status", update["UpdateExpression"])
        self.assertTrue(result["results"][0]["termination_requested"])

    def test_mismatched_status_identity_never_terminates_instance(self) -> None:
        status = self.status()
        status["subagent_instance_id"] = "i-00000000000000000"
        s3, table, ec2 = self.clients(status=status)

        def client(name: str):
            return {"s3": s3, "table": table, "ec2": ec2}[name]

        with patch.object(handler, "_client", side_effect=client):
            with self.assertRaisesRegex(ValueError, "subagent_instance_id"):
                handler.lambda_handler(self.event(), None)

        ec2.terminate_instances.assert_not_called()
        table.update_item.assert_not_called()

    def test_duplicate_request_is_idempotently_ignored(self) -> None:
        agent = {
            "job_id": self.job_id,
            "agent_id": self.agent_id,
            "orchestrator_id": self.orchestrator_id,
            "instance_id": self.instance_id,
            "active": True,
            "state": "RUNNING",
            "termination_requested_at": "2026-01-01T00:10:01Z",
        }
        s3, table, ec2 = self.clients(agent=agent)

        def client(name: str):
            return {"s3": s3, "table": table, "ec2": ec2}[name]

        with patch.object(handler, "_client", side_effect=client):
            result = handler.lambda_handler(self.event(), None)

        ec2.terminate_instances.assert_not_called()
        table.update_item.assert_not_called()
        self.assertEqual(
            result["results"][0]["reason"], "termination_already_requested"
        )

    def test_failed_request_uses_the_failure_marker_before_termination(self) -> None:
        request = self.request("failed")
        status = self.status("failed")
        status["error"] = "Codex failed"
        s3, table, ec2 = self.clients(request=request, status=status)

        def client(name: str):
            return {"s3": s3, "table": table, "ec2": ec2}[name]

        with patch.object(handler, "_client", side_effect=client):
            handler.lambda_handler(self.event(), None)

        s3.head_object.assert_called_once_with(
            Bucket="agent-workspace-bucket",
            Key=f"{self.prefix}/result/failure.md",
        )
        ec2.terminate_instances.assert_called_once_with(InstanceIds=[self.instance_id])


if __name__ == "__main__":
    unittest.main()
