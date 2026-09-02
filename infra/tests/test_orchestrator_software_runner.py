from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
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

ORCHESTRATOR_BIN_DIR = (
    Path(__file__).resolve().parents[1]
    / "runtime"
    / "orchestrator"
    / "bin"
)
SOFTWARE_BUILDER_BIN_DIR = (
    Path(__file__).resolve().parents[1]
    / "runtime"
    / "orch_software_builder"
    / "bin"
)
sys.path.insert(0, str(ORCHESTRATOR_BIN_DIR))
sys.path.insert(0, str(SOFTWARE_BUILDER_BIN_DIR))


def load_module(name: str, filename: str, bin_dir: Path):
    specification = importlib.util.spec_from_file_location(name, bin_dir / filename)
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    return module


data_mining_entrypoint_module = load_module(
    "data_mining_orchestrator_entrypoint",
    "orchestrator_entrypoint.py",
    ORCHESTRATOR_BIN_DIR,
)
software_builder_entrypoint_module = load_module(
    "software_builder_orchestrator_entrypoint",
    "orchestrator_entrypoint.py",
    SOFTWARE_BUILDER_BIN_DIR,
)
credentials_module = load_module(
    "software_github_credentials",
    "software_github_credentials.py",
    SOFTWARE_BUILDER_BIN_DIR,
)
project_credentials_module = load_module(
    "software_project_credentials",
    "software_project_credentials.py",
    SOFTWARE_BUILDER_BIN_DIR,
)
helper_module = load_module(
    "github_credential_helper",
    "github_credential_helper.py",
    SOFTWARE_BUILDER_BIN_DIR,
)
runner_module = load_module(
    "orchestrator_software_runner",
    "orchestrator_software_runner.py",
    SOFTWARE_BUILDER_BIN_DIR,
)

RepositoryCredentials = credentials_module.RepositoryCredentials
ProjectCredentials = project_credentials_module.ProjectCredentials
SoftwareOrchestratorRun = runner_module.SoftwareOrchestratorRun


