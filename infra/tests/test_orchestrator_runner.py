from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True

# The production AMI installs boto3 in /opt/multi-agent/venv. Keep these unit
# tests runnable with the host Python by providing import-only stubs; individual
# AWS clients are mocked in every test that uses them.
if "boto3" not in sys.modules:
    boto3_stub = types.ModuleType("boto3")
    boto3_stub.client = Mock()
    sys.modules["boto3"] = boto3_stub
if "botocore.exceptions" not in sys.modules:
    botocore_stub = types.ModuleType("botocore")
    exceptions_stub = types.ModuleType("botocore.exceptions")

    class ClientError(Exception):
        pass

    exceptions_stub.ClientError = ClientError
    botocore_stub.exceptions = exceptions_stub
    sys.modules["botocore"] = botocore_stub
    sys.modules["botocore.exceptions"] = exceptions_stub

runner_path = (
    Path(__file__).resolve().parents[1]
    / "runtime"
    / "orchestrator"
    / "bin"
    / "orchestrator_runner.py"
)
runner_spec = importlib.util.spec_from_file_location("orchestrator_runner", runner_path)
assert runner_spec and runner_spec.loader
runner_module = importlib.util.module_from_spec(runner_spec)
sys.modules[runner_spec.name] = runner_module
runner_spec.loader.exec_module(runner_module)
OrchestratorRun = runner_module.OrchestratorRun


class OrchestratorRunnerTests(unittest.TestCase):
    def make_run(self, root: Path) -> OrchestratorRun:
        run = OrchestratorRun.__new__(OrchestratorRun)
        run.job_id = "job_abc1_1234abcd"
        run.orchestrator_instance_id = "i-1234567890abcdef0"
        run.orchestrator_model = "gpt-5.6-terra"
        run.subagent_model = "gpt-5.6-luna"
        run.workspace = root / "workspace"
        run.codex_home = run.workspace / ".codex"
        run.final_message = run.workspace / "final.md"
        run.mcp_command = root / "spawn-agent-mcp"
        run.documentation_dir = root / "documentation"
        run.documentation_dir.mkdir()
        (run.documentation_dir / "DATABASE.md").write_text(
            "Database navigation", encoding="utf-8"
        )
        run.mcp_command.write_text("#!/bin/sh\n", encoding="utf-8")
        run.mcp_command.chmod(0o755)
        return run

    def test_codex_exec_receives_task_search_model_and_writable_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            task = "Compare two public companies."

            def complete_codex(command, **kwargs):
                run.final_message.write_text("Research result", encoding="utf-8")
                return Mock(returncode=0)

            with patch.object(runner_module.subprocess, "run", side_effect=complete_codex) as call:
                run.run_codex(task)

            command = call.call_args.args[0]
            self.assertLess(command.index("--search"), command.index("exec"))
            self.assertEqual(command[command.index("--model") + 1], "gpt-5.6-terra")
            self.assertEqual(command[command.index("--sandbox") + 1], "workspace-write")
            self.assertEqual(command[-1], task)
            self.assertEqual(call.call_args.kwargs["env"]["CODEX_HOME"], str(run.codex_home))
            self.assertEqual(
                call.call_args.kwargs["env"]["ORCHESTRATOR_WORKSPACE"],
                str(run.workspace),
            )

            config = (run.codex_home / "config.toml").read_text(encoding="utf-8")
            self.assertIn("You have been given the following task", config)
            self.assertIn("create a plan.md file", config)
            self.assertIn("[mcp_servers.subagent_manager.tools.spawn_agent]", config)
            self.assertIn(
                "[mcp_servers.subagent_manager.tools.collect_agent_results]",
                config,
            )
            self.assertIn('"ORCHESTRATOR_WORKSPACE"', config)
            self.assertIn('"SUBAGENT_MODEL"', config)
            self.assertEqual(
                (run.workspace / "documentation" / "DATABASE.md").read_text(encoding="utf-8"),
                "Database navigation",
            )

    def test_missing_spawn_agent_server_fails_before_codex(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            run.mcp_command.unlink()
            run.workspace.mkdir()
            with patch.object(runner_module.subprocess, "run") as call:
                with self.assertRaisesRegex(RuntimeError, "spawn_agent MCP executable is missing"):
                    run.run_codex("Investigate a market.")
            call.assert_not_called()

    def test_refreshed_auth_does_not_overwrite_a_manual_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            run.auth_parameter = "/project/codex/auth-json"
            run.original_auth = '{"tokens":"old"}'
            run.codex_home.mkdir(parents=True)
            (run.codex_home / "auth.json").write_text(
                '{"tokens":"refreshed"}', encoding="utf-8"
            )
            run.ssm = Mock()
            run.ssm.get_parameter.return_value = {
                "Parameter": {"Value": '{"tokens":"manually-rotated"}'}
            }

            run.persist_refreshed_auth()

            run.ssm.put_parameter.assert_not_called()


if __name__ == "__main__":
    unittest.main()
