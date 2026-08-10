import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PREVIEW_LIMIT = 100;

const RESOURCE_CONFIG = {
  "agent-workspace": {
    kind: "s3",
    label: "Agent Workspace",
    environmentVariable: "AGENT_WORKSPACE_BUCKET_NAME",
  },
  audit: {
    kind: "s3",
    label: "Audit",
    environmentVariable: "AUDIT_BUCKET_NAME",
  },
  "global-memory": {
    kind: "s3",
    label: "Global Memory",
    environmentVariable: "GLOBAL_MEMORY_BUCKET_NAME",
  },
  jobs: {
    kind: "dynamodb",
    label: "Jobs",
    environmentVariable: "JOBS_TABLE_NAME",
  },
  state: {
    kind: "dynamodb",
    label: "State",
    environmentVariable: "STATE_TABLE_NAME",
  },
} as const;

type ResourceId = keyof typeof RESOURCE_CONFIG;

function json(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function errorResponse(error: string, status: number) {
  return json({ error }, { status });
}

function isResourceId(value: string | null): value is ResourceId {
  return value !== null && Object.hasOwn(RESOURCE_CONFIG, value);
}

function normalizeForJson(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (value instanceof Set) {
    return Array.from(value, normalizeForJson);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeForJson(nestedValue)]),
    );
  }
  return value;
}

async function inspectBucket(id: ResourceId, label: string, bucketName: string) {
  const s3 = new S3Client(awsClientOptions());
  try {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        MaxKeys: PREVIEW_LIMIT,
      }),
    );
    return json({
      id,
      kind: "s3",
      label,
      name: bucketName,
      objects: (page.Contents ?? []).map((object) => ({
        key: object.Key ?? "",
        size: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString() ?? null,
        storageClass: object.StorageClass ?? null,
      })),
      isTruncated: page.IsTruncated === true,
      limit: PREVIEW_LIMIT,
    });
  } finally {
    s3.destroy();
  }
}

async function inspectTable(id: ResourceId, label: string, tableName: string) {
  const dynamo = new DynamoDBClient(awsClientOptions());
  const documents = DynamoDBDocumentClient.from(dynamo, {
    marshallOptions: { removeUndefinedValues: true },
  });
  try {
    const page = await documents.send(
      new ScanCommand({
        TableName: tableName,
        Limit: PREVIEW_LIMIT,
      }),
    );
    return json({
      id,
      kind: "dynamodb",
      label,
      name: tableName,
      items: normalizeForJson(page.Items ?? []),
      isTruncated: page.LastEvaluatedKey !== undefined,
      limit: PREVIEW_LIMIT,
    });
  } finally {
    documents.destroy();
  }
}

export async function GET(request: Request) {
  const resourceId = new URL(request.url).searchParams.get("resource");
  if (!isResourceId(resourceId)) {
    return errorResponse("Select one of the configured database resources.", 400);
  }

  const config = RESOURCE_CONFIG[resourceId];
  const resourceName = process.env[config.environmentVariable];
  if (!resourceName) {
    return errorResponse(
      `The admin server is missing ${config.environmentVariable}.`,
      503,
    );
  }

  try {
    return config.kind === "s3"
      ? await inspectBucket(resourceId, config.label, resourceName)
      : await inspectTable(resourceId, config.label, resourceName);
  } catch (error) {
    console.error(`${config.label} inspection failed`, error);
    return errorResponse(
      error instanceof Error ? error.message : `${config.label} could not be read.`,
      502,
    );
  }
}
