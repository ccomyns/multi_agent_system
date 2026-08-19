import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import { DEFAULT_JOB_TYPE, isJobType, JOB_ID_PATTERN } from "@/lib/jobs";
import {
  listObjectsUnderPrefix,
  resultArtifacts,
} from "@/lib/result-artifact-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function errorResponse(error: string, status: number) {
  return json({ error }, { status });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  if (!JOB_ID_PATTERN.test(jobId)) {
    return errorResponse("A valid job ID is required.", 400);
  }

  const jobsTable = process.env.JOBS_TABLE_NAME;
  const workspaceBucket = process.env.AGENT_WORKSPACE_BUCKET_NAME;
  if (!jobsTable || !workspaceBucket) {
    return errorResponse(
      "The admin server is missing JOBS_TABLE_NAME or AGENT_WORKSPACE_BUCKET_NAME.",
      503,
    );
  }

  const dynamo = new DynamoDBClient(awsClientOptions());
  const documents = DynamoDBDocumentClient.from(dynamo, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client(awsClientOptions());

  try {
    const stored = await documents.send(
      new GetCommand({
        TableName: jobsTable,
        Key: { pk: `JOB#${jobId}` },
        ConsistentRead: true,
      }),
    );
    if (!stored.Item || stored.Item.job_id !== jobId) {
      return errorResponse("That job does not exist.", 404);
    }

    const jobType = isJobType(stored.Item.type_of_job)
      ? stored.Item.type_of_job
      : DEFAULT_JOB_TYPE;
    if (jobType !== "data_mining") {
      return errorResponse("That job type does not publish data-mining artifacts.", 409);
    }

    const prefix = `jobs/${jobId}/result/`;
    const objects = await listObjectsUnderPrefix(s3, workspaceBucket, prefix);
    return json({ artifacts: resultArtifacts(objects, prefix) });
  } catch (error) {
    console.error(`Result artifact listing failed for ${jobId}`, error);
    return errorResponse(
      error instanceof Error ? error.message : "The result artifacts could not be listed.",
      502,
    );
  } finally {
    documents.destroy();
    dynamo.destroy();
    s3.destroy();
  }
}
