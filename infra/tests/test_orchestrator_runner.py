from __future__ import annotations

import importlib.util
import json
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
        run.codex_home = root / "codex-home"
        run.plan_file = run.workspace / "plan.md"
        run.final_message = run.workspace / "final.md"
        run.final_result = run.workspace / "final_result.json"
        run.result_dir = root / "result"
        run.completed_file = run.result_dir / "completed.md"
        run.failure_file = run.result_dir / "failure.md"
        run.bootstrap_log = root / "logs" / "bootstrap.log"
        run.codex_log = root / "logs" / "codex.log"
        run.workspace_bucket = "agent-workspace-bucket"
        run.s3 = Mock()
        run.mcp_command = root / "spawn-agent-mcp"
        run.documentation_dir = root / "documentation"
        run.documentation_dir.mkdir()
        (run.documentation_dir / "DATABASE.md").write_text(
            "Database navigation", encoding="utf-8"
        )
        run.mcp_command.write_text("#!/bin/sh\n", encoding="utf-8")
        run.mcp_command.chmod(0o755)
        run.prepare_directories()
        run.bootstrap_log.parent.mkdir()
        run.bootstrap_log.write_text("cloud-init started\n", encoding="utf-8")
        run.codex_log.write_text("", encoding="utf-8")
        return run

    def write_codex_outputs(self, run: OrchestratorRun) -> None:
        run.plan_file.write_text("# Research plan\n", encoding="utf-8")
        run.final_message.write_text("Research result", encoding="utf-8")
        run.final_result.write_text(
            json.dumps(
                {
                    "companies": [{"name": "Example Corp", "value": 42}],
                    "notes": "Structure chosen for this research task",
                }
            ),
            encoding="utf-8",
        )

    def test_codex_exec_receives_task_search_model_and_writable_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            task = "Compare two public companies."

            def complete_codex(command, **kwargs):
                self.write_codex_outputs(run)
                return Mock(returncode=0)

            with patch.object(runner_module.subprocess, "run", side_effect=complete_codex) as call:
                run.run_codex(task)

            command = call.call_args.args[0]
            self.assertLess(command.index("--search"), command.index("exec"))
            self.assertEqual(command[command.index("--model") + 1], "gpt-5.6-terra")
            self.assertEqual(command[command.index("--sandbox") + 1], "workspace-write")
            self.assertEqual(command[-1], task)
            self.assertEqual(call.call_args.kwargs["env"]["CODEX_HOME"], str(run.codex_home))
            self.assertIs(call.call_args.kwargs["stderr"], runner_module.subprocess.STDOUT)
            self.assertEqual(call.call_args.kwargs["stdout"].name, str(run.codex_log))
            self.assertEqual(
                call.call_args.kwargs["env"]["ORCHESTRATOR_WORKSPACE"],
                str(run.workspace),
            )

            config = (run.codex_home / "config.toml").read_text(encoding="utf-8")
            self.assertIn("You have been given the following task", config)
            self.assertIn("create a plan.md file", config)
            self.assertIn("create final_result.json", config)
            self.assertIn("Choose the JSON structure", config)
            self.assertIn("active_subagent_limit_reached", config)
            self.assertIn("A subagent should have ownership over a single URL", config)
            self.assertIn("Include the URL of the website", config)
            self.assertIn("use Playwright with Chromium", config)
            self.assertIn("click through and explore", config)
            self.assertIn("pagination, filters, expandable sections", config)
            self.assertIn("strong but bounded effort", config)
            self.assertIn("stop searching rather than repeatedly", config)
            self.assertIn("unavailable or not publicly listed", config)
            self.assertIn("and then finish normally", config)
            self.assertIn("following relevant same-site links", config)
            self.assertIn("Do not perform web scraping in the orchestrator", config)
            self.assertIn("retain that rejected task", config)
            self.assertIn("retry the rejected task until its spawn request is accepted", config)
            self.assertIn("must never cause a planned task to be abandoned", config)
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
            with patch.object(runner_module.subprocess, "run") as call:
                with self.assertRaisesRegex(RuntimeError, "spawn_agent MCP executable is missing"):
                    run.run_codex("Investigate a market.")
            call.assert_not_called()

    def test_invalid_final_result_json_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))

            def complete_codex(command, **kwargs):
                self.write_codex_outputs(run)
                run.final_result.write_text(
                    "not-json",
                    encoding="utf-8",
                )
                return Mock(returncode=0)

            with patch.object(runner_module.subprocess, "run", side_effect=complete_codex):
                with self.assertRaisesRegex(RuntimeError, "valid JSON"):
                    run.run_codex("Investigate a market.")

    def test_upload_outputs_publishes_plan_json_and_final_message(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            self.write_codex_outputs(run)

            uploaded = run.upload_outputs()

            keys = [call.kwargs["Key"] for call in run.s3.put_object.call_args_list]
            self.assertEqual(
                keys,
                [
                    f"jobs/{run.job_id}/result/plan.md",
                    f"jobs/{run.job_id}/result/final_result.json",
                    f"jobs/{run.job_id}/result/final.md",
                ],
            )
            self.assertTrue(uploaded["plan_uri"].endswith("/result/plan.md"))
            self.assertTrue(
                uploaded["final_result_uri"].endswith("/result/final_result.json")
            )

    def test_debug_bundle_and_terminal_marker_are_uploaded_before_shutdown(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            self.write_codex_outputs(run)
            (run.workspace / "collected").mkdir()
            (run.workspace / "collected" / "agent-data.json").write_text(
                '{"records": []}\n', encoding="utf-8"
            )

            outputs = run.upload_outputs()
            outputs.update(run.upload_debug_artifacts())
            outputs["completion_marker_uri"] = run.terminal_marker_uri("completed")
            run.upload_status("completed", **outputs)
            run.upload_terminal_marker("completed")

            keys = [call.kwargs["Key"] for call in run.s3.put_object.call_args_list]
            prefix = f"jobs/{run.job_id}/orchestrator"
            self.assertIn(f"{prefix}/debug/bootstrap.log", keys)
            self.assertIn(f"{prefix}/debug/codex.log", keys)
            self.assertIn(f"{prefix}/workspace/plan.md", keys)
            self.assertIn(f"{prefix}/workspace/collected/agent-data.json", keys)
            self.assertEqual(keys[-2], f"{prefix}/status/completed.json")
            self.assertEqual(keys[-1], f"{prefix}/result/completed.md")
            self.assertEqual(
                run.completed_file.read_text(encoding="utf-8"),
                "Completed successfully.\n",
            )

    def test_refreshed_auth_does_not_overwrite_a_manual_rotation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            run.auth_parameter = "/project/codex/auth-json"
            run.original_auth = '{"tokens":"old"}'
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
