from __future__ import annotations

import unittest
from pathlib import Path


INFRA_ROOT = Path(__file__).resolve().parents[1]


class SubagentTerminationInfrastructureTests(unittest.TestCase):
    def test_terraform_manages_dedicated_terminator_lambda(self) -> None:
        lambda_tf = (INFRA_ROOT / "lambda.tf").read_text(encoding="utf-8")
        iam_tf = (INFRA_ROOT / "iam.tf").read_text(encoding="utf-8")

        self.assertIn('resource "aws_lambda_function" "subagent_terminator"', lambda_tf)
        self.assertIn('source_file = "${path.module}/../src/subagent_terminator/handler.py"', lambda_tf)
        self.assertIn('principal      = "s3.amazonaws.com"', lambda_tf)
        self.assertIn('resource "aws_iam_role" "subagent_terminator"', iam_tf)
        self.assertIn('"ec2:ResourceTag/ManagedBy" = "subagent-manager"', iam_tf)
        self.assertIn('"s3:GetObjectVersion"', iam_tf)

    def test_workspace_notification_targets_only_termination_requests(self) -> None:
        storage_tf = (INFRA_ROOT / "storage.tf").read_text(encoding="utf-8")

        self.assertIn('resource "aws_s3_bucket_notification" "agent_workspace"', storage_tf)
        self.assertIn('events              = ["s3:ObjectCreated:Put"]', storage_tf)
        self.assertIn('filter_prefix       = "jobs/"', storage_tf)
        self.assertIn('filter_suffix       = "termination/request.json"', storage_tf)

    def test_subagent_image_version_is_bumped_for_request_publisher(self) -> None:
        variables_tf = (INFRA_ROOT / "variables.tf").read_text(encoding="utf-8")
        agent_block = variables_tf.split('variable "agent_image_version"', 1)[1].split(
            "variable ", 1
        )[0]

        self.assertIn('default     = "1.1.5"', agent_block)

    def test_agent_core_runs_duckdb_installer_with_bash(self) -> None:
        images_tf = (INFRA_ROOT / "images.tf").read_text(encoding="utf-8")

        self.assertIn("HOME=/root bash /tmp/install-duckdb.sh", images_tf)
        self.assertNotIn("HOME=/root sh /tmp/install-duckdb.sh", images_tf)


if __name__ == "__main__":
    unittest.main()
