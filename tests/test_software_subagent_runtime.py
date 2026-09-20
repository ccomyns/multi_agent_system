import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from botocore.exceptions import ClientError

BIN = Path(__file__).resolve().parents[1] / 'infra/runtime/subagent_software_builder/bin'
sys.path.insert(0, str(BIN))
spec = importlib.util.spec_from_file_location('software_worker', BIN / 'subagent_runner.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_usage_accumulates_across_corrective_turns(self):
        with tempfile.TemporaryDirectory() as temp:
            recorder = worker.TelemetryRecorder(s3=Mock(), bucket="memory", prefix="project/agent/_runtime/telemetry", local_dir=Path(temp), actor_type="subagent", job_id="job", orchestrator_instance_id="parent")
            for count in (10, 20):
                recorder.append_raw_event(json.dumps({"type": "turn.completed", "usage": {"input_tokens": count, "output_tokens": 5}}))
            self.assertEqual(recorder.latest["usage"]["total_tokens"], 40)

    def test_missing_is_retryable_but_access_denied_is_not_missing(self):
        s3 = Mock()
        s3.get_object.side_effect = ClientError({'Error': {'Code': 'NoSuchKey'}}, 'GetObject')
        self.assertFalse(worker.valid_description(s3, 'bucket', 'project/agent/'))
        s3.get_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject')
        with self.assertRaises(ClientError):
            worker.valid_description(s3, 'bucket', 'project/agent/')

    def run_worker(self, root, execute, valid, deadline=None):
        s3, ssm, telemetry = Mock(), Mock(), Mock()
        s3.get_object.return_value = {'Body': io.BytesIO(json.dumps({'task': 'Research trial results'}).encode())}
        ssm.get_parameter.return_value = {'Parameter': {'Value': '{}'}}
        environment = {'GLOBAL_MEMORY_BUCKET_NAME': 'memory', 'OUTPUT_PREFIX': 'project/agent/', 'SUBAGENT_EXPIRES_AT': str(deadline or int(time.time()) + 1800), 'JOB_ID': 'job_abc1_1234abcd', 'AGENT_ID': 'sw-one', 'ORCHESTRATOR_INSTANCE_ID': 'i-parent', 'TASK_S3_KEY': 'project/agent/_runtime/input.json', 'CODEX_AUTH_SSM_PARAMETER_NAME': '/codex', 'SUBAGENT_MODEL': 'model', 'SUBAGENT_INSTANCE_ID': 'i-child'}
        with patch.dict(os.environ, environment), patch.object(worker, 'WORK_DIR', root), patch.object(worker.boto3, 'client', side_effect=lambda service: s3 if service == 's3' else ssm), patch.object(worker, 'TelemetryRecorder', return_value=telemetry), patch.object(worker.signal, 'signal'), patch.object(worker, 'execute', execute), patch.object(worker, 'valid_description', valid), patch.object(worker.time, 'sleep'):
            try:
                result = worker.main()
            except Exception as error:
                result = error
        return result, s3, telemetry

    def test_missing_description_resumes_same_thread_and_shares_deadline(self):
        with tempfile.TemporaryDirectory() as temp:
            execute = Mock(side_effect=[(0, 'thread-1'), (0, 'thread-1')])
            valid = Mock(side_effect=[False, True])
            result, s3, telemetry = self.run_worker(Path(temp), execute, valid)
            self.assertEqual(result, 0)
            first, second = execute.call_args_list
            self.assertNotIn('--ephemeral', first.args[0])
            self.assertEqual(second.args[0][:4], ['codex', 'exec', 'resume', 'thread-1'])
            self.assertEqual(first.args[1], second.args[1])
            self.assertIn('description.md', second.args[0][-1])
            self.assertTrue(any(call.args[0] == 'description_retry' for call in telemetry.record.call_args_list))
            self.assertEqual([call.kwargs['Key'] for call in s3.put_object.call_args_list], [
                'project/agent/_runtime/status/completed.json',
                'project/agent/_runtime/result/completed.md',
                'project/agent/_runtime/termination/request.json',
            ])
            self.assertEqual(json.loads(s3.put_object.call_args_list[0].kwargs['Body'])['attempts'], 2)

    def test_nonzero_exit_retries_even_with_description(self):
        with tempfile.TemporaryDirectory() as temp:
            execute = Mock(side_effect=[(1, 'thread-1'), (0, 'thread-1')])
            result, _, _ = self.run_worker(Path(temp), execute, Mock(return_value=True))
            self.assertEqual(result, 0)
            self.assertEqual(execute.call_count, 2)

    def test_deadline_exhaustion_never_starts_codex_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            execute = Mock()
            result, s3, _ = self.run_worker(Path(temp), execute, Mock(), deadline=int(time.time()) - 1)
            self.assertIsInstance(result, TimeoutError)
            execute.assert_not_called()
            self.assertEqual(s3.put_object.call_args_list[0].kwargs['Key'], 'project/agent/_runtime/status/failed.json')
            self.assertEqual(s3.put_object.call_args.kwargs['Key'], 'project/agent/_runtime/termination/request.json')

    def test_s3_outage_reports_failure_without_reprompting_as_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            execute = Mock(return_value=(0, 'thread-1'))
            result, s3, _ = self.run_worker(Path(temp), execute, Mock(side_effect=RuntimeError('S3 unavailable')))
            self.assertIsInstance(result, RuntimeError)
            execute.assert_called_once()
            self.assertEqual(s3.put_object.call_args_list[0].kwargs['Key'], 'project/agent/_runtime/status/failed.json')
            self.assertEqual(s3.put_object.call_args.kwargs['Key'], 'project/agent/_runtime/termination/request.json')

    def test_timeout_kills_entire_process_group(self):
        process = Mock(pid=123)
        with patch.object(worker.subprocess, 'Popen', return_value=process), patch.object(worker.selectors, 'DefaultSelector'), patch.object(worker.os, 'killpg') as kill:
            with self.assertRaises(TimeoutError):
                worker.execute(['codex'], time.time() - 1, Mock(), None)
            kill.assert_called_once_with(123, worker.signal.SIGKILL)
            process.wait.assert_called_once()


if __name__ == '__main__':
    unittest.main()
