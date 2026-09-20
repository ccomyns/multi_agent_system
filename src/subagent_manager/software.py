"""Software research agents: trusted assignments, isolated VM roles and lifecycle."""
import hashlib
import json
import os
import re
import time

import boto3
from botocore.exceptions import ClientError
from importlib import import_module
base = import_module(f"{__package__}.handler" if __package__ else "handler")


def table(name):
    return boto3.resource('dynamodb').Table(os.environ[name])


def job_for(event, running=True):
    job_id = event.get('job_id', '')
    if not isinstance(job_id, str) or not base._JOB_ID_PATTERN.fullmatch(job_id):
        raise ValueError('Invalid job ID')
    job = table('JOBS_TABLE_NAME').get_item(Key={'pk': f'JOB#{job_id}'}, ConsistentRead=True).get('Item', {})
    if job.get('type_of_job') != 'software_builder' or job.get('orchestrator_instance_id') != event.get('orchestrator_id'):
        raise ValueError('Software job does not belong to this orchestrator')
    if running and job.get('status') != 'running':
        raise ValueError('Job is not running')
    return job


def policy(bucket, prefix):
    partition = os.environ['AWS_PARTITION']
    return {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], 'Resource': f'arn:{partition}:s3:::{bucket}/{prefix}*'},
        {'Effect': 'Allow', 'Action': 's3:ListBucket', 'Resource': f'arn:{partition}:s3:::{bucket}', 'Condition': {'StringLike': {'s3:prefix': prefix + '*'}}},
        {'Effect': 'Allow', 'Action': 's3:GetObject', 'Resource': f"arn:{partition}:s3:::{os.environ['RUNTIME_ARTIFACT_BUCKET']}/{os.environ['SOFTWARE_SUBAGENT_RUNTIME_S3_KEY']}"},
        {'Effect': 'Allow', 'Action': 'ssm:GetParameter', 'Resource': os.environ['CODEX_AUTH_PARAMETER_ARN']},
    ]}


