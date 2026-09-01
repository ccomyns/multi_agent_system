export type ProjectSummary = {
  name: string;
};

export const PROJECT_NAME_MAX_LENGTH = 80;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 240;

export type ProjectsResponse = {
  projects: ProjectSummary[];
};

export type CreateProjectResponse = {
  project: ProjectSummary;
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

export function projectNameError(value: string) {
  const name = value.trim();
  if (!name || name.length > PROJECT_NAME_MAX_LENGTH) {
    return `Project names must contain between 1 and ${PROJECT_NAME_MAX_LENGTH} characters.`;
  }
  if (
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9_.:=+@ -]+$/u.test(name)
  ) {
    return "Project names may contain only letters, numbers, spaces, periods, underscores, colons, equals signs, plus signs, hyphens, and @ signs.";
  }
  return null;
}

export function projectDescriptionError(value: string) {
  return value.trim().length > PROJECT_DESCRIPTION_MAX_LENGTH
    ? `Project descriptions cannot exceed ${PROJECT_DESCRIPTION_MAX_LENGTH} characters.`
    : null;
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

export function isCreateProjectResponse(
  value: unknown,
): value is CreateProjectResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "project" in value &&
    isProjectSummary(value.project)
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
