export type AgentStatus =
  | "running"
  | "provisioning"
  | "completed"
  | "failed";

export type Subagent = {
  id: string;
  name: string;
  specialty: string;
  status: AgentStatus;
  assignment: string;
  instanceId: string | null;
  startedAt: string;
  runtime: string;
  lastActivity: string;
};

export type OrchestratorInstance = {
  instanceId: string;
  state: "running" | "stopping" | "stopped" | "terminated";
  instanceType: string;
  availabilityZone: string;
  privateIp: string;
  launchedAt: string;
  cpuUtilization: number;
  memoryUtilization: number;
};

export type ActiveRun = {
  id: string;
  objective: string;
  status: "initializing" | "running" | "stopping" | "completed" | "failed";
  createdAt: string;
  elapsed: string;
  maxActiveAgents: number;
  activeAgentCount: number;
  orchestrator: OrchestratorInstance;
  agents: Subagent[];
};

export type MonitorTabId = "mon" | "data" | "infra";

export type MonitorTab = {
  id: MonitorTabId;
  label: string;
};

export type MonitorSubagentStep = {
  id: string;
  name: string;
  description: string;
};
