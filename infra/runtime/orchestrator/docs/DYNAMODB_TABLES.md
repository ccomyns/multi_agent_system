# DynamoDB table roles

The system deliberately uses two tables because job orchestration and subagent
capacity have different keys, writers, lifecycles, and consistency needs.

## Jobs table

Terraform name: `aws_dynamodb_table.jobs`

Primary key: partition key `pk`

Records:

- `pk = ACTIVE_JOB`: the singleton lock that enforces at most one active
  multi-agent research job.
- `pk = JOB#<job_id>`: the user request and top-level orchestrator lifecycle,
  including `type_of_job`, status, the orchestrator EC2 instance ID, and
  timestamps. New records currently use `type_of_job = data_mining`; readers
  treat older records without the attribute as data-mining jobs.

The admin server creates the job record and lock together. The real
orchestrator reads its job record and eventually completes or fails it while
releasing the lock. This table does not contain one record per subagent.

## State table

Terraform name: `aws_dynamodb_table.state`

Primary key: partition key `pk`, sort key `sk`

Records grouped beneath `pk = ORCHESTRATOR#<orchestrator_id>`:

- `sk = COUNTER`: the atomic active-subagent count for that orchestrator.
- `sk = AGENT#<agent_id>`: one subagent reservation and EC2 lifecycle record.

Agent records contain provisioning state, active status, AMI and instance type,
TTL, EC2 instance ID, timestamps, and errors. Real-job records also include the
job ID, canonical S3 task URI, and configured model. The `instance-index` GSI
maps an EC2 instance ID back to its agent record so termination events can
decrement the correct orchestrator counter exactly once.

The subagent-manager Lambda owns writes to this table. The orchestrator itself
is a grouping identifier here, not an `AGENT` record.

## Relationship

The jobs-table record stores only `orchestrator_instance_id`. The runtime uses
that EC2 instance ID as the orchestrator grouping key in the state table:

```text
JOB#<job_id>.orchestrator_instance_id
             |
             +--> ORCHESTRATOR#<instance_id> / COUNTER
             +--> ORCHESTRATOR#<instance_id> / AGENT#<agent_id>
             +--> ORCHESTRATOR#<instance_id> / AGENT#<agent_id>
```

There is not currently a third table representing an "orchestrator agent."
