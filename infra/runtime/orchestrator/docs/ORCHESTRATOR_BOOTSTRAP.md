# Real orchestrator bootstrap

The normal EC2 launch template gets its short, job-specific user data from
`compute.tf`. That user data reads the `JobId` instance tag, writes
`/etc/multi-agent/orchestrator.env`, and starts
`multi-agent-orchestrator.service`.

The durable runtime source lives under `runtime/orchestrator/`. Terraform
packages that whole directory as a versioned ZIP artifact in the private
agent-workspace bucket. EC2 Image Builder downloads and expands it under
`/opt/multi-agent/runtime`; this
keeps scripts and documentation out of the 16 KB inline component document and
lets the bundle grow independently. The systemd service is installed disabled
and is started by the orchestrator launch template.

## Authentication

Terraform intentionally manages only the SSM Parameter Store name and IAM
permissions, never the secret value. By default, the runner reads the
`/<project_name>/codex/auth-json` SecureString with decryption and writes it to
the orchestrator's private `$CODEX_HOME/auth.json` with mode `0600`. This
credential directory is outside the model-writable job workspace.

Create or update that parameter outside Terraform. For example, from a machine
on which Codex is logged in:

```bash
aws ssm put-parameter \
  --name /financial-research-agents/codex/auth-json \
  --type SecureString \
  --overwrite \
  --value file://$HOME/.codex/auth.json
```

Codex may refresh account tokens in `auth.json`. At the end of a run, the
runner persists the changed file back to SSM, but only when the parameter still
matches the value fetched at startup. A manual rotation made during a job is
therefore not knowingly overwritten. If the SecureString uses a customer-managed
KMS key, add the corresponding encrypt/decrypt permissions to the orchestrator
role before deployment.

## Job lifecycle

The runner:

1. Reads `JOB#<job_id>` from the jobs table and validates that it belongs to
   this orchestrator.
2. If the job has private anchor data, downloads it from
   `jobs/<job_id>/input/` into the orchestrator-only local `input/` directory.
3. Fetches and installs the current Codex `auth.json`.
4. Verifies that the configured local `spawn_agent` MCP executable exists.
5. Writes a job-local Codex configuration with the requested developer prompt
   and the required MCP server, and copies the bundled documentation into the
   job workspace as `documentation/`.
6. Runs the original task with `gpt-5.6-terra`, a workspace-write sandbox, no
   interactive approvals, and live native search via `codex --search exec`.
7. Validates and uploads the durable job outputs:
   - `s3://<agent-workspace>/jobs/<job_id>/result/plan.md`
   - `s3://<agent-workspace>/jobs/<job_id>/result/final_result.json`
   - `s3://<agent-workspace>/jobs/<job_id>/result/final.md`
8. Atomically marks the job completed or failed and releases `ACTIVE_JOB`.
9. Shuts down; the launch template converts shutdown into EC2 termination.

The default `SUBAGENT_MODEL=gpt-5.6-luna` is passed to the MCP server. The MCP
server must apply that value when it launches a subagent; it is not controlled
by the orchestrator's `--model` flag.

## S3 data boundaries

- `AGENT_WORKSPACE_BUCKET_NAME` contains job-scoped inputs, intermediate
  artifacts, subagent outputs, final results, and Image Builder runtime bundles.
- Raw files uploaded by users use the deterministic key
  `jobs/<job_id>/input/anchor-data`. Bucket and role
  policies allow only the orchestrator role to read them. The admin server can
  upload but cannot download them, and subagents cannot read or overwrite them.
  Inputs are also excluded from the orchestrator debug-workspace upload.
- `GLOBAL_MEMORY_BUCKET_NAME` contains curated knowledge that persists across
  jobs. It is read-only for both orchestrators and subagents.

Orchestrators and subagents write research output only to the current job's
workspace. A separate trusted ingestion or curation workflow is responsible
for adding data to global memory.

## Final result

The orchestrator should follow `DATA_MINING_RESULT_SCHEMA.md` and publish one or
two standardized relational tables. The runner classifies schema-compliant
results for telemetry but does not make that classification a completion gate.
Any non-empty, valid JSON object or array remains publishable and is displayed
as JSON in the admin UI when it does not satisfy the database schema. Missing or
syntactically invalid output still fails the job.

## Local subagent-manager MCP server

The runtime includes `/opt/multi-agent/runtime/bin/spawn-agent-mcp`, a required
stdio MCP server that exposes `spawn_agent(task)` and
`collect_agent_results(agent_ids, timeout_seconds, poll_interval_seconds)`.
Codex starts it from the job-local MCP configuration. The server uses the
orchestrator EC2 instance ID as its grouping identity and derives job identity,
Lambda routing, Luna model selection, and deterministic agent IDs from trusted
environment variables rather than model-controlled arguments.

Before invoking Lambda, it writes the complete task specification under
`jobs/<job_id>/agents/<agent_id>/input.json`. The current Lambda accepts the
job, task URI, and model fields, validates the canonical task location, and
passes trusted identity to the subagent bootstrap. The subagent downloads the
input, runs Codex, and publishes:

- `jobs/<job_id>/agents/<agent_id>/summary/summary.md`
- `jobs/<job_id>/agents/<agent_id>/summary/results_<agent_id>.json`
- `jobs/<job_id>/agents/<agent_id>/result/completed.md` or `failure.md`
- `jobs/<job_id>/agents/<agent_id>/status/completed.json` or `failed.json`

The spawn call returns after EC2 accepts the instance launch. After launching
the planned batch, the orchestrator passes the accepted agent IDs to
`collect_agent_results`. That tool checks the exact `completed.md` and
`failure.md` S3 keys with metadata-only requests, then downloads only
`summary.md` and `results_<agent_id>.json` into
`<orchestrator workspace>/subagents/<agent_id>/`, and returns their local paths.
The terminal Markdown markers remain in S3 and are not returned to Codex. A
bounded collection timeout returns pending IDs so the orchestrator can call the
tool again without relaunching agents.

Only eight subagents may be active at once. If a later planned spawn returns
`active_subagent_limit_reached`, the orchestrator retains that task, collects
the accepted batch, and then retries the rejected task with brief delays until
capacity reconciliation allows it to launch. Rejected IDs are not collected
until a retry has actually been accepted. This permits jobs with more than eight
subtasks to run in successive batches without silently dropping work.
