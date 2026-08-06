from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
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


if __name__ == "__main__":
    unittest.main()
