from __future__ import annotations

import importlib.util
import inspect
import io
import json
import os
import subprocess
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


ROOT = Path(__file__).resolve().parents[2]
BIN_DIR = ROOT / "infra/runtime/orch_software_builder/bin"
sys.path.insert(0, str(BIN_DIR))


def _load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN_DIR / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {filename}.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


if "software_project_credentials" not in sys.modules:
    _load_module("software_project_credentials", "software_project_credentials.py")
server = _load_module("vercel_publisher_mcp", "vercel_publisher_mcp.py")


class VercelPublisherMcpTests(unittest.TestCase):
    environment = {
        "AWS_REGION": "us-east-1",
        "VERCEL_PUBLISHER_FUNCTION_NAME": "vercel-publisher",
        "GITHUB_TOKEN_BROKER_FUNCTION_NAME": "github-token-broker",
        "JOB_ID": "job_abc1_1234abcd",
        "ORCHESTRATOR_INSTANCE_ID": "i-1234567890abcdef0",
        "SOFTWARE_BUILDER_REPOSITORY_ROOT": "/work/repository",
    }
    source = {
        "repository_full_name": "mas-workspace/generated-site",
        "branch": "main",
        "commit_sha": "a" * 40,
    }

    def setUp(self) -> None:
        server._deployment_ids.clear()

    def deployment_body(
        self,
        ready_state: str,
        *,
        public_url: str | None = None,
        error_message: str | None = None,
    ) -> dict:
        return {
            "repository": {
                "id": 123456,
                "full_name": self.source["repository_full_name"],
            },
            "deployment": {
                "id": "dpl_abc123",
                "ready_state": ready_state,
                "terminal": ready_state in {"READY", "ERROR", "CANCELED"},
                "target": "production",
                "project_id": "prj_abc123",
                "project_name": "generated-site",
                "commit_sha": self.source["commit_sha"],
                "branch": self.source["branch"],
                "deployment_url": "https://generated-site-abc.vercel.app",
                "public_url": public_url,
                "alias_assigned": public_url is not None,
                "error_code": "BUILD_FAILED" if error_message else None,
                "error_message": error_message,
            },
        }

    def test_tool_accepts_no_model_selected_scope(self) -> None:
        self.assertEqual(list(inspect.signature(server.publish_site).parameters), [])

    def test_current_commit_must_be_clean_and_present_on_origin(self) -> None:
        commit_sha = self.source["commit_sha"]
        responses = [
            subprocess.CompletedProcess([], 0, "", ""),
            subprocess.CompletedProcess([], 0, "main\n", ""),
            subprocess.CompletedProcess([], 0, f"{commit_sha}\n", ""),
            subprocess.CompletedProcess(
                [],
                0,
                "https://github.com/mas-workspace/generated-site.git\n",
                "",
            ),
            subprocess.CompletedProcess(
                [],
                0,
                f"{commit_sha}\trefs/heads/main\n",
                "",
            ),
        ]
        with (
            patch.object(Path, "is_dir", return_value=True),
            patch.object(server.subprocess, "run", side_effect=responses) as run,
        ):
            result = server.current_pushed_commit(Path("/work/repository"))

        self.assertEqual(result, self.source)
        self.assertEqual(run.call_count, 5)
        self.assertEqual(
            run.call_args_list[-1].args[0][-4:],
            ["ls-remote", "--exit-code", "origin", "refs/heads/main"],
        )

    def test_dirty_repository_is_rejected_before_publication(self) -> None:
        with (
            patch.object(Path, "is_dir", return_value=True),
            patch.object(
                server.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, " M app.py\n", ""),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "working tree clean"):
                server.current_pushed_commit(Path("/work/repository"))

    def test_publish_invokes_then_polls_until_public_url_is_ready(self) -> None:
        with (
            patch.dict(os.environ, self.environment, clear=True),
            patch.object(server, "current_pushed_commit", return_value=self.source),
            patch.object(
                server,
                "_invoke_publisher",
                side_effect=[
                    self.deployment_body("QUEUED"),
                    self.deployment_body("BUILDING"),
                    self.deployment_body(
                        "READY",
                        public_url="https://generated-site.vercel.app",
                    ),
                ],
            ) as invoke,
            patch.object(server.time, "sleep") as sleep,
        ):
            result = server.publish_site()

        self.assertTrue(result["published"])
        self.assertEqual(result["public_url"], "https://generated-site.vercel.app")
        self.assertEqual(result["commit_sha"], self.source["commit_sha"])
        self.assertEqual(
            [call.kwargs["action"] for call in invoke.call_args_list],
            ["publish", "status", "status"],
        )
        self.assertIsNone(invoke.call_args_list[0].kwargs["deployment_id"])
        self.assertEqual(
            invoke.call_args_list[1].kwargs["deployment_id"],
            "dpl_abc123",
        )
        self.assertEqual(sleep.call_count, 2)

    def test_retry_polls_the_existing_deployment_instead_of_republishing(self) -> None:
        cache_key = (
            self.environment["JOB_ID"],
            self.source["branch"],
            self.source["commit_sha"],
        )
        server._deployment_ids[cache_key] = "dpl_abc123"
        with (
            patch.dict(os.environ, self.environment, clear=True),
            patch.object(server, "current_pushed_commit", return_value=self.source),
            patch.object(
                server,
                "_invoke_publisher",
                return_value=self.deployment_body(
                    "READY",
                    public_url="https://generated-site.vercel.app",
                ),
            ) as invoke,
        ):
            server.publish_site()

        self.assertEqual(invoke.call_count, 1)
        self.assertEqual(invoke.call_args.kwargs["action"], "status")

    def test_terminal_vercel_failure_is_reported_without_another_poll(self) -> None:
        with (
            patch.dict(os.environ, self.environment, clear=True),
            patch.object(server, "current_pushed_commit", return_value=self.source),
            patch.object(
                server,
                "_invoke_publisher",
                return_value=self.deployment_body(
                    "ERROR",
                    error_message="The application build failed.",
                ),
            ) as invoke,
            patch.object(server.time, "sleep") as sleep,
        ):
            with self.assertRaisesRegex(RuntimeError, "application build failed"):
                server.publish_site()

        self.assertEqual(invoke.call_count, 1)
        sleep.assert_not_called()

    def test_lambda_request_contains_identity_and_commit_but_no_scope_controls(self) -> None:
        lambda_client = Mock()
        lambda_client.invoke.return_value = {
            "Payload": io.BytesIO(
                json.dumps(
                    {
                        "statusCode": 200,
                        "body": self.deployment_body("QUEUED"),
                    }
                ).encode("utf-8")
            )
        }
        with (
            patch.dict(os.environ, self.environment, clear=True),
            patch.object(server.boto3, "client", return_value=lambda_client),
        ):
            server._invoke_publisher(
                action="publish",
                deployment_id=None,
                branch=self.source["branch"],
                commit_sha=self.source["commit_sha"],
            )

        event = json.loads(lambda_client.invoke.call_args.kwargs["Payload"])
        self.assertEqual(
            set(event),
            {
                "action",
                "job_id",
                "orchestrator_instance_id",
                "branch",
                "commit_sha",
            },
        )
        self.assertNotIn("repository", event)
        self.assertNotIn("project", event)
        self.assertNotIn("team_id", event)


