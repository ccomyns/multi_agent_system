import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

import { validProjectDirectory, type ProjectDirectoryEntry, type ProjectSummary } from "@/lib/project-uploads";

export async function listRootProjects(
  s3: S3Client,
  bucket: string,
): Promise<ProjectSummary[]> {
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

export async function listProjectDirectory(s3: S3Client, bucket: string, project: string, path: string) {
  if (!validProjectDirectory(project, path)) throw new Error("Invalid project directory.");
  const prefix = `${project}/${path}`;
  const entries = new Map<string, ProjectDirectoryEntry>();
  const seenTokens = new Set<string>();
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: token }));
    for (const folder of page.CommonPrefixes ?? []) {
      const key = folder.Prefix;
      if (!key?.startsWith(prefix) || key === prefix) continue;
      const name = key.slice(prefix.length).replace(/\/$/, "");
      if (!name || name.includes("/")) continue;
      entries.set(key, { name, path: key.slice(project.length + 1), kind: "folder", size: null, modifiedAt: null });
    }
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key?.startsWith(prefix) || key === prefix) continue;
      const name = key.slice(prefix.length);
      if (!name || name.includes("/")) continue;
      entries.set(key, { name, path: key.slice(project.length + 1), kind: "file", size: object.Size ?? 0, modifiedAt: object.LastModified?.toISOString() ?? null });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!token || seenTokens.has(token))) throw new Error("The directory listing could not be completed.");
    if (token) seenTokens.add(token);
  } while (token);
  return [...entries.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
