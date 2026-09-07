# Multi-Agent Financial Research System

An early-stage system for coordinating EC2-based financial research agents. The
current implementation contains:

- Independently built Ubuntu 24.04 AMIs for data-mining orchestrators,
  software-builder orchestrators, and browser-enabled subagents.
- Separate on-demand `t3.large` launch templates for data-mining and
  software-builder orchestrators; Terraform creates no persistent orchestrator.
- A Lambda function that launches subagent EC2 instances.
- A dedicated S3-triggered Lambda that terminates a subagent only after its
  trusted runner publishes durable terminal artifacts.
- A separate GitHub credential-broker Lambda that mints one-hour writer tokens
  for exactly the repository assigned to an active software-builder job.
- Separate trusted data-mining and software-builder entrypoints, each of which
  rejects the other job type.
- A real subagent runtime that downloads S3 task specifications, runs Codex,
  publishes a research summary, structured JSON dataset, and terminal marker,
  then self-terminates.
- A hard limit of twelve active subagents per orchestrator.
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
                          +--conditional write--> trusted GitHub repository assignment
                          |
                          +--launch template--> EC2 orchestrator (one per run)
                                      |
                                      +--invoke--> GitHub token broker
                                      |                 |
                                      |                 +--> job + assignment validation
                                      |                 +--> SSM/KMS writer App key
                                      |                 +--> one-repository GitHub token
                                      |
                                      v
                             Lambda subagent manager -----> EC2 subagents
                                      |                         |
                                      +----> DynamoDB state     +----> S3 summary + JSON data
                                      |                         +----> terminal marker + request
                                      |
                                      +----> S3 audit records

S3 termination request -----> Lambda terminator -----> EC2 termination
Subagent terminated event -----> EventBridge -----> Lambda reconciliation
```

The audit bucket is an append-only lifecycle destination. The global-memory
bucket holds durable knowledge across jobs, while the agent-workspace bucket
holds task specifications, intermediate artifacts, and results under
`jobs/<job_id>/`. DynamoDB is the operational source of truth for active counts
and agent state. Data-mining orchestrators and subagents have read-only access
to global memory. A software-builder orchestrator receives refreshable,
short-lived credentials for only its assigned top-level project folder and can
read, create, overwrite, and delete objects inside that folder. Runtime status,
telemetry, and debug output continue to use the agent workspace. Each subagent
item includes its
orchestrator ID, agent ID, AMI ID, instance type, TTL, state, EC2 instance ID,
and lifecycle timestamps. A real subagent downloads
`jobs/<job_id>/agents/<agent_id>/input.json`, keeps all working files under
`/work`, and writes `/summary/summary.md` plus `/summary/results.json`. The
supervisor adds the trusted agent ID when it uploads the dataset as
`results_<agent_id>.json`, then uploads those data products,
writes a brief `/result/completed.md` or `/result/failure.md` terminal marker,
publishes a machine-readable status record, and then writes a trusted
`termination/request.json`. S3 invokes a dedicated terminator Lambda, which
validates the request, status, marker, DynamoDB agent identity, and EC2 instance
before requesting termination. Guest shutdown and the 30-minute TTL remain
independent fallbacks.
The orchestrator's local MCP server waits on the active agent IDs and returns as
soon as any one terminal marker appears, without downloading the marker itself.
It downloads only that agent's summary and JSON dataset, letting the orchestrator
process the result, refill the freed slot, and immediately wait on the remaining
agents. The 30-minute TTL is a hard backstop for hung runs, not the normal
completion mechanism.

The orchestrator service reads the trusted `TypeOfJob` EC2 tag into
`TYPE_OF_JOB` and starts `orchestrator_entrypoint.py`. Data-mining jobs continue
to use `orchestrator_runner.py`, including its subagent MCP server. Software
jobs use `orchestrator_software_runner.py`; that runner neither imports the
data-mining runner nor configures the subagent MCP server. It asks the GitHub
broker for the assigned repository, clones it under the software job directory,
and starts Codex with the cloned repository root as its working directory.
When a global-memory project is selected, a second broker validates the active
job and immutable project assignment before issuing a session-tagged IAM role
limited to that exact S3 prefix. The Codex process receives it through an AWS
`credential_process`, so long runs refresh credentials without broadening the
scope.
Their durable sources are separated under `infra/runtime/orchestrator/` and
`infra/runtime/orch_software_builder/`, respectively. The data-mining subagent
has a third source tree under `infra/runtime/subagent/`. Terraform packages all
three as independent, content-addressed S3 artifacts. Each instance downloads
and verifies exactly its own artifact at launch, so a runtime edit does not
rebuild any AMI and logs can identify the exact artifact digest in use.

Before a successful orchestrator shuts down, it uploads three durable outputs
under `jobs/<job_id>/result/`: `plan.md`, the narrative `final.md`, and a
structured `final_result.json`. The orchestrator chooses the JSON structure that
best fits the task and its collected subagent data; the runner only validates
that the file is a non-empty JSON object or array before publication.

Jobs live in a second table, `<project>-jobs`, which holds two kinds of items:
one job record per run (`pk = JOB#<job_id>`) and a single lock item
(`pk = ACTIVE_JOB`). The lock's `active_job_id` references the active job
record's `pk`. The browser mints the `job_id` and posts it to the admin server,
which issues one transaction containing conditional lock and job writes. A
software-builder transaction also writes its immutable trusted repository and
optional global-memory project assignment in that transaction. The lock succeeds only if no job is active,
and the job write succeeds only if that `job_id` has never been used. Only when
the transaction commits does the admin server call `ec2:RunInstances`; the
returned instance ID is stored as
`orchestrator_instance_id` and also serves as the join key into the subagent
state table. A job's `status` is `initializing`, `running`, `completed`, or
`failed`. Ending a job terminates its orchestrator and
deletes the lock in one transaction, so the lock can never outlive the job that
owns it.