class SoftwareRunnerSeparationTests(unittest.TestCase):
    def test_software_builder_uses_a_distinct_ami_and_launch_template(self) -> None:
        infra = Path(__file__).resolve().parents[1]
        images = (infra / "images.tf").read_text(encoding="utf-8")
        compute = (infra / "compute.tf").read_text(encoding="utf-8")

        self.assertIn(
            'resource "aws_imagebuilder_image_recipe" "software_builder_orchestrator"',
            images,
        )
        self.assertIn(
            'resource "aws_imagebuilder_image" "software_builder_orchestrator"',
            images,
        )
        self.assertIn("software_builder_orchestrator_ami_id = one(", images)
        self.assertIn(
            'resource "aws_launch_template" "software_builder_orchestrator"',
            compute,
        )
        self.assertIn(
            "image_id               = local.software_builder_orchestrator_ami_id",
            compute,
        )
        software_recipe = images.split(
            'resource "aws_imagebuilder_image_recipe" "software_builder_orchestrator"',
            1,
        )[1].split('resource "aws_imagebuilder_image_recipe" "subagent"', 1)[0]
        self.assertIn(
            "aws_imagebuilder_component.software_builder_base_runtime.arn",
            software_recipe,
        )
        self.assertNotIn(
            "aws_imagebuilder_component.data_mining_orchestrator_base_runtime.arn",
            software_recipe,
        )

    def test_all_runtimes_are_hash_pinned_and_installed_at_launch(self) -> None:
        infra = Path(__file__).resolve().parents[1]
        artifacts = (infra / "artifacts.tf").read_text(encoding="utf-8")
        compute = (infra / "compute.tf").read_text(encoding="utf-8")
        iam = (infra / "iam.tf").read_text(encoding="utf-8")
        images = (infra / "images.tf").read_text(encoding="utf-8")

        self.assertIn("system/runtime/orchestrator-data-mining/", artifacts)
        self.assertIn("system/runtime/software-builder/", artifacts)
        self.assertIn("system/runtime/subagent-data-mining/", artifacts)
        self.assertEqual(compute.count("ORCHESTRATOR_RUNTIME_S3_KEY="), 2)
        self.assertEqual(compute.count("ORCHESTRATOR_RUNTIME_SHA256="), 2)
        self.assertNotIn("SOFTWARE_BUILDER_RUNTIME_S3_KEY=", compute)
        self.assertIn(
            "user_data = base64encode(local.software_builder_orchestrator_bootstrap)",
            compute,
        )
        orchestrator_policy = iam.split(
            'resource "aws_iam_role_policy" "orchestrator"', 1
        )[1].split('resource "aws_iam_role" "image_builder"', 1)[0]
        subagent_policy = iam.split(
            'resource "aws_iam_role_policy" "subagent"', 1
        )[1].split('resource "aws_iam_role" "orchestrator"', 1)[0]
        self.assertIn("ReadIsolatedOrchestratorRuntimes", orchestrator_policy)
        self.assertIn("system/runtime/orchestrator-data-mining/*", orchestrator_policy)
        self.assertIn("system/runtime/software-builder/*", orchestrator_policy)
        self.assertIn("ReadDataMiningSubagentRuntime", subagent_policy)
        self.assertIn("system/runtime/subagent-data-mining/*", subagent_policy)
        self.assertIn(
            "ExecStart=/usr/local/bin/run-runtime-orchestrator",
            images,
        )
        data_mining_component = images.split(
            'resource "aws_imagebuilder_component" "data_mining_orchestrator_base_runtime"',
            1,
        )[1].split(
            'resource "aws_imagebuilder_component" "software_builder_base_runtime"',
            1,
        )[0]
        self.assertNotIn("software_builder_runtime", data_mining_component)
        self.assertNotIn("aws_s3_object", data_mining_component)

        software_component = images.split(
            'resource "aws_imagebuilder_component" "software_builder_base_runtime"',
            1,
        )[1].split(
            'resource "aws_imagebuilder_component" "subagent_browser_tools"',
            1,
        )[0]
        self.assertNotIn("data_mining_orchestrator_runtime", software_component)
        self.assertNotIn("aws_s3_object", software_component)

        subagent_component = images.split(
            'resource "aws_imagebuilder_component" "data_mining_subagent_base_runtime"',
            1,
        )[1].split('resource "aws_imagebuilder_image_recipe" "orchestrator"', 1)[0]
        self.assertNotIn("aws_s3_object", subagent_component)
        self.assertNotIn('action = "S3Download"', images)

        lambda_tf = (infra / "lambda.tf").read_text(encoding="utf-8")
        manager_source = (
            infra.parent / "src" / "subagent_manager" / "handler.py"
        ).read_text(encoding="utf-8")
        self.assertIn("SUBAGENT_RUNTIME_S3_KEY", lambda_tf)
        self.assertIn("SUBAGENT_RUNTIME_SHA256", lambda_tf)
        self.assertIn("SUBAGENT_RUNTIME_S3_KEY=", manager_source)
        self.assertIn("SUBAGENT_RUNTIME_SHA256=", manager_source)

    def test_dispatchers_reject_the_other_runtime_job_type(self) -> None:
        self.assertEqual(
            data_mining_entrypoint_module.runner_path(
                "data_mining", ORCHESTRATOR_BIN_DIR
            ).name,
            "orchestrator_runner.py",
        )
        with self.assertRaisesRegex(RuntimeError, "unsupported TYPE_OF_JOB"):
            data_mining_entrypoint_module.runner_path(
                "software_builder", ORCHESTRATOR_BIN_DIR
            )

        self.assertEqual(
            software_builder_entrypoint_module.runner_path(
                "software_builder", SOFTWARE_BUILDER_BIN_DIR
            ).name,
            "orchestrator_software_runner.py",
        )
        with self.assertRaisesRegex(RuntimeError, "unsupported TYPE_OF_JOB"):
            software_builder_entrypoint_module.runner_path(
                "data_mining", SOFTWARE_BUILDER_BIN_DIR
            )

    def test_software_runner_has_no_data_mining_or_subagent_runtime_dependency(self) -> None:
        source = (SOFTWARE_BUILDER_BIN_DIR / "orchestrator_software_runner.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("from orchestrator_runner", source)
        self.assertNotIn("import orchestrator_runner", source)
        self.assertNotIn("SPAWN_AGENT_MCP_COMMAND", source)
        self.assertNotIn("[mcp_servers.", source)
        self.assertNotIn("final_result.json", source)

    def test_systemd_starts_the_trusted_dispatcher(self) -> None:
        infra = Path(__file__).resolve().parents[1]
        images = (infra / "images.tf").read_text(encoding="utf-8")
        compute = (infra / "compute.tf").read_text(encoding="utf-8")

        self.assertEqual(
            images.count("ExecStart=/usr/local/bin/run-runtime-orchestrator"), 2
        )
        self.assertIn("ExecStart=/usr/local/bin/run-runtime-subagent", images)
        self.assertNotIn("/opt/multi-agent/runtime/bin/", images)
        self.assertIn("meta-data/tags/instance/TypeOfJob", compute)
        self.assertIn("TYPE_OF_JOB=$type_of_job", compute)
        self.assertIn("apt-get install -y git", images)
        self.assertIn('"git --version"', images)

    def test_software_builder_database_access_is_scoped_to_its_role_and_network(self) -> None:
        infra = Path(__file__).resolve().parents[1]
        compute = (infra / "compute.tf").read_text(encoding="utf-8")
        database = (infra / "database.tf").read_text(encoding="utf-8")
        iam = (infra / "iam.tf").read_text(encoding="utf-8")

        normal_launch_template = compute.split(
            'resource "aws_launch_template" "orchestrator"', 1
        )[1].split(
            'resource "aws_launch_template" "software_builder_orchestrator"', 1
        )[0]
        software_launch_template = compute.split(
            'resource "aws_launch_template" "software_builder_orchestrator"', 1
        )[1]
        normal_policy = iam.split(
            'resource "aws_iam_role_policy" "orchestrator"', 1
        )[1].split(
            'resource "aws_iam_role" "software_builder_orchestrator"', 1
        )[0]
        software_policy = iam.split(
            'resource "aws_iam_role_policy" "software_builder_orchestrator"', 1
        )[1].split('resource "aws_iam_role" "image_builder"', 1)[0]

        self.assertIn("POSTGRESQL_SSM_PARAMETER_PREFIX=", compute)
        self.assertNotIn("software_builder_database_client", normal_launch_template)
        self.assertIn("software_builder_database_client", software_launch_template)
        self.assertIn(
            'resource "aws_security_group" "software_builder_database_client"',
            database,
        )
        self.assertIn("security_groups = [aws_security_group.postgresql.id]", database)
        self.assertNotIn("ReadPostgresqlCredentials", normal_policy)
        self.assertIn("ReadPostgresqlCredentials", software_policy)
        self.assertIn('"ssm:GetParameters"', software_policy)
        self.assertIn("local.postgresql_ssm_parameter_prefix", software_policy)


class SoftwareGitHubCredentialTests(unittest.TestCase):
    def broker_response(self, **overrides):
        body = {
            "token": "ghs_" + "a" * 36,
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(minutes=55)
            ).isoformat().replace("+00:00", "Z"),
            "repository": {"id": 123456, "fullName": "mas-workspace/empty-repo"},
            "permissions": {"contents": "write", "metadata": "read"},
            **overrides,
        }
        return {
            "statusCode": 200,
            "body": body,
        }

    def test_broker_request_uses_only_trusted_job_identity(self) -> None:
        client = Mock()
        client.invoke.return_value = {
            "Payload": io.BytesIO(json.dumps(self.broker_response()).encode("utf-8"))
        }

        credentials = credentials_module.request_repository_credentials(
            region="us-east-1",
            function_name="github-token-broker",
            job_id="job_abc1_1234abcd",
            orchestrator_instance_id="i-1234567890abcdef0",
            lambda_client=client,
        )

        request = json.loads(client.invoke.call_args.kwargs["Payload"])
        self.assertEqual(
            request,
            {
                "job_id": "job_abc1_1234abcd",
                "orchestrator_instance_id": "i-1234567890abcdef0",
            },
        )
        self.assertEqual(credentials.repository_full_name, "mas-workspace/empty-repo")
        self.assertEqual(credentials.repository_id, 123456)

    def test_broker_accepts_stateless_github_installation_tokens(self) -> None:
        # GitHub's 2026 stateless format is ghs_APPID_JWT. JWT base64url
        # segments contain periods and may contain hyphens and underscores.
        token = (
            "ghs_123456_"
            "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJpc3MiOiIxMjM0NTYiLCJzdWIiOiJpbnN0YWxsYXRpb24ifQ."
            "signature-with_url-safe-characters"
        )
        client = Mock()
        client.invoke.return_value = {
            "Payload": io.BytesIO(
                json.dumps(self.broker_response(token=token)).encode("utf-8")
            )
        }

        credentials = credentials_module.request_repository_credentials(
            region="us-east-1",
            function_name="github-token-broker",
            job_id="job_abc1_1234abcd",
            orchestrator_instance_id="i-1234567890abcdef0",
            lambda_client=client,
        )

        self.assertEqual(credentials.token, token)

    def test_broker_rejects_non_installation_and_line_break_tokens(self) -> None:
        for token in (
            "ghp_" + "a" * 36,
            "ghs_" + "a" * 15,
            "ghs_" + "a" * 20 + "\npassword=attacker-controlled",
        ):
            with self.subTest(token_type=token[:4], token_length=len(token)):
                client = Mock()
                client.invoke.return_value = {
                    "Payload": io.BytesIO(
                        json.dumps(self.broker_response(token=token)).encode("utf-8")
                    )
                }
                with self.assertRaisesRegex(RuntimeError, "invalid token"):
                    credentials_module.request_repository_credentials(
                        region="us-east-1",
                        function_name="github-token-broker",
                        job_id="job_abc1_1234abcd",
                        orchestrator_instance_id="i-1234567890abcdef0",
                        lambda_client=client,
                    )

    def test_broker_response_must_remain_write_only_for_one_repository(self) -> None:
        response = self.broker_response(
            permissions={"contents": "write", "metadata": "read", "issues": "write"}
        )
        client = Mock()
        client.invoke.return_value = {
            "Payload": io.BytesIO(json.dumps(response).encode("utf-8"))
        }

        with self.assertRaisesRegex(RuntimeError, "unexpected permissions"):
            credentials_module.request_repository_credentials(
                region="us-east-1",
                function_name="github-token-broker",
                job_id="job_abc1_1234abcd",
                orchestrator_instance_id="i-1234567890abcdef0",
                lambda_client=client,
            )

    def test_git_helper_returns_credentials_only_for_the_assigned_repo(self) -> None:
        credentials = RepositoryCredentials(
            token="ghs_" + "b" * 36,
            expires_at="2099-01-01T00:00:00Z",
            repository_id=123456,
            repository_full_name="mas-workspace/empty-repo",
        )
        environment = {
            "AWS_REGION": "us-east-1",
            "GITHUB_TOKEN_BROKER_FUNCTION_NAME": "github-token-broker",
            "JOB_ID": "job_abc1_1234abcd",
            "ORCHESTRATOR_INSTANCE_ID": "i-1234567890abcdef0",
        }

        output = io.StringIO()
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(
                helper_module,
                "request_repository_credentials",
                return_value=credentials,
            ),
        ):
            return_code = helper_module.main(
                ["git-credential-software-builder", "get"],
                io.StringIO(
                    "protocol=https\nhost=github.com\n"
                    "path=mas-workspace/empty-repo.git\n\n"
                ),
                output,
            )
        self.assertEqual(return_code, 0)
        self.assertEqual(
            output.getvalue(),
            f"username=x-access-token\npassword={credentials.token}\n\n",
        )

        rejected_output = io.StringIO()
        with (
            patch.dict(os.environ, environment, clear=True),
            patch.object(
                helper_module,
                "request_repository_credentials",
                return_value=credentials,
            ),
        ):
            return_code = helper_module.main(
                ["git-credential-software-builder", "get"],
                io.StringIO(
                    "protocol=https\nhost=github.com\n"
                    "path=mas-workspace/a-different-repo.git\n\n"
                ),
                rejected_output,
            )
        self.assertEqual(return_code, 1)
        self.assertEqual(rejected_output.getvalue(), "")


