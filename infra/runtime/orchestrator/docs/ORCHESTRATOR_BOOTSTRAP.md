# Real orchestrator bootstrap

The normal EC2 launch template gets its short, job-specific user data from
`compute.tf`. That user data reads the `JobId` instance tag, writes
`/etc/multi-agent/orchestrator.env`, and starts
`multi-agent-orchestrator.service`.

The durable runtime source lives under `runtime/orchestrator/`. Terraform
packages that whole directory as a versioned ZIP artifact in private S3. EC2
Image Builder downloads and expands it under `/opt/multi-agent/runtime`; this
keeps scripts and documentation out of the 16 KB inline component document and
lets the bundle grow independently. The systemd service is installed disabled
and is started only by the normal launch template. The stress-test template
shares the environment setup but does not start the real runner.

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
2. Fetches and installs the current Codex `auth.json`.
3. Verifies that the configured local `spawn_agent` MCP executable exists.
4. Writes a job-local Codex configuration with the requested developer prompt
   and the required MCP server, and copies the bundled documentation into the
   job workspace as `documentation/`.
5. Runs the original task with `gpt-5.6-terra`, a workspace-write sandbox, no
   interactive approvals, and live native search via `codex --search exec`.
6. Uploads the final response to `jobs/<job_id>/result/final.md`.
7. Atomically marks the job completed or failed and releases `ACTIVE_JOB`.
8. Shuts down; the launch template converts shutdown into EC2 termination.

The default `SUBAGENT_MODEL=gpt-5.6-luna` is passed to the MCP server. The MCP
server must apply that value when it launches a subagent; it is not controlled
by the orchestrator's `--model` flag.

## Local spawn-agent MCP server

The runtime includes `/opt/multi-agent/runtime/bin/spawn-agent-mcp`, a required
stdio MCP server that exposes only `spawn_agent(task)`. Codex starts it from the
job-local MCP configuration. The server uses the orchestrator EC2 instance ID
as its grouping identity and derives job identity, Lambda routing, Luna model
selection, and a deterministic agent ID from trusted environment variables
rather than model-controlled arguments.

Before invoking Lambda, it writes the complete task specification under
`jobs/<job_id>/agents/<agent_id>/input.json`. The current Lambda accepts the
additional job, task URI, and model fields without using them, and the current
subagent bootstrap still only sleeps until its TTL. Implementing the subagent
runner that consumes this input and publishes a result remains the next
pipeline stage.