Terraform builds the launch templates and AMIs but launches no runtime
orchestrator or subagent. EC2 Image Builder temporarily launches build/test
instances while creating each AMI and terminates those workers after the build.
The admin backend chooses the data-mining or software-builder launch template
from the validated job type and terminates the instance when the run is complete.

## Repository

```text
admin/                  Next.js admin console
infra/                  Terraform configuration
infra/runtime/orchestrator/ Data-mining orchestrator runtime
infra/runtime/orch_software_builder/ Software-builder orchestrator runtime
src/subagent_manager/   Lambda implementation
src/subagent_terminator/ S3-triggered terminal-artifact termination Lambda
src/github_token_broker/ Repository-scoped GitHub credential broker
src/project_credentials_broker/ Project-scoped AWS credential broker
tests/                  Python and Node.js unit tests
```

## Admin Console

The console models exactly one active multi-agent run. It shows:

- Orchestrator EC2 state and host utilization.
- The current research objective and elapsed time.
- Active capacity against the twelve-agent limit.
- Searchable and filterable subagent assignments, instances, and activity.

Launch a Job is backed by the jobs table through `/api/jobs`; the legacy root
overview still uses typed mock data. AWS credentials stay on the Next.js server,
so browser code never receives credentials or calls `RunInstances` directly.