class SoftwareProjectCredentialTests(unittest.TestCase):
    def broker_response(self, **project_overrides):
        return {
            "statusCode": 200,
            "body": {
                "credentials": {
                    "access_key_id": "ASIAEXAMPLE",
                    "secret_access_key": "secret",
                    "session_token": "session-token",
                    "expiration": (
                        datetime.now(timezone.utc) + timedelta(minutes=55)
                    ).isoformat().replace("+00:00", "Z"),
                },
                "project": {
                    "name": "customer-insights",
                    "bucket": "global-memory-bucket",
                    "prefix": "customer-insights/",
                    "s3_uri": "s3://global-memory-bucket/customer-insights/",
                    **project_overrides,
                },
            },
        }

    def test_broker_request_contains_identity_but_no_project_scope(self) -> None:
        client = Mock()
        client.invoke.return_value = {
            "Payload": io.BytesIO(
                json.dumps(self.broker_response()).encode("utf-8")
            )
        }

        credentials = project_credentials_module.request_project_credentials(
            region="us-east-1",
            function_name="project-credentials-broker",
            job_id="job_abc1_1234abcd",
            orchestrator_instance_id="i-1234567890abcdef0",
            lambda_client=client,
        )

        request = json.loads(client.invoke.call_args.kwargs["Payload"])
        self.assertEqual(
            request,
            {
                "job_id": "job_abc1_1234abcd",
                "orchestrator_instance_id": "i-1234567890abcdef0",
            },
        )
        self.assertEqual(credentials.project_name, "customer-insights")
        self.assertEqual(
            credentials.s3_uri,
            "s3://global-memory-bucket/customer-insights/",
        )

    def test_broker_response_cannot_broaden_the_project_prefix(self) -> None:
        client = Mock()
        client.invoke.return_value = {
            "Payload": io.BytesIO(
                json.dumps(
                    self.broker_response(prefix="", s3_uri="s3://global-memory-bucket/")
                ).encode("utf-8")
            )
        }

        with self.assertRaisesRegex(RuntimeError, "invalid prefix"):
            project_credentials_module.request_project_credentials(
                region="us-east-1",
                function_name="project-credentials-broker",
                job_id="job_abc1_1234abcd",
                orchestrator_instance_id="i-1234567890abcdef0",
                lambda_client=client,
            )


