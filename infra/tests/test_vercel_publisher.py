from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
HANDLER_PATH = ROOT / "src/vercel_publisher/handler.py"
INFRA = ROOT / "infra"


def _load_handler():
    boto3 = types.ModuleType("boto3")
    boto3.client = Mock()
    sys.modules.setdefault("boto3", boto3)
    spec = importlib.util.spec_from_file_location(
        "vercel_publisher_handler",
        HANDLER_PATH,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load the Vercel publisher handler.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


publisher = _load_handler()


class VercelPublisherHandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        publisher._clients.clear()
        publisher._token_cache.clear()
        self.request = publisher.PublishRequest(
            action="publish",
            job_id="job_abcd_12345678",
            instance_id="i-1234567890abcdef0",
            branch="vercel-integration",
            commit_sha="a" * 40,
        )
        self.repository = publisher.RepositoryAssignment(
            repository_id=123456,
            full_name="mas-workspace/generated-site",
        )
        self.configuration = publisher.Configuration(
            jobs_table="jobs",
            assignments_table="assignments",
            organization="mas-workspace",
            team_id="team_abc123",
            token_parameter="/test/vercel/access-token",
        )

    def test_request_rejects_model_selected_deployment_scope(self) -> None:
        event = {
            "action": "publish",
            "job_id": self.request.job_id,
            "orchestrator_instance_id": self.request.instance_id,
            "branch": self.request.branch,
            "commit_sha": self.request.commit_sha,
            "repository": "somewhere/else",
        }

        with self.assertRaises(publisher.PublisherError) as raised:
            publisher._parse_request(event)

        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.code, "deployment_scope_not_accepted")

    def test_assignment_requires_the_active_software_builder_instance(self) -> None:
        records = [
            {"active_job_id": {"S": f"JOB#{self.request.job_id}"}},
            {
                "job_id": {"S": self.request.job_id},
                "type_of_job": {"S": "software_builder"},
                "status": {"S": "running"},
                "orchestrator_instance_id": {"S": self.request.instance_id},
            },
            {
                "job_id": {"S": self.request.job_id},
                "github_repository_id": {"N": str(self.repository.repository_id)},
                "github_repository_full_name": {"S": self.repository.full_name},
            },
        ]

        with patch.object(publisher, "_get_item", side_effect=records) as get_item:
            result = publisher._assigned_repository(
                self.request,
                self.configuration,
            )

        self.assertEqual(result, self.repository)
        self.assertEqual(get_item.call_count, 3)

    def test_token_is_decrypted_from_ssm_and_cached(self) -> None:
        ssm = Mock()
        ssm.get_parameter.return_value = {
            "Parameter": {"Value": "vercel-token-value-long-enough"}
        }
        publisher._clients["ssm"] = ssm

        first = publisher._vercel_token(self.configuration.token_parameter)
        second = publisher._vercel_token(self.configuration.token_parameter)

        self.assertEqual(first, "vercel-token-value-long-enough")
        self.assertEqual(second, first)
        ssm.get_parameter.assert_called_once_with(
            Name=self.configuration.token_parameter,
            WithDecryption=True,
        )

    def test_publish_deploys_the_exact_assigned_commit_to_production(self) -> None:
        deployment = {
            "id": "dpl_abc123",
            "readyState": "QUEUED",
            "projectId": "prj_abc123",
            "target": "production",
            "url": "generated-site-abc.vercel.app",
        }

        with (
            patch.object(
                publisher,
                "_get_or_create_project",
                return_value=("prj_abc123", "generated-site"),
            ),
            patch.object(
                publisher,
                "_vercel_json",
                return_value=deployment,
            ) as vercel_json,
        ):
            result = publisher._publish(
                self.request,
                self.configuration,
                self.repository,
                "secret-token",
            )

        call = vercel_json.call_args
        self.assertEqual(call.args[:2], ("POST", "/v13/deployments"))
        self.assertEqual(call.args[3], self.configuration.team_id)
        self.assertEqual(
            call.kwargs["body"],
            {
                "name": "generated-site",
                "project": "prj_abc123",
                "target": "production",
                "gitSource": {
                    "type": "github",
                    "repoId": self.repository.repository_id,
                    "ref": self.request.branch,
                    "sha": self.request.commit_sha,
                },
            },
        )
        self.assertEqual(result["id"], "dpl_abc123")
        self.assertEqual(
            result["deployment_url"],
            "https://generated-site-abc.vercel.app",
        )

    def test_status_rejects_a_deployment_for_another_commit(self) -> None:
        status_request = publisher.PublishRequest(
            action="status",
            job_id=self.request.job_id,
            instance_id=self.request.instance_id,
            branch=self.request.branch,
            commit_sha=self.request.commit_sha,
            deployment_id="dpl_abc123",
        )
        project = {
            "id": "prj_abc123",
            "name": "generated-site",
            "link": {
                "type": "github",
                "repoId": self.repository.repository_id,
                "org": "mas-workspace",
                "repo": "generated-site",
            },
        }
        deployment = {
            "id": "dpl_abc123",
            "readyState": "READY",
            "projectId": "prj_abc123",
            "target": "production",
            "gitSource": {
                "type": "github",
                "ref": status_request.branch,
                "sha": "b" * 40,
            },
        }

        with patch.object(
            publisher,
            "_vercel_json",
            side_effect=[project, deployment],
        ):
            with self.assertRaises(publisher.PublisherError) as raised:
                publisher._status(
                    status_request,
                    self.configuration,
                    self.repository,
                    "secret-token",
                )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(
            raised.exception.code,
            "vercel_deployment_scope_mismatch",
        )

    def test_project_name_is_stable_for_github_names_vercel_cannot_use(self) -> None:
        repository = publisher.RepositoryAssignment(
            repository_id=321,
            full_name="mas-workspace/Generated_Site",
        )

        name = publisher._project_name(repository)

        self.assertRegex(name, r"^generated-site-[0-9a-f]{8}$")
        self.assertLessEqual(len(name), 100)


