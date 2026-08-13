import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import { validateDataMiningResult } from "@/lib/data-mining-result";
import { DEFAULT_JOB_TYPE, isJobType, JOB_ID_PATTERN } from "@/lib/jobs";

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
      return errorResponse("That job type does not publish a data-mining result.", 409);
    }
    if (stored.Item.status !== "completed" && stored.Item.status !== "failed") {
      return errorResponse("The final result is available only after the job has ended.", 409);
    }

    const key = `jobs/${jobId}/result/final_result.json`;
    let object;
    try {
      object = await s3.send(
        new GetObjectCommand({ Bucket: workspaceBucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return errorResponse(
          "This saved job did not publish a final_result.json file.",
          404,
        );
      }
      throw error;
    }

    const body = await object.Body?.transformToString();
    if (!body?.trim()) {
      return errorResponse("The published final_result.json file is empty.", 422);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return errorResponse("The published final_result.json file is not valid JSON.", 422);
    }
    const validation = validateDataMiningResult(parsed);
    return validation.valid
      ? json({ view: "database", result: validation.result })
      : json({ view: "json", result: parsed, schemaError: validation.error });
  } catch (error) {
    console.error(`Final result read failed for ${jobId}`, error);
    return errorResponse(
      error instanceof Error ? error.message : "The final result could not be read.",
      502,
    );
  } finally {
    documents.destroy();
    dynamo.destroy();
    s3.destroy();
  }
}
