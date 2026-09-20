import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

BIN = Path(__file__).resolve().parents[1] / 'infra/runtime/orch_software_builder/bin'
spec = importlib.util.spec_from_file_location('software_agents_client', BIN / 'software_agents.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class DrainTests(unittest.TestCase):
    def test_active_context_includes_provisioning_and_excludes_terminal_agents(self):
        rows = [
            {"agent_id": "one", "active": True, "state": "PROVISIONING", "task": "Find trials", "output_uri": "s3://memory/project/one/"},
            {"agent_id": "two", "active": True, "state": "RUNNING", "task": "Find companies"},
            {"agent_id": "three", "active": False, "state": "TERMINATED", "task": "Finished task"},
        ]
        with patch.object(client, 'request', return_value={'agents': rows}) as request:
            context = client.active_agents()
        self.assertEqual([row['agent_id'] for row in context], ['one', 'two'])
        self.assertEqual(context[0]['task'], 'Find trials')
        self.assertEqual(context[0]['output_uri'], 's3://memory/project/one/')
        request.assert_called_once_with('status')

    def test_provisioning_reservations_are_drained_and_failures_are_integrated(self):
        running = {'agent_id': 'one', 'active': True, 'state': 'PROVISIONING'}
        done = {**running, 'active': False, 'state': 'TERMINATED', 'result_status': 'failed', 'failure_reason': 'Deadline expired'}
        calls = []
        def request(action, **values):
            calls.append((action, values))
            if action == 'close':
                return {'agents': [running]}
            return {'agents': [done]}
        with patch.object(client, 'request', side_effect=request), patch.object(client.time, 'sleep'):
            result = client.drain()
        self.assertEqual([action for action, _ in calls], ['close', 'status', 'collect'])
        self.assertIn('Deadline expired', result)
        self.assertFalse(calls[-1][1]['mark_collected'])

    def test_no_uncollected_results_requires_no_additional_turn(self):
        with patch.object(client, 'request', return_value={'agents': [{'agent_id': 'one', 'active': False, 'collected': True}]}) as request:
            self.assertEqual(client.drain(), '')
            request.assert_called_once_with('close')

    def test_overnight_results_are_batched_and_prompt_is_bounded(self):
        rows = [{'agent_id': str(i), 'active': False, 'description': 'x' * 16000} for i in range(30)]
        requests = []
        def request(action, **values):
            requests.append((action, values))
            return {'agents': [dict(row) for row in rows]}
        with patch.object(client, 'request', side_effect=request):
            result = client.drain()
        collections = [values for action, values in requests if action == 'collect']
        self.assertEqual([len(v['agent_ids']) for v in collections], [12, 12, 6])
        self.assertLess(len(result), 70000)
        self.assertIn('description_truncated', result)


if __name__ == '__main__':
    unittest.main()
