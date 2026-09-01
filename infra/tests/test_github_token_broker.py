from __future__ import annotations

import unittest
from pathlib import Path


INFRA = Path(__file__).resolve().parents[1]


class GitHubTokenBrokerInfrastructureTests(unittest.TestCase):
    def test_orchestrator_can_invoke_broker_but_cannot_read_writer_key(self) -> None:
        iam = (INFRA / "iam.tf").read_text(encoding="utf-8")
        orchestrator = iam.split('resource "aws_iam_role_policy" "orchestrator"', 1)[1]
        orchestrator = orchestrator.split('resource "aws_iam_role" "image_builder"', 1)[0]

        self.assertIn("aws_lambda_function.github_token_broker.arn", orchestrator)
        self.assertNotIn("github_writer_private_key", orchestrator)
        self.assertNotIn("kms:Decrypt", orchestrator)

    def test_only_broker_reads_the_trusted_assignment_table_at_runtime(self) -> None:
        iam = (INFRA / "iam.tf").read_text(encoding="utf-8")
        broker = iam.split('resource "aws_iam_role_policy" "github_token_broker"', 1)[1]
        broker = broker.split('resource "aws_iam_role" "subagent"', 1)[0]
        orchestrator = iam.split('resource "aws_iam_role_policy" "orchestrator"', 1)[1]
        orchestrator = orchestrator.split('resource "aws_iam_role" "image_builder"', 1)[0]

        self.assertIn("aws_dynamodb_table.github_repository_assignments.arn", broker)
        self.assertIn('"kms:EncryptionContext:PARAMETER_ARN"', broker)
        self.assertNotIn(
            "aws_dynamodb_table.github_repository_assignments.arn", orchestrator
        )

    def test_private_key_value_is_not_managed_by_terraform(self) -> None:
        github = (INFRA / "github.tf").read_text(encoding="utf-8")

        self.assertNotIn('resource "aws_ssm_parameter"', github)
        self.assertIn('resource "aws_kms_key" "github_writer_private_key"', github)

    def test_admin_job_api_configuration_is_exported(self) -> None:
        outputs = (INFRA / "outputs.tf").read_text(encoding="utf-8")

        self.assertIn(
            'output "github_repository_assignments_table_name"', outputs
        )
        self.assertIn(
            'output "software_builder_orchestrator_launch_template_id"', outputs
        )

    def test_software_builder_uses_a_dedicated_role_and_scoped_project_session(self) -> None:
        iam = (INFRA / "iam.tf").read_text(encoding="utf-8")
        compute = (INFRA / "compute.tf").read_text(encoding="utf-8")
        software_role = iam.split(
            'resource "aws_iam_role_policy" "software_builder_orchestrator"', 1
        )[1].split('resource "aws_iam_role" "image_builder"', 1)[0]
        project_role = iam.split(
            'resource "aws_iam_role_policy" "software_builder_project_workspace"',
            1,
        )[1].split('resource "aws_iam_role" "subagent"', 1)[0]

        self.assertIn(
            "aws_iam_instance_profile.software_builder_orchestrator.name",
            compute,
        )
        self.assertIn("aws_lambda_function.project_credentials_broker.arn", software_role)
        self.assertNotIn("global_memory", software_role)
        self.assertIn('$${aws:PrincipalTag/ProjectName}/*', project_role)
        self.assertIn('"s3:PutObject"', project_role)
        self.assertIn('"s3:DeleteObject"', project_role)
        self.assertIn('"s3:GetObject"', project_role)


if __name__ == "__main__":
    unittest.main()
