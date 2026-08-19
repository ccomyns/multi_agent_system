import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CopyObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import { DEFAULT_JOB_TYPE, isJobType, JOB_ID_PATTERN } from "@/lib/jobs";
import {
  listObjectsUnderPrefix,
  selectResultObjects,
  type SelectedResultObject,
} from "@/lib/result-artifact-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COPY_CONCURRENCY = 10;
const MAX_SELECTED_ARTIFACTS = 5_000;

type UploadRequest = {
  artifactIds: string[];
  createProject: boolean;
  description: string;
  projectName: string;
};

function json(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function errorResponse(error: string, status: number) {
  return json({ error }, { status });
}

function parseUploadRequest(value: unknown): UploadRequest | string {
  if (typeof value !== "object" || value === null) {
    return "The upload request must be a JSON object.";
  }

  const projectName = "projectName" in value && typeof value.projectName === "string"
    ? value.projectName.trim()
    : "";
  if (!projectName || projectName.length > 80) {
    return "Project names must contain between 1 and 80 characters.";
  }
  if (
    projectName === "." ||
    projectName === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(projectName)
  ) {
    return "Project names cannot contain slashes, backslashes, or control characters.";
  }

  if (!("createProject" in value) || typeof value.createProject !== "boolean") {
    return "The upload request must specify whether the project is new.";
  }

  const description = "description" in value && typeof value.description === "string"
    ? value.description.trim()
    : "";
  if (description.length > 240) {
    return "Project descriptions cannot exceed 240 characters.";
  }

  if (!("artifactIds" in value) || !Array.isArray(value.artifactIds)) {
    return "Select at least one result file or folder to upload.";
  }
  const artifactIds = [...new Set(value.artifactIds)];
  if (
    artifactIds.length === 0 ||
    artifactIds.length > MAX_SELECTED_ARTIFACTS ||
    artifactIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 1_100)
  ) {
    return `Select between 1 and ${MAX_SELECTED_ARTIFACTS.toLocaleString()} valid result artifacts.`;
  }

  return {
    artifactIds: artifactIds as string[],
    createProject: value.createProject,
    description,
    projectName,
  };
}

async function dataMiningJobError(
  documents: DynamoDBDocumentClient,
  jobsTable: string,
  jobId: string,
) {
  const stored = await documents.send(
    new GetCommand({
      TableName: jobsTable,
      Key: { pk: `JOB#${jobId}` },
      ConsistentRead: true,
    }),
  );
  if (!stored.Item || stored.Item.job_id !== jobId) {
    return { error: "That job does not exist.", status: 404 };
  }

  const jobType = isJobType(stored.Item.type_of_job)
    ? stored.Item.type_of_job
    : DEFAULT_JOB_TYPE;
  return jobType === "data_mining"
    ? null
    : {
        error: "That job type does not publish data-mining artifacts.",
        status: 409,
      };
}

async function listRootProjects(s3: S3Client, bucket: string) {
  const projectNames = new Set<string>();
  let continuationToken: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Delimiter: "/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const commonPrefix of page.CommonPrefixes ?? []) {
      const name = commonPrefix.Prefix?.replace(/\/$/, "");
      if (name) projectNames.add(name);
    }

    const nextToken = page.NextContinuationToken;
    if (page.IsTruncated && !nextToken) {
      throw new Error("The project listing ended without a continuation token.");
    }
    if (nextToken && nextToken === continuationToken) {
      throw new Error("The project listing returned a repeated continuation token.");
    }
    continuationToken = nextToken;
  } while (continuationToken);

  return [...projectNames]
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map((name) => ({ name }));
}

async function projectExists(s3: S3Client, bucket: string, projectName: string) {
  const page = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: `${projectName}/`,
      MaxKeys: 1,
    }),
  );
  return (page.KeyCount ?? page.Contents?.length ?? 0) > 0;
}