class VercelPublisherInfrastructureTests(unittest.TestCase):
    def test_lambda_receives_only_non_secret_vercel_configuration(self) -> None:
        lambda_tf = (INFRA / "lambda.tf").read_text(encoding="utf-8")
        publisher_lambda = lambda_tf.split(
            'resource "aws_lambda_function" "vercel_publisher"',
            1,
        )[1].split(
            'resource "aws_cloudwatch_event_rule" "subagent_terminated"',
            1,
        )[0]

        self.assertIn("VERCEL_TEAM_ID", publisher_lambda)
        self.assertIn("VERCEL_ACCESS_TOKEN_SSM_PARAMETER_NAME", publisher_lambda)
        self.assertNotIn("VERCEL_TOKEN", publisher_lambda)

    def test_only_publisher_role_reads_the_vercel_token(self) -> None:
        iam = (INFRA / "iam.tf").read_text(encoding="utf-8")
        publisher_role = iam.split(
            'resource "aws_iam_role_policy" "vercel_publisher"',
            1,
        )[1].split(
            'resource "aws_iam_role" "software_builder_project_workspace"',
            1,
        )[0]
        software_role = iam.split(
            'resource "aws_iam_role_policy" "software_builder_orchestrator"',
            1,
        )[1].split('resource "aws_iam_role" "image_builder"', 1)[0]

        self.assertIn("local.vercel_access_token_ssm_parameter_arn", publisher_role)
        self.assertIn("aws_lambda_function.vercel_publisher.arn", software_role)
        self.assertNotIn("vercel_access_token_ssm_parameter_arn", software_role)

    def test_token_value_is_not_managed_by_terraform(self) -> None:
        vercel = (INFRA / "vercel.tf").read_text(encoding="utf-8")

        self.assertNotIn('resource "aws_ssm_parameter"', vercel)


if __name__ == "__main__":
    unittest.main()
