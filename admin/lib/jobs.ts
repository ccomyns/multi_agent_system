import { useMemo, useSyncExternalStore } from "react";

export type JobStatus = "initializing" | "running" | "completed" | "failed";

export type Job = {
  jobId: string;
  originalQuery: string;
  status: JobStatus;
  createdAt: string;
};

const JOBS_STORAGE_KEY = "research-control.jobs";
const JOBS_CHANGED_EVENT = "research-control.jobs-changed";

function isJob(value: unknown): value is Job {
  return (
    typeof value === "object" &&
    value !== null &&
    "jobId" in value &&
    typeof value.jobId === "string" &&
    "originalQuery" in value &&
    typeof value.originalQuery === "string" &&
    "status" in value &&
    ["initializing", "running", "completed", "failed"].includes(
      String(value.status),
    ) &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}

function parsePreviewJobs(snapshot: string | null): Job[] {
  if (snapshot === null) {
    return [];
  }

  try {
    const stored: unknown = JSON.parse(snapshot);
    return Array.isArray(stored) ? stored.filter(isJob) : [];
  } catch {
    return [];
  }
}

export function readPreviewJobs(): Job[] {
  if (typeof window === "undefined") {
    return [];
  }

  return parsePreviewJobs(window.localStorage.getItem(JOBS_STORAGE_KEY) ?? "[]");
}

function subscribeToPreviewJobs(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(JOBS_CHANGED_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(JOBS_CHANGED_EVENT, onStoreChange);
  };
}

function getPreviewJobsSnapshot() {
  return window.localStorage.getItem(JOBS_STORAGE_KEY) ?? "[]";
}

function getServerPreviewJobsSnapshot() {
  return null;
}

export function usePreviewJobs() {
  const snapshot = useSyncExternalStore(
    subscribeToPreviewJobs,
    getPreviewJobsSnapshot,
    getServerPreviewJobsSnapshot,
  );

  return {
    jobs: useMemo(() => parsePreviewJobs(snapshot), [snapshot]),
    hydrated: snapshot !== null,
  };
}

export function findActivePreviewJob(jobs = readPreviewJobs()) {
  return jobs.find((job) => job.status === "initializing" || job.status === "running") ?? null;
}

export function createPreviewJob(originalQuery: string): Job {
  const jobs = readPreviewJobs();
  const activeJob = findActivePreviewJob(jobs);
  if (activeJob) {
    return activeJob;
  }

  const job: Job = {
    jobId: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    originalQuery,
    status: "initializing",
    createdAt: new Date().toISOString(),
  };

  window.localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify([job, ...jobs]));
  window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
  return job;
}
