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
    def test_first_framework_deployment_confirms_detection_after_database_upload(self):
        for with_database in (False, True):
            with self.subTest(with_database=with_database):
                repository = publisher.RepositoryAssignment(
                    123456, "mas-workspace/generated-site", "app" if with_database else None
                )
                database_url = "postgresql://db_" + "a" * 24 + "_app:secret@host/app?sslmode=require"
                ssm = Mock()
                ssm.get_parameter.side_effect = [
                    {"Parameter": {"Value": "ready"}},
                    {"Parameter": {"Value": json.dumps({"database_name": "app", "url": database_url})}},
                ]
                requests = []

                def upstream(request, timeout):
                    url = publisher.urllib_parse.urlsplit(request.full_url)
                    query = publisher.urllib_parse.parse_qs(url.query)
                    body = json.loads(request.data)
                    requests.append(url.path)
                    self.assertEqual(query["teamId"], [self.configuration.team_id])
                    if url.path.endswith("/env"):
                        self.assertEqual(body["value"], database_url)
                        response = {"created": {"key": "DATABASE_URL", "type": "sensitive", "target": ["production"]}}
                    else:
                        # Model Vercel's observed first-deployment confirmation
                        # error at the HTTP boundary. Without the query fix this
                        # raises the same rejection seen in the actual job.
                        if query.get("skipAutoDetectionConfirmation") != ["1"]:
                            raise publisher.urllib_error.HTTPError(
                                request.full_url, 400, "Bad Request", {}, io.BytesIO(json.dumps({
                                    "error": {"code": "missing_project_settings", "message": "The projectSettings object is required for new projects"}
                                }).encode())
                            )
                        self.assertEqual(body["gitSource"]["sha"], self.request.commit_sha)
                        self.assertNotIn("secret", request.data.decode())
                        response = {"id": "dpl_abc123", "readyState": "QUEUED", "projectId": "prj_abc123", "target": "production", "url": "site.vercel.app"}
                    return io.BytesIO(json.dumps(response).encode())

                with patch.dict(os.environ, {"DATABASE_CREDENTIALS_SSM_PREFIX": "/db/databases"}), \
                     patch.object(publisher, "_client", return_value=ssm), \
                     patch.object(publisher, "_get_or_create_project", return_value=("prj_abc123", "generated-site")), \
                     patch.object(publisher.urllib_request, "urlopen", side_effect=upstream):
                    result = publisher._publish(self.request, self.configuration, repository, "token")
                self.assertEqual(result["id"], "dpl_abc123")
                self.assertEqual(requests, (["/v10/projects/prj_abc123/env"] if with_database else []) + ["/v13/deployments"])

    def test_database_environment_is_installed_before_deploying(self):
        repository = publisher.RepositoryAssignment(123456, "mas-workspace/generated-site", "app")
        url = "postgresql://db_" + "a" * 24 + "_app:secret@host/app?sslmode=require"
        ssm = Mock()
        ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "ready"}},
            {"Parameter": {"Value": json.dumps({"database_name": "app", "url": url})}},
        ]
        def vercel(method, path, *args, **kwargs):
            if path.endswith("/env"):
                self.assertEqual(kwargs["query"], {"upsert": "true"})
                self.assertEqual(kwargs["body"], {"key": "DATABASE_URL", "value": url, "type": "sensitive", "target": ["production"]})
                return {"created": {"key": "DATABASE_URL", "type": "sensitive", "target": ["production"]}, "failed": []}
            return {"id": "dpl_abc123", "readyState": "QUEUED", "projectId": "prj_abc123", "target": "production", "url": "site.vercel.app"}
        with patch.dict(os.environ, {"DATABASE_CREDENTIALS_SSM_PREFIX": "/db/databases"}), \
             patch.object(publisher, "_client", return_value=ssm), \
             patch.object(publisher, "_get_or_create_project", return_value=("prj_abc123", "generated-site")), \
             patch.object(publisher, "_vercel_json", side_effect=vercel) as api:
            result = publisher._publish(self.request, self.configuration, repository, "token")
        self.assertEqual([call.args[1] for call in api.call_args_list], ["/v10/projects/prj_abc123/env", "/v13/deployments"])
        self.assertEqual(ssm.get_parameter.call_args.kwargs["Name"], "/db/databases/app/app")
        self.assertNotIn("secret", json.dumps(result))

    def test_environment_failure_prevents_deployment_and_redacts_upstream_error(self):
        repository = publisher.RepositoryAssignment(123456, "mas-workspace/generated-site", "app")
        url = "postgresql://db_" + "a" * 24 + "_app:secret@host/app?sslmode=require"
        for response in [RuntimeError(url), {"failed": [{"error": {"message": url}}]}, {}]:
            ssm = Mock()
            ssm.get_parameter.side_effect = [
                {"Parameter": {"Value": "ready"}},
                {"Parameter": {"Value": json.dumps({"database_name": "app", "url": url})}},
            ]
            with patch.dict(os.environ, {"DATABASE_CREDENTIALS_SSM_PREFIX": "/db/databases"}), \
                 patch.object(publisher, "_client", return_value=ssm), \
                 patch.object(publisher, "_get_or_create_project", return_value=("prj_abc123", "generated-site")), \
                 patch.object(publisher, "_vercel_json", side_effect=[response]) as api:
                with self.assertRaises(publisher.PublisherError) as raised:
                    publisher._publish(self.request, self.configuration, repository, "token")
            self.assertNotIn("secret", str(raised.exception))
            self.assertEqual(api.call_count, 1)
            self.assertTrue(api.call_args.args[1].endswith("/env"))

    def test_publisher_rejects_owner_credential(self):
        repository = publisher.RepositoryAssignment(123456, "mas-workspace/generated-site", "app")
        ssm = Mock()
        ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "ready"}},
            {"Parameter": {"Value": json.dumps({"database_name": "app", "url": "postgresql://db_" + "a" * 24 + "_owner:secret@host/app"})}},
        ]
        with patch.dict(os.environ, {"DATABASE_CREDENTIALS_SSM_PREFIX": "/db/databases"}), \
             patch.object(publisher, "_client", return_value=ssm), \
             patch.object(publisher, "_vercel_json") as api:
            with self.assertRaises(publisher.PublisherError):
                publisher._install_database_environment("token", self.configuration, repository, "prj_abc123")
        api.assert_not_called()

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
        self.assertEqual(call.kwargs["query"], {"skipAutoDetectionConfirmation": "1"})
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

    def test_ready_public_deployment_is_recorded_on_the_active_job(self) -> None:
        dynamodb = Mock()
        publisher._clients["dynamodb"] = dynamodb
        deployment = {
            "id": "dpl_abc123",
            "ready_state": "READY",
            "project_id": "prj_abc123",
            "project_name": "generated-site",
            "branch": self.request.branch,
            "commit_sha": self.request.commit_sha,
            "public_url": "https://generated-site.vercel.app",
        }

        publisher._record_published_website(
            self.request,
            self.configuration,
            deployment,
        )

        update = dynamodb.update_item.call_args.kwargs
        self.assertEqual(update["TableName"], self.configuration.jobs_table)
        self.assertEqual(
            update["Key"],
            {"pk": {"S": f"JOB#{self.request.job_id}"}},
        )
        self.assertIn("#job_status = :running", update["ConditionExpression"])
        website = update["ExpressionAttributeValues"][":website"]["M"]
        self.assertEqual(
            website["url"],
            {"S": "https://generated-site.vercel.app"},
        )
        self.assertEqual(website["commit_sha"], {"S": self.request.commit_sha})
        self.assertRegex(
            website["published_at"]["S"],
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$",
        )

    def test_non_ready_deployment_is_not_recorded(self) -> None:
        dynamodb = Mock()
        publisher._clients["dynamodb"] = dynamodb

        publisher._record_published_website(
            self.request,
            self.configuration,
            {"ready_state": "BUILDING", "public_url": None},
        )

        dynamodb.update_item.assert_not_called()


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
        self.assertIn('"dynamodb:UpdateItem"', publisher_role)
        self.assertIn("aws_lambda_function.vercel_publisher.arn", software_role)
        self.assertNotIn("vercel_access_token_ssm_parameter_arn", software_role)

    def test_token_value_is_not_managed_by_terraform(self) -> None:
        vercel = (INFRA / "vercel.tf").read_text(encoding="utf-8")

        self.assertNotIn('resource "aws_ssm_parameter"', vercel)


if __name__ == "__main__":
    unittest.main()
