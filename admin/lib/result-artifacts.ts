export type ResultArtifactKind = "file" | "folder";

export type ResultArtifact = {
  id: string;
  kind: ResultArtifactKind;
  name: string;
  path: string;
  size: number | null;
  lastModified: string | null;
};

export type ResultArtifactsResponse = {
  artifacts: ResultArtifact[];
};

function isArtifact(value: unknown): value is ResultArtifact {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "kind" in value &&
    (value.kind === "file" || value.kind === "folder") &&
    "name" in value &&
    typeof value.name === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    "size" in value &&
    (value.size === null || (typeof value.size === "number" && Number.isFinite(value.size))) &&
    "lastModified" in value &&
    (value.lastModified === null || typeof value.lastModified === "string")
  );
}

export function isResultArtifactsResponse(value: unknown): value is ResultArtifactsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "artifacts" in value &&
    Array.isArray(value.artifacts) &&
    value.artifacts.every(isArtifact)
  );
}
