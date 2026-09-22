"""Exercise launch-time maintenance controls without changing the test host."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class SoftwareHostMaintenanceTests(unittest.TestCase):
    def test_updates_drain_before_start_and_restart_preserves_host(self):
        compute = (Path(__file__).resolve().parents[1] / "compute.tf").read_text()
        bootstrap = compute.split("software_builder_orchestrator_bootstrap = <<-EOT", 1)[1]
        fragment = bootstrap.split("    # Patch the AMI", 1)[1].split(
            "    cat >> /etc/multi-agent/orchestrator.env", 1
        )[0]
        # Terraform strips heredoc indentation before handing this script to bash.
        fragment = "\n".join(line[4:] if line.startswith("    ") else line
                             for line in ("    # Patch the AMI" + fragment).splitlines())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "etc/apt/apt.conf.d").mkdir(parents=True)
            calls = root / "calls"
            fragment = fragment.replace("/etc/", str(root / "etc") + "/")
            mocks = '''set -euo pipefail
systemctl() {
  echo "$*" >> "$TEST_ROOT/calls"
  if [ "$1" = is-active ]; then
    if [ -f "$TEST_ROOT/update-finished" ]; then return 3; fi
    touch "$TEST_ROOT/update-finished"
  fi
}
sleep() { echo waited >> "$TEST_ROOT/calls"; }
shutdown() { exit 99; }
'''
            subprocess.run(["bash", "-c", mocks + fragment], check=True,
                           env={**os.environ, "TEST_ROOT": str(root)}, capture_output=True)
            lines = calls.read_text().splitlines()
            self.assertIn("mask --now apt-daily.timer apt-daily-upgrade.timer", lines)
            self.assertIn("mask apt-daily.service apt-daily-upgrade.service", lines)
            self.assertEqual(lines.count("waited"), 1)
            self.assertEqual(lines[-1], "is-active --quiet apt-daily.service apt-daily-upgrade.service")
            self.assertIn('APT::Periodic::Enable "0";',
                          (root / "etc/apt/apt.conf.d/99-multi-agent").read_text())
            self.assertIn(r"qr(^multi-agent-orchestrator\.service$)} = 0;",
                          (root / "etc/needrestart/conf.d/multi-agent.conf").read_text())
            unit = (root / "etc/systemd/system/multi-agent-orchestrator.service.d/recovery.conf").read_text()
            hook = unit.split("ExecStopPost=+/bin/sh -c '", 1)[1].split("'", 1)[0]
            hook = hook.replace("/sbin/shutdown -h now", "exit 42")
            for code, status, expected in [("killed", "TERM", 0), ("exited", "0", 42),
                                           ("exited", "1", 42), ("killed", "KILL", 42)]:
                with self.subTest(code=code, status=status):
                    result = subprocess.run(["sh", "-c", hook],
                                            env={**os.environ, "EXIT_CODE": code, "EXIT_STATUS": status})
                    self.assertEqual(result.returncode, expected)
