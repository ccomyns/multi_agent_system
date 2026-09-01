import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import { listRootProjects } from "@/lib/project-storage";
import {
  projectDescriptionError,
  projectNameError,
} from "@/lib/project-uploads";

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

type CreateProjectRequest = {
  description: string;
  name: string;
};

function parseCreateProjectRequest(value: unknown): CreateProjectRequest | string {
  if (typeof value !== "object" || value === null) {
    return "The project request must be a JSON object.";
  }

  const name = "name" in value && typeof value.name === "string"
    ? value.name.trim()
    : "";
  const invalidName = projectNameError(name);
  if (invalidName) return invalidName;

  const description = "description" in value && typeof value.description === "string"
    ? value.description.trim()
    : "";
  const invalidDescription = projectDescriptionError(description);
  if (invalidDescription) return invalidDescription;

  return { description, name };
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

export async function GET() {
  const globalMemoryBucket = process.env.GLOBAL_MEMORY_BUCKET_NAME;
  if (!globalMemoryBucket) {
    return json(
      { error: "The admin server is missing GLOBAL_MEMORY_BUCKET_NAME." },
      { status: 503 },
    );
  }

  const s3 = new S3Client(awsClientOptions());
  try {
    return json({ projects: await listRootProjects(s3, globalMemoryBucket) });
  } catch (error) {
    console.error("Software Builder project listing failed", error);
    return json(
      {
        error: error instanceof Error ? error.message : "Projects could not be listed.",
      },
      { status: 502 },
    );
  } finally {
    s3.destroy();
  }
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("The project request must contain valid JSON.", 400);
  }

  const parsed = parseCreateProjectRequest(payload);
  if (typeof parsed === "string") return errorResponse(parsed, 400);

  const globalMemoryBucket = process.env.GLOBAL_MEMORY_BUCKET_NAME;
  if (!globalMemoryBucket) {
    return errorResponse(
      "The admin server is missing GLOBAL_MEMORY_BUCKET_NAME.",
      503,
    );
  }

  const s3 = new S3Client(awsClientOptions());
  try {
    const existing = await s3.send(
      new ListObjectsV2Command({
        Bucket: globalMemoryBucket,
        Prefix: `${parsed.name}/`,
        MaxKeys: 1,
      }),
    );
    if ((existing.KeyCount ?? existing.Contents?.length ?? 0) > 0) {
      return errorResponse("A project with that name already exists.", 409);
    }

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: globalMemoryBucket,
          Key: `${parsed.name}/`,
          Body: "",
          ContentType: "application/x-directory",
          IfNoneMatch: "*",
          ServerSideEncryption: "AES256",
        }),
      );
    } catch (error) {
      if (isPreconditionFailure(error)) {
        return errorResponse("A project with that name already exists.", 409);
      }
      throw error;
    }

    if (parsed.description) {
      await s3.send(
        new PutObjectCommand({
          Bucket: globalMemoryBucket,
          Key: `${parsed.name}/description.md`,
          Body: `${parsed.description}\n`,
          ContentType: "text/markdown; charset=utf-8",
          IfNoneMatch: "*",
          ServerSideEncryption: "AES256",
        }),
      );
    }

    return json({ project: { name: parsed.name } }, { status: 201 });
  } catch (error) {
    console.error("Software Builder project creation failed", error);
    return errorResponse(
      error instanceof Error ? error.message : "The project could not be created.",
      502,
    );
  } finally {
    s3.destroy();
  }
}
