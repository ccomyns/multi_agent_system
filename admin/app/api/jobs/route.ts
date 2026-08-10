import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import type { Job, JobStatus, JobType, JobsSnapshot } from "@/lib/jobs";
import { DEFAULT_JOB_TYPE, isJobType, JOB_ID_PATTERN } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Exactly one lock item ever. Its presence means a multi-agent job is active.
const LOCK_KEY = "ACTIVE_JOB";
const MAX_TASK_LENGTH = 4000;
const JOB_HISTORY_LIMIT = 50;

type LaunchJobRequest = {
  jobId?: unknown;
  originalTask?: unknown;
  typeOfJob?: unknown;
};

type JobItem = {
  pk?: unknown;
  job_id?: unknown;
  original_task?: unknown;
  type_of_job?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  orchestrator_instance_id?: unknown;
  launched_at?: unknown;
  finished_at?: unknown;
};

const JOB_STATUSES: JobStatus[] = ["initializing", "running", "completed", "failed"];

function json(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function errorResponse(error: string, status: number) {
  return json({ error }, { status });
}

function configuration() {
  const jobsTable = process.env.JOBS_TABLE_NAME;
  const launchTemplateId = process.env.ORCHESTRATOR_LAUNCH_TEMPLATE_ID;
  if (!jobsTable || !launchTemplateId) {
    return null;
  }
  return {
    jobsTable,
    launchTemplateId,
    launchTemplateVersion: process.env.ORCHESTRATOR_LAUNCH_TEMPLATE_VERSION || "$Default",
    region: process.env.AWS_REGION,
  };
}

function documentClient() {
  const client = new DynamoDBClient(awsClientOptions());
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function jobPk(jobId: string) {
  return `JOB#${jobId}`;
}

function jobKey(jobId: string) {
  return { pk: jobPk(jobId) };
}

function isJobStatus(value: unknown): value is JobStatus {
  return JOB_STATUSES.includes(value as JobStatus);
}

function toJob(item: Record<string, unknown> | undefined): Job | null {
  if (!item) {
    return null;
  }
  const record = item as JobItem;
  if (
    typeof record.job_id !== "string" ||
    typeof record.original_task !== "string" ||
    typeof record.created_at !== "string" ||
    !isJobStatus(record.status)
  ) {
    return null;
  }
  return {
    jobId: record.job_id,
    originalTask: record.original_task,
    // Records created before job types were introduced are data-mining jobs.
    typeOfJob: isJobType(record.type_of_job) ? record.type_of_job : DEFAULT_JOB_TYPE,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : record.created_at,
    orchestratorInstanceId:
      typeof record.orchestrator_instance_id === "string" ? record.orchestrator_instance_id : null,
    launchedAt: typeof record.launched_at === "string" ? record.launched_at : null,
    finishedAt: typeof record.finished_at === "string" ? record.finished_at : null,
  };
}

function jobIdFromActiveJobRef(activeJobId: unknown): string | null {
  if (typeof activeJobId !== "string") {
    return null;
  }
  // The lock stores a reference to the job record's pk (JOB#<job_id>).
  return activeJobId.startsWith("JOB#") ? activeJobId.slice(4) : activeJobId;
}

// A cancelled transaction tells us which of the two conditional writes failed:
// index 0 is the lock, index 1 is the job record itself.
function cancellationCodes(error: TransactionCanceledException) {
  return (error.CancellationReasons ?? []).map((reason) => reason.Code ?? "None");
}

async function scanJobs(documents: DynamoDBDocumentClient, jobsTable: string) {
  const jobs: Job[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const page = await documents.send(
      new ScanCommand({
        TableName: jobsTable,
        // Only job records carry a job_id attribute; the lock item is excluded.
        FilterExpression: "begins_with(pk, :prefix)",
        ExpressionAttributeValues: { ":prefix": "JOB#" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of page.Items ?? []) {
      const job = toJob(item);
      if (job) {
        jobs.push(job);
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);

  jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return jobs.slice(0, JOB_HISTORY_LIMIT);
}

export async function GET() {
  const config = configuration();
  if (!config) {
    return errorResponse(
      "The admin server is missing JOBS_TABLE_NAME or ORCHESTRATOR_LAUNCH_TEMPLATE_ID.",
      503,
    );
  }

  const documents = documentClient();
  try {
    const [history, lock] = await Promise.all([
      scanJobs(documents, config.jobsTable),
      documents.send(
        new GetCommand({
          TableName: config.jobsTable,
          Key: { pk: LOCK_KEY },
          ConsistentRead: true,
        }),
      ),
    ]);

    const snapshot: JobsSnapshot = {
      jobs: history,
      activeJobId: jobIdFromActiveJobRef(lock.Item?.active_job_id),
    };
    return json(snapshot);
  } catch (error) {
    console.error("Job history read failed", error);
    return errorResponse(
      error instanceof Error ? error.message : "The job table could not be read.",
      502,
    );
  } finally {
    documents.destroy();
  }
}

export async function POST(request: Request) {
  const config = configuration();
  if (!config) {
    return errorResponse(
      "The admin server is missing JOBS_TABLE_NAME or ORCHESTRATOR_LAUNCH_TEMPLATE_ID.",
      503,
    );
  }

  let input: LaunchJobRequest;
  try {
    input = (await request.json()) as LaunchJobRequest;
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  if (typeof input.jobId !== "string" || !JOB_ID_PATTERN.test(input.jobId)) {
    return errorResponse("jobId must look like job_<timestamp>_<random>.", 400);
  }
  if (
    typeof input.originalTask !== "string" ||
    input.originalTask.trim().length === 0 ||
    input.originalTask.length > MAX_TASK_LENGTH
  ) {
    return errorResponse(
      `originalTask must be between 1 and ${MAX_TASK_LENGTH} characters.`,
      400,
    );
  }

  const jobId = input.jobId;
  const originalTask = input.originalTask.trim();
  const requestedJobType = input.typeOfJob ?? DEFAULT_JOB_TYPE;
  if (!isJobType(requestedJobType)) {
    return errorResponse("typeOfJob is not supported.", 400);
  }
  const typeOfJob: JobType = requestedJobType;
  const createdAt = new Date().toISOString();
  const documents = documentClient();

  try {
    // Claim the lock and create the job record together. The lock write fails if
    // another job is active; the job write fails if this job_id already exists.
    await documents.send(
      new TransactWriteCommand({
        ClientRequestToken: jobId,
        TransactItems: [
          {
            Put: {
              TableName: config.jobsTable,
              Item: {
                pk: LOCK_KEY,
                active_job_id: jobPk(jobId),
                updated_at: createdAt,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: config.jobsTable,
              Item: {
                pk: jobPk(jobId),
                job_id: jobId,
                original_task: originalTask,
                type_of_job: typeOfJob,
                status: "initializing",
                created_at: createdAt,
                updated_at: createdAt,
                orchestrator_instance_id: null,
                launched_at: null,
                finished_at: null,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    documents.destroy();
    if (error instanceof TransactionCanceledException) {
      const [lockCode, jobCode] = cancellationCodes(error);
      if (jobCode === "ConditionalCheckFailed") {
        return errorResponse("That job ID has already been used. Retry with a new one.", 409);
      }
      if (lockCode === "ConditionalCheckFailed") {
        return errorResponse(
          "Another multi-agent job is already active. End it before launching a new one.",
          409,
        );
      }
    }
    console.error("Job reservation failed", error);
    return errorResponse(
      error instanceof Error ? error.message : "The job record could not be created.",
      502,
    );
  }

  const ec2 = new EC2Client(awsClientOptions());
  let instanceId: string;
  try {
    const response = await ec2.send(
      new RunInstancesCommand({
        LaunchTemplate: {
          LaunchTemplateId: config.launchTemplateId,
          Version: config.launchTemplateVersion,
        },
        MinCount: 1,
        MaxCount: 1,
        ClientToken: jobId,
        TagSpecifications: [
          {
            ResourceType: "instance",
            Tags: [
              { Key: "Name", Value: `orchestrator-${jobId}` },
              { Key: "Role", Value: "orchestrator" },
              { Key: "JobId", Value: jobId },
              { Key: "TypeOfJob", Value: typeOfJob },
            ],
          },
          {
            ResourceType: "volume",
            Tags: [
              { Key: "Role", Value: "orchestrator" },
              { Key: "JobId", Value: jobId },
              { Key: "TypeOfJob", Value: typeOfJob },
            ],
          },
        ],
      }),
    );
    const launchedId = response.Instances?.[0]?.InstanceId;
    if (!launchedId) {
      throw new Error("EC2 accepted the launch request without returning an instance ID.");
    }
    instanceId = launchedId;
  } catch (error) {
    console.error("Orchestrator launch failed", error);
    const reason = error instanceof Error ? error.message : "The orchestrator could not be launched.";
    await releaseJob(documents, config.jobsTable, jobId, "failed");
    documents.destroy();
    ec2.destroy();
    return errorResponse(reason, 502);
  }

  const launchedAt = new Date().toISOString();
  try {
    const updated = await documents.send(
      new UpdateCommand({
        TableName: config.jobsTable,
        Key: jobKey(jobId),
        UpdateExpression:
          "SET #status = :running, orchestrator_instance_id = :instanceId, launched_at = :now, updated_at = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":running": "running",
          ":instanceId": instanceId,
          ":now": launchedAt,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    const job = toJob(updated.Attributes);
    if (!job) {
      throw new Error("The stored job record has an unexpected shape.");
    }
    return json(job, { status: 201 });
  } catch (error) {
    console.error("Job record could not be linked to its orchestrator", error);
    await terminateOrchestrator(ec2, instanceId);
    await releaseJob(documents, config.jobsTable, jobId, "failed");
    return errorResponse(
      "The orchestrator launched but its job record could not be updated, so it was terminated.",
      502,
    );
  } finally {
    documents.destroy();
    ec2.destroy();
  }
}

export async function DELETE(request: Request) {
  const config = configuration();
  if (!config) {
    return errorResponse(
      "The admin server is missing JOBS_TABLE_NAME or ORCHESTRATOR_LAUNCH_TEMPLATE_ID.",
      503,
    );
  }

  const jobId = new URL(request.url).searchParams.get("jobId") ?? "";
  if (!JOB_ID_PATTERN.test(jobId)) {
    return errorResponse("A valid jobId query parameter is required.", 400);
  }

  const documents = documentClient();
  const ec2 = new EC2Client(awsClientOptions());
  try {
    const stored = await documents.send(
      new GetCommand({
        TableName: config.jobsTable,
        Key: jobKey(jobId),
        ConsistentRead: true,
      }),
    );
    const job = toJob(stored.Item);
    if (!job) {
      return errorResponse("That job does not exist.", 404);
    }

    if (job.orchestratorInstanceId) {
      await terminateOrchestrator(ec2, job.orchestratorInstanceId);
    }

    const ended = await releaseJob(documents, config.jobsTable, jobId, "completed");
    return json(ended ?? { ...job, status: "completed" satisfies JobStatus });
  } catch (error) {
    console.error("Job could not be ended", error);
    return errorResponse(
      error instanceof Error ? error.message : "The job could not be ended.",
      502,
    );
  } finally {
    documents.destroy();
    ec2.destroy();
  }
}

// Moves a job to a terminal status and frees the lock in one transaction, so the
// lock can never outlive the job that owns it.
async function releaseJob(
  documents: DynamoDBDocumentClient,
  jobsTable: string,
  jobId: string,
  status: Extract<JobStatus, "completed" | "failed">,
): Promise<Job | null> {
  const finishedAt = new Date().toISOString();
  try {
    await documents.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: jobsTable,
              Key: { pk: LOCK_KEY },
              ConditionExpression: "attribute_not_exists(pk) OR active_job_id = :jobPk",
              ExpressionAttributeValues: { ":jobPk": jobPk(jobId) },
            },
          },
          {
            Update: {
              TableName: jobsTable,
              Key: jobKey(jobId),
              UpdateExpression: "SET #status = :status, finished_at = :now, updated_at = :now",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": status,
                ":now": finishedAt,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    console.error("Job lock could not be released", error);
    return null;
  }

  const stored = await documents.send(
    new GetCommand({ TableName: jobsTable, Key: jobKey(jobId), ConsistentRead: true }),
  );
  return toJob(stored.Item);
}

async function terminateOrchestrator(ec2: EC2Client, instanceId: string) {
  try {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  } catch (error) {
    if (error instanceof Error && error.name === "InvalidInstanceID.NotFound") {
      return;
    }
    console.error(`Orchestrator ${instanceId} could not be terminated`, error);
  }
}
