from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True


class FastMCPStub:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def tool(self, *args, **kwargs):
        def decorate(function):
            return function

        return decorate

    def run(self, *args, **kwargs):
        raise AssertionError("the stdio server must not start during unit tests")


if "boto3" not in sys.modules:
    boto3_stub = types.ModuleType("boto3")
    boto3_stub.client = Mock()
    sys.modules["boto3"] = boto3_stub
if "mcp.server.fastmcp" not in sys.modules:
    mcp_stub = types.ModuleType("mcp")
    server_stub = types.ModuleType("mcp.server")
    fastmcp_stub = types.ModuleType("mcp.server.fastmcp")
    fastmcp_stub.FastMCP = FastMCPStub
    mcp_stub.server = server_stub
    server_stub.fastmcp = fastmcp_stub
    sys.modules["mcp"] = mcp_stub
    sys.modules["mcp.server"] = server_stub
    sys.modules["mcp.server.fastmcp"] = fastmcp_stub

server_path = (
    Path(__file__).resolve().parents[1]
    / "runtime"
    / "orchestrator"
    / "bin"
    / "spawn_agent_mcp.py"
)
server_spec = importlib.util.spec_from_file_location("spawn_agent_mcp", server_path)
assert server_spec and server_spec.loader
server_module = importlib.util.module_from_spec(server_spec)
sys.modules[server_spec.name] = server_module
server_spec.loader.exec_module(server_module)


