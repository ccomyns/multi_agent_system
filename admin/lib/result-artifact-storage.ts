import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

import type { ResultArtifact } from "@/lib/result-artifacts";

export type ListedResultObject = {
  Key?: string;
  Size?: number;
  LastModified?: Date;
};

export type SelectedResultObject = {
  sourceKey: string;
  relativePath: string;
};

export function resultArtifacts(objects: ListedResultObject[], prefix: string) {
  const folders = new Map<string, ResultArtifact>();
  const files: ResultArtifact[] = [];

  function addFolder(parts: string[], lastModified: string | null = null) {
    const path = `${parts.join("/")}/`;
    const existing = folders.get(path);
    folders.set(path, {
      id: `folder:${path}`,
      kind: "folder",
      name: parts.at(-1) ?? path,
      path,
      size: null,
      lastModified: lastModified ?? existing?.lastModified ?? null,
    });
  }

  for (const object of objects) {
    if (!object.Key?.startsWith(prefix)) continue;
    const relativePath = object.Key.slice(prefix.length).replace(/^\/+/, "");
    if (!relativePath) continue;

    const isFolder = relativePath.endsWith("/");
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    const folderCount = isFolder ? parts.length : parts.length - 1;
    for (let index = 1; index <= folderCount; index += 1) {
      addFolder(
        parts.slice(0, index),
        isFolder && index === parts.length
          ? object.LastModified?.toISOString() ?? null
          : null,
      );
    }

    if (!isFolder) {
      const path = parts.join("/");
      files.push({
        id: `file:${path}`,
        kind: "file",
        name: parts.at(-1) ?? path,
        path,
        size: object.Size ?? 0,
        lastModified: object.LastModified?.toISOString() ?? null,
      });
    }
  }

  return [...folders.values(), ...files].sort((left, right) =>
    left.path.localeCompare(right.path, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

export async function listObjectsUnderPrefix(
  s3: S3Client,
  bucket: string,
  prefix: string,
) {
  const objects: ListedResultObject[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    objects.push(...(page.Contents ?? []));

    const nextToken = page.NextContinuationToken;
    if (page.IsTruncated && !nextToken) {
      throw new Error("The result artifact listing ended without a continuation token.");
    }
    if (nextToken && nextToken === continuationToken) {
      throw new Error("The result artifact listing returned a repeated continuation token.");
    }
    continuationToken = nextToken;
  } while (continuationToken);

  return objects;
}

export function selectResultObjects(
  objects: ListedResultObject[],
  prefix: string,
  requestedArtifactIds: string[],
) {
  const availableArtifacts = new Map(
    resultArtifacts(objects, prefix).map((artifact) => [artifact.id, artifact]),
  );
  const requestedIds = [...new Set(requestedArtifactIds)];
  const unknownIds = requestedIds.filter((id) => !availableArtifacts.has(id));
  if (unknownIds.length > 0) {
    throw new Error("One or more selected result artifacts no longer exist.");
  }

  const availableObjects = objects.flatMap((object) => {
    if (!object.Key?.startsWith(prefix)) return [];
    const relativePath = object.Key.slice(prefix.length).replace(/^\/+/, "");
    return relativePath
      ? [{ sourceKey: object.Key, relativePath } satisfies SelectedResultObject]
      : [];
  });
  const selectedObjects = new Map<string, SelectedResultObject>();

  for (const artifactId of requestedIds) {
    const artifact = availableArtifacts.get(artifactId);
    if (!artifact) continue;

    for (const object of availableObjects) {
      const matches = artifact.kind === "folder"
        ? object.relativePath.startsWith(artifact.path)
        : object.relativePath === artifact.path;
      if (matches) selectedObjects.set(object.sourceKey, object);
    }
  }

  if (selectedObjects.size === 0) {
    throw new Error("None of the selected result artifacts contain uploadable objects.");
  }

  return [...selectedObjects.values()];
}
