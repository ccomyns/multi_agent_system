import { createSign } from "node:crypto";

const JOB_ID_PATTERN = /^job_[a-z0-9]{4,12}_[0-9a-f]{8}$/;
const INSTANCE_ID_PATTERN = /^i-[0-9a-f]{8,17}$/;
const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "multi-agent-research-system-github-token-broker";

export class BrokerError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "BrokerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAttribute(item, name) {
  const value = item?.[name];
  return record(value) && typeof value.S === "string" ? value.S : null;
}

function positiveIntegerAttribute(item, name) {
  const value = item?.[name];
  if (!record(value) || typeof value.N !== "string") return null;
  const parsed = Number(value.N);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseBrokerRequest(event) {
  if (!record(event)) {
    throw new BrokerError(
      400,
      "invalid_request",
      "The broker request must be an object.",
    );
  }
  if (
    "repository" in event ||
    "repository_id" in event ||
    "repository_ids" in event ||
    "repository_name" in event
  ) {
    throw new BrokerError(
      400,
      "repository_scope_not_accepted",
      "Repository scope is derived from the trusted job record, not broker input.",
    );
  }

  const jobId = typeof event.job_id === "string" ? event.job_id : "";
  const orchestratorInstanceId =
    typeof event.orchestrator_instance_id === "string"
      ? event.orchestrator_instance_id
      : "";
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new BrokerError(400, "invalid_job_id", "job_id is invalid.");
  }
  if (!INSTANCE_ID_PATTERN.test(orchestratorInstanceId)) {
    throw new BrokerError(
      400,
      "invalid_orchestrator_instance_id",
      "orchestrator_instance_id is invalid.",
    );
  }
  return { jobId, orchestratorInstanceId };
}

export function assignedRepository({
  request,
  activeLock,
  job,
  assignment,
  organization,
}) {
  const expectedJobKey = `JOB#${request.jobId}`;
  if (stringAttribute(activeLock, "active_job_id") !== expectedJobKey) {
    throw new BrokerError(
      403,
      "job_not_active",
      "The requested job does not own the active-job lock.",
    );
  }
  if (stringAttribute(job, "job_id") !== request.jobId) {
    throw new BrokerError(
      404,
      "job_not_found",
      "The requested job was not found.",
    );
  }
  if (stringAttribute(job, "type_of_job") !== "software_builder") {
    throw new BrokerError(
      403,
      "wrong_job_type",
      "GitHub credentials are only available to software-builder jobs.",
    );
  }
  if (stringAttribute(job, "status") !== "running") {
    throw new BrokerError(
      409,
      "job_not_running",
      "GitHub credentials are only available while the assigned job is running.",
    );
  }
  if (
    stringAttribute(job, "orchestrator_instance_id") !==
    request.orchestratorInstanceId
  ) {
    throw new BrokerError(
      403,
      "orchestrator_mismatch",
      "The requesting orchestrator is not assigned to this job.",
    );
  }

  if (stringAttribute(assignment, "job_id") !== request.jobId) {
    throw new BrokerError(
      409,
      "repository_not_assigned",
      "The software-builder job has no trusted GitHub repository assignment.",
    );
  }

  const id = positiveIntegerAttribute(assignment, "github_repository_id");
  const fullName = stringAttribute(assignment, "github_repository_full_name");
  if (!id || !fullName) {
    throw new BrokerError(
      409,
      "repository_not_assigned",
      "The software-builder job has no trusted GitHub repository assignment.",
    );
  }
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    parts[0].toLowerCase() !== organization.toLowerCase() ||
    !parts[1]
  ) {
    throw new BrokerError(
      403,
      "repository_outside_organization",
      "The assigned repository is outside the configured GitHub organization.",
    );
  }
  return { id, fullName };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createAppJwt({ clientId, privateKey, nowMs = Date.now() }) {
  const now = Math.floor(nowMs / 1000);
  const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: clientId,
  });
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsignedToken);
    signer.end();
    return `${unsignedToken}.${signer.sign(privateKey, "base64url")}`;
  } catch {
    throw new BrokerError(
      500,
      "invalid_private_key",
      "The configured GitHub App private key is invalid.",
    );
  }
}

function githubMessage(payload, fallback) {
  return record(payload) && typeof payload.message === "string"
    ? payload.message
    : fallback;
}

async function githubJson(path, authorization, init, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${GITHUB_API_ROOT}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: authorization,
        "Content-Type": "application/json",
        "User-Agent": GITHUB_USER_AGENT,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new BrokerError(
      502,
      "github_unavailable",
      "The GitHub API could not be reached.",
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // GitHub can return an empty or non-JSON response during upstream failures.
  }
  if (!response.ok) {
    throw new BrokerError(
      502,
      "github_rejected_request",
      githubMessage(payload, `GitHub rejected the request (${response.status}).`),
    );
  }
  return payload;
}

export async function mintRepositoryToken({
  clientId,
  privateKey,
  organization,
  repository,
  fetchImpl = fetch,
  nowMs = Date.now(),
}) {
  const jwt = createAppJwt({ clientId, privateKey, nowMs });
  const installation = await githubJson(
    `/orgs/${encodeURIComponent(organization)}/installation`,
    `Bearer ${jwt}`,
    { method: "GET" },
    fetchImpl,
  );
  if (!record(installation) || !Number.isSafeInteger(installation.id)) {
    throw new BrokerError(
      502,
      "invalid_installation_response",
      "GitHub returned an invalid App installation response.",
    );
  }

  const tokenResponse = await githubJson(
    `/app/installations/${installation.id}/access_tokens`,
    `Bearer ${jwt}`,
    {
      method: "POST",
      body: JSON.stringify({
        repository_ids: [repository.id],
        permissions: {
          contents: "write",
          metadata: "read",
        },
      }),
    },
    fetchImpl,
  );
  if (
    !record(tokenResponse) ||
    typeof tokenResponse.token !== "string" ||
    !tokenResponse.token ||
    typeof tokenResponse.expires_at !== "string" ||
    !Number.isFinite(Date.parse(tokenResponse.expires_at))
  ) {
    throw new BrokerError(
      502,
      "invalid_token_response",
      "GitHub returned an invalid installation-token response.",
    );
  }

  return {
    token: tokenResponse.token,
    expires_at: tokenResponse.expires_at,
    repository: repository,
    permissions: {
      contents: "write",
      metadata: "read",
    },
  };
}

export async function issueRepositoryToken(event, dependencies, configuration) {
  const request = parseBrokerRequest(event);
  const activeLock = await dependencies.getActiveLock();
  const job = await dependencies.getJob(request.jobId);
  const assignment = await dependencies.getAssignment(request.jobId);
  const repository = assignedRepository({
    request,
    activeLock,
    job,
    assignment,
    organization: configuration.organization,
  });
  const privateKey = await dependencies.getPrivateKey();
  return mintRepositoryToken({
    clientId: configuration.clientId,
    privateKey,
    organization: configuration.organization,
    repository,
    fetchImpl: dependencies.fetchImpl,
    nowMs: dependencies.nowMs,
  });
}
