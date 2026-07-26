import type { ActiveRun, AgentStatus, OrchestratorInstance } from "@/lib/types";

type Status =
  | AgentStatus
  | ActiveRun["status"]
  | OrchestratorInstance["state"];

const labels: Record<Status, string> = {
  running: "Running",
  provisioning: "Provisioning",
  completed: "Completed",
  failed: "Failed",
  initializing: "Initializing",
  stopping: "Stopping",
  stopped: "Stopped",
  terminated: "Terminated",
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-indicator" aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
