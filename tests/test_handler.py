from __future__ import annotations

import io
import json
import os
import subprocess
import unittest
from unittest.mock import Mock, patch

from botocore.exceptions import ClientError

from src.subagent_manager import handler


class SpawnTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(
            os.environ,
            {
                "AUDIT_BUCKET_NAME": "audit-bucket",
                "AGENT_WORKSPACE_BUCKET_NAME": "agent-workspace-bucket",
                "MAX_ACTIVE_SUBAGENTS": "8",
                "STATE_TABLE_NAME": "state-table",
                "SUBAGENT_MODEL": "gpt-5.6-luna",
            },
            clear=False,
        )
        self.environment.start()
        handler._clients.clear()

    def tearDown(self) -> None:
        handler._clients.clear()
        self.environment.stop()

    @staticmethod
    def handoff(agent_id: str) -> dict[str, str]:
        job_id = "job_abc1_1234abcd"
        task_s3_key = f"jobs/{job_id}/agents/{agent_id}/input.json"
        return {
            "job_id": job_id,
            "task_s3_uri": f"s3://agent-workspace-bucket/{task_s3_key}",
            "task_s3_key": task_s3_key,
            "model": "gpt-5.6-luna",
            "task": "Investigate revenue quality",
        }

    @classmethod
    def spawn_event(cls, request_id: str) -> dict[str, str]:
        handoff = cls.handoff(request_id)
        return {
            "action": "spawn",
            "orchestrator_id": "orchestrator-1",
            "request_id": request_id,
            "job_id": handoff["job_id"],
            "task_s3_uri": handoff["task_s3_uri"],
            "model": handoff["model"],
            "task": handoff["task"],
        }

    def test_first_eight_launches_succeed_and_ninth_is_rejected(self) -> None:
        records: dict[tuple[str, str], dict] = {}
        active_count = 0

        def existing(orchestrator_id: str, agent_id: str):
            return records.get((orchestrator_id, agent_id))

        def reserve(
            orchestrator_id: str,
            agent_id: str,
            created_at: str,
            handoff: dict[str, str],
        ) -> bool:
            nonlocal active_count
            if active_count >= 8:
                return False
            active_count += 1
            records[(orchestrator_id, agent_id)] = {
                "state": "PROVISIONING",
                "created_at": created_at,
            }
            return True

        def mark(orchestrator_id: str, agent_id: str, instance_id: str, launched_at: str):
            records[(orchestrator_id, agent_id)].update(
                state="RUNNING",
                instance_id=instance_id,
                launched_at=launched_at,
            )

        with (
            patch.object(handler, "_existing_agent", side_effect=existing),
            patch.object(handler, "_reserve_slot", side_effect=reserve),
            patch.object(
                handler,
                "_launch_instance",
                side_effect=lambda _, agent_id, handoff: f"i-{agent_id[-4:]}",
            ),
            patch.object(handler, "_mark_launched", side_effect=mark),
            patch.object(handler, "_active_count", side_effect=lambda _: active_count),
            patch.object(handler, "_audit"),
        ):
            results = [
                handler.lambda_handler(
                    self.spawn_event(f"request-{number}"),
                    None,
                )
                for number in range(1, 10)
            ]

        self.assertEqual([result["statusCode"] for result in results], [201] * 8 + [429])
        self.assertEqual(results[-1]["body"]["error"], "active_subagent_limit_reached")
        self.assertEqual(active_count, 8)

    def test_reservation_persists_subagent_launch_metadata(self) -> None:
        dynamodb = Mock()
        with (
            patch.dict(
                os.environ,
                {
                    "SUBAGENT_AMI_ID": "ami-browser-tools",
                    "SUBAGENT_INSTANCE_TYPE": "t3.large",
                    "SUBAGENT_TTL_SECONDS": "1800",
                },
            ),
            patch.object(handler, "_client", return_value=dynamodb),
        ):
            reserved = handler._reserve_slot(
                "orchestrator-1",
                "agent-1",
                "2026-01-01T00:00:00Z",
                self.handoff("agent-1"),
            )

        self.assertTrue(reserved)
        put_item = dynamodb.transact_write_items.call_args.kwargs["TransactItems"][1][
            "Put"
        ]["Item"]
        self.assertEqual(put_item["ami_id"], {"S": "ami-browser-tools"})
        self.assertEqual(put_item["instance_type"], {"S": "t3.large"})
        self.assertEqual(put_item["ttl_seconds"], {"N": "1800"})
        self.assertEqual(put_item["task"], {"S": "Investigate revenue quality"})

    def test_real_task_launch_passes_only_trusted_s3_handoff_to_runner(self) -> None:
        ec2 = Mock()
        ec2.run_instances.return_value = {"Instances": [{"InstanceId": "i-subagent"}]}
        handoff = {
            "job_id": "job_abc1_1234abcd",
            "task_s3_uri": (
                "s3://agent-workspace-bucket/jobs/job_abc1_1234abcd/"
                "agents/agent-0123456789abcdef01234567/input.json"
            ),
            "task_s3_key": (
                "jobs/job_abc1_1234abcd/agents/"
                "agent-0123456789abcdef01234567/input.json"
            ),
            "model": "gpt-5.6-luna",
            "task": "Investigate revenue quality",
        }
        with (
            patch.dict(
                os.environ,
                {
                    "AWS_REGION": "us-east-1",
                    "AGENT_WORKSPACE_BUCKET_NAME": "agent-workspace-bucket",
                    "GLOBAL_MEMORY_BUCKET_NAME": "global-memory-bucket",
                    "CODEX_AUTH_SSM_PARAMETER_NAME": "/project/codex/auth-json",
                    "RUNTIME_ARTIFACT_BUCKET": "runtime-artifact-bucket",
                    "RUNTIME_ARTIFACT_BUCKET_OWNER": "123456789012",
                    "SUBAGENT_AMI_ID": "ami-browser-tools",
                    "SUBAGENT_INSTANCE_PROFILE_NAME": "subagent-profile",
                    "SUBAGENT_INSTANCE_TYPE": "t3.large",
                    "SUBAGENT_RUNTIME_NAME": "subagent-data-mining",
                    "SUBAGENT_RUNTIME_S3_KEY": (
                        "system/runtime/subagent-data-mining/hash/runtime.zip"
                    ),
                    "SUBAGENT_RUNTIME_SHA256": "a" * 64,
                    "SUBAGENT_SECURITY_GROUP_ID": "sg-subagents",
                    "SUBAGENT_SUBNET_ID": "subnet-public",
                    "SUBAGENT_TTL_SECONDS": "1800",
                },
            ),
            patch.object(handler, "_client", return_value=ec2),
        ):
            handler._launch_instance(
                "i-1234567890abcdef0",
                "agent-0123456789abcdef01234567",
                handoff,
            )

        user_data = ec2.run_instances.call_args.kwargs["UserData"]
        self.assertEqual(ec2.run_instances.call_args.kwargs["ImageId"], "ami-browser-tools")
        self.assertEqual(ec2.run_instances.call_args.kwargs["InstanceType"], "t3.large")
        self.assertNotIn("BlockDeviceMappings", ec2.run_instances.call_args.kwargs)
        self.assertIn("TASK_S3_KEY=" + handoff["task_s3_key"], user_data)
        self.assertIn("RUNTIME_ARTIFACT_BUCKET=runtime-artifact-bucket", user_data)
        self.assertIn("SUBAGENT_RUNTIME_NAME=subagent-data-mining", user_data)
        self.assertIn("SUBAGENT_RUNTIME_SHA256=" + "a" * 64, user_data)
        self.assertIn("systemctl start --no-block multi-agent-subagent.service", user_data)
        self.assertIn("BOOTSTRAP_LOG_PATH=/var/log/multi-agent/subagent-bootstrap.log", user_data)
        self.assertIn("CODEX_LOG_PATH=/var/log/multi-agent/subagent-codex.log", user_data)
        self.assertNotIn("apt-get", user_data)
        self.assertNotIn("bubblewrap", user_data)
        subprocess.run(["bash", "-n"], input=user_data, text=True, check=True)
        self.assertNotIn("Investigate revenue quality", user_data)
        self.assertNotIn("sleep 1800", user_data)

    def test_spawn_requires_a_job_scoped_task_handoff(self) -> None:
        result = handler.lambda_handler(
            {
                "action": "spawn",
                "orchestrator_id": "orchestrator-1",
                "request_id": "request-1",
            },
            None,
        )

        self.assertEqual(result["statusCode"], 400)
        self.assertFalse(result["body"]["accepted"])
        self.assertIn("must all be supplied", result["body"]["error"])

    def test_task_handoff_rejects_an_untrusted_s3_uri(self) -> None:
        result = handler.lambda_handler(
            {
                "action": "spawn",
                "orchestrator_id": "i-1234567890abcdef0",
                "request_id": "agent-0123456789abcdef01234567",
                "job_id": "job_abc1_1234abcd",
                "task_s3_uri": "s3://another-bucket/arbitrary-input.json",
                "model": "gpt-5.6-luna",
                "task": "Investigate revenue quality",
            },
            None,
        )

        self.assertEqual(result["statusCode"], 400)
        self.assertFalse(result["body"]["accepted"])
        self.assertIn("trusted job and agent identity", result["body"]["error"])

    def test_repeated_request_id_is_idempotent(self) -> None:
        existing = {
            "state": "RUNNING",
            "instance_id": "i-0123456789",
        }
        with (
            patch.object(handler, "_existing_agent", return_value=existing),
            patch.object(handler, "_reserve_slot") as reserve,
            patch.object(handler, "_launch_instance") as launch,
        ):
            result = handler.lambda_handler(
                self.spawn_event("stable-request-id"),
                None,
            )

        self.assertEqual(result["statusCode"], 200)
        self.assertTrue(result["body"]["idempotent_replay"])
        self.assertEqual(result["body"]["instance_id"], "i-0123456789")
        reserve.assert_not_called()
        launch.assert_not_called()

    def test_ambiguous_launch_error_retains_slot(self) -> None:
        with (
            patch.object(handler, "_existing_agent", return_value=None),
            patch.object(handler, "_reserve_slot", return_value=True),
            patch.object(handler, "_launch_instance", side_effect=TimeoutError("timed out")),
            patch.object(handler, "_mark_launch_unknown") as mark_unknown,
            patch.object(handler, "_release_failed_launch") as release,
            patch.object(handler, "_audit"),
        ):
            with self.assertRaises(TimeoutError):
                handler.lambda_handler(
                    self.spawn_event("ambiguous-request"),
                    None,
                )

        mark_unknown.assert_called_once()
        release.assert_not_called()

    def test_explicit_ec2_rejection_releases_slot(self) -> None:
        error = ClientError(
            {
                "Error": {
                    "Code": "InsufficientInstanceCapacity",
                    "Message": "No capacity",
                }
            },
            "RunInstances",
        )
        with (
            patch.object(handler, "_existing_agent", return_value=None),
            patch.object(handler, "_reserve_slot", return_value=True),
            patch.object(handler, "_launch_instance", side_effect=error),
            patch.object(handler, "_release_failed_launch") as release,
            patch.object(handler, "_audit"),
        ):
            with self.assertRaises(ClientError):
                handler.lambda_handler(
                    self.spawn_event("rejected-request"),
                    None,
                )

        release.assert_called_once()

    def test_invalid_orchestrator_id_is_rejected(self) -> None:
        result = handler.lambda_handler(
            {"orchestrator_id": "contains spaces", "request_id": "request-1"},
            None,
        )

        self.assertEqual(result["statusCode"], 400)
        self.assertFalse(result["body"]["accepted"])


class TerminationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(
            os.environ,
            {
                "AUDIT_BUCKET_NAME": "audit-bucket",
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

    def test_termination_reconciles_state_and_audits(self) -> None:
        dynamodb = Mock()
        agent = {
            "orchestrator_id": "orchestrator-1",
            "agent_id": "agent-1",
            "created_at": "2026-01-01T00:00:00Z",
            "launched_at": "2026-01-01T00:00:01Z",
        }
        event = {
            "source": "aws.ec2",
            "detail-type": "EC2 Instance State-change Notification",
            "time": "2026-01-01T00:15:00Z",
            "detail": {
                "instance-id": "i-0123456789",
                "state": "terminated",
            },
        }

        with (
            patch.object(handler, "_find_agent_by_instance", return_value=agent),
            patch.object(
                handler,
                "_client",
                side_effect=lambda name: dynamodb if name == "dynamodb" else Mock(),
            ),
            patch.object(handler, "_terminal_projection", return_value={}),
            patch.object(handler, "_audit") as audit,
        ):
            result = handler.lambda_handler(event, None)

        self.assertTrue(result["reconciled"])
        dynamodb.transact_write_items.assert_called_once()
        audit.assert_called_once()

    def test_completed_terminal_projection_reads_compact_metrics(self) -> None:
        s3 = Mock()

        def get_object(**kwargs):
            key = kwargs["Key"]
            if key.endswith("/status/completed.json"):
                value = {"state": "completed"}
            elif key.endswith("/telemetry/latest.json"):
                value = {
                    "codex_started_at": "2026-01-01T00:00:00Z",
                    "codex_finished_at": "2026-01-01T00:02:03Z",
                    "usage": {"total_tokens": 4567},
                }
            else:
                self.fail(f"unexpected S3 key: {key}")
            raw = json.dumps(value).encode("utf-8")
            return {"Body": io.BytesIO(raw), "ContentLength": len(raw)}

        s3.get_object.side_effect = get_object
        with patch.object(handler, "_client", return_value=s3):
            projection = handler._terminal_projection(
                {"job_id": "job_abc1_1234abcd", "agent_id": "agent-1"}
            )

        self.assertEqual(
            projection,
            {
                "result_status": "completed",
                "runtime_seconds": 123,
                "total_tokens": 4567,
            },
        )


if __name__ == "__main__":
    unittest.main()
