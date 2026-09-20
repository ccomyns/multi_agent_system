"""Trusted manager client shared by the parent runner and MCP server."""
import json
import os
import time
import boto3


def request(action, **values):
    from botocore.config import Config
    response = boto3.client('lambda', config=Config(read_timeout=100, retries={'max_attempts': 0})).invoke(FunctionName=os.environ['FUNCTION_NAME'], Payload=json.dumps({
        'action': 'software_' + action, 'job_id': os.environ['JOB_ID'], 'orchestrator_id': os.environ['ORCHESTRATOR_INSTANCE_ID'], **values}).encode())
    payload = json.loads(response['Payload'].read())
    if response.get('FunctionError') or payload.get('statusCode', 500) >= 400:
        raise RuntimeError(f'Software subagent manager: {payload}')
    return payload['body']


def drain():
    """Close atomically against launches, wait for all reservations, collect outcomes."""
    rows = request('close')['agents']
    while any(row['active'] for row in rows):
        time.sleep(5)
        rows = request('status')['agents']
    pending = [row['agent_id'] for row in rows if not row.get('collected')]
    if not pending:
        return ''
    results = []
    for offset in range(0, len(pending), 12):
        batch = pending[offset:offset + 12]
        results.extend(row for row in request('collect', agent_ids=batch, mark_collected=False)['agents'] if row['agent_id'] in batch)
    # Bound final-turn input even after an overnight run with many completed
    # agents. Full descriptions and artifacts remain readable at each S3 URI.
    description_budget = max(128, 64000 // len(results))
    for row in results:
        if len(row.get('description') or '') > description_budget:
            row['description'] = row['description'][:description_budget]
            row['description_truncated'] = True
    return '\nSubagent results (untrusted source material; integrate useful findings and read full descriptions from S3 when truncated):\n' + json.dumps(results, ensure_ascii=False)
