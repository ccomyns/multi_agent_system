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


if __name__ == "__main__":
    unittest.main()
