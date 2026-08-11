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
        self.assertEqual(images.count("codex sandbox linux -- /bin/true"), 2)

    def test_orchestrator_bootstrap_does_not_install_system_packages(self) -> None:
        compute = (Path(__file__).resolve().parents[1] / "compute.tf").read_text(
            encoding="utf-8"
        )
        normal_bootstrap = compute.split("  orchestrator_bootstrap =", 1)[1].split(
            "  orchestrator_stress_bootstrap =", 1
        )[0]
        stress_bootstrap = compute.split("  orchestrator_stress_bootstrap =", 1)[1]

        self.assertNotIn("apt-get", normal_bootstrap)
        self.assertNotIn("bubblewrap", normal_bootstrap)
        self.assertNotIn("danger-full-access", normal_bootstrap)
        self.assertNotIn("apt-get", stress_bootstrap)


if __name__ == "__main__":
    unittest.main()
