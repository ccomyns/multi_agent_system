import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

import type { ProjectSummary } from "@/lib/project-uploads";

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
