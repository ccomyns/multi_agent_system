from __future__ import annotations

import os
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
                "MAX_ACTIVE_SUBAGENTS": "8",
                "STATE_TABLE_NAME": "state-table",
            },
            clear=False,
        )
        self.environment.start()
        handler._clients.clear()

    def tearDown(self) -> None:
        handler._clients.clear()
        self.environment.stop()

    def test_first_eight_launches_succeed_and_ninth_is_rejected(self) -> None:
        records: dict[tuple[str, str], dict] = {}
        active_count = 0

        def existing(orchestrator_id: str, agent_id: str):
            return records.get((orchestrator_id, agent_id))

        def reserve(orchestrator_id: str, agent_id: str, created_at: str) -> bool:
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
                side_effect=lambda _, agent_id: f"i-{agent_id[-4:]}",
            ),
            patch.object(handler, "_mark_launched", side_effect=mark),
            patch.object(handler, "_active_count", side_effect=lambda _: active_count),
            patch.object(handler, "_audit"),
        ):
            results = [
                handler.lambda_handler(
                    {
                        "action": "spawn",
                        "orchestrator_id": "orchestrator-1",
                        "request_id": f"request-{number}",
                    },
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
            )

        self.assertTrue(reserved)
        put_item = dynamodb.transact_write_items.call_args.kwargs["TransactItems"][1][
            "Put"
        ]["Item"]
        self.assertEqual(put_item["ami_id"], {"S": "ami-browser-tools"})
        self.assertEqual(put_item["instance_type"], {"S": "t3.large"})
        self.assertEqual(put_item["ttl_seconds"], {"N": "1800"})

    def test_launch_uses_prebaked_ami_t3_large_and_thirty_minute_ttl(self) -> None:
        ec2 = Mock()
        ec2.run_instances.return_value = {"Instances": [{"InstanceId": "i-subagent"}]}
        with (
            patch.dict(
                os.environ,
                {
                    "SUBAGENT_AMI_ID": "ami-browser-tools",
                    "SUBAGENT_INSTANCE_PROFILE_NAME": "subagent-profile",
                    "SUBAGENT_INSTANCE_TYPE": "t3.large",
                    "SUBAGENT_SECURITY_GROUP_ID": "sg-subagents",
                    "SUBAGENT_SUBNET_ID": "subnet-public",
                    "SUBAGENT_TTL_SECONDS": "1800",
                },
            ),
            patch.object(handler, "_client", return_value=ec2),
        ):
            instance_id = handler._launch_instance("orchestrator-1", "agent-1")

        self.assertEqual(instance_id, "i-subagent")
        launch = ec2.run_instances.call_args.kwargs
        self.assertEqual(launch["ImageId"], "ami-browser-tools")
        self.assertEqual(launch["InstanceType"], "t3.large")
        self.assertIn("sleep 1800", launch["UserData"])
        self.assertNotIn("BlockDeviceMappings", launch)

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
                {
                    "orchestrator_id": "orchestrator-1",
                    "request_id": "stable-request-id",
                },
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
                    {
                        "orchestrator_id": "orchestrator-1",
                        "request_id": "ambiguous-request",
                    },
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
                    {
                        "orchestrator_id": "orchestrator-1",
                        "request_id": "rejected-request",
                    },
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
            patch.object(handler, "_audit") as audit,
        ):
            result = handler.lambda_handler(event, None)

        self.assertTrue(result["reconciled"])
        dynamodb.transact_write_items.assert_called_once()
        audit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
