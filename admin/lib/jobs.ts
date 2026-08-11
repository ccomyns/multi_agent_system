export type JobStatus = "initializing" | "running" | "completed" | "failed";
export type JobType = "data_mining";

export const DEFAULT_JOB_TYPE: JobType = "data_mining";
export const JOB_TYPES: JobType[] = [DEFAULT_JOB_TYPE];

export function isJobType(value: unknown): value is JobType {
  return JOB_TYPES.includes(value as JobType);
}

export function jobTypeLabel(type: JobType) {
  switch (type) {
    case "data_mining":
      return "Data Mining";
  }
}

export function jobDetailHref(job: Pick<Job, "jobId" | "typeOfJob">) {
  switch (job.typeOfJob) {
    case "data_mining":
      return `/jobs/${encodeURIComponent(job.jobId)}`;
  }
}

export type Job = {
  jobId: string;
  originalTask: string;
  typeOfJob: JobType;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  orchestratorInstanceId: string | null;
  launchedAt: string | null;
  finishedAt: string | null;
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
    "typeOfJob" in value &&
    isJobType(value.typeOfJob) &&
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

export async function requestJobLaunch(originalTask: string, typeOfJob: JobType): Promise<Job> {
  const payload = await requestJobs("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: createJobId(), originalTask, typeOfJob }),
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
