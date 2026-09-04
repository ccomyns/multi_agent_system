import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import type { AgentTelemetryResponse } from "@/lib/agent-telemetry";
import {
  DEFAULT_JOB_TYPE,
  isJobType,
  JOB_ID_PATTERN,
  parsePublishedWebsite,
} from "@/lib/jobs";
import {
  controlPlaneEvent,
  mergeTelemetryEvents,
  readAgentTelemetry,
} from "@/lib/telemetry-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(data: unknown, init?: ResponseInit) {
  const result = NextResponse.json(data, init);
  result.headers.set("Cache-Control", "no-store");
  return result;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  if (!JOB_ID_PATTERN.test(jobId)) {
    return response({ error: "A valid job ID is required." }, { status: 400 });
  }
  const jobsTable = process.env.JOBS_TABLE_NAME;
  const bucket = process.env.AGENT_WORKSPACE_BUCKET_NAME;
  if (!jobsTable || !bucket) {
    return response({ error: "The admin server telemetry configuration is incomplete." }, { status: 503 });
  }

  const dynamo = new DynamoDBClient(awsClientOptions());
  const documents = DynamoDBDocumentClient.from(dynamo);
  const s3 = new S3Client(awsClientOptions());
  try {
    const stored = await documents.send(
      new GetCommand({
        TableName: jobsTable,
        Key: { pk: `JOB#${jobId}` },
        ConsistentRead: true,
      }),
    );
    const job = stored.Item;
    if (!job || job.job_id !== jobId) {
      return response({ error: "That job does not exist." }, { status: 404 });
    }
    const jobType = isJobType(job.type_of_job) ? job.type_of_job : DEFAULT_JOB_TYPE;

    const telemetry = await readAgentTelemetry(
      s3,
      bucket,
      `jobs/${jobId}/orchestrator/telemetry`,
    );
    const terminal = job.status === "completed" || job.status === "failed";
    const payload: AgentTelemetryResponse = {
      actorType: "orchestrator",
      agentId: null,
      jobType,
      publishedWebsite: parsePublishedWebsite(job.published_website),
      task: typeof job.original_task === "string" ? job.original_task : "Task unavailable",
      status: typeof job.status === "string" ? job.status : "unknown",
      isTerminal: terminal,
      telemetry: telemetry.telemetry,
      events: mergeTelemetryEvents(telemetry.events, [
        controlPlaneEvent(job.created_at, "job_created", "job accepted by the control plane"),
        controlPlaneEvent(job.launched_at, "instance_launched", "orchestrator EC2 instance launched"),
        controlPlaneEvent(job.finished_at, "job_finished", `job marked ${String(job.status)}`),
      ]),
    };
    return response(payload);
  } catch (error) {
    console.error(`Orchestrator telemetry read failed for ${jobId}`, error);
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
