import { S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { awsClientOptions } from "@/lib/aws";
import { listProjectDirectory } from "@/lib/project-storage";
import { validProjectDirectory } from "@/lib/project-uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ project: string }> }) {
  const { project } = await context.params;
  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!validProjectDirectory(project, path)) return json({ error: "Invalid project directory." }, 400);
  const bucket = process.env.GLOBAL_MEMORY_BUCKET_NAME;
  if (!bucket) return json({ error: "The admin server is missing GLOBAL_MEMORY_BUCKET_NAME." }, 503);
  const s3 = new S3Client(awsClientOptions());
  try { return json({ entries: await listProjectDirectory(s3, bucket, project, path) }); }
  catch { return json({ error: "Unable to list this folder. Check storage access and try again." }, 502); }
  finally { s3.destroy(); }
}