class VercelPublisherMcpInfrastructureTests(unittest.TestCase):
    def test_software_builder_image_installs_and_validates_mcp(self) -> None:
        images = (ROOT / "infra/images.tf").read_text(encoding="utf-8")
        software_component = images.split(
            'resource "aws_imagebuilder_component" "software_builder_base_runtime"',
            1,
        )[1].split(
            'resource "aws_imagebuilder_component" "subagent_browser_tools"',
            1,
        )[0]

        self.assertIn("--upgrade pip boto3 'mcp>=1.27,<2'", software_component)
        self.assertIn("from mcp.server.fastmcp import FastMCP", software_component)

    def test_launcher_passes_only_the_publisher_environment(self) -> None:
        launcher = (
            ROOT
            / "infra/runtime/orch_software_builder/bin/vercel-publisher-mcp"
        ).read_text(encoding="utf-8")

        self.assertIn("exec /usr/bin/env -i", launcher)
        self.assertIn('VERCEL_PUBLISHER_FUNCTION_NAME="$VERCEL_PUBLISHER_FUNCTION_NAME"', launcher)
        self.assertIn(
            'GITHUB_TOKEN_BROKER_FUNCTION_NAME="$GITHUB_TOKEN_BROKER_FUNCTION_NAME"',
            launcher,
        )
        self.assertNotIn("DATABASE_URL", launcher)
        self.assertNotIn("AWS_PROFILE", launcher)


if __name__ == "__main__":
    unittest.main()
