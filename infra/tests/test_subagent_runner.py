from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True

if "boto3" not in sys.modules:
    boto3_stub = types.ModuleType("boto3")
    boto3_stub.client = Mock()
    sys.modules["boto3"] = boto3_stub

runner_path = (
    Path(__file__).resolve().parents[1]
    / "runtime"
    / "subagent"
    / "bin"
    / "subagent_runner.py"
)
runner_spec = importlib.util.spec_from_file_location("subagent_runner", runner_path)
assert runner_spec and runner_spec.loader
runner_module = importlib.util.module_from_spec(runner_spec)
sys.modules[runner_spec.name] = runner_module
runner_spec.loader.exec_module(runner_module)
SubagentRun = runner_module.SubagentRun


class SubagentRunnerTests(unittest.TestCase):
    def make_run(self, root: Path) -> SubagentRun:
        run = SubagentRun.__new__(SubagentRun)
        run.region = "us-east-1"
        run.workspace_bucket = "agent-workspace-bucket"
        run.global_memory_bucket = "global-memory-bucket"
        run.auth_parameter = "/project/codex/auth-json"
        run.job_id = "job_abc1_1234abcd"
        run.agent_id = "agent-0123456789abcdef01234567"
        run.orchestrator_instance_id = "i-1234567890abcdef0"
        run.subagent_instance_id = "i-abcdef01234567890"
        run.model = "gpt-5.6-luna"
        run.agent_prefix = f"jobs/{run.job_id}/agents/{run.agent_id}"
        run.task_s3_key = f"{run.agent_prefix}/input.json"
        run.work_dir = root / "work"
        run.summary_dir = root / "summary"
        run.result_dir = root / "result"
        run.summary_file = run.summary_dir / "summary.md"
        run.results_file = run.summary_dir / f"results_{run.agent_id}.json"
        run.completed_file = run.result_dir / "completed.md"
        run.failure_file = run.result_dir / "failure.md"
        run.codex_final_message = run.work_dir / "codex-final-message.md"
        run.codex_home = root / "codex-home"
        run.bootstrap_log = root / "logs" / "bootstrap.log"
        run.codex_log = root / "logs" / "codex.log"
        run.s3 = Mock()
        run.ssm = Mock()
        run.prepare_directories()
        run.bootstrap_log.parent.mkdir()
        run.bootstrap_log.write_text("cloud-init started\n", encoding="utf-8")
        run.codex_log.write_text("", encoding="utf-8")
        return run

    def task_spec(self, run: SubagentRun) -> dict[str, object]:
        return {
            "schema_version": 1,
            "job_id": run.job_id,
            "orchestrator_instance_id": run.orchestrator_instance_id,
            "agent_id": run.agent_id,
            "model": run.model,
            "task": "Investigate revenue quality.",
            "created_at": "2026-01-01T00:00:00Z",
        }

    def test_download_task_validates_identity_and_keeps_input_in_work(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            task = self.task_spec(run)
            encoded = json.dumps(task).encode("utf-8")
            run.s3.get_object.return_value = {"Body": io.BytesIO(encoded)}

            loaded = run.download_task()

            self.assertEqual(loaded["task"], "Investigate revenue quality.")
            self.assertEqual((run.work_dir / "input.json").read_bytes(), encoded)
            run.s3.get_object.assert_called_once_with(
                Bucket=run.workspace_bucket,
                Key=run.task_s3_key,
            )

    def test_download_task_rejects_mismatched_agent_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            task = self.task_spec(run)
            task["agent_id"] = "agent-ffffffffffffffffffffffff"
            run.s3.get_object.return_value = {
                "Body": io.BytesIO(json.dumps(task).encode("utf-8"))
            }

            with self.assertRaisesRegex(RuntimeError, "agent_id does not match"):
                run.download_task()

    def test_codex_is_noninteractive_and_confined_to_three_output_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))

            def complete_codex(command, **kwargs):
                run.summary_file.write_text("Work summary", encoding="utf-8")
                run.results_file.write_text('{"records": [{"value": 42}]}', encoding="utf-8")
                return Mock(returncode=0)

            with patch.object(
                runner_module.subprocess,
                "run",
                side_effect=complete_codex,
            ) as call:
                run.run_codex("Investigate revenue quality.")

            command = call.call_args.args[0]
            self.assertEqual(command[command.index("--ask-for-approval") + 1], "never")
            self.assertEqual(command[command.index("--sandbox") + 1], "workspace-write")
            self.assertEqual(command[command.index("--cd") + 1], str(run.work_dir))
            self.assertNotIn("danger-full-access", command)
            self.assertEqual(call.call_args.kwargs["env"]["CODEX_HOME"], str(run.codex_home))
            self.assertIs(call.call_args.kwargs["stderr"], runner_module.subprocess.STDOUT)
            self.assertEqual(call.call_args.kwargs["stdout"].name, str(run.codex_log))
            self.assertEqual(
                call.call_args.kwargs["env"]["TMPDIR"],
                str(run.work_dir / "tmp"),
            )
            self.assertEqual(
                command[command.index("--output-last-message") + 1],
                str(run.codex_final_message),
            )

            config = (run.codex_home / "config.toml").read_text(encoding="utf-8")
            self.assertIn('approval_policy = "never"', config)
            self.assertIn("save the exact script you ran", config)
            self.assertIn("raw and processed scraped data files", config)
            self.assertIn('writable_roots = ["/summary"]', config)
            self.assertIn("network_access = true", config)
            self.assertIn("exclude_slash_tmp = true", config)

    def test_invalid_results_json_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))

            def complete_codex(command, **kwargs):
                run.summary_file.write_text("Work summary", encoding="utf-8")
                run.results_file.write_text("not-json", encoding="utf-8")
                return Mock(returncode=0)

            with patch.object(runner_module.subprocess, "run", side_effect=complete_codex):
                with self.assertRaisesRegex(RuntimeError, "valid UTF-8 JSON"):
                    run.run_codex("Investigate revenue quality.")

    def test_completion_marker_is_uploaded_last(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            run.summary_file.write_text("Work summary", encoding="utf-8")
            run.results_file.write_text('{"records": []}', encoding="utf-8")
            (run.work_dir / "scrape.py").write_text("print('scrape')\n", encoding="utf-8")
            (run.work_dir / "scraped-data.json").write_text("[]\n", encoding="utf-8")

            outputs = run.upload_data_outputs()
            outputs.update(run.upload_debug_artifacts())
            outputs["completion_marker_uri"] = run.terminal_marker_uri("completed")
            run.upload_status("completed", **outputs)
            run.upload_terminal_marker("completed")

            calls = run.s3.put_object.call_args_list
            self.assertEqual(calls[0].kwargs["Key"], f"{run.agent_prefix}/summary/summary.md")
            self.assertEqual(
                calls[1].kwargs["Key"],
                f"{run.agent_prefix}/summary/results_{run.agent_id}.json",
            )
            keys = [call.kwargs["Key"] for call in calls]
            self.assertIn(f"{run.agent_prefix}/debug/bootstrap.log", keys)
            self.assertIn(f"{run.agent_prefix}/debug/codex.log", keys)
            self.assertIn(f"{run.agent_prefix}/work/scrape.py", keys)
            self.assertIn(f"{run.agent_prefix}/work/scraped-data.json", keys)
            self.assertGreaterEqual(keys.count(f"{run.agent_prefix}/summary/summary.md"), 2)
            self.assertEqual(keys[-2], f"{run.agent_prefix}/status/completed.json")
            self.assertEqual(keys[-1], f"{run.agent_prefix}/result/completed.md")
            self.assertEqual(
                run.completed_file.read_text(encoding="utf-8"),
                "Completed successfully.\n",
            )

    def test_failure_marker_is_brief_and_separate_from_completion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))

            uri = run.upload_terminal_marker("failed")

            self.assertEqual(run.failure_file.read_text(encoding="utf-8"), "Run failed.\n")
            self.assertFalse(run.completed_file.exists())
            self.assertEqual(
                uri,
                f"s3://{run.workspace_bucket}/{run.agent_prefix}/result/failure.md",
            )


if __name__ == "__main__":
    unittest.main()