Successful data-mining launches navigate to `/jobs/<job_id>`. That page polls a
server-side monitor endpoint which combines compact job and subagent DynamoDB
projections with the live orchestrator EC2 state. Full S3 telemetry and event
history are loaded only when an orchestrator or subagent card is opened. The
browser receives only normalized monitor data, never AWS credentials.

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
(`PassRole` for the orchestrator instance profiles, restricted to EC2), and S3
(inspection of the system's data buckets plus project creation in global memory).

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
the values needed for each anchor record to subagents through a rolling window
of up to twelve active agents.

Completed data-mining jobs preferentially publish a versioned one- or two-table
JSON result. The orchestrator detail page renders compliant results as a
read-only, paginated spreadsheet with table tabs. Any other valid JSON result
still completes normally and is displayed in a formatted JSON fallback view.

To launch real jobs, copy `admin/.env.example` to `admin/.env.local` and set
`JOBS_TABLE_NAME`, `ORCHESTRATOR_LAUNCH_TEMPLATE_ID`,
`ORCHESTRATOR_LAUNCH_TEMPLATE_VERSION`,
`SOFTWARE_BUILDER_ORCHESTRATOR_LAUNCH_TEMPLATE_ID`,
`SOFTWARE_BUILDER_ORCHESTRATOR_LAUNCH_TEMPLATE_VERSION`,
`GITHUB_REPOSITORY_ASSIGNMENTS_TABLE_NAME`, and `AWS_REGION`
from the Terraform outputs. Launching a job starts a billable `t3.large`
orchestrator that runs until the job is ended from the console.

Set `AGENT_WORKSPACE_BUCKET_NAME`, `GLOBAL_MEMORY_BUCKET_NAME`, and
`STATE_TABLE_NAME` from the corresponding Terraform outputs for anchor files,
job monitoring, result artifacts, and project uploads.

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
node --test tests/github_token_broker.test.mjs
```

The tests cover the configured agent boundary, over-capacity rejection,
idempotent request IDs, launch failure handling, terminal-artifact termination,
termination reconciliation, and project-scoped credential issuance.

## GitHub writer credential boundary

The admin/provisioner GitHub App and the orchestrator/writer GitHub App are
separate identities. The writer App should have only repository
`Contents: Read and write` (GitHub also supplies metadata read access). Install
it on the organization repositories it may serve. The infrastructure then
reduces each issued installation token to one trusted repository ID, so an
orchestrator never receives the App PEM and cannot request another repository
in the broker payload.

Terraform defines the broker Lambda, its dedicated IAM role, a dedicated KMS
key, and an admin-only DynamoDB repository-assignment table. The only runtime
identity allowed to call `ssm:GetParameter` and `kms:Decrypt` for the writer key
is the broker role. The orchestrator role can invoke the broker but has no
access to the assignment table, PEM parameter, or KMS key. Subagents have none
of those permissions.

Copy the non-secret example variables, set the writer App's Client ID, and set
the software builder's Git author name and verified GitHub email. Prefer the
personal account's GitHub no-reply email when that account is connected to the
Vercel Pro team. An App ID, client secret, installation ID, or PEM contents do
not belong in this file:

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
```

After reviewing and applying Terraform, create the SecureString out of band.
Terraform deliberately does not manage an `aws_ssm_parameter` value because a
managed value would be copied into Terraform state. Run this with the same
deployer/admin AWS profile used for Terraform, not the restricted admin-server
application credentials:

```bash
WRITER_PEM_PATH="/absolute/path/to/cody-software-builder-writer.private-key.pem"

aws ssm put-parameter \
  --region us-east-1 \
  --name "$(terraform output -raw github_writer_private_key_ssm_parameter_name)" \
  --description "Private key for the GitHub software-builder writer App" \
  --type SecureString \
  --key-id "$(terraform output -raw github_writer_private_key_kms_key_arn)" \
  --value "file://$WRITER_PEM_PATH"
```

Use `--overwrite` only when intentionally rotating an existing key. You can
verify the parameter's metadata without printing its decrypted value:

```bash
aws ssm describe-parameters \
  --region us-east-1 \
  --parameter-filters \
    "Key=Name,Option=Equals,Values=$(terraform output -raw github_writer_private_key_ssm_parameter_name)"
```

The software-builder submit API atomically creates the job and an immutable
item in the `github_repository_assignments_table_name` output with
`job_id`, GitHub's numeric `github_repository_id`, and
`github_repository_full_name`. The broker accepts only `job_id` and
`orchestrator_instance_id`; it obtains repository scope from that trusted
record, verifies the active job and EC2 assignment, and asks GitHub for an
installation token limited to that repository and `contents:write`. GitHub
installation tokens expire after one hour.

The software-builder runner uses the first token only to clone the assigned
repository. It then installs a repository-local Git credential helper that asks
the broker for a fresh token when Git needs one, allowing a long-running job to
push after the first token expires without storing the token in the remote URL,
repository, environment file, or Codex configuration. Before the runner marks a
job complete, it requires a clean working tree and verifies that the current
commit exists on the matching branch at `origin`.

At EC2 startup, Terraform writes `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` into
the software-builder-only systemd environment file. The runner explicitly
passes them to Codex, so ordinary `git commit` commands use the configured
GitHub identity as the author. Repository-local `user.name` and `user.email`
remain `cody-software-builder[bot]`, preserving the bot as the committer and the
GitHub App installation token as the push credential. This split lets Vercel
associate private-organization commits with the connected Pro team member
without exposing that member's GitHub credentials to the builder.

## Vercel publisher boundary

Terraform defines a dedicated Vercel publisher Lambda and IAM role. The
software-builder EC2 role may invoke the function, but only the Lambda may read
the Vercel access token from SSM. The token value is never managed by Terraform
and is not placed in the builder's environment.

Set the following non-secret inputs in `infra/terraform.tfvars` (Terraform does
not load `admin/.env.local`):

```hcl
vercel_team_id = "team_REPLACE_WITH_VERCEL_TEAM_ID"
vercel_access_token_ssm_parameter_name = "/financial-research-agents/vercel/access-token"
```

The parameter-name input is optional when the token uses the default path
`/<project_name>/vercel/access-token`. The Lambda expects an existing SSM
`SecureString`; it reads it with decryption at invocation time. Its IAM policy
grants `ssm:GetParameter` only for that exact path. Parameters encrypted with a
customer-managed KMS key also require an explicit `kms:Decrypt` grant, which is
not configured by default.

The software-builder runtime exposes a no-argument `publish_site` MCP tool. It
requires a clean working tree, derives the current branch and commit, verifies
that exact commit on `origin`, and then uses the function's two invocation
actions. The MCP launcher starts with an empty environment and forwards only
its AWS region, broker function names, trusted job/instance identity, and
repository path. In particular, the database URL and Codex authentication are
not forwarded in the publisher subprocess environment.

Publication creates or validates a Vercel project linked to the job's trusted
GitHub repository, then deploys the exact pushed commit to production:

```json
{
  "action": "publish",
  "job_id": "job_abcd_12345678",
  "orchestrator_instance_id": "i-1234567890abcdef0",
  "branch": "vercel-integration",
  "commit_sha": "0123456789abcdef0123456789abcdef01234567"
}
```

Deployment state is polled with the same trusted commit identity plus the
returned deployment ID:

```json
{
  "action": "status",
  "job_id": "job_abcd_12345678",
  "orchestrator_instance_id": "i-1234567890abcdef0",
  "branch": "vercel-integration",
  "commit_sha": "0123456789abcdef0123456789abcdef01234567",
  "deployment_id": "dpl_REPLACE_WITH_DEPLOYMENT_ID"
}
```

Repository, Vercel team/project, token, and environment-variable fields are
intentionally rejected. Those scopes come from Terraform and the immutable
repository assignment for the active software-builder job. A successful status
response reports the production alias as `public_url` once Vercel assigns it;
the unique `deployment_url` may remain protected under the team's Deployment
Protection settings.

Software-builder Codex currently runs with `danger-full-access` and approval
prompts disabled. This gives its shell commands outbound network access and
write access to `.git`, allowing Codex itself to install dependencies, commit,
and push through the broker-backed Git credential helper. The wrapper accepts a
successful run only when the working tree is clean and the current commit is
present on the matching branch at `origin`.

This mode also lets model-generated commands access anything available to the
software-builder OS user and EC2 role. Keep that instance role tightly scoped;
use a narrower host-side publish tool or trusted wrapper before granting the
role access to sensitive AWS resources.

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

### Proof-of-concept PostgreSQL database

Terraform provisions one publicly reachable, Single-AZ Amazon RDS for
PostgreSQL `db.t4g.micro` instance with 20 GiB of encrypted gp3 storage. It uses
the existing project VPC, its internet gateway and public route table, and two
public subnets in separate Availability Zones. The database security group
deliberately allows TCP port 5432 from `0.0.0.0/0`. This exposure and the lack of
retained backups, deletion protection, and a final snapshot are PoC choices,
not production defaults.

The initial database is `researchagents` and its master username is
`researchadmin`. Terraform generates the password; no credential is stored in
source-controlled configuration. After `terraform apply`, connection fields
are available at these Parameter Store paths, where `<project_name>` is the
`project_name` Terraform variable (by default `financial-research-agents`):

| Connection field | SSM parameter | Type |
| --- | --- | --- |
| Host | `/<project_name>/database/postgresql/host` | `String` |
| Port | `/<project_name>/database/postgresql/port` | `String` |
| Database name | `/<project_name>/database/postgresql/database-name` | `String` |
| Username | `/<project_name>/database/postgresql/username` | `String` |
| Password | `/<project_name>/database/postgresql/password` | `SecureString` |

The Software Builder runtime panel can select an existing managed database or
stage a new database name and optional description. Saving the dialog only
stages details; the main Submit button provisions the database and credentials.
Descriptions are PostgreSQL database comments. With no database selected, the
job receives no database credential; there is no master-credential fallback.
Existing databases without completed managed credentials are shown as
unavailable. They are not automatically converted or modified.

Each new database has two independently generated PostgreSQL login roles:

| Role | Consumer | Permissions |
| --- | --- | --- |
| Owner | Assigned software-builder job | Own database and public schema; create, alter, and drop application tables; read/write rows |
| Application | Assigned Vercel project | CONNECT, public schema USAGE, SELECT/INSERT/UPDATE/DELETE on application tables, and sequence USAGE |

Neither role has superuser, CREATEDB, CREATEROLE, replication, or BYPASSRLS
privileges. Database and public-schema PUBLIC grants are revoked. Default
privileges apply to tables/sequences created by the owner in the public schema;
new owner-created functions do not grant PUBLIC execution. The builder must
complete schema changes before publishing, not in the Vercel build. Custom
schemas or stored-function access need explicit grants from the owner.

The trusted admin server uses the instance master credential only to provision
databases/roles and list databases. Each managed database is recorded under
`/<project_name>/database/postgresql/databases/<database-name>/`:

| Parameter | Type | Contents |
| --- | --- | --- |
| owner | SecureString | JSON with database_name and owner connection url |
| app | SecureString | JSON with database_name and application connection url |
| provisioning | SecureString | Generated role names and passwords retained for resumable setup |
| status | String | provisioning or ready |

A database is selectable only after setup is ready. A PostgreSQL session lock
serializes creation attempts. If SQL or SSM writes fail, submitting the same
name resumes setup with the same passwords. Partial databases/roles are retained
for retry, not deleted. No credentials are returned to the browser.

The credential broker validates the active job, orchestrator instance, and
trusted database assignment before reading its owner secret. The orchestrator
has no direct read access to database parameters. The owner URL is written to a
mode-0600 file outside the repository, injected as DATABASE_URL, and removed
when the runner exits.

At publication time, the Vercel publisher creates or locates the assigned
project, retrieves only the assigned application secret, and upserts a
sensitive production DATABASE_URL before triggering deployment. Environment
upload failures stop publication; retries upsert the same variable. The owner
credential is never uploaded. Preview/development variables are not populated.
Credential rotation is not automated; changing a PostgreSQL password requires
updating its stored secret and republishing/redeploying Vercel.

For the admin server, set `POSTGRESQL_SSM_PARAMETER_PREFIX` to the Terraform
output of the same name and `POSTGRESQL_CA_BUNDLE_PATH` to a local copy of the
[AWS RDS CA bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem).
These two non-secret settings belong in `admin/.env.local`; database passwords
do not. The admin host must reach RDS on port 5432, and admin connections verify
the server certificate using the bundle.

Generate and review a new Terraform plan after changing this code; old saved
plans do not include the new IAM, broker, publisher, and runner configuration.
Apply that plan and restart the admin server before using managed databases.
No new manually configured environment variables are required beyond the two
admin settings above; Terraform supplies the broker/publisher parameter prefix.
Do not deploy during an active software-builder job.

`terraform output postgresql_ssm_parameter_names` reports the instance
provisioning parameter paths without exposing passwords. The master password
is still present in Terraform state, which must remain protected. Per-database
passwords are generated at Submit time and are not Terraform resources.
SecureString values use the account's standard SSM encryption key. IAM permits
the broker to read only owner/status parameters and the publisher to read only
app/status parameters; the admin manages provisioning records and both secrets.

Applying this configuration builds three independently versioned base AMIs:

- Data-mining orchestrator: Codex CLI, DuckDB CLI, Python dependencies, and a
  launch-time runtime downloader.
- Software-builder orchestrator: an independently versioned base AMI containing
  Codex CLI, Git, Playwright, Chromium, Python dependencies, and a launch-time
  runtime downloader. Playwright is installed globally; Chromium is available
  as `chromium`, with browser binaries in `/opt/ms-playwright`. The runner sets
  `PLAYWRIGHT_BROWSERS_PATH` for agent commands. Adding these baked dependencies
  requires building image version `1.0.3` and updating the launch template;
  updating the runtime ZIP alone does not install them.
- Data-mining subagent: Codex CLI, DuckDB CLI, Playwright, Chromium, Python
  dependencies, and a launch-time runtime downloader.

Terraform packages the data-mining orchestrator, software-builder orchestrator,
and data-mining subagent sources as three isolated, content-addressed S3 ZIPs.
Each instance receives only its own artifact key and SHA-256 and verifies it
before execution. Runtime-only edits therefore update the S3 object and launch
configuration without rebuilding any AMI.

Both runtime roles default to `t3.large`, with a maximum of twelve active
subagents per orchestrator. Subagents self-terminate after
1,800 seconds (30 minutes). The AMIs use Ubuntu 24.04 because it is an operating
system supported by Playwright.

The install components request current software releases at image-build time.
An existing AMI does not update its installed dependencies. Orchestrator
workload and subagent image versions are separate so one can be rebuilt without
unnecessarily rebuilding the others. Runtime changes do not change any base
AMI: Terraform uploads immutable runtime ZIPs and pins their keys and SHA-256
hashes in the relevant launch configuration.
The current versions are:

```hcl
orchestrator_image_version = "1.1.7"
software_builder_orchestrator_image_version = "1.0.1"
agent_image_version = "1.1.5"
```

Increment an image version only when its base recipe, baked dependencies, or
downloader changes. Do not increment an orchestrator or subagent image version
for runner, prompt, documentation, or other runtime-only changes.

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