class SoftwareOrchestratorRunnerTests(unittest.TestCase):
    def make_run(self, root: Path) -> SoftwareOrchestratorRun:
        run = SoftwareOrchestratorRun.__new__(SoftwareOrchestratorRun)
        run.region = "us-east-1"
        run.job_id = "job_abc1_1234abcd"
        run.job_pk = f"JOB#{run.job_id}"
        run.orchestrator_instance_id = "i-1234567890abcdef0"
        run.jobs_table = "jobs-table"
        run.workspace_bucket = "workspace-bucket"
        run.global_memory_bucket = "global-memory-bucket"
        run.auth_parameter = "/project/codex/auth-json"
        run.database_parameter_prefix = "/project/database/postgresql"
        run.orchestrator_model = "gpt-5.6-terra"
        run.token_broker_function = "github-token-broker"
        run.project_broker_function = "project-credentials-broker"
        run.job_root = root / "software-job"
        run.repository_root = run.job_root / "repository"
        run.codex_home = root / "software-codex-home"
        run.result_dir = root / "software-result"
        run.final_message = run.result_dir / "final.md"
        run.result_manifest = run.result_dir / "software_result.json"
        run.completed_file = run.result_dir / "completed.md"
        run.failure_file = run.result_dir / "failure.md"
        run.credential_helper = root / "github_credential_helper.py"
        run.credential_helper.write_text("# helper\n", encoding="utf-8")
        run.project_credential_process = root / "software_project_credentials.py"
        run.project_credential_process.write_text("# process\n", encoding="utf-8")
        run.project_aws_config = run.codex_home / "project-aws-config"
        run.database_url_file = run.codex_home / "database-url"
        run.bootstrap_log = root / "logs" / "bootstrap.log"
        run.codex_log = root / "logs" / "software-codex.log"
        run.ddb = Mock()
        run.s3 = Mock()
        run.ssm = Mock()
        run.lambda_client = Mock()
        run.telemetry = runner_module.TelemetryRecorder(
            s3=run.s3,
            bucket=run.workspace_bucket,
            prefix=f"jobs/{run.job_id}/orchestrator/telemetry",
            local_dir=root / "software-telemetry",
            actor_type="orchestrator",
            job_id=run.job_id,
            orchestrator_instance_id=run.orchestrator_instance_id,
        )
        run.original_auth = ""
        run.database_url = "postgresql://user:password@database.example.com:5432/app"
        run.repository_id = None
        run.repository_full_name = None
        run.project_name = None
        run.project_prefix = None
        run.project_s3_uri = None
        run.prepare_directories()
        run._atomic_secret_write(run.database_url_file, run.database_url)
        run.bootstrap_log.parent.mkdir()
        run.bootstrap_log.write_text("bootstrap\n", encoding="utf-8")
        run.codex_log.write_text("", encoding="utf-8")
        return run

    def test_database_credentials_are_loaded_from_ssm_and_stored_outside_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            values = {
                "host": "database.example.com",
                "port": "5432",
                "database-name": "research agents",
                "username": "research admin",
                "password": "p@ss/word",
            }
            run.ssm.get_parameters.return_value = {
                "Parameters": [
                    {
                        "Name": f"{run.database_parameter_prefix}/{name}",
                        "Value": value,
                    }
                    for name, value in values.items()
                ],
                "InvalidParameters": [],
            }

            run.install_database_credentials()

            self.assertEqual(
                run.database_url,
                "postgresql://research%20admin:p%40ss%2Fword@"
                "database.example.com:5432/research%20agents?sslmode=require",
            )
            self.assertEqual(
                run.database_url_file.read_text(encoding="utf-8").strip(),
                run.database_url,
            )
            self.assertEqual(run.database_url_file.stat().st_mode & 0o777, 0o600)
            self.assertFalse(run.database_url_file.is_relative_to(run.repository_root))
            run.ssm.get_parameters.assert_called_once_with(
                Names=[
                    f"{run.database_parameter_prefix}/host",
                    f"{run.database_parameter_prefix}/port",
                    f"{run.database_parameter_prefix}/database-name",
                    f"{run.database_parameter_prefix}/username",
                    f"{run.database_parameter_prefix}/password",
                ],
                WithDecryption=True,
            )

            run.clear_database_credentials()
            self.assertEqual(run.database_url, "")
            self.assertFalse(run.database_url_file.exists())

    def test_database_credentials_fail_closed_when_ssm_omits_a_parameter(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            run.clear_database_credentials()
            run.ssm.get_parameters.return_value = {
                "Parameters": [],
                "InvalidParameters": [
                    f"{run.database_parameter_prefix}/password"
                ],
            }

            with self.assertRaisesRegex(RuntimeError, "do not exist"):
                run.install_database_credentials()

            self.assertFalse(run.database_url_file.exists())

    def credentials(self) -> RepositoryCredentials:
        return RepositoryCredentials(
            token="ghs_" + "c" * 36,
            expires_at="2099-01-01T00:00:00Z",
            repository_id=123456,
            repository_full_name="mas-workspace/empty-repo",
        )

    def test_task_must_be_a_running_software_builder_job(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            run.ddb.get_item.return_value = {
                "Item": {
                    "type_of_job": {"S": "software_builder"},
                    "status": {"S": "running"},
                    "orchestrator_instance_id": {"S": run.orchestrator_instance_id},
                    "original_task": {"S": "Build a small API."},
                }
            }
            self.assertEqual(
                run.load_task(timeout_seconds=0),
                "Build a small API.",
            )

            run.ddb.get_item.return_value["Item"]["type_of_job"] = {"S": "data_mining"}
            with self.assertRaisesRegex(RuntimeError, "not a software-builder job"):
                run.load_task(timeout_seconds=0)

    def test_checkout_uses_broker_token_without_putting_it_in_the_remote_url(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            credentials = self.credentials()
            calls: list[tuple[list[str], dict[str, str]]] = []

            def execute(command, **kwargs):
                calls.append((command, kwargs.get("env", {})))
                if command[:2] == ["git", "clone"]:
                    (run.repository_root / ".git").mkdir(parents=True)
                return subprocess.CompletedProcess(command, 0, "", "")

            with (
                patch.object(run, "request_repository_credentials", return_value=credentials),
                patch.object(runner_module.subprocess, "run", side_effect=execute),
            ):
                returned = run.checkout_repository()

            clone_command, clone_environment = calls[0]
            self.assertEqual(
                returned,
                {"id": credentials.repository_id, "full_name": credentials.repository_full_name},
            )
            self.assertIn(
                "https://github.com/mas-workspace/empty-repo.git",
                clone_command,
            )
            self.assertNotIn(credentials.token, " ".join(clone_command))
            self.assertEqual(
                clone_environment["SOFTWARE_BUILDER_GITHUB_TOKEN"],
                credentials.token,
            )
            self.assertFalse(any(run.job_root.glob("github-askpass-*")))
            config_commands = [command for command, _ in calls[1:]]
            self.assertTrue(
                any(
                    command[-2:] == ["credential.useHttpPath", "true"]
                    for command in config_commands
                )
            )

    def test_codex_starts_at_repository_root_without_subagent_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            (run.repository_root / ".git").mkdir(parents=True)
            credentials = self.credentials()
            run.repository_id = credentials.repository_id
            run.repository_full_name = credentials.repository_full_name

            def complete_codex(command, **kwargs):
                run.final_message.write_text("Implemented and pushed.\n", encoding="utf-8")
                process = Mock()
                process.stdout = io.BytesIO(
                    b'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n'
                )
                process.wait.return_value = 0
                return process

            with patch.object(
                runner_module.subprocess,
                "Popen",
                side_effect=complete_codex,
            ) as popen:
                run.run_codex("Implement the requested feature.")

            command = popen.call_args.args[0]
            environment = popen.call_args.kwargs["env"]
            self.assertEqual(command[command.index("--cd") + 1], str(run.repository_root))
            self.assertEqual(
                command[command.index("--sandbox") + 1],
                "danger-full-access",
            )
            self.assertEqual(
                command[command.index("--ask-for-approval") + 1],
                "never",
            )
            self.assertNotIn("--skip-git-repo-check", command)
            self.assertEqual(environment["SOFTWARE_BUILDER_REPOSITORY_ROOT"], str(run.repository_root))
            self.assertEqual(
                environment["GITHUB_TOKEN_BROKER_FUNCTION_NAME"],
                run.token_broker_function,
            )
            self.assertEqual(environment["AWS_EC2_METADATA_DISABLED"], "true")
            self.assertEqual(environment["DATABASE_URL"], run.database_url)
            self.assertEqual(
                environment["DATABASE_URL_FILE"],
                str(run.database_url_file),
            )
            self.assertNotIn("AWS_PROFILE", environment)
            self.assertNotIn("FUNCTION_NAME", environment)
            self.assertNotIn("SPAWN_AGENT_MCP_COMMAND", environment)

            config = (run.codex_home / "config.toml").read_text(encoding="utf-8")
            self.assertIn("current working directory is exactly", config)
            self.assertIn("No subagent tools are configured", config)
            self.assertIn("git add and commit every intended change", config)
            self.assertIn("push the current branch to origin", config)
            self.assertIn("leave the working tree clean", config)
            self.assertIn("PostgreSQL DATABASE_URL is available", config)
            self.assertNotIn(run.database_url, config)
            self.assertNotIn("[sandbox_workspace_write]", config)
            self.assertNotIn("[mcp_servers.", config)

    def test_project_workspace_uses_refreshable_scoped_aws_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            credentials = ProjectCredentials(
                access_key_id="ASIAEXAMPLE",
                secret_access_key="secret",
                session_token="session-token",
                expiration="2099-01-01T00:00:00Z",
                project_name="customer-insights",
                bucket=run.global_memory_bucket,
                prefix="customer-insights/",
                s3_uri=(
                    f"s3://{run.global_memory_bucket}/customer-insights/"
                ),
            )
            with patch.object(
                runner_module,
                "request_project_credentials",
                return_value=credentials,
            ) as request_credentials:
                project = run.configure_project_workspace()

            self.assertEqual(project["name"], "customer-insights")
            request_credentials.assert_called_once_with(
                region=run.region,
                function_name=run.project_broker_function,
                job_id=run.job_id,
                orchestrator_instance_id=run.orchestrator_instance_id,
                allow_unassigned=True,
                lambda_client=run.lambda_client,
            )
            environment = run.codex_environment()
            self.assertEqual(environment["AWS_PROFILE"], "software-builder-project")
            self.assertEqual(
                environment["SOFTWARE_BUILDER_PROJECT_S3_URI"],
                credentials.s3_uri,
            )
            self.assertNotIn("AWS_ACCESS_KEY_ID", environment)
            aws_config = run.project_aws_config.read_text(encoding="utf-8")
            self.assertIn("[profile software-builder-project]", aws_config)
            self.assertIn("credential_process =", aws_config)

    def test_completion_requires_a_clean_commit_present_on_origin(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = self.make_run(Path(temporary))
            credentials = self.credentials()
            run.repository_id = credentials.repository_id
            run.repository_full_name = credentials.repository_full_name
            commit = "a" * 40
            with patch.object(
                run,
                "_git",
                side_effect=[
                    "https://github.com/mas-workspace/empty-repo.git",
                    "",
                    commit,
                    "main",
                    f"{commit}\trefs/heads/main",
                ],
            ):
                result = run.verify_repository_published()

            self.assertEqual(result["repository"]["full_name"], "mas-workspace/empty-repo")
            self.assertEqual(result["branch"], "main")
            self.assertEqual(result["commit_sha"], commit)


if __name__ == "__main__":
    unittest.main()
