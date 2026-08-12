import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import { parseTelemetrySummary } from "@/lib/agent-telemetry";
import type {
  JobMonitorSnapshot,
  MonitoredSubagent,
  MonitoredSubagentStatus,
  OrchestratorProgress,
} from "@/lib/job-monitor";
import {
  DEFAULT_JOB_TYPE,
  isJobType,
  JOB_ID_PATTERN,
} from "@/lib/jobs";
import type { Job, JobStatus } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_ID_PATTERN = /^agent-[0-9a-f]{24}$/;
const TERMINAL_EC2_STATES = new Set(["shutting-down", "stopped", "terminated"]);
const JOB_STATUSES: JobStatus[] = ["initializing", "running", "completed", "failed"];

type JobItem = {
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

type AgentItem = Record<string, unknown> & {
  agent_id?: unknown;
  state?: unknown;
  active?: unknown;
  instance_id?: unknown;
  created_at?: unknown;
  launched_at?: unknown;
  terminated_at?: unknown;
  failure_reason?: unknown;
  task_s3_uri?: unknown;
};

type AgentArtifacts = {
  inputKey: string | null;
  completedStatusKey: string | null;
  failedStatusKey: string | null;
  telemetryLatestKey: string | null;
};

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
  const stateTable = process.env.STATE_TABLE_NAME;
  const workspaceBucket = process.env.AGENT_WORKSPACE_BUCKET_NAME;
  if (!jobsTable || !stateTable || !workspaceBucket) {
    return null;
  }
  return { jobsTable, stateTable, workspaceBucket };
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
    typeOfJob: isJobType(record.type_of_job) ? record.type_of_job : DEFAULT_JOB_TYPE,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: typeof record.updated_at === "string" ? record.updated_at : record.created_at,
    orchestratorInstanceId:
      typeof record.orchestrator_instance_id === "string"
        ? record.orchestrator_instance_id
        : null,
    launchedAt: typeof record.launched_at === "string" ? record.launched_at : null,
    finishedAt: typeof record.finished_at === "string" ? record.finished_at : null,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isNotFound(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === "NoSuchKey" ||
    candidate.name === "NotFound" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function readJsonObject(
  s3: S3Client,
  bucket: string,
  key: string | null,
): Promise<Record<string, unknown> | null> {
  if (!key) {
    return null;
  }
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await response.Body?.transformToString();
    if (!text) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function listAgentObjectKeys(s3: S3Client, bucket: string, jobId: string) {
  const keys: string[] = [];
  const prefix = `jobs/${jobId}/agents/`;
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key) {
        keys.push(object.Key);
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function queryAgentItems(
  documents: DynamoDBDocumentClient,
  stateTable: string,
  orchestratorInstanceId: string | null,
) {
  if (!orchestratorInstanceId) {
    return [];
  }
  const items: AgentItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await documents.send(
      new QueryCommand({
        TableName: stateTable,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :agentPrefix)",
        ExpressionAttributeValues: {
          ":pk": `ORCHESTRATOR#${orchestratorInstanceId}`,
          ":agentPrefix": "AGENT#",
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }),
    );
    items.push(...((page.Items ?? []) as AgentItem[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

function collectArtifacts(jobId: string, keys: string[]) {
  const byAgent = new Map<string, AgentArtifacts>();
  const prefix = `jobs/${jobId}/agents/`;
  for (const key of keys) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const [agentId, ...parts] = key.slice(prefix.length).split("/");
    if (!AGENT_ID_PATTERN.test(agentId)) {
      continue;
    }
    const relative = parts.join("/");
    if (
      ![
        "input.json",
        "status/completed.json",
        "status/failed.json",
        "telemetry/latest.json",
      ].includes(relative)
    ) {
      continue;
    }
    const artifacts = byAgent.get(agentId) ?? {
      inputKey: null,
      completedStatusKey: null,
      failedStatusKey: null,
      telemetryLatestKey: null,
    };
    if (relative === "input.json") {
      artifacts.inputKey = key;
    } else if (relative === "status/completed.json") {
      artifacts.completedStatusKey = key;
    } else if (relative === "status/failed.json") {
      artifacts.failedStatusKey = key;
    } else {
      artifacts.telemetryLatestKey = key;
    }
    byAgent.set(agentId, artifacts);
  }
  return byAgent;
}

function taskKeyFromUri(uri: unknown, bucket: string) {
  if (typeof uri !== "string") {
    return null;
  }
  const prefix = `s3://${bucket}/`;
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
}

function mapSubagentStatus(
  state: unknown,
  artifacts: AgentArtifacts,
): MonitoredSubagentStatus {
  if (artifacts.failedStatusKey) {
    return "failed";
  }
  if (artifacts.completedStatusKey) {
    return "completed";
  }
  switch (state) {
    case "PROVISIONING":
      return "provisioning";
    case "RUNNING":
      return "running";
    case "LAUNCH_FAILED":
      return "failed";
    case "LAUNCH_OUTCOME_UNKNOWN":
      return "unknown";
    case "TERMINATED":
      return "terminated";
    default:
      return "queued";
  }
}

async function buildSubagents(
  s3: S3Client,
  bucket: string,
  artifactsByAgent: Map<string, AgentArtifacts>,
  agentItems: AgentItem[],
) {
  const itemByAgent = new Map<string, AgentItem>();
  for (const item of agentItems) {
    const agentId = stringValue(item.agent_id);
    if (agentId && AGENT_ID_PATTERN.test(agentId)) {
      itemByAgent.set(agentId, item);
      const artifacts = artifactsByAgent.get(agentId) ?? {
        inputKey: taskKeyFromUri(item.task_s3_uri, bucket),
        completedStatusKey: null,
        failedStatusKey: null,
        telemetryLatestKey: null,
      };
      artifactsByAgent.set(agentId, artifacts);
    }
  }

  const subagents = await Promise.all(
    [...artifactsByAgent.entries()].map(async ([agentId, artifacts]) => {
      const item = itemByAgent.get(agentId);
      const [input, failure, telemetry] = await Promise.all([
        readJsonObject(s3, bucket, artifacts.inputKey),
        readJsonObject(s3, bucket, artifacts.failedStatusKey),
        readJsonObject(s3, bucket, artifacts.telemetryLatestKey),
      ]);
      const status = mapSubagentStatus(item?.state, artifacts);
      const result: MonitoredSubagent = {
        agentId,
        task: stringValue(input?.task) ?? "Task details unavailable",
        status,
        instanceId: stringValue(item?.instance_id),
        active: item?.active === true,
        createdAt: stringValue(item?.created_at) ?? stringValue(input?.created_at),
        launchedAt: stringValue(item?.launched_at),
        terminatedAt: stringValue(item?.terminated_at),
        error: stringValue(failure?.error) ?? stringValue(item?.failure_reason),
        telemetry: parseTelemetrySummary(telemetry),
      };
      return result;
    }),
  );

  return subagents.sort((left, right) => {
    const leftTime = left.createdAt ?? "";
    const rightTime = right.createdAt ?? "";
    return leftTime.localeCompare(rightTime) || left.agentId.localeCompare(right.agentId);
  });
}

async function describeOrchestrator(ec2: EC2Client, instanceId: string | null) {
  if (!instanceId) {
    return null;
  }
  try {
    const response = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    return response.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "InvalidInstanceID.NotFound"
    ) {
      // EC2 can be briefly eventually consistent immediately after RunInstances.
      return null;
    }
    throw error;
  }
}

function progressFor(
  job: Job,
  ec2State: string | null,
  hasSubagentInput: boolean,
  codexStartedAt: string | null,
): { progress: OrchestratorProgress; isTerminal: boolean; stoppedUnexpectedly: boolean } {
  const jobFinished = job.status === "completed" || job.status === "failed";
  const stoppedUnexpectedly =
    !jobFinished && ec2State !== null && TERMINAL_EC2_STATES.has(ec2State);
  if (jobFinished || stoppedUnexpectedly) {
    return { progress: "done", isTerminal: true, stoppedUnexpectedly };
  }
  if (hasSubagentInput) {
    return {
      progress: "coordinating_subagents",
      isTerminal: false,
      stoppedUnexpectedly: false,
    };
  }
  if (codexStartedAt) {
    return { progress: "making_plan", isTerminal: false, stoppedUnexpectedly: false };
  }
  return {
    progress: "launching_orchestrator",
    isTerminal: false,
    stoppedUnexpectedly: false,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  if (!JOB_ID_PATTERN.test(jobId)) {
    return errorResponse("A valid job ID is required.", 400);
  }
  const config = configuration();
  if (!config) {
    return errorResponse(
      "The admin server is missing JOBS_TABLE_NAME, STATE_TABLE_NAME, or AGENT_WORKSPACE_BUCKET_NAME.",
      503,
    );
  }

  const dynamo = new DynamoDBClient(awsClientOptions());
  const documents = DynamoDBDocumentClient.from(dynamo, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client(awsClientOptions());
  const ec2 = new EC2Client(awsClientOptions());

  try {
    const stored = await documents.send(
      new GetCommand({
        TableName: config.jobsTable,
        Key: { pk: `JOB#${jobId}` },
        ConsistentRead: true,
      }),
    );
    const job = toJob(stored.Item);
    if (!job) {
      return errorResponse("That job does not exist.", 404);
    }
    if (job.typeOfJob !== "data_mining") {
      return errorResponse("That job type does not use the data-mining monitor.", 409);
    }

    const [ec2State, objectKeys, agentItems, orchestratorTelemetryRecord] = await Promise.all([
      describeOrchestrator(ec2, job.orchestratorInstanceId),
      listAgentObjectKeys(s3, config.workspaceBucket, jobId),
      queryAgentItems(documents, config.stateTable, job.orchestratorInstanceId),
      readJsonObject(
        s3,
        config.workspaceBucket,
        `jobs/${jobId}/orchestrator/telemetry/latest.json`,
      ),
    ]);
    const artifacts = collectArtifacts(jobId, objectKeys);
    const orchestratorTelemetry = parseTelemetrySummary(orchestratorTelemetryRecord);
    const subagents = await buildSubagents(
      s3,
      config.workspaceBucket,
      artifacts,
      agentItems,
    );
    const progress = progressFor(
      job,
      ec2State,
      [...artifacts.values()].some((item) => item.inputKey !== null),
      orchestratorTelemetry?.codexStartedAt ?? null,
    );

    let orchestratorError: string | null = null;
    if (job.status === "failed") {
      const failure = await readJsonObject(
        s3,
        config.workspaceBucket,
        `jobs/${jobId}/orchestrator/status/failed.json`,
      );
      orchestratorError =
        stringValue(failure?.error) ?? "The orchestrator ended before completing the job.";
    } else if (progress.stoppedUnexpectedly) {
      orchestratorError =
        "The orchestrator instance stopped while the job record was still active.";
    }

    const snapshot: JobMonitorSnapshot = {
      job,
      progress: progress.progress,
      orchestratorEc2State: ec2State,
      orchestratorError,
      orchestratorTelemetry,
      isTerminal: progress.isTerminal,
      subagents,
    };
    return json(snapshot);
  } catch (error) {
    console.error(`Job monitor read failed for ${jobId}`, error);
    return errorResponse(
      error instanceof Error ? error.message : "The job monitor could not be read.",
      502,
    );
  } finally {
    documents.destroy();
    dynamo.destroy();
    s3.destroy();
    ec2.destroy();
  }
}
