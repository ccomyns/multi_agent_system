# Multi-Agent Financial Research System

An early-stage system for coordinating EC2-based financial research agents. The
current implementation contains:

- Prebaked Ubuntu 24.04 AMIs for orchestrators and browser-enabled subagents.
- On-demand `t3.large` orchestrator launch templates; Terraform does not create
  a persistent orchestrator instance.
- A Lambda function that launches subagent EC2 instances.
- A real subagent runtime that downloads S3 task specifications, runs Codex,
  publishes a research summary, structured JSON dataset, and terminal marker,
  then self-terminates.
- A hard limit of eight active subagents per orchestrator.
- A hard limit of one active multi-agent job, enforced by a DynamoDB lock item.
- DynamoDB transactions for concurrency state.
- Separate S3 buckets for lifecycle audit records, durable global memory, and
  per-job agent workspaces.
- EventBridge reconciliation when subagent instances terminate.
- A Next.js operations console.

No infrastructure is created by cloning or building this repository.

## Architecture

The orchestrator invokes the subagent manager Lambda with an orchestrator ID and
a stable request ID. Lambda atomically reserves a slot in DynamoDB before it
calls EC2. DynamoDB, rather than Lambda memory, enforces the concurrency limit
across concurrent Lambda containers.

```text
Browser --job_id--> Admin server --DynamoDB transaction--> job record + active-job lock
                          |
                          +--launch template--> EC2 orchestrator (one per run)
                                      |
                                      v
                             Lambda subagent manager -----> EC2 subagents
                                      |                         |
                                      +----> DynamoDB state     +----> S3 summary + JSON data
                                      |                         +----> terminate on completion
                                      |
                                      +----> S3 audit records

Subagent terminated event -----> EventBridge -----> Lambda reconciliation
```

The audit bucket is an append-only lifecycle destination. The global-memory
bucket holds durable knowledge across jobs, while the agent-workspace bucket
holds task specifications, intermediate artifacts, and results under
`jobs/<job_id>/`. DynamoDB is the operational source of truth for active counts
and agent state. Both orchestrators and subagents have read-only access to
global memory; they write job output only to the agent workspace. Each subagent
item includes its
orchestrator ID, agent ID, AMI ID, instance type, TTL, state, EC2 instance ID,
and lifecycle timestamps. A real subagent downloads
`jobs/<job_id>/agents/<agent_id>/input.json`, keeps all working files under
`/work`, and writes `/summary/summary.md` plus
`/summary/results_<agent_id>.json`. The supervisor uploads those data products,
writes a brief `/result/completed.md` or `/result/failure.md` terminal marker,
and publishes a machine-readable status record before the instance shuts down.
The orchestrator's local MCP server polls for those terminal markers without
downloading them, then downloads only the summary and JSON dataset. The
30-minute TTL is a hard backstop for hung runs, not the normal completion
mechanism.

Before a successful orchestrator shuts down, it uploads three durable outputs
under `jobs/<job_id>/result/`: `plan.md`, the narrative `final.md`, and a
structured `final_result.json`. The orchestrator chooses the JSON structure that
best fits the task and its collected subagent data; the runner only validates
that the file is a non-empty JSON object or array before publication.

Jobs live in a second table, `<project>-jobs`, which holds two kinds of items:
one job record per run (`pk = JOB#<job_id>`) and a single lock item
(`pk = ACTIVE_JOB`). The lock's `active_job_id` references the active job
record's `pk`. The browser mints the `job_id` and posts it to the admin server,
which issues one transaction containing two conditional writes: the lock write
succeeds only if no lock exists, and the job write succeeds only if that
`job_id` has never been used. Only when the transaction commits does the admin
server call `ec2:RunInstances`; the returned instance ID is stored as
`orchestrator_instance_id` and also serves as the join key into the subagent
state table. A job's `status` is `initializing`, `running`, `completed`, or
`failed`. Ending a job terminates its orchestrator and
deletes the lock in one transaction, so the lock can never outlive the job that
owns it.

Terraform builds the launch templates and AMIs but launches no runtime
orchestrator or subagent. EC2 Image Builder temporarily launches build/test
instances while creating each AMI and terminates those workers after the build.
The admin backend launches one orchestrator from the normal launch template for
each run and terminates it when the run is complete.

## Repository

```text
admin/                  Next.js admin console
infra/                  Terraform configuration
src/subagent_manager/   Lambda implementation
tests/                  Python unit tests
```

## Admin Console

The console models exactly one active multi-agent run. It shows:

- Orchestrator EC2 state and host utilization.
- The current research objective and elapsed time.
- Active capacity against the eight-agent limit.
- Searchable and filterable subagent assignments, instances, and activity.

Launch a Job is backed by the jobs table through `/api/jobs`; the legacy root
overview still uses typed mock data. AWS credentials stay on the Next.js server,
so browser code never receives credentials or calls `RunInstances` directly.

