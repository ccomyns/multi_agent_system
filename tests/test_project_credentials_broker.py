from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch


sys.dont_write_bytecode = True

if "boto3" not in sys.modules:
    boto3_stub = types.ModuleType("boto3")
    boto3_stub.client = Mock()
    sys.modules["boto3"] = boto3_stub

HANDLER_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "project_credentials_broker"
    / "handler.py"
)
specification = importlib.util.spec_from_file_location(
    "project_credentials_broker_handler", HANDLER_PATH
)
assert specification and specification.loader
handler = importlib.util.module_from_spec(specification)
specification.loader.exec_module(handler)


JOB_ID = "job_abc1_1234abcd"
INSTANCE_ID = "i-1234567890abcdef0"


class ProjectCredentialsBrokerTests(unittest.TestCase):
    def test_database_request_uses_only_assigned_owner_secret(self):
        ssm = Mock()
        url = "postgresql://db_" + "a" * 24 + "_owner:secret@host/app?sslmode=require"
        ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "ready"}},
            {"Parameter": {"Value": json.dumps({"database_name": "app", "url": url})}},
        ]
        with patch.dict(os.environ, {"DATABASE_CREDENTIALS_SSM_PREFIX": "/db/databases"}), \
             patch.object(handler, "_trusted_assignment", return_value={"database_name": {"S": "app"}}), \
             patch.object(handler, "_client", return_value=ssm):
            result = handler.lambda_handler(self.request(resource="database"), None)
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(result["body"]["database"]["url"], url)
        self.assertEqual(ssm.get_parameter.call_args.kwargs["Name"], "/db/databases/app/owner")

    def test_database_request_cannot_select_another_database(self):
        with patch.object(handler, "_client") as client:
            result = handler.lambda_handler(self.request(resource="database", database_name="other"), None)
        self.assertEqual(result["statusCode"], 400)
        client.assert_not_called()

    def test_database_request_checks_instance_before_reading_secrets(self):
        dynamodb, sts = self.clients(orchestrator_instance_id="i-00000000000000000")
        ssm = Mock()
        with patch.dict(os.environ, self.environment(), clear=True), \
             patch.object(handler, "_client", side_effect=lambda name: {"dynamodb": dynamodb, "sts": sts, "ssm": ssm}[name]):
            result = handler.lambda_handler(self.request(resource="database"), None)
        self.assertEqual(result["statusCode"], 403)
        ssm.get_parameter.assert_not_called()

    def test_incomplete_database_never_returns_a_secret(self):
        ssm = Mock()
        ssm.get_parameter.return_value = {"Parameter": {"Value": "provisioning"}}
        with patch.dict(os.environ, {"DATABASE_CREDENTIALS_SSM_PREFIX": "/db/databases"}), \
             patch.object(handler, "_trusted_assignment", return_value={"database_name": {"S": "app"}}), \
             patch.object(handler, "_client", return_value=ssm):
            result = handler.lambda_handler(self.request(resource="database"), None)
        self.assertEqual(result["statusCode"], 409)
        self.assertEqual(ssm.get_parameter.call_count, 1)

    def environment(self) -> dict[str, str]:
        return {
            "GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME": "assignments-table",
            "GLOBAL_MEMORY_BUCKET_NAME": "global-memory-bucket",
            "JOBS_TABLE_NAME": "jobs-table",
            "PROJECT_WORKSPACE_ROLE_ARN": (
                "arn:aws:iam::123456789012:role/project-workspace"
            ),
        }

    def request(self, **updates):
        return {
            "job_id": JOB_ID,
            "orchestrator_instance_id": INSTANCE_ID,
            **updates,
        }

    def clients(
        self,
        *,
        project_name: str = "customer-insights",
        orchestrator_instance_id: str = INSTANCE_ID,
    ):
        dynamodb = Mock()
        dynamodb.get_item.side_effect = [
            {"Item": {"active_job_id": {"S": f"JOB#{JOB_ID}"}}},
            {
                "Item": {
                    "job_id": {"S": JOB_ID},
                    "type_of_job": {"S": "software_builder"},
                    "status": {"S": "running"},
                    "orchestrator_instance_id": {"S": orchestrator_instance_id},
                }
            },
            {
                "Item": {
                    "job_id": {"S": JOB_ID},
                    "global_memory_project_name": {"S": project_name},
                }
            },
        ]
        sts = Mock()
        sts.assume_role.return_value = {
            "Credentials": {
                "AccessKeyId": "ASIAEXAMPLE",
                "SecretAccessKey": "secret",
                "SessionToken": "session-token",
                "Expiration": datetime.now(timezone.utc) + timedelta(minutes=55),
            }
        }
        return dynamodb, sts

    def test_scope_comes_only_from_trusted_assignment(self) -> None:
        dynamodb, sts = self.clients()

        def client(name: str):
            return {"dynamodb": dynamodb, "sts": sts}[name]

        with (
            patch.dict(os.environ, self.environment(), clear=True),
            patch.object(handler, "_client", side_effect=client),
        ):
            response = handler.lambda_handler(self.request(), None)

        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(
            response["body"]["project"],
            {
                "name": "customer-insights",
                "bucket": "global-memory-bucket",
                "prefix": "customer-insights/",
                "s3_uri": "s3://global-memory-bucket/customer-insights/",
            },
        )
        sts.assume_role.assert_called_once_with(
            RoleArn="arn:aws:iam::123456789012:role/project-workspace",
            RoleSessionName="project-abc1_1234abcd",
            DurationSeconds=3600,
            Tags=[{"Key": "ProjectName", "Value": "customer-insights"}],
        )

    def test_caller_cannot_supply_a_different_project(self) -> None:
        response = handler.lambda_handler(
            self.request(project_name="another-project"), None
        )

        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(response["body"]["error"], "project_scope_not_accepted")

    def test_invalid_assignment_never_reaches_sts(self) -> None:
        dynamodb, sts = self.clients(project_name="project-*")

        def client(name: str):
            return {"dynamodb": dynamodb, "sts": sts}[name]

        with (
            patch.dict(os.environ, self.environment(), clear=True),
            patch.object(handler, "_client", side_effect=client),
        ):
            response = handler.lambda_handler(self.request(), None)

        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(response["body"]["error"], "project_not_assigned")
        sts.assume_role.assert_not_called()

    def test_another_orchestrator_cannot_receive_the_project_session(self) -> None:
        dynamodb, sts = self.clients(
            orchestrator_instance_id="i-abcdef12345678901"
        )

        def client(name: str):
            return {"dynamodb": dynamodb, "sts": sts}[name]

        with (
            patch.dict(os.environ, self.environment(), clear=True),
            patch.object(handler, "_client", side_effect=client),
        ):
            response = handler.lambda_handler(self.request(), None)

        self.assertEqual(response["statusCode"], 403)
        self.assertEqual(response["body"]["error"], "orchestrator_mismatch")
        sts.assume_role.assert_not_called()


if __name__ == "__main__":
    unittest.main()
