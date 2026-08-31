import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  GitHubRepositorySummary,
  GitHubRepositoryVisibility,
} from "@/lib/github-repository-types";

const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "multi-agent-research-system-admin";

interface GitHubConfiguration {
  organization: string;
  issuer: string;
  privateKeyPath: string;
}

interface GitHubInstallation {
  id?: unknown;
}

interface GitHubInstallationToken {
  token?: unknown;
}

interface GitHubRepositoryResource {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  description?: unknown;
  private?: unknown;
  visibility?: unknown;
  html_url?: unknown;
  default_branch?: unknown;
}

interface GitHubErrorResource {
  message?: unknown;
  errors?: unknown;
}

type InstallationPermissions = {
  administration?: "write";
  metadata?: "read";
};

export class GitHubConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConfigurationError";
  }
}

export class GitHubApiError extends Error {
  readonly upstreamStatus: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.upstreamStatus = status;
  }
}

function configuration(): GitHubConfiguration {
  const organization = process.env.GITHUB_ORGANIZATION?.trim();
  const issuer =
    process.env.GITHUB_APP_CLIENT_ID?.trim() || process.env.GITHUB_APP_ID?.trim();
  const configuredPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();

  if (!organization) {
    throw new GitHubConfigurationError(
      "The admin server is missing GITHUB_ORGANIZATION.",
    );
  }
  if (!issuer) {
    throw new GitHubConfigurationError(
      "The admin server is missing GITHUB_APP_CLIENT_ID or GITHUB_APP_ID.",
    );
  }
  if (!configuredPath) {
    throw new GitHubConfigurationError(
      "The admin server is missing GITHUB_APP_PRIVATE_KEY_PATH.",
    );
  }
  if (!isAbsolute(configuredPath)) {
    throw new GitHubConfigurationError(
      "GITHUB_APP_PRIVATE_KEY_PATH must be an absolute path.",
    );
  }

  return {
    organization,
    issuer,
    privateKeyPath: configuredPath,
  };
}

function base64UrlJson(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function createAppJwt(config: GitHubConfiguration) {
  let privateKey: string;
  try {
    privateKey = await readFile(config.privateKeyPath, "utf8");
  } catch {
    throw new GitHubConfigurationError(
      "The GitHub App private key could not be read from GITHUB_APP_PRIVATE_KEY_PATH.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: config.issuer,
  });
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsignedToken);
    signer.end();
    const signature = signer.sign(privateKey, "base64url");
    return `${unsignedToken}.${signature}`;
  } catch {
    throw new GitHubConfigurationError(
      "The file at GITHUB_APP_PRIVATE_KEY_PATH is not a valid GitHub App private key.",
    );
  }
}

function githubErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload !== "object" || payload === null) return fallback;
  const githubError = payload as GitHubErrorResource;
  const message =
    typeof githubError.message === "string" ? githubError.message : fallback;

  if (!Array.isArray(githubError.errors)) return message;
  const details = githubError.errors
    .map((error) => {
      if (typeof error === "string") return error;
      if (typeof error !== "object" || error === null) return null;
      const record = error as Record<string, unknown>;
      return typeof record.message === "string"
        ? record.message
        : typeof record.code === "string"
          ? record.code.replaceAll("_", " ")
          : null;
    })
    .filter((detail): detail is string => Boolean(detail));

  return details.length > 0 ? `${message}: ${details.join(", ")}` : message;
}

