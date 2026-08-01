export type JobStatus = "initializing" | "running" | "completed" | "failed";

export type Job = {
  jobId: string;
  originalTask: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  orchestratorId: string | null;
  orchestratorInstanceId: string | null;
  launchedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
  resultS3Prefix: string;
};

export type JobsSnapshot = {
  jobs: Job[];
  activeJobId: string | null;
};

// Shared by the browser (which mints the ID) and the admin server (which validates
// it before using it as both a DynamoDB key and an EC2 client token).
export const JOB_ID_PATTERN = /^job_[a-z0-9]{4,12}_[0-9a-f]{8}$/;

const ACTIVE_STATUSES: JobStatus[] = ["initializing", "running"];

export function createJobId() {
  const stamp = Date.now().toString(36);
  const random = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return `job_${stamp}_${random}`;
}

export function isActiveJob(job: Job) {
  return ACTIVE_STATUSES.includes(job.status);
}

export function isJob(value: unknown): value is Job {
  return (
    typeof value === "object" &&
    value !== null &&
    "jobId" in value &&
    typeof value.jobId === "string" &&
    "originalTask" in value &&
    typeof value.originalTask === "string" &&
    "status" in value &&
    ["initializing", "running", "completed", "failed"].includes(String(value.status)) &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}

function isSnapshot(value: unknown): value is JobsSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "jobs" in value &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isJob)
  );
}

function readError(payload: unknown, fallback: string) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

async function requestJobs(input: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(readError(payload, `The request failed (${response.status}).`));
  }
  return payload;
}

export async function fetchJobs(): Promise<JobsSnapshot> {
  const payload = await requestJobs("/api/jobs");
  if (!isSnapshot(payload)) {
    throw new Error("The admin server returned an unexpected job list.");
  }
  return payload;
}

export async function requestJobLaunch(originalTask: string): Promise<Job> {
  const payload = await requestJobs("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: createJobId(), originalTask }),
  });
  if (!isJob(payload)) {
    throw new Error("The admin server returned an unexpected job record.");
  }
  return payload;
}

export async function requestJobEnd(jobId: string): Promise<Job> {
  const payload = await requestJobs(`/api/jobs?jobId=${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  if (!isJob(payload)) {
    throw new Error("The admin server returned an unexpected job record.");
  }
  return payload;
}
