import { isJob } from "@/lib/jobs";
import type { Job } from "@/lib/jobs";

export type OrchestratorProgress =
  | "launching_orchestrator"
  | "making_plan"
  | "coordinating_subagents"
  | "done";

export type MonitoredSubagentStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "terminated"
  | "unknown";

export type MonitoredSubagent = {
  agentId: string;
  task: string;
  status: MonitoredSubagentStatus;
  instanceId: string | null;
  active: boolean;
  createdAt: string | null;
  launchedAt: string | null;
  terminatedAt: string | null;
  error: string | null;
};

export type JobMonitorSnapshot = {
  job: Job;
  progress: OrchestratorProgress;
  orchestratorEc2State: string | null;
  orchestratorError: string | null;
  isTerminal: boolean;
  subagents: MonitoredSubagent[];
};

const PROGRESS_VALUES: OrchestratorProgress[] = [
  "launching_orchestrator",
  "making_plan",
  "coordinating_subagents",
  "done",
];

const SUBAGENT_STATUS_VALUES: MonitoredSubagentStatus[] = [
  "queued",
  "provisioning",
  "running",
  "completed",
  "failed",
  "terminated",
  "unknown",
];

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isMonitoredSubagent(value: unknown): value is MonitoredSubagent {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentId" in value &&
    typeof value.agentId === "string" &&
    "task" in value &&
    typeof value.task === "string" &&
    "status" in value &&
    SUBAGENT_STATUS_VALUES.includes(value.status as MonitoredSubagentStatus) &&
    "instanceId" in value &&
    isNullableString(value.instanceId) &&
    "active" in value &&
    typeof value.active === "boolean" &&
    "createdAt" in value &&
    isNullableString(value.createdAt) &&
    "launchedAt" in value &&
    isNullableString(value.launchedAt) &&
    "terminatedAt" in value &&
    isNullableString(value.terminatedAt) &&
    "error" in value &&
    isNullableString(value.error)
  );
}

export function isJobMonitorSnapshot(value: unknown): value is JobMonitorSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "job" in value &&
    isJob(value.job) &&
    "progress" in value &&
    PROGRESS_VALUES.includes(value.progress as OrchestratorProgress) &&
    "orchestratorEc2State" in value &&
    isNullableString(value.orchestratorEc2State) &&
    "orchestratorError" in value &&
    isNullableString(value.orchestratorError) &&
    "isTerminal" in value &&
    typeof value.isTerminal === "boolean" &&
    "subagents" in value &&
    Array.isArray(value.subagents) &&
    value.subagents.every(isMonitoredSubagent)
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

export async function fetchJobMonitor(
  jobId: string,
  signal?: AbortSignal,
): Promise<JobMonitorSnapshot> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/monitor`, {
    cache: "no-store",
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(readError(payload, `The monitor request failed (${response.status}).`));
  }
  if (!isJobMonitorSnapshot(payload)) {
    throw new Error("The admin server returned an unexpected monitor response.");
  }
  return payload;
}