Successful data-mining launches navigate to `/jobs/<job_id>`. That page polls a
server-side monitor endpoint which combines the job record, orchestrator EC2
state, subagent state-table records, and job-scoped S3 artifacts. The browser
receives only the normalized job and agent monitor data, never AWS credentials.

Terraform creates a `<project>-admin-server` IAM user for this server, but it
does **not** create access keys. Long-lived secrets must stay out of Terraform
state and out of this repository. After applying, create a key yourself (or
prefer a short-lived credential source such as an assumed role / SSO profile)
and put it only in a local, gitignored environment such as `admin/.env.local`
or your shell's AWS credential chain:

```bash
terraform output admin_server_iam_user_name
aws iam create-access-key --user-name "$(terraform output -raw admin_server_iam_user_name)"
```

The user's policy spans DynamoDB (job table transactions and read access to
subagent state), EC2 (`RunInstances`, `CreateTags`, `DescribeInstances`, and
`TerminateInstances` limited to instances tagged `Role=orchestrator`), IAM
(`PassRole` for the orchestrator instance profile, restricted to EC2), and S3
(read-only inspection of the system's data buckets).

Use a supported Node.js LTS release. Node 24 is specified in `admin/.nvmrc`.

```bash
cd admin
nvm use
npm install
npm run dev
```

Open `http://localhost:3000`.

On the new-job page, a user can drop one JSON or Excel anchor file anywhere in
the UI (or use the paperclip button) before launching the job. Files are limited
to 25 MB and stored at the private `jobs/<job_id>/input/anchor-data` key in the agent
workspace bucket. Only the orchestrator can download the raw file; it passes
the values needed for each anchor record to subagents in successive batches.

To launch real jobs, copy `admin/.env.example` to `admin/.env.local` and set
`JOBS_TABLE_NAME`, `ORCHESTRATOR_LAUNCH_TEMPLATE_ID`,
`ORCHESTRATOR_LAUNCH_TEMPLATE_VERSION`, `AUDIT_BUCKET_NAME`, and `AWS_REGION`
from the Terraform outputs. Launching a job starts a billable `t3.large`
orchestrator that runs until the job is ended from the console.

The Database Management page provides read-only previews of all three S3
buckets and both DynamoDB tables. Set `AGENT_WORKSPACE_BUCKET_NAME`,
`GLOBAL_MEMORY_BUCKET_NAME`, and `STATE_TABLE_NAME` from the corresponding
Terraform outputs; it shares the jobs table and audit bucket settings above.
The S3 and DynamoDB previews show at most the first 100 records per resource.

Frontend validation:

```bash
npm run lint
npm run typecheck
npm run build
npm audit
```

## Lambda Tests

Create a local environment and run the unit tests:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m unittest discover -s tests -v
```

The tests cover the eight-agent boundary, ninth-call rejection, idempotent
request IDs, launch failure handling, and termination reconciliation.

## Terraform

Install Terraform using the
[official HashiCorp instructions](https://developer.hashicorp.com/terraform/install).
Then initialize and validate the configuration:

```bash
cd infra
terraform fmt -check -recursive .
terraform init -backend=false
terraform validate
```

`terraform init` downloads providers. `terraform validate` checks configuration
and provider schemas. Neither command creates AWS resources.

Reviewing and creating infrastructure are separate, explicit steps:

```bash
terraform plan -out=tfplan
terraform show tfplan
terraform apply tfplan
```

Do not run `apply` until the plan, AWS account, region, permissions, and
estimated cost have been reviewed.

Applying this configuration builds two AMIs:

- Orchestrator: Codex CLI, DuckDB CLI, and the multi-agent runtime.
- Subagent: Codex CLI, DuckDB CLI, Playwright, Chromium, and the S3-delivered
  task runner.

Both runtime roles default to `t3.large`. Subagents self-terminate after 1,800
seconds (30 minutes). The AMIs use Ubuntu 24.04 because it is an operating
system supported by Playwright.

The install components request current software releases at image-build time.
An existing AMI does not update itself. Orchestrator and subagent image versions
are separate so one can be rebuilt without unnecessarily rebuilding the other.
The current versions are:

```hcl
orchestrator_image_version = "1.0.8"
agent_image_version        = "1.0.5"
```

Increment `orchestrator_image_version` for orchestrator runtime or recipe
changes. Increment `agent_image_version` when shared agent tools or the
subagent image change.

The AMI build creates temporary EC2 instances and persistent EBS-backed AMIs,
so it takes longer and costs more than a configuration-only Terraform apply.
Codex is installed but deliberately unauthenticated; API keys or sign-in tokens
must be supplied securely at runtime and must never be baked into an AMI.

## Data Safety

Do not commit Terraform state, plan files, `.tfvars` files, environment files,
credentials, keys, or local AWS configuration. These are excluded by
`.gitignore`. Terraform state can contain sensitive infrastructure values and
should eventually use a secured remote backend with locking.

The S3 audit bucket uses encryption, versioning, and public-access blocking.
Terraform will not delete a non-empty audit bucket, because `force_destroy` is
hardcoded to `false` on the bucket.
