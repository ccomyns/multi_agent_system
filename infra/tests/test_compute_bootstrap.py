from __future__ import annotations

import unittest
from pathlib import Path


class SandboxDependencyTests(unittest.TestCase):
    def test_sandbox_dependencies_are_baked_and_probed_in_both_images(self) -> None:
        images = (Path(__file__).resolve().parents[1] / "images.tf").read_text(
            encoding="utf-8"
        )

        self.assertIn("apparmor-profiles apparmor-utils bubblewrap", images)
        self.assertIn("bwrap-userns-restrict", images)
        self.assertIn('echo "bubblewrap=$(bwrap --version)"', images)
        self.assertEqual(images.count("codex sandbox -- /bin/true"), 2)
        self.assertEqual(
            images.count("if [ ! -x /opt/multi-agent/venv/bin/python ]; then"), 2
        )
        self.assertIn("--upgrade pip boto3 'mcp>=1.27,<2'", images)

    def test_orchestrator_bootstrap_does_not_install_system_packages(self) -> None:
        compute = (Path(__file__).resolve().parents[1] / "compute.tf").read_text(
            encoding="utf-8"
        )
        normal_bootstrap = compute.split("  orchestrator_bootstrap =", 1)[1]

        self.assertNotIn("apt-get", normal_bootstrap)
        self.assertNotIn("bubblewrap", normal_bootstrap)
        self.assertNotIn("danger-full-access", normal_bootstrap)
        self.assertNotIn("stress", compute.lower())
        self.assertIn("GITHUB_TOKEN_BROKER_FUNCTION_NAME=", compute)
        self.assertNotIn("GITHUB_WRITER_PRIVATE_KEY", compute)


if __name__ == "__main__":
    unittest.main()
