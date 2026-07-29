# Multi-Agent Financial Research System

An early-stage system for coordinating EC2-based financial research agents. The
current implementation contains:

- Prebaked Ubuntu 24.04 AMIs for orchestrators and browser-enabled subagents.
- On-demand `t3.large` orchestrator launch templates; Terraform does not create
  a persistent orchestrator instance.
- A Lambda function that launches subagent EC2 instances.
- A hard limit of eight active subagents per orchestrator.
- DynamoDB transactions for concurrency state.
- S3 lifecycle audit records.
- EventBridge reconciliation when subagent instances terminate.
- An on-demand, self-terminating orchestrator stress-test launch template.
- A Next.js operations console.

No infrastructure is created by cloning or building this repository.

## Architecture

The orchestrator invokes the subagent manager Lambda with an orchestrator ID and
a stable request ID. Lambda atomically reserves a slot in DynamoDB before it
calls EC2. DynamoDB, rather than Lambda memory, enforces the concurrency limit
across concurrent Lambda containers.

```text
Admin backend --launch template--> EC2 orchestrator (one per run)
                                      |
                                      v
                             Lambda subagent manager -----> EC2 subagents
                                      |                         |
                                      +----> DynamoDB state     +----> terminate after 30 minutes
                                      |
                                      +----> S3 audit records

Subagent terminated event -----> EventBridge -----> Lambda reconciliation
```

S3 is an append-only audit destination. DynamoDB is the operational source of
truth for active counts and agent state. Each subagent item includes its
orchestrator ID, agent ID, AMI ID, instance type, TTL, state, EC2 instance ID,
and lifecycle timestamps.

Terraform builds the launch templates and AMIs but launches no runtime
orchestrator or subagent. EC2 Image Builder temporarily launches build/test
instances while creating each AMI and terminates those workers after the build.
The admin backend will eventually launch one orchestrator from the normal
launch template for each run and terminate it when the run is complete.

## Repository

```text
admin/                  Next.js admin console
infra/                  Terraform configuration
scripts/stress_test.py  Nine-call integration stress test
src/subagent_manager/   Lambda implementation
tests/                  Python unit tests
```

## Admin Console

The console models exactly one active multi-agent run. It shows:

- Orchestrator EC2 state and host utilization.
- The current research objective and elapsed time.
- Active capacity against the eight-agent limit.
- Searchable and filterable subagent assignments, instances, and activity.

The UI currently uses typed mock data. It deliberately has no AWS credentials
or direct browser-to-AWS integration. Terraform exposes the orchestrator
launch-template IDs for a future authenticated backend; browser code should not
receive AWS credentials or call `RunInstances` directly.

Use a supported Node.js LTS release. Node 24 is specified in `admin/.nvmrc`.

```bash
cd admin
nvm use
npm install
npm run dev
```

Open `http://localhost:3000`.

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

- Orchestrator: Codex CLI, DuckDB CLI, and the Python stress-test harness.
- Subagent: Codex CLI, DuckDB CLI, Playwright, and Playwright's Chromium build.

Both runtime roles default to `t3.large`. Subagents self-terminate after 1,800
seconds (30 minutes). The AMIs use Ubuntu 24.04 because it is an operating
system supported by Playwright.

The install components request current software releases at image-build time.
An existing AMI does not update itself. To rebuild both AMIs with current
releases, increment the semantic image version and apply again:

```hcl
agent_image_version = "1.0.1"
```

The AMI build creates temporary EC2 instances and persistent EBS-backed AMIs,
so it takes longer and costs more than a configuration-only Terraform apply.
Codex is installed but deliberately unauthenticated; API keys or sign-in tokens
must be supplied securely at runtime and must never be baked into an AMI.

## Stress Test

Terraform provides a launch template instead of creating a test instance during
`terraform apply`. Obtain the template ID and version after applying:

```bash
terraform output orchestrator_stress_test_launch_template_id
terraform output orchestrator_stress_test_launch_template_version
```

The admin backend can pass those values to EC2 `RunInstances`. An instance
launched from this template:

- Starts one `t3.large` orchestrator.
- Generates a stable orchestrator ID from its EC2 instance ID.
- Runs `run-subagent-stress-test`, which invokes Lambda nine times.
- Expects eight subagents and one `429` capacity rejection.
- Writes the JSON report under the S3 stress-test prefix.
- Shuts itself down; the launch template converts shutdown into EC2
  termination.

The eight accepted Lambda calls create `t3.large` subagents from the prebaked
browser AMI. DynamoDB atomically records the counter and per-agent metadata
before EC2 is called, then updates the item with the instance ID and launch
state. EventBridge updates the records when the subagents terminate.

## Data Safety

Do not commit Terraform state, plan files, `.tfvars` files, environment files,
credentials, keys, or local AWS configuration. These are excluded by
`.gitignore`. Terraform state can contain sensitive infrastructure values and
should eventually use a secured remote backend with locking.

The S3 audit bucket uses encryption, versioning, and public-access blocking.
Terraform will not delete a non-empty audit bucket unless
`audit_bucket_force_destroy` is explicitly enabled.