function copySource(bucket: string, key: string) {
  return `${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function copySelectedObjects(
  s3: S3Client,
  sourceBucket: string,
  destinationBucket: string,
  projectName: string,
  selectedObjects: SelectedResultObject[],
) {
  for (let index = 0; index < selectedObjects.length; index += COPY_CONCURRENCY) {
    const batch = selectedObjects.slice(index, index + COPY_CONCURRENCY);
    await Promise.all(
      batch.map((object) =>
        s3.send(
          new CopyObjectCommand({
            Bucket: destinationBucket,
            CopySource: copySource(sourceBucket, object.sourceKey),
            Key: `${projectName}/${object.relativePath}`,
          }),
        ),
      ),
    );
  }
}

function isPreconditionFailure(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    error.$metadata.httpStatusCode === 412
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
  const globalMemoryBucket = process.env.GLOBAL_MEMORY_BUCKET_NAME;
  if (!jobsTable || !globalMemoryBucket) {
    return errorResponse(
      "The admin server is missing JOBS_TABLE_NAME or GLOBAL_MEMORY_BUCKET_NAME.",
      503,
    );
  }

  const dynamo = new DynamoDBClient(awsClientOptions());
  const documents = DynamoDBDocumentClient.from(dynamo, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client(awsClientOptions());

  try {
    const jobError = await dataMiningJobError(documents, jobsTable, jobId);
    if (jobError) return errorResponse(jobError.error, jobError.status);
    return json({ projects: await listRootProjects(s3, globalMemoryBucket) });
  } catch (error) {
    console.error(`Project listing failed for ${jobId}`, error);
    return errorResponse(
      error instanceof Error ? error.message : "Projects could not be listed.",
      502,
    );
  } finally {
    documents.destroy();
    dynamo.destroy();
    s3.destroy();
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  if (!JOB_ID_PATTERN.test(jobId)) {
    return errorResponse("A valid job ID is required.", 400);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("The upload request must contain valid JSON.", 400);
  }
  const parsed = parseUploadRequest(payload);
  if (typeof parsed === "string") return errorResponse(parsed, 400);

  const jobsTable = process.env.JOBS_TABLE_NAME;
  const workspaceBucket = process.env.AGENT_WORKSPACE_BUCKET_NAME;
  const globalMemoryBucket = process.env.GLOBAL_MEMORY_BUCKET_NAME;
  if (!jobsTable || !workspaceBucket || !globalMemoryBucket) {
    return errorResponse(
      "The admin server is missing JOBS_TABLE_NAME, AGENT_WORKSPACE_BUCKET_NAME, or GLOBAL_MEMORY_BUCKET_NAME.",
      503,
    );
  }

  const dynamo = new DynamoDBClient(awsClientOptions());
  const documents = DynamoDBDocumentClient.from(dynamo, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client(awsClientOptions());

  try {
    const jobError = await dataMiningJobError(documents, jobsTable, jobId);
    if (jobError) return errorResponse(jobError.error, jobError.status);

    const resultPrefix = `jobs/${jobId}/result/`;
    const sourceObjects = await listObjectsUnderPrefix(s3, workspaceBucket, resultPrefix);
    let selectedObjects: SelectedResultObject[];
    try {
      selectedObjects = selectResultObjects(sourceObjects, resultPrefix, parsed.artifactIds);
    } catch (error) {
      return errorResponse(
        error instanceof Error ? error.message : "The selected artifacts are no longer available.",
        409,
      );
    }

    const exists = await projectExists(s3, globalMemoryBucket, parsed.projectName);
    if (parsed.createProject && exists) {
      return errorResponse("A project with that name already exists.", 409);
    }
    if (!parsed.createProject && !exists) {
      return errorResponse("That project no longer exists. Refresh the project list.", 404);
    }

    if (parsed.createProject) {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: globalMemoryBucket,
            Key: `${parsed.projectName}/`,
            Body: "",
            ContentType: "application/x-directory",
            IfNoneMatch: "*",
            Metadata: parsed.description
              ? {
                  description: Buffer.from(parsed.description, "utf8").toString("base64"),
                  "description-encoding": "base64",
                }
              : undefined,
          }),
        );
      } catch (error) {
        if (isPreconditionFailure(error)) {
          return errorResponse("A project with that name already exists.", 409);
        }
        throw error;
      }
    }

    await copySelectedObjects(
      s3,
      workspaceBucket,
      globalMemoryBucket,
      parsed.projectName,
      selectedObjects,
    );
    return json({
      projectName: parsed.projectName,
      uploadedCount: selectedObjects.length,
    });
  } catch (error) {
    console.error(`Project upload failed for ${jobId}`, error);
    return errorResponse(
      error instanceof Error ? error.message : "The selected artifacts could not be uploaded.",
      502,
    );
  } finally {
    documents.destroy();
    dynamo.destroy();
    s3.destroy();
  }
}
