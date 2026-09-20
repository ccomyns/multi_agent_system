from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from collections import deque
from pathlib import Path
from unittest.mock import Mock, patch


BIN = Path(__file__).resolve().parents[1] / "runtime/orch_software_builder/bin"
spec = importlib.util.spec_from_file_location("software_app_server", BIN / "codex_app_server.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SoftwareConversation = module.SoftwareConversation
AppServerError = module.AppServerError


class FakeClient:
    def __init__(self, *, crash=False, fail_wrap=False, interrupt_race=False):
        self.calls = []
        self.events = deque()
        self.turns = 0
        self.crash = crash
        self.fail_wrap = fail_wrap
        self.interrupt_race = interrupt_race
        self.closed = False

    def send(self, message):
        self.calls.append((message["method"], message.get("params", {})))

    def request(self, method, params):
        self.calls.append((method, params))
        if method in {"thread/start", "thread/resume"}:
            return {"thread": {"id": "thread-persistent"}}
        if method == "turn/start":
            self.turns += 1
            turn = f"turn-{self.turns}"
            wrapping = "The user clicked End Job" in params["input"][0]["text"]
            if not self.crash:
                self.events.extend([
                    {"method": "item/completed", "params": {
                        "threadId": "thread-persistent", "turnId": turn,
                        "item": {"type": "agentMessage", "text": "Published and verified." if wrapping else "Done for now."},
                    }},
                    {"method": "turn/completed", "params": {
                        "threadId": "thread-persistent",
                        "turn": {"id": turn, "status": "failed" if wrapping and self.fail_wrap else "completed"},
                    }},
                ])
            return {"turn": {"id": turn}}
        if method == "turn/interrupt" and self.interrupt_race:
            raise AppServerError("No active turn")
        return {}

    def event(self):
        if self.crash:
            raise AppServerError("process crashed")
        return self.events.popleft()

    def close(self):
        self.closed = True


class SoftwareConversationTests(unittest.TestCase):
    def make_loop(self, root, factory, should_end, reprompt="Be ambitious. Improve signal quality."):
        loop = SoftwareConversation(
            state_file=root / "state.json", final_file=root / "final.md",
            task="Build an investment dashboard", reprompt=reprompt,
            cwd=root, model="test-model", should_end=should_end,
            checkpoint=Mock(), client_factory=factory,
        )
        loop.pause = Mock()
        return loop

    def test_empty_reprompt_finishes_after_one_turn_and_saves_final_result(self):
        for reprompt in (None, "", " \n\t "):
            with self.subTest(reprompt=reprompt), tempfile.TemporaryDirectory() as temp:
                client = FakeClient()
                root = Path(temp)
                loop = self.make_loop(root, lambda: client, lambda: False, reprompt)
                loop.run()
                turns = [p for m, p in client.calls if m == "turn/start"]
                self.assertEqual(len(turns), 1)
                self.assertEqual(turns[0]["input"][0]["text"], loop.task)
                self.assertEqual(loop.final_file.read_text(), "Done for now.\n")
                self.assertTrue(loop.state["wrapped_up"])
                self.assertTrue(client.closed)
                loop.pause.assert_not_called()
                resumed = self.make_loop(root, Mock(side_effect=AssertionError("must not restart")), lambda: False, reprompt)
                resumed.run()

    def test_single_turn_drains_then_integrates_results_in_same_thread(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: client, lambda: False, "")
            def drain():
                self.assertEqual(client.turns, 1)
                return "Research findings at s3://memory/project/agent/description.md"
            loop.drain_agents = Mock(side_effect=drain)
            loop.run()
            self.assertEqual(client.turns, 2)
            prompts = [p["input"][0]["text"] for m, p in client.calls if m == "turn/start"]
            self.assertIn("Research findings", prompts[1])
            self.assertIn("Do not launch any more subagents", prompts[1])
            self.assertNotIn("The user clicked End Job", prompts[1])
            loop.drain_agents.assert_called_once()
            self.assertTrue(loop.state["wrapped_up"])

    def test_end_job_drains_before_dispatching_wrap_up(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: client, lambda: True)
            def drain():
                self.assertEqual(client.turns, 0)
                return "Agent failed: deadline expired"
            loop.drain_agents = Mock(side_effect=drain)
            loop.run()
            prompt = next(p["input"][0]["text"] for m, p in client.calls if m == "turn/start")
            self.assertIn("Agent failed: deadline expired", prompt)
            self.assertIn("publish_site", prompt)
            self.assertEqual(client.turns, 1)

    def test_end_during_single_turn_drain_still_dispatches_wrap_up(self):
        client = FakeClient()
        ending = [False]
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: client, lambda: ending[0], "")
            def drain():
                ending[0] = True
                return ""
            loop.drain_agents = drain
            loop.run()
            self.assertEqual(client.turns, 2)
            self.assertEqual(loop.final_file.read_text(), "Published and verified.\n")

    def test_single_turn_failure_does_not_dispatch_another_turn(self):
        client = FakeClient(crash=True)
        with tempfile.TemporaryDirectory() as temp:
            factory = Mock(return_value=client)
            loop = self.make_loop(Path(temp), factory, lambda: False, None)
            with self.assertRaisesRegex(AppServerError, "process crashed"):
                loop.run()
            factory.assert_called_once()
            self.assertEqual(client.turns, 1)
            self.assertTrue(client.closed)
            self.assertFalse(loop.final_file.exists())

    def test_end_job_still_wraps_up_a_single_turn_job(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: client, lambda: client.turns >= 1, "")
            loop.checkpoint.side_effect = lambda *a, **kw: setattr(loop, "last_poll", float("-inf"))
            loop.run()
            self.assertEqual(sum(m == "turn/interrupt" for m, _ in client.calls), 1)
            self.assertEqual(client.turns, 2)
            self.assertEqual(loop.final_file.read_text(), "Published and verified.\n")

    def test_premature_completions_reprompt_same_thread_until_end(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: client, lambda: client.turns >= 2)
            loop.run()
            prompts = [params for method, params in client.calls if method == "turn/start"]
            self.assertEqual(len(prompts), 3)
            self.assertTrue(all(p["threadId"] == "thread-persistent" for p in prompts))
            self.assertIn(loop.reprompt, prompts[0]["input"][0]["text"])
            self.assertIn(loop.reprompt, prompts[1]["input"][0]["text"])
            self.assertIn(loop.task, prompts[1]["input"][0]["text"])
            self.assertIn("The user clicked End Job", prompts[2]["input"][0]["text"])
            self.assertNotIn(loop.reprompt, prompts[2]["input"][0]["text"])
            self.assertEqual(loop.final_file.read_text(), "Published and verified.\n")
            self.assertTrue(json.loads(loop.state_file.read_text())["wrapped_up"])
            self.assertEqual(sum(m == "thread/start" for m, _ in client.calls), 1)
            self.assertTrue(client.closed)

    def test_process_crash_resumes_exact_thread_with_reprompt(self):
        first, second = FakeClient(crash=True), FakeClient()
        clients = iter([first, second])
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: next(clients), lambda: second.turns >= 1)
            loop.run()
            resume = next(p for m, p in second.calls if m == "thread/resume")
            self.assertEqual(resume["threadId"], "thread-persistent")
            self.assertFalse(any(m == "thread/start" for m, _ in second.calls))
            prompt = next(p for m, p in second.calls if m == "turn/start")["input"][0]["text"]
            self.assertIn(loop.reprompt, prompt)
            self.assertIn(loop.task, prompt)
            self.assertTrue(first.closed)

    def test_mid_turn_end_interrupts_then_runs_only_wrap_up(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: client, lambda: client.turns >= 1)
            # Force a control read during the active turn without wall-clock sleeps.
            loop.checkpoint.side_effect = lambda *a, **kw: setattr(loop, "last_poll", float("-inf"))
            loop.run()
            methods = [m for m, _ in client.calls]
            self.assertEqual(methods.count("turn/interrupt"), 1)
            self.assertEqual(methods.count("turn/start"), 2)
            interrupt = methods.index("turn/interrupt")
            self.assertEqual(methods[interrupt + 1], "turn/start")
            wrap = [p for m, p in client.calls if m == "turn/start"][-1]["input"][0]["text"]
            self.assertIn("Do not launch any more subagents", wrap)
            self.assertIn("publish_site", wrap)

    def test_completion_racing_interrupt_reconnects_only_for_wrap_up(self):
        first, second = FakeClient(interrupt_race=True), FakeClient()
        clients = iter([first, second])
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: next(clients), lambda: first.turns >= 1)
            loop.checkpoint.side_effect = lambda *a, **kw: setattr(loop, "last_poll", float("-inf"))
            loop.run()
            turns = [p for m, p in second.calls if m == "turn/start"]
            self.assertEqual(len(turns), 1)
            self.assertIn("The user clicked End Job", turns[0]["input"][0]["text"])

    def test_terminal_error_notification_retries_without_waiting_for_completion(self):
        first, second = FakeClient(), FakeClient()
        def terminal_error():
            return {"method": "error", "params": {
                "threadId": "thread-persistent", "turnId": "turn-1",
                "willRetry": False, "error": {"message": "Provider unavailable"},
            }}
        first.event = terminal_error
        clients = iter([first, second])
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: next(clients), lambda: second.turns >= 1)
            loop.run()
            self.assertTrue(first.closed)
            self.assertTrue(any(m == "thread/resume" for m, _ in second.calls))

    def test_end_before_first_turn_skips_normal_work(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: client, lambda: True)
            loop.run()
            turns = [p for m, p in client.calls if m == "turn/start"]
            self.assertEqual(len(turns), 1)
            self.assertIn(loop.task, turns[0]["input"][0]["text"])
            self.assertIn("The user clicked End Job", turns[0]["input"][0]["text"])
            self.assertFalse(any(m == "turn/interrupt" for m, _ in client.calls))

    def test_failed_wrap_up_cannot_restart_normal_work(self):
        clients = [FakeClient(fail_wrap=True) for _ in range(3)]
        factory = iter(clients)
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: next(factory), lambda: True)
            with self.assertRaisesRegex(AppServerError, "three attempts"):
                loop.run()
            self.assertTrue(loop.state["ending"])
            self.assertFalse(loop.state["wrapped_up"])
            self.assertFalse(loop.final_file.exists())
            for client in clients:
                for method, params in client.calls:
                    if method == "turn/start":
                        self.assertIn("The user clicked End Job", params["input"][0]["text"])

    def test_saved_end_request_survives_loop_recreation(self):
        client = FakeClient()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            loop = self.make_loop(root, lambda: client, lambda: True)
            loop.state.update(thread_id="thread-persistent", ending=True)
            loop.save()
            resumed = self.make_loop(root, lambda: client, Mock(side_effect=AssertionError("must stay ending")))
            resumed.run()
            self.assertTrue(any(m == "thread/resume" for m, _ in client.calls))
            completed = self.make_loop(root, Mock(side_effect=AssertionError("must not restart")), lambda: False)
            completed.run()

    def test_resume_failure_never_creates_replacement_thread(self):
        client = FakeClient()
        original = client.request
        def request(method, params):
            if method == "thread/resume":
                client.calls.append((method, params))
                raise AppServerError("thread missing")
            return original(method, params)
        client.request = request
        with tempfile.TemporaryDirectory() as temp:
            loop = self.make_loop(Path(temp), lambda: client, lambda: True)
            loop.state["thread_id"] = "thread-persistent"
            loop.save()
            with self.assertRaises(AppServerError):
                loop.run()
            self.assertFalse(any(m in {"thread/start", "turn/start"} for m, _ in client.calls))

    def test_stdio_client_preserves_events_arriving_before_response(self):
        script = '''import sys,json
for line in sys.stdin:
    m=json.loads(line)
    print(json.dumps({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"u","status":"completed"}}}),flush=True)
    print(json.dumps({"id":m["id"],"result":{"accepted":True}}),flush=True)
'''
        spawn = subprocess.Popen
        def launch(command, **kwargs):
            self.assertEqual(command, ["codex", "app-server"])
            return spawn([sys.executable, "-u", "-c", script], **kwargs)
        with tempfile.TemporaryDirectory() as temp, open(os.devnull, "wb") as log:
            events = []
            with patch.object(module.subprocess, "Popen", side_effect=launch):
                client = module.AppServerClient(cwd=Path(temp), env=os.environ.copy(), log=log, on_event=events.append)
            try:
                self.assertEqual(client.request("turn/interrupt", {}), {"accepted": True})
                self.assertEqual(client.event()["method"], "turn/completed")
                self.assertEqual(len(events), 1)
            finally:
                client.close()
            self.assertIsNotNone(client.process.poll())

    def test_telemetry_uses_root_thread_cumulative_totals(self):
        spec = importlib.util.spec_from_file_location("software_telemetry", BIN / "agent_telemetry.py")
        telemetry_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(telemetry_module)
        with tempfile.TemporaryDirectory() as temp:
            telemetry = telemetry_module.TelemetryRecorder(
                s3=Mock(), bucket="bucket", prefix="jobs/job/orchestrator/telemetry",
                local_dir=Path(temp), actor_type="orchestrator", job_id="job",
                orchestrator_instance_id="instance",
            )
            telemetry.latest["codex_thread_id"] = "root"
            for thread, total in [("root", 15), ("root", 30), ("child", 100)]:
                telemetry.note_activity({"method": "thread/tokenUsage/updated", "params": {
                    "threadId": thread, "tokenUsage": {"total": {
                        "inputTokens": total - 5, "outputTokens": 5, "totalTokens": total,
                    }},
                }})
            self.assertEqual(telemetry.latest["usage"]["total_tokens"], 30)


if __name__ == "__main__":
    unittest.main()
