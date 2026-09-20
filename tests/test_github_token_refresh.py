import importlib.util
import io
import json
from pathlib import Path
import os
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

BIN = Path(__file__).resolve().parents[1] / 'infra/runtime/orch_software_builder/bin'
sys.path.insert(0, str(BIN))
import github_token_refresh as refresh
from software_github_credentials import RepositoryCredentials

spec = importlib.util.spec_from_file_location('refresh_credential_helper', BIN / 'github_credential_helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class RefreshTests(unittest.TestCase):
    def credentials(self, minutes=60, token='a'):
        return RepositoryCredentials('ghs_' + token * 36, (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(), 123, 'org/repo')

    def controller(self, path, initial, fetch):
        return refresh.GitHubTokenRefresher(path=path, initial=initial, job_id='job', orchestrator_id='instance', fetch=fetch)

    def test_refresh_schedules_from_reported_expiry_with_five_minute_margin(self):
        for minutes in (60, 30, 10):
            self.assertAlmostEqual(refresh.refresh_delay(self.credentials(minutes)), (minutes - 5) * 60, delta=2)
        self.assertEqual(refresh.refresh_delay(self.credentials(4)), 0)

    def test_cache_is_private_atomic_scoped_and_rejects_expiring_tokens(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'token.json'
            token = self.credentials()
            refresh.write_credentials(path, token, 'job', 'instance')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(refresh.read_credentials(path, 'job', 'instance'), token)
            self.assertIsNone(refresh.read_credentials(path, 'other-job', 'instance'))
            self.assertIsNone(refresh.read_credentials(path, 'job', 'other-instance'))
            refresh.write_credentials(path, self.credentials(4), 'job', 'instance')
            self.assertIsNone(refresh.read_credentials(path, 'job', 'instance'))
            self.assertEqual(list(Path(temp).iterdir()), [path])

    def test_background_refresh_recovers_without_logging_token(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'token.json'
            fresh = self.credentials(token='b')
            fetch = Mock(side_effect=[RuntimeError('SECRET'), fresh])
            run = self.controller(path, self.credentials(), fetch)
            run.stopping = Mock()
            run.stopping.wait.side_effect = [False, False, True]
            run.stopping.is_set.return_value = False
            with self.assertLogs(refresh.LOG, level='INFO') as logs:
                run._run()
            self.assertEqual(refresh.read_credentials(path, 'job', 'instance'), fresh)
            self.assertEqual(run.stopping.wait.call_args_list[1].args, (60,))
            self.assertNotIn('SECRET', '\n'.join(logs.output))
            self.assertNotIn(fresh.token, '\n'.join(logs.output))

    def test_shutdown_during_fetch_does_not_recreate_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'token.json'
            run = self.controller(path, self.credentials(), Mock())
            run.stopping = Mock()
            run.stopping.wait.return_value = False
            run.stopping.is_set.return_value = True
            run.fetch.return_value = self.credentials(token='b')
            run._run()
            self.assertFalse(path.exists())

    def test_changed_repository_cannot_replace_cached_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'token.json'
            initial = self.credentials()
            refresh.write_credentials(path, initial, 'job', 'instance')
            other = RepositoryCredentials(initial.token, initial.expires_at, 456, 'org/other')
            run = self.controller(path, initial, Mock(return_value=other))
            run.stopping = Mock()
            run.stopping.wait.side_effect = [False, True]
            with self.assertLogs(refresh.LOG, level='WARNING'):
                run._run()
            self.assertEqual(refresh.read_credentials(path, 'job', 'instance'), initial)

    def test_start_and_stop_remove_cached_secret(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'token.json'
            run = self.controller(path, self.credentials(), Mock())
            run.start()
            self.assertTrue(path.exists())
            run.stop()
            self.assertFalse(path.exists())
            self.assertFalse(run.thread.is_alive())
            run.fetch.assert_not_called()

    def test_git_uses_cached_token_then_fetches_when_cache_is_stale(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'token.json'
            initial, fresh = self.credentials(), self.credentials(token='b')
            env = {'SOFTWARE_BUILDER_GITHUB_CREDENTIAL_FILE': str(path), 'JOB_ID': 'job', 'ORCHESTRATOR_INSTANCE_ID': 'instance', 'AWS_REGION': 'us-east-1', 'GITHUB_TOKEN_BROKER_FUNCTION_NAME': 'broker'}
            def invoke(operation='get', repository='org/repo.git'):
                output = io.StringIO()
                code = helper.main(['helper', operation], io.StringIO(f'protocol=https\nhost=github.com\npath={repository}\n\n'), output)
                return code, output.getvalue()
            with patch.dict(os.environ, env), patch.object(helper, 'request_repository_credentials', return_value=fresh) as fetch:
                refresh.write_credentials(path, initial, 'job', 'instance')
                self.assertIn(initial.token, invoke()[1])
                fetch.assert_not_called()
                self.assertEqual(invoke(repository='org/other.git'), (1, ''))
                self.assertEqual(invoke('erase'), (0, ''))
                self.assertFalse(path.exists())
                self.assertIn(fresh.token, invoke()[1])
                refresh.write_credentials(path, self.credentials(4), 'job', 'instance')
                self.assertIn(fresh.token, invoke()[1])
                self.assertEqual(fetch.call_count, 2)


if __name__ == '__main__':
    unittest.main()
