import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import type { AgentTelemetryResponse } from "@/lib/agent-telemetry";
import { DEFAULT_JOB_TYPE, isJobType, JOB_ID_PATTERN } from "@/lib/jobs";
import {
  controlPlaneEvent,
  mergeTelemetryEvents,
  readAgentTelemetry,
  readOptionalS3Text,
} from "@/lib/telemetry-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const AGENT_ID_PATTERN = /^agent-[0-9a-f]{24}$/;

function response(data: unknown, init?: ResponseInit) {
  const result = NextResponse.json(data, init);
  result.headers.set("Cache-Control", "no-store");
  return result;
}

function errorFromStatus(text: string | null) {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && "error" in parsed &&
      typeof parsed.error === "string"
      ? parsed.error
      : null;
  } catch {
    return null;
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string; agentId: string }> },
) {
  const { jobId, agentId } = await context.params;
  if (!JOB_ID_PATTERN.test(jobId) || !AGENT_ID_PATTERN.test(agentId)) {
    return response({ error: "Valid job and agent IDs are required." }, { status: 400 });
  }
  const jobsTable = process.env.JOBS_TABLE_NAME;
  const stateTable = process.env.STATE_TABLE_NAME;
  const bucket = process.env.AGENT_WORKSPACE_BUCKET_NAME;
  if (!jobsTable || !stateTable || !bucket) {
    return response({ error: "The admin server telemetry configuration is incomplete." }, { status: 503 });
  }

  const dynamo = new DynamoDBClient(awsClientOptions());
  const documents = DynamoDBDocumentClient.from(dynamo);
  const s3 = new S3Client(awsClientOptions());
  try {
    const jobResult = await documents.send(
      new GetCommand({
        TableName: jobsTable,
        Key: { pk: `JOB#${jobId}` },
        ConsistentRead: true,
      }),
    );
    const job = jobResult.Item;
    if (!job || job.job_id !== jobId) {
      return response({ error: "That job does not exist." }, { status: 404 });
    }
    const jobType = isJobType(job.type_of_job) ? job.type_of_job : DEFAULT_JOB_TYPE;
    if (jobType !== "data_mining") {
      return response({ error: "That job type does not use agent telemetry." }, { status: 409 });
    }
    if (typeof job.orchestrator_instance_id !== "string") {
      return response({ error: "That job has no orchestrator instance." }, { status: 404 });
    }

    const prefix = `jobs/${jobId}/agents/${agentId}`;
    const [agentResult, inputText, completedStatus, failedStatus, telemetry] = await Promise.all([
      documents.send(
        new GetCommand({
          TableName: stateTable,
          Key: {
            pk: `ORCHESTRATOR#${job.orchestrator_instance_id}`,
            sk: `AGENT#${agentId}`,
          },
          ConsistentRead: true,
        }),
      ),
      readOptionalS3Text(s3, bucket, `${prefix}/input.json`),
      readOptionalS3Text(s3, bucket, `${prefix}/status/completed.json`),
      readOptionalS3Text(s3, bucket, `${prefix}/status/failed.json`),
      readAgentTelemetry(s3, bucket, `${prefix}/telemetry`),
    ]);
    let input: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = inputText ? JSON.parse(inputText) : null;
      input = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      input = null;
    }
    const agent = agentResult.Item;
    if (!agent && !input) {
      return response({ error: "That subagent does not exist for this job." }, { status: 404 });
    }
    const state = typeof agent?.state === "string" ? agent.state : "UNKNOWN";
    const status = failedStatus
      ? "failed"
      : completedStatus
        ? "completed"
        : state.toLowerCase();
    const terminal = Boolean(completedStatus || failedStatus) ||
      ["TERMINATED", "LAUNCH_FAILED", "LAUNCH_OUTCOME_UNKNOWN"].includes(state);
    const payload: AgentTelemetryResponse = {
      actorType: "subagent",
      agentId,
      task: typeof input?.task === "string" ? input.task : "Task unavailable",
      status,
      error: errorFromStatus(failedStatus) ??
        (typeof agent?.failure_reason === "string" ? agent.failure_reason : null),
      isTerminal: terminal || job.status === "completed" || job.status === "failed",
      telemetry: telemetry.telemetry,
      events: mergeTelemetryEvents(telemetry.events, [
        controlPlaneEvent(input?.created_at ?? agent?.created_at, "subagent_created", "subagent task accepted"),
        controlPlaneEvent(agent?.launched_at, "instance_launched", "subagent EC2 instance launched"),
        controlPlaneEvent(agent?.terminated_at, "instance_terminated", "subagent EC2 instance terminated"),
      ]),
    };
    return response(payload);
  } catch (error) {
    console.error(`Subagent telemetry read failed for ${jobId}/${agentId}`, error);
    return response(
      { error: error instanceof Error ? error.message : "Telemetry could not be read." },
      { status: 502 },
    );
  } finally {
    documents.destroy();
    dynamo.destroy();
    s3.destroy();
  }
}
