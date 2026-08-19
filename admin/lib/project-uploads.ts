export type ProjectSummary = {
  name: string;
};

export type ProjectsResponse = {
  projects: ProjectSummary[];
};

export type ProjectUploadResponse = {
  projectName: string;
  uploadedCount: number;
};

function isProjectSummary(value: unknown): value is ProjectSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  );
}

export function isProjectsResponse(value: unknown): value is ProjectsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "projects" in value &&
    Array.isArray(value.projects) &&
    value.projects.every(isProjectSummary)
  );
}

export function isProjectUploadResponse(value: unknown): value is ProjectUploadResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "projectName" in value &&
    typeof value.projectName === "string" &&
    "uploadedCount" in value &&
    typeof value.uploadedCount === "number" &&
    Number.isInteger(value.uploadedCount) &&
    value.uploadedCount >= 0
  );
}
