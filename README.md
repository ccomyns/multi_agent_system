# Multi-Agent Financial Research System

An early-stage system for coordinating EC2-based financial research agents. The
current implementation contains:

- A Lambda function that launches subagent EC2 instances.
- A hard limit of eight active subagents per orchestrator.
- DynamoDB transactions for concurrency state.
- S3 lifecycle audit records.
- EventBridge reconciliation when subagent instances terminate.
- An opt-in EC2 stress-test caller.
- A Next.js operations console.

No infrastructure is created by cloning or building this repository.

## Architecture

The orchestrator invokes the subagent manager Lambda with an orchestrator ID and
a stable request ID. Lambda atomically reserves a slot in DynamoDB before it
calls EC2. DynamoDB, rather than Lambda memory, enforces the concurrency limit
across concurrent Lambda containers.

```text
Orchestrator
    |
    v
Lambda subagent manager -----> EC2 subagent
    |                              |
    +----> DynamoDB state          +----> self-terminate after TTL
    |
    +----> S3 audit records

EC2 terminated event -----> EventBridge -----> Lambda reconciliation
```

S3 is an append-only audit destination. DynamoDB is the operational source of
truth for active counts and agent state.

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
or direct browser-to-AWS integration.

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

The stress caller is disabled by default:

```hcl
create_stress_test_instance = false
```

Enabling it creates one caller EC2 instance. The caller invokes Lambda nine
times; a successful test briefly launches eight additional subagent instances
and verifies that the ninth request receives a `429` response. The caller
terminates itself after reporting, and subagents terminate after their
configured TTL.

## Data Safety

Do not commit Terraform state, plan files, `.tfvars` files, environment files,
credentials, keys, or local AWS configuration. These are excluded by
`.gitignore`. Terraform state can contain sensitive infrastructure values and
should eventually use a secured remote backend with locking.

The S3 audit bucket uses encryption, versioning, and public-access blocking.
Terraform will not delete a non-empty audit bucket unless
`audit_bucket_force_destroy` is explicitly enabled.