class SpawnAgentMcpTests(unittest.TestCase):
    environment = {
        "AWS_REGION": "us-east-1",
        "FUNCTION_NAME": "subagent-manager",
        "AGENT_WORKSPACE_BUCKET_NAME": "agent-workspace-bucket",
        "JOB_ID": "job_abc1_1234abcd",
        "ORCHESTRATOR_INSTANCE_ID": "i-1234567890abcdef0",
        "SUBAGENT_MODEL": "gpt-5.6-luna",
    }

    def test_spawn_agent_stores_task_and_invokes_lambda_with_trusted_values(self) -> None:
        s3 = Mock()
        lambda_client = Mock()
        lambda_client.invoke.return_value = {
            "Payload": io.BytesIO(
                json.dumps(
                    {
                        "statusCode": 201,
                        "body": {
                            "accepted": True,
                            "agent_id": "agent-from-lambda",
                            "instance_id": "i-0123456789abcdef0",
                            "active_count": 1,
                        },
                    }
                ).encode("utf-8")
            )
        }

        def client(service, **kwargs):
            return {"s3": s3, "lambda": lambda_client}[service]

        with patch.dict(os.environ, self.environment, clear=True):
            with patch.object(server_module.boto3, "client", side_effect=client):
                result = server_module.spawn_agent("  Investigate revenue quality.  ")

        expected_id = server_module.stable_agent_id(
            self.environment["JOB_ID"], "Investigate revenue quality."
        )
        stored = s3.put_object.call_args.kwargs
        self.assertEqual(stored["Bucket"], "agent-workspace-bucket")
        stored_record = json.loads(stored["Body"])
        self.assertEqual(stored_record["task"], "Investigate revenue quality.")
        self.assertEqual(stored_record["model"], "gpt-5.6-luna")
        self.assertIn(expected_id, stored["Key"])

        invoked = json.loads(lambda_client.invoke.call_args.kwargs["Payload"])
        self.assertEqual(invoked["request_id"], expected_id)
        self.assertEqual(invoked["model"], "gpt-5.6-luna")
        self.assertEqual(invoked["task"], "Investigate revenue quality.")
        self.assertEqual(
            invoked["orchestrator_id"], self.environment["ORCHESTRATOR_INSTANCE_ID"]
        )
        self.assertEqual(result["instance_id"], "i-0123456789abcdef0")
        self.assertEqual(result["agent_id"], "agent-from-lambda")
        self.assertTrue(result["accepted"])

    def test_identical_task_retries_use_the_same_agent_id(self) -> None:
        first = server_module.stable_agent_id("job_abc1_1234abcd", "same task")
        second = server_module.stable_agent_id("job_abc1_1234abcd", "same task")
        different_job = server_module.stable_agent_id("job_def2_deadbeef", "same task")
        self.assertEqual(first, second)
        self.assertNotEqual(first, different_job)

    def test_capacity_rejection_is_returned_as_a_structured_result(self) -> None:
        s3 = Mock()
        lambda_client = Mock()
        lambda_client.invoke.return_value = {
            "Payload": io.BytesIO(
                json.dumps(
                    {
                        "statusCode": 429,
                        "body": {
                            "accepted": False,
                            "error": "active_subagent_limit_reached",
                            "max_active_subagents": 8,
                        },
                    }
                ).encode("utf-8")
            )
        }

        with patch.dict(os.environ, self.environment, clear=True):
            with patch.object(
                server_module.boto3,
                "client",
                side_effect=lambda service, **kwargs: {
                    "s3": s3,
                    "lambda": lambda_client,
                }[service],
            ):
                result = server_module.spawn_agent("Ninth task")

        self.assertFalse(result["accepted"])
        self.assertEqual(result["status_code"], 429)
        self.assertEqual(result["error"], "active_subagent_limit_reached")
        self.assertEqual(result["max_active_subagents"], 8)

    def test_wait_on_any_downloads_summary_and_json_but_not_marker(self) -> None:
        agent_id = "agent-0123456789abcdef01234567"
        s3 = Mock()

        class MissingObject(Exception):
            response = {"Error": {"Code": "NoSuchKey"}}

        completed_status = {
            "schema_version": 1,
            "state": "completed",
            "job_id": self.environment["JOB_ID"],
            "orchestrator_instance_id": self.environment["ORCHESTRATOR_INSTANCE_ID"],
            "agent_id": agent_id,
        }

        def head_object(**kwargs):
            if kwargs["Key"].endswith("/result/completed.md"):
                return {}
            raise MissingObject()

        def get_object(**kwargs):
            key = kwargs["Key"]
            agent_prefix = f"jobs/{self.environment['JOB_ID']}/agents/{agent_id}"
            objects = {
                f"{agent_prefix}/status/completed.json": json.dumps(completed_status).encode(
                    "utf-8"
                ),
                f"{agent_prefix}/summary/summary.md": b"Approach and findings",
                f"{agent_prefix}/summary/results_{agent_id}.json": (
                    b'{"records":[{"value":42}]}'
                ),
            }
            if key not in objects:
                raise MissingObject()
            return {"Body": io.BytesIO(objects[key]), "ContentLength": len(objects[key])}

        s3.head_object.side_effect = head_object
        s3.get_object.side_effect = get_object
        with tempfile.TemporaryDirectory() as temporary:
            environment = {
                **self.environment,
                "ORCHESTRATOR_WORKSPACE": temporary,
            }
            with patch.dict(os.environ, environment, clear=True):
                with patch.object(server_module.boto3, "client", return_value=s3):
                    result = server_module.wait_on_any([agent_id], timeout_seconds=0)

            terminal = result["terminal"]
            self.assertEqual(terminal["state"], "completed")
            self.assertEqual(Path(terminal["summary_path"]).read_text(), "Approach and findings")
            self.assertEqual(
                json.loads(Path(terminal["results_path"]).read_text()),
                {"records": [{"value": 42}]},
            )
            self.assertTrue(result["event_received"])
            self.assertTrue(result["all_terminal"])
            self.assertEqual(result["remaining_agent_ids"], [])
            self.assertFalse(result["terminal_markers_downloaded"])
            requested_keys = [call.kwargs["Key"] for call in s3.get_object.call_args_list]
            self.assertNotIn(
                f"jobs/{self.environment['JOB_ID']}/agents/{agent_id}/result/completed.md",
                requested_keys,
            )
            self.assertTrue(
                any(
                    call.kwargs["Key"].endswith("/result/completed.md")
                    for call in s3.head_object.call_args_list
                )
            )

    def test_wait_on_any_returns_remaining_ids_after_timeout(self) -> None:
        agent_id = "agent-0123456789abcdef01234567"
        s3 = Mock()

        class MissingObject(Exception):
            response = {"Error": {"Code": "NoSuchKey"}}

        s3.head_object.side_effect = MissingObject()
        with tempfile.TemporaryDirectory() as temporary:
            environment = {
                **self.environment,
                "ORCHESTRATOR_WORKSPACE": temporary,
            }
            with patch.dict(os.environ, environment, clear=True):
                with patch.object(server_module.boto3, "client", return_value=s3):
                    result = server_module.wait_on_any([agent_id], timeout_seconds=0)

        self.assertFalse(result["all_terminal"])
        self.assertFalse(result["event_received"])
        self.assertTrue(result["timed_out"])
        self.assertIsNone(result["terminal"])
        self.assertEqual(result["remaining_agent_ids"], [agent_id])

    def test_wait_on_any_reports_subagent_failure_without_downloading_marker(self) -> None:
        agent_id = "agent-0123456789abcdef01234567"
        s3 = Mock()

        class MissingObject(Exception):
            response = {"Error": {"Code": "NoSuchKey"}}

        failed_status = {
            "schema_version": 1,
            "state": "failed",
            "job_id": self.environment["JOB_ID"],
            "orchestrator_instance_id": self.environment["ORCHESTRATOR_INSTANCE_ID"],
            "agent_id": agent_id,
            "error_type": "RuntimeError",
            "error": "research failed",
        }

        def head_object(**kwargs):
            if kwargs["Key"].endswith("/result/completed.md"):
                raise MissingObject()
            return {}

        def get_object(**kwargs):
            return {"Body": io.BytesIO(json.dumps(failed_status).encode("utf-8"))}

        s3.head_object.side_effect = head_object
        s3.get_object.side_effect = get_object
        with tempfile.TemporaryDirectory() as temporary:
            environment = {
                **self.environment,
                "ORCHESTRATOR_WORKSPACE": temporary,
            }
            with patch.dict(os.environ, environment, clear=True):
                with patch.object(server_module.boto3, "client", return_value=s3):
                    result = server_module.wait_on_any([agent_id], timeout_seconds=0)

        self.assertTrue(result["all_terminal"])
        self.assertEqual(result["terminal"]["state"], "failed")
        self.assertEqual(result["terminal"]["error"], "research failed")

    def test_wait_on_any_returns_when_one_of_multiple_agents_is_terminal(self) -> None:
        pending_id = "agent-0123456789abcdef01234567"
        completed_id = "agent-fedcba9876543210fedcba98"
        s3 = Mock()

        class MissingObject(Exception):
            response = {"Error": {"Code": "NoSuchKey"}}

        completed_status = {
            "schema_version": 1,
            "state": "completed",
            "job_id": self.environment["JOB_ID"],
            "orchestrator_instance_id": self.environment["ORCHESTRATOR_INSTANCE_ID"],
            "agent_id": completed_id,
        }

        def head_object(**kwargs):
            key = kwargs["Key"]
            if completed_id in key and key.endswith("/result/completed.md"):
                return {}
            raise MissingObject()

        def get_object(**kwargs):
            key = kwargs["Key"]
            completed_prefix = f"jobs/{self.environment['JOB_ID']}/agents/{completed_id}"
            objects = {
                f"{completed_prefix}/status/completed.json": json.dumps(
                    completed_status
                ).encode("utf-8"),
                f"{completed_prefix}/summary/summary.md": b"Completed second agent",
                f"{completed_prefix}/summary/results_{completed_id}.json": b'{"value":2}',
            }
            if key not in objects:
                raise MissingObject()
            return {"Body": io.BytesIO(objects[key]), "ContentLength": len(objects[key])}

        s3.head_object.side_effect = head_object
        s3.get_object.side_effect = get_object
        with tempfile.TemporaryDirectory() as temporary:
            environment = {
                **self.environment,
                "ORCHESTRATOR_WORKSPACE": temporary,
            }
            with patch.dict(os.environ, environment, clear=True):
                with patch.object(server_module.boto3, "client", return_value=s3):
                    with patch.object(server_module.time, "sleep") as sleep:
                        result = server_module.wait_on_any([pending_id, completed_id])

        sleep.assert_not_called()
        self.assertTrue(result["event_received"])
        self.assertFalse(result["timed_out"])
        self.assertFalse(result["all_terminal"])
        self.assertEqual(result["terminal"]["agent_id"], completed_id)
        self.assertEqual(result["terminal"]["state"], "completed")
        self.assertEqual(result["remaining_agent_ids"], [pending_id])


if __name__ == "__main__":
    unittest.main()
