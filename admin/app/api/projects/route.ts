import { S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { awsClientOptions } from "@/lib/aws";
import { listRootProjects } from "@/lib/project-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
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