async function githubJson<T>(
  path: string,
  authorization: string,
  init: Omit<RequestInit, "headers"> = {},
) {
  const response = await fetch(`${GITHUB_API_ROOT}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: authorization,
      "Content-Type": "application/json",
      "User-Agent": GITHUB_USER_AGENT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Some upstream failures have an empty or non-JSON body.
  }

  if (!response.ok) {
    throw new GitHubApiError(
      response.status,
      githubErrorMessage(payload, `GitHub request failed (${response.status}).`),
    );
  }

  return payload as T;
}

async function installationId(config: GitHubConfiguration, jwt: string) {
  const installation = await githubJson<GitHubInstallation>(
    `/orgs/${encodeURIComponent(config.organization)}/installation`,
    `Bearer ${jwt}`,
  );
  if (
    typeof installation.id !== "number" ||
    !Number.isSafeInteger(installation.id)
  ) {
    throw new GitHubApiError(
      502,
      "GitHub returned an invalid App installation response.",
    );
  }
  return installation.id;
}

async function installationToken(permissions: InstallationPermissions) {
  const config = configuration();
  const jwt = await createAppJwt(config);
  const id = await installationId(config, jwt);
  const response = await githubJson<GitHubInstallationToken>(
    `/app/installations/${id}/access_tokens`,
    `Bearer ${jwt}`,
    {
      method: "POST",
      body: JSON.stringify({ permissions }),
    },
  );
  if (typeof response.token !== "string" || response.token.length === 0) {
    throw new GitHubApiError(
      502,
      "GitHub returned an invalid installation token response.",
    );
  }
  return { config, token: response.token };
}

function repositorySummary(resource: GitHubRepositoryResource) {
  if (
    typeof resource.id !== "number" ||
    !Number.isSafeInteger(resource.id) ||
    typeof resource.name !== "string" ||
    typeof resource.full_name !== "string" ||
    typeof resource.html_url !== "string"
  ) {
    throw new GitHubApiError(502, "GitHub returned an invalid repository response.");
  }

  let visibility: GitHubRepositoryVisibility;
  if (
    resource.visibility === "private" ||
    resource.visibility === "public" ||
    resource.visibility === "internal"
  ) {
    visibility = resource.visibility;
  } else {
    visibility = resource.private === true ? "private" : "public";
  }

  return {
    id: resource.id,
    name: resource.name,
    fullName: resource.full_name,
    description:
      typeof resource.description === "string" ? resource.description : null,
    visibility,
    htmlUrl: resource.html_url,
    defaultBranch:
      typeof resource.default_branch === "string"
        ? resource.default_branch
        : null,
  } satisfies GitHubRepositorySummary;
}

export async function listOrganizationRepositories() {
  const { config, token } = await installationToken({ metadata: "read" });
  const repositories: GitHubRepositorySummary[] = [];

  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({
      type: "all",
      sort: "full_name",
      direction: "asc",
      per_page: "100",
      page: String(page),
    });
    const resources = await githubJson<GitHubRepositoryResource[]>(
      `/orgs/${encodeURIComponent(config.organization)}/repos?${query}`,
      `Bearer ${token}`,
    );
    if (!Array.isArray(resources)) {
      throw new GitHubApiError(502, "GitHub returned an invalid repository list.");
    }
    repositories.push(...resources.map(repositorySummary));
    if (resources.length < 100) break;
  }

  repositories.sort((left, right) => left.name.localeCompare(right.name));
  return { organization: config.organization, repositories };
}

export async function getOrganizationRepository(repositoryId: number) {
  const { config, token } = await installationToken({ metadata: "read" });
  const resource = await githubJson<GitHubRepositoryResource>(
    `/repositories/${repositoryId}`,
    `Bearer ${token}`,
  );
  const repository = repositorySummary(resource);
  const [owner] = repository.fullName.split("/", 1);
  if (owner.toLowerCase() !== config.organization.toLowerCase()) {
    throw new GitHubApiError(
      403,
      "The selected repository is outside the configured organization.",
    );
  }
  return repository;
}

export async function createOrganizationRepository(input: {
  name: string;
  description: string;
}) {
  const { config, token } = await installationToken({ administration: "write" });
  const resource = await githubJson<GitHubRepositoryResource>(
    `/orgs/${encodeURIComponent(config.organization)}/repos`,
    `Bearer ${token}`,
    {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        description: input.description || undefined,
        private: true,
        auto_init: true,
      }),
    },
  );
  return { organization: config.organization, repository: repositorySummary(resource) };
}
