export const GITHUB_REPOSITORY_NAME_MAX_LENGTH = 100;
export const GITHUB_REPOSITORY_DESCRIPTION_MAX_LENGTH = 350;

export type GitHubRepositoryVisibility = "private" | "public" | "internal";

export interface GitHubRepositorySummary {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  visibility: GitHubRepositoryVisibility;
  htmlUrl: string;
  defaultBranch: string | null;
}

export interface GitHubRepositoriesResponse {
  organization: string;
  repositories: GitHubRepositorySummary[];
}

export interface CreateGitHubRepositoryResponse {
  organization: string;
  repository: GitHubRepositorySummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function repositoryNameError(value: string) {
  const name = value.trim();
  if (!name) return "Enter a repository name.";
  if (name.length > GITHUB_REPOSITORY_NAME_MAX_LENGTH) {
    return `Repository names must be ${GITHUB_REPOSITORY_NAME_MAX_LENGTH} characters or fewer.`;
  }
  if (name === "." || name === ".." || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return "Use only letters, numbers, periods, hyphens, and underscores.";
  }
  return null;
}

export function isGitHubRepositorySummary(
  value: unknown,
): value is GitHubRepositorySummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    typeof value.name === "string" &&
    typeof value.fullName === "string" &&
    (value.description === null || typeof value.description === "string") &&
    (value.visibility === "private" ||
      value.visibility === "public" ||
      value.visibility === "internal") &&
    typeof value.htmlUrl === "string" &&
    (value.defaultBranch === null || typeof value.defaultBranch === "string")
  );
}

export function isGitHubRepositoriesResponse(
  value: unknown,
): value is GitHubRepositoriesResponse {
  return (
    isRecord(value) &&
    typeof value.organization === "string" &&
    Array.isArray(value.repositories) &&
    value.repositories.every(isGitHubRepositorySummary)
  );
}

export function isCreateGitHubRepositoryResponse(
  value: unknown,
): value is CreateGitHubRepositoryResponse {
  return (
    isRecord(value) &&
    typeof value.organization === "string" &&
    isGitHubRepositorySummary(value.repository)
  );
}