def create_profile(agent):
    iam = base._client('iam')
    name = agent['iam_name']
    iam.create_role(RoleName=name, PermissionsBoundary=os.environ['SOFTWARE_SUBAGENT_BOUNDARY_ARN'], Tags=[{'Key': key, 'Value': agent[key]} for key in ('job_id', 'agent_id', 'orchestrator_id') if key in agent], AssumeRolePolicyDocument=json.dumps({
        'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'ec2.amazonaws.com'}, 'Action': 'sts:AssumeRole'}]}))
    iam.put_role_policy(RoleName=name, PolicyName='agent-folder', PolicyDocument=json.dumps(policy(agent['output_bucket'], agent['output_prefix'])))
    iam.create_instance_profile(InstanceProfileName=name)
    iam.add_role_to_instance_profile(InstanceProfileName=name, RoleName=name)


def cleanup(agent):
    if agent.get('iam_cleaned'):
        return
    iam = base._client('iam')
    name = agent['iam_name']
    for method, args in [
        ('remove_role_from_instance_profile', dict(InstanceProfileName=name, RoleName=name)),
        ('delete_instance_profile', dict(InstanceProfileName=name)),
        ('delete_role_policy', dict(RoleName=name, PolicyName='agent-folder')),
        ('delete_role', dict(RoleName=name)),
    ]:
        try:
            getattr(iam, method)(**args)
        except ClientError as error:
            if error.response['Error']['Code'] != 'NoSuchEntity':
                raise
    base._client('table').update_item(Key=base._agent_key(agent['orchestrator_id'], agent['agent_id']), UpdateExpression='SET iam_cleaned = :yes', ExpressionAttributeValues={':yes': True})


def spawn(event):
    job = job_for(event)
    supplied_task = event.get('task')
    if not isinstance(supplied_task, str):
        raise ValueError('Task must be a string')
    task = supplied_task.strip()
    if not task or len(task) > base._MAX_TASK_LENGTH:
        raise ValueError('Task must contain 1-12000 characters')
    job_id, orch = job['job_id'], job['orchestrator_instance_id']
    agent_id = 'sw-' + hashlib.sha256((job_id + '\n' + task).encode()).hexdigest()[:32]
    existing = base._existing_agent(orch, agent_id)
    if existing:
        return base._response(200, accepted=True, agent_id=agent_id, state=existing['state'], output_uri=f"s3://{existing['output_bucket']}/{existing['output_prefix']}")
    assignment = table('GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME').get_item(Key={'job_id': job_id}, ConsistentRead=True).get('Item', {})
    project = assignment.get('global_memory_project_name', '')
    if project in {'.', '..'} or project != project.strip() or not re.fullmatch(r'[A-Za-z0-9_.:=+@ -]{1,80}', project):
        raise ValueError('A valid S3 project assignment is required')
    bucket = os.environ['GLOBAL_MEMORY_BUCKET_NAME']
    prefix = f'{project}/{agent_id}/'
    handoff = dict(job_id=job_id, task=task, model=os.environ['SUBAGENT_MODEL'], task_s3_key=prefix + '_runtime/input.json', task_s3_uri=f's3://{bucket}/{prefix}_runtime/input.json',
                   software=True, output_bucket=bucket, output_prefix=prefix, expires_at=int(time.time()) + 1800,
                   iam_name=os.environ['SOFTWARE_SUBAGENT_IAM_PREFIX'] + agent_id)
    if not base._reserve_slot(orch, agent_id, base._now(), handoff):
        return base._response(409, accepted=False, error='Delegation closed, job ended, or 12 active agents already reserved; retry status before spawning')
    agent = {**handoff, 'orchestrator_id': orch, 'agent_id': agent_id}
    try:
        create_profile(agent)
        base._client('s3').put_object(Bucket=bucket, Key=handoff['task_s3_key'], Body=json.dumps(agent).encode(), ContentType='application/json')
    except Exception as error:
        base._release_failed_launch(orch, agent_id, base._now(), str(error))
        try:
            cleanup(agent)
        except Exception as cleanup_error:
            print(f'Credential cleanup failed after launch failure: {cleanup_error}')
        raise
    instance_id = None
    try:
        # EC2 observes instance profile changes asynchronously. Retries retain the
        # same client token, slot and identity, including ambiguous launch results.
        for attempt in range(6):
            try:
                instance_id = base._launch_instance(orch, agent_id, handoff)
                break
            except ClientError as error:
                if error.response['Error']['Code'] != 'InvalidParameterValue' or attempt == 5:
                    raise
                time.sleep(5)
        base._mark_launched(orch, agent_id, instance_id, base._now())
    except Exception as error:
        if instance_id is not None:
            # Keep the slot and credentials until the termination event arrives.
            base._mark_launch_unknown(orch, agent_id, base._now(), str(error))
            base._client('ec2').terminate_instances(InstanceIds=[instance_id])
        elif isinstance(error, ClientError):
            base._release_failed_launch(orch, agent_id, base._now(), str(error))
            cleanup(agent)
        else:
            # As in mining, preserve the slot if EC2 may have accepted the launch.
            base._mark_launch_unknown(orch, agent_id, base._now(), str(error))
        raise
    return base._response(201, accepted=True, agent_id=agent_id, instance_id=instance_id, output_uri=f's3://{bucket}/{prefix}')


def agents(event):
    items, cursor = [], None
    while True:
        args = dict(KeyConditionExpression='pk = :pk AND begins_with(sk, :agent)', ExpressionAttributeValues={':pk': f"ORCHESTRATOR#{event['orchestrator_id']}", ':agent': 'AGENT#'}, ConsistentRead=True)
        if cursor:
            args['ExclusiveStartKey'] = cursor
        page = base._client('table').query(**args)
        items.extend(a for a in page.get('Items', []) if a.get('software') and a.get('job_id') == event['job_id'])
        cursor = page.get('LastEvaluatedKey')
        if not cursor:
            return items


def description(agent):
    try:
        obj = base._client('s3').get_object(Bucket=agent['output_bucket'], Key=agent['output_prefix'] + 'description.md')
    except ClientError as error:
        if base._object_is_missing(error):
            return None
        raise
    raw = obj['Body'].read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        return None
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        return None
    return text if text.strip() else None


def close(event):
    table('JOBS_TABLE_NAME').update_item(Key={'pk': f"JOB#{event['job_id']}"}, UpdateExpression='SET delegation_closed_at = if_not_exists(delegation_closed_at, :now)',
        ConditionExpression='orchestrator_instance_id = :orch AND #status = :running', ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={':now': base._now(), ':orch': event['orchestrator_id'], ':running': 'running'})


def dispatch(event):
    try:
        job_for(event)
        action = event['action']
        if action not in {'software_spawn', 'software_status', 'software_collect', 'software_close', 'software_cancel'}:
            raise ValueError('Unsupported software agent action')
        if action == 'software_collect' and (not isinstance(event.get('agent_ids'), list) or not 1 <= len(event['agent_ids']) <= 12):
            raise ValueError('Collect 1-12 agent IDs at a time')
        if action == 'software_spawn':
            return spawn(event)
        if action in {'software_close', 'software_cancel'}:
            close(event)
        rows = agents(event)
        if action == 'software_cancel':
            for row in rows:
                if row.get('active') and row.get('instance_id'):
                    base._client('ec2').terminate_instances(InstanceIds=[row['instance_id']])
        results = []
        for row in rows:
            result = {k: row.get(k) for k in ('agent_id', 'state', 'active', 'collected', 'result_status', 'failure_reason')}
            if row.get('active'):
                result['task'] = row['task']
            result['output_uri'] = f"s3://{row['output_bucket']}/{row['output_prefix']}"
            if action == 'software_collect' and not row.get('active') and row['agent_id'] in event.get('agent_ids', []):
                result['description'] = description(row)
                if not result['description']:
                    result['result_status'] = 'failed'
                    result['failure_reason'] = result['failure_reason'] or 'Missing or invalid description.md'
                if result['description'] and len(result['description']) > 16000:
                    result['description'] = result['description'][:16000]
                    result['description_truncated'] = True
                if event.get('mark_collected', True):
                    base._client('table').update_item(Key=base._agent_key(event['orchestrator_id'], row['agent_id']), UpdateExpression='SET collected = :yes', ExpressionAttributeValues={':yes': True})
            results.append(result)
        return base._response(200, agents=results)
    except ValueError as error:
        return base._response(400, error=str(error))
