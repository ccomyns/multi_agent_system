import io
import json
import os
import time
import unittest
from unittest.mock import Mock, patch
from botocore.exceptions import ClientError
from src.subagent_manager import handler, software

ENV = {
    'AWS_PARTITION': 'aws', 'RUNTIME_ARTIFACT_BUCKET': 'runtime-bucket',
    'SOFTWARE_SUBAGENT_RUNTIME_S3_KEY': 'system/runtime/software/hash/runtime.zip',
    'CODEX_AUTH_PARAMETER_ARN': 'arn:aws:ssm:us-east-1:123:parameter/codex',
    'STATE_TABLE_NAME': 'state', 'JOBS_TABLE_NAME': 'jobs',
    'GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME': 'assignments',
    'GLOBAL_MEMORY_BUCKET_NAME': 'actual-memory-bucket',
    'SUBAGENT_MODEL': 'test-model', 'SOFTWARE_SUBAGENT_IAM_PREFIX': 'test-sw-',
    'SOFTWARE_SUBAGENT_BOUNDARY_ARN': 'arn:aws:iam::123:policy/boundary',
}
JOB = {'job_id': 'job_abc1_1234abcd', 'type_of_job': 'software_builder', 'status': 'running', 'orchestrator_instance_id': 'i-parent'}
EVENT = {'action': 'software_spawn', 'job_id': JOB['job_id'], 'orchestrator_id': 'i-parent', 'task': 'Find clinical trial data'}


class SoftwareManagerTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, ENV)
        self.env.start()
        handler._clients.clear()
        self.clients = {name: Mock() for name in ('table', 'dynamodb', 's3', 'iam', 'ec2')}
        handler._clients.update(self.clients)
        self.jobs, self.assignments = Mock(), Mock()
        self.jobs.get_item.return_value = {'Item': dict(JOB)}
        self.assignments.get_item.return_value = {'Item': {'global_memory_project_name': 'Healthcare Research'}}
        self.tables = patch.object(software, 'table', side_effect=lambda name: self.jobs if name == 'JOBS_TABLE_NAME' else self.assignments)
        self.tables.start()

    def tearDown(self):
        self.tables.stop()
        self.env.stop()
        handler._clients.clear()

    def test_software_cannot_select_mining_role_using_own_or_historical_job(self):
        for job in (JOB, {**JOB, 'type_of_job': 'data_mining', 'orchestrator_instance_id': 'i-other'}, {**JOB, 'type_of_job': 'data_mining', 'status': 'completed'}):
            self.jobs.get_item.return_value = {'Item': job}
            with self.assertRaises(ValueError):
                handler._validate_mining_job(JOB['job_id'], 'i-parent')
        self.jobs.get_item.return_value = {'Item': {**JOB, 'type_of_job': 'data_mining'}}
        handler._validate_mining_job(JOB['job_id'], 'i-parent')

    def test_iam_creation_failure_releases_reservation_without_waiting_for_deadline(self):
        self.clients['table'].get_item.return_value = {}
        with patch.object(software, 'create_profile', side_effect=RuntimeError('IAM denied')), patch.object(handler, '_release_failed_launch') as release, patch.object(software, 'cleanup') as cleanup:
            with self.assertRaisesRegex(RuntimeError, 'IAM denied'):
                software.spawn(EVENT)
            release.assert_called_once()
            cleanup.assert_called_once()
        self.clients['ec2'].run_instances.assert_not_called()

    def test_policy_has_only_literal_own_folder_and_bootstrap_reads(self):
        statements = software.policy('actual-memory-bucket', 'project/sw-123/')['Statement']
        objects, listing, runtime, auth = statements
        self.assertEqual(objects['Resource'], 'arn:aws:s3:::actual-memory-bucket/project/sw-123/*')
        self.assertEqual(listing['Condition'], {'StringLike': {'s3:prefix': 'project/sw-123/*'}})
        self.assertEqual(runtime['Action'], 's3:GetObject')
        self.assertEqual(runtime['Resource'], 'arn:aws:s3:::runtime-bucket/system/runtime/software/hash/runtime.zip')
        self.assertEqual(auth['Action'], 'ssm:GetParameter')
        self.assertFalse(any(a.startswith(('iam:', 'lambda:', 'rds:')) for stmt in statements for a in ([stmt['Action']] if isinstance(stmt['Action'], str) else stmt['Action'])))

    def test_reservation_atomically_checks_end_and_closure_and_caps_at_twelve(self):
        handoff = dict(job_id=JOB['job_id'], task='research', task_s3_uri='s3://bucket/project/agent/_runtime/input.json', model='model', software=True, output_bucket='bucket', output_prefix='project/agent/', expires_at=100, iam_name='role')
        with patch.dict(os.environ, {'MAX_ACTIVE_SUBAGENTS': '99'}):
            self.assertTrue(handler._reserve_slot('i-parent', 'sw-123', handler._now(), handoff))
        txn = self.clients['dynamodb'].transact_write_items.call_args.kwargs['TransactItems']
        check = txn[0]['ConditionCheck']
        self.assertIn('attribute_not_exists(end_requested_at)', check['ConditionExpression'])
        self.assertIn('attribute_not_exists(delegation_closed_at)', check['ConditionExpression'])
        self.assertIn('orchestrator_instance_id = :orch', check['ConditionExpression'])
        self.assertEqual(txn[1]['Update']['ExpressionAttributeValues'][':limit'], {'N': '12'})
        self.assertEqual(txn[2]['Put']['Item']['output_prefix'], {'S': 'project/agent/'})

    def test_cancelled_transaction_never_launches_or_creates_role(self):
        self.clients['table'].get_item.return_value = {}
        self.clients['dynamodb'].transact_write_items.side_effect = ClientError({'Error': {'Code': 'TransactionCanceledException'}}, 'TransactWriteItems')
        self.assertEqual(software.spawn(EVENT)['statusCode'], 409)
        self.clients['iam'].create_role.assert_not_called()
        self.clients['ec2'].run_instances.assert_not_called()

    def test_scope_comes_from_assignment_and_repeated_task_is_idempotent(self):
        self.clients['table'].get_item.return_value = {}
        with patch.object(software, 'create_profile') as profile, patch.object(handler, '_launch_instance', return_value='i-worker') as launch:
            result = software.spawn({**EVENT, 'output_prefix': 'other/', 'model': 'untrusted', 'project_name': 'other'})['body']
            handoff = launch.call_args.args[2]
            self.assertEqual(handoff['model'], 'test-model')
            self.assertEqual(handoff['output_prefix'], f"Healthcare Research/{result['agent_id']}/")
            self.assertAlmostEqual(handoff['expires_at'], time.time() + 1800, delta=3)
            self.clients['table'].get_item.return_value = {'Item': {**handoff, 'state': 'RUNNING'}}
            replay = software.spawn(EVENT)['body']
            self.assertEqual(replay['agent_id'], result['agent_id'])
            launch.assert_called_once()
            profile.assert_called_once()

    def test_invalid_or_cross_job_assignment_never_provisions(self):
        for job in ({**JOB, 'status': 'completed'}, {**JOB, 'orchestrator_instance_id': 'i-other'}, {**JOB, 'type_of_job': 'data_mining'}):
            self.jobs.get_item.return_value = {'Item': job}
            self.assertEqual(software.dispatch(EVENT)['statusCode'], 400)
        self.clients['iam'].create_role.assert_not_called()

    def test_unsafe_project_cannot_expand_iam_scope(self):
        self.clients['table'].get_item.return_value = {}
        for name in ('*', 'project/*', 'project?', '../escape', 'a\nEVIL=x', '..'):
            self.assignments.get_item.return_value = {'Item': {'global_memory_project_name': name}}
            with self.assertRaises(ValueError):
                software.spawn(EVENT)
        self.clients['iam'].create_role.assert_not_called()

    def test_unknown_launch_keeps_slot_for_reconciliation(self):
        self.clients['table'].get_item.return_value = {}
        with patch.object(software, 'create_profile'), patch.object(handler, '_launch_instance', side_effect=TimeoutError('response lost')), patch.object(handler, '_mark_launch_unknown') as unknown, patch.object(handler, '_release_failed_launch') as release:
            with self.assertRaises(TimeoutError):
                software.spawn(EVENT)
            unknown.assert_called_once()
            release.assert_not_called()

    def test_profile_creation_requires_boundary_and_literal_policy(self):
        software.create_profile({'iam_name': 'test-sw-one', 'output_bucket': 'memory', 'output_prefix': 'project/one/'})
        iam = self.clients['iam']
        self.assertEqual(iam.create_role.call_args.kwargs['PermissionsBoundary'], ENV['SOFTWARE_SUBAGENT_BOUNDARY_ARN'])
        self.assertEqual(json.loads(iam.put_role_policy.call_args.kwargs['PolicyDocument'])['Statement'][0]['Resource'], 'arn:aws:s3:::memory/project/one/*')

    def test_reaper_terminates_expired_instance_before_cleanup(self):
        row = dict(software=True, agent_id='sw-one', orchestrator_id='i-parent', job_id=JOB['job_id'], active=True, instance_id='i-child', expires_at=0, iam_name='role')
        self.clients['ec2'].describe_instances.side_effect = [
            {'Reservations': [{'Instances': [{'InstanceId': 'i-child', 'State': {'Name': 'running'}}]}]},
            {'Reservations': [{'Instances': [{'InstanceId': 'i-parent', 'State': {'Name': 'running'}}]}]},
        ]
        with patch.object(software, 'cleanup') as cleanup:
            software.reconcile_agent(row)
            self.clients['ec2'].terminate_instances.assert_called_once_with(InstanceIds=['i-child'])
            cleanup.assert_not_called()

    def test_reaper_releases_expired_provisioning_without_vm(self):
        row = dict(software=True, agent_id='sw-one', orchestrator_id='i-parent', job_id=JOB['job_id'], active=True, expires_at=0, iam_name='role')
        self.clients['ec2'].describe_instances.return_value = {'Reservations': []}
        with patch.object(handler, '_release_failed_launch') as release, patch.object(software, 'cleanup') as cleanup:
            software.reconcile_agent(row)
            release.assert_called_once()
            cleanup.assert_called_once_with(row)

    def test_description_requires_valid_nonblank_utf8_and_is_bounded(self):
        for content, expected in ((b'# Findings', '# Findings'), (b' \n', None), (b'\xff', None), (b'x' * (1024 * 1024 + 1), None)):
            self.clients['s3'].get_object.return_value = {'Body': io.BytesIO(content)}
            self.assertEqual(software.description({'output_bucket': 'bucket', 'output_prefix': 'project/agent/'}), expected)

    def test_s3_access_error_is_not_treated_as_missing_description(self):
        self.clients['s3'].get_object.side_effect = ClientError({'Error': {'Code': 'AccessDenied'}}, 'GetObject')
        with self.assertRaises(ClientError):
            software.description({'output_bucket': 'bucket', 'output_prefix': 'project/agent/'})


if __name__ == '__main__':
    unittest.main()
