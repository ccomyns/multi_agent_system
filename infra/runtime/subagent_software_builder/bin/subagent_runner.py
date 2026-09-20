"""Run a research task, resuming until its S3 description exists or time expires."""
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time

import boto3
from botocore.exceptions import ClientError
from agent_telemetry import TelemetryRecorder, utc_now

MAX_DESCRIPTION = 1024 * 1024
WORK_DIR = Path("/work")


def valid_description(s3, bucket, prefix):
    try:
        response = s3.get_object(Bucket=bucket, Key=prefix + 'description.md')
    except ClientError as error:
        if error.response['Error']['Code'] in {'NoSuchKey', '404', 'NotFound'}:
            return False
        raise
    content = response['Body'].read(MAX_DESCRIPTION + 1)
    try:
        return len(content) <= MAX_DESCRIPTION and bool(content.decode('utf-8').strip())
    except UnicodeDecodeError:
        return False


def execute(command, deadline, telemetry, session):
    process = subprocess.Popen(command, cwd=WORK_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    buffer = b''
    def consume(line):
        nonlocal session
        text = line.decode('utf-8', errors='replace')
        telemetry.append_raw_event(text)
        try:
            event = json.loads(text)
            if event.get('type') == 'thread.started':
                session = event['thread_id']
                (WORK_DIR / ".codex-session").write_text(session)
        except (ValueError, KeyError):
            pass
    try:
        while True:
            if time.time() >= deadline:
                raise TimeoutError('30-minute subagent deadline reached')
            if not selector.select(1):
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                consume(line)
        if buffer:
            consume(buffer)
        return process.wait(timeout=max(0.1, deadline - time.time())), session
    finally:
        selector.close()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()


def main():
    s3 = boto3.client('s3')
    bucket, prefix = os.environ['GLOBAL_MEMORY_BUCKET_NAME'], os.environ['OUTPUT_PREFIX']
    deadline = int(os.environ['SUBAGENT_EXPIRES_AT'])
    WORK_DIR.mkdir(exist_ok=True)
    telemetry = TelemetryRecorder(s3=s3, bucket=bucket, prefix=prefix + '_runtime/telemetry', local_dir=(WORK_DIR / ".telemetry"), actor_type='subagent', job_id=os.environ['JOB_ID'], agent_id=os.environ['AGENT_ID'], orchestrator_instance_id=os.environ['ORCHESTRATOR_INSTANCE_ID'], subagent_instance_id=os.environ.get('SUBAGENT_INSTANCE_ID'))
    def stop(signum, frame):
        raise RuntimeError('Subagent stopped')
    signal.signal(signal.SIGTERM, stop)
    try:
        telemetry.record('runner_started', 'Software research subagent started')
        task = json.loads(s3.get_object(Bucket=bucket, Key=os.environ['TASK_S3_KEY'])['Body'].read())['task']
        home = (WORK_DIR / ".codex")
        home.mkdir(mode=0o700, exist_ok=True)
        auth = boto3.client('ssm').get_parameter(Name=os.environ['CODEX_AUTH_SSM_PARAMETER_NAME'], WithDecryption=True)['Parameter']['Value']
        (home / 'auth.json').write_text(auth)
        (home / 'auth.json').chmod(0o600)
        os.environ['CODEX_HOME'] = str(home)
        os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/ms-playwright'
        os.environ['PATH'] = '/opt/multi-agent/venv/bin:/usr/local/bin:/usr/bin:/bin'
        (home / 'config.toml').write_text('cli_auth_credentials_store = "file"\nweb_search = "live"\n')
        prompt = f'''You are a data-gathering subagent. Complete this task:\n{task}\n
You have Playwright and Chromium. You have no application GitHub repository, RDS,
or Vercel access. Your only writable S3 location is s3://{bucket}/{prefix}.
Read access is limited to this same folder (plus runtime/auth bootstrap resources).
Upload useful files there in any format appropriate to the task. Keep full S3 keys,
including the project and agent prefixes, in any metadata you produce.
Before finishing, upload a nonempty UTF-8 description.md (at most 1 MiB) to
s3://{bucket}/{prefix}description.md explaining what you did, findings, sources,
output files and limitations. Do not put deliverables in the reserved _runtime/ folder.
Your total deadline, including corrective retries, is 30 minutes from allocation.
'''
        session_file = (WORK_DIR / ".codex-session")
        session = session_file.read_text().strip() if session_file.exists() else None
        attempt = 0
        telemetry.record('codex_started', 'Research started', codex_started_at=utc_now())
        while time.time() < deadline:
            attempt += 1
            command = ['codex', 'exec']
            if session:
                command += ['resume', session]
            command += ['--json', '--model', os.environ['SUBAGENT_MODEL'], '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', prompt]
            code, session = execute(command, deadline, telemetry, session)
            if time.time() >= deadline:
                raise TimeoutError('30-minute subagent deadline reached')
            if code == 0 and valid_description(s3, bucket, prefix):
                telemetry.record('run_completed', 'S3 description verified', codex_finished_at=utc_now(), codex_exit_code=code)
                telemetry.publish_raw_events(strict=True)
                telemetry.publish(strict=True)
                s3.put_object(Bucket=bucket, Key=prefix + '_runtime/status/completed.json', Body=json.dumps({'attempts': attempt, 'completed_at': utc_now()}).encode(), ContentType='application/json')
                return 0
            telemetry.record('description_retry', f'Attempt {attempt}: exit {code}; completion requires exit 0 and a valid S3 description.md')
            prompt = f'Continue the assigned task using the existing context and files. Last exit code: {code}. Ensure s3://{bucket}/{prefix}description.md exists, is nonempty UTF-8 and at most 1 MiB, and finish successfully. Original task:\n{task}'
            time.sleep(min(5, max(0, deadline - time.time())))
        raise TimeoutError('30-minute subagent deadline reached')
    except Exception as error:
        try:
            telemetry.record('run_failed', str(error)[:500], codex_finished_at=utc_now())
            telemetry.publish_raw_events(strict=True)
            s3.put_object(Bucket=bucket, Key=prefix + '_runtime/status/failed.json', Body=json.dumps({'error': str(error)[:500]}).encode(), ContentType='application/json')
        except Exception:
            pass
        raise
    finally:
        # Logs remain within the same IAM-enforced folder as every other write.
        for variable, name in [('BOOTSTRAP_LOG_PATH', 'bootstrap.log'), ('CODEX_LOG_PATH', 'codex.log')]:
            path = os.environ.get(variable)
            if path and Path(path).is_file():
                try:
                    s3.upload_file(path, bucket, prefix + '_runtime/debug/' + name)
                except Exception:
                    pass


if __name__ == '__main__':
    raise SystemExit(main())
