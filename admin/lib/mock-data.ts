import type {
  ActiveRun,
  MonitorSubagentStep,
  MonitorTab,
} from "@/lib/types";

export const activeRun: ActiveRun = {
  id: "run_01J4Z2M8H7K3",
  objective:
    "Assess semiconductor sector earnings quality and identify asymmetric risk before the next rebalance.",
  status: "running",
  createdAt: "Jul 26, 2026 at 10:42 AM",
  elapsed: "2h 18m",
  maxActiveAgents: 8,
  activeAgentCount: 6,
  orchestrator: {
    instanceId: "i-0e74b29c6a114d3f2",
    state: "running",
    instanceType: "m7i.large",
    availabilityZone: "us-east-1a",
    privateIp: "10.42.1.24",
    launchedAt: "Jul 26, 2026 at 10:41 AM",
    cpuUtilization: 42,
    memoryUtilization: 61,
  },
  agents: [
    {
      id: "agent_7f2a",
      name: "Filings Analyst",
      specialty: "SEC filings",
      status: "running",
      assignment:
        "Compare revenue recognition, receivables, and deferred revenue trends across NVDA, AMD, and AVGO.",
      instanceId: "i-0a18f4d229db37c01",
      startedAt: "10:47 AM",
      runtime: "2h 13m",
      lastActivity: "Parsed AVGO 10-Q exhibits",
    },
    {
      id: "agent_b18c",
      name: "Earnings Quality",
      specialty: "Forensic accounting",
      status: "running",
      assignment:
        "Normalize operating margins for stock compensation, restructuring charges, and acquisition accounting.",
      instanceId: "i-00bc8e774d3fa16a7",
      startedAt: "10:51 AM",
      runtime: "2h 09m",
      lastActivity: "Reconciled AMD non-GAAP bridge",
    },
    {
      id: "agent_1d93",
      name: "Supply Chain",
      specialty: "Industry research",
      status: "running",
      assignment:
        "Map foundry capacity, advanced packaging constraints, and supplier concentration through 2027.",
      instanceId: "i-05af2c6cb071fe823",
      startedAt: "11:02 AM",
      runtime: "1h 58m",
      lastActivity: "Reviewing CoWoS capacity estimates",
    },
    {
      id: "agent_4ac1",
      name: "Market Signals",
      specialty: "Derivatives",
      status: "running",
      assignment:
        "Measure options skew, implied earnings moves, short interest, and positioning across the peer set.",
      instanceId: "i-038cf347e6c4dc972",
      startedAt: "11:14 AM",
      runtime: "1h 46m",
      lastActivity: "Updated 30-day volatility surface",
    },
    {
      id: "agent_09e5",
      name: "Scenario Builder",
      specialty: "Valuation",
      status: "running",
      assignment:
        "Build bull, base, and bear valuation cases using unit growth, pricing, and margin sensitivities.",
      instanceId: "i-027ad5188b3ef0c14",
      startedAt: "11:28 AM",
      runtime: "1h 32m",
      lastActivity: "Running bear-case sensitivity",
    },
    {
      id: "agent_3b60",
      name: "Risk Reviewer",
      specialty: "Adversarial review",
      status: "provisioning",
      assignment:
        "Challenge the emerging thesis and catalogue evidence that could invalidate each key assumption.",
      instanceId: "i-0d68fb7623de7b144",
      startedAt: "12:55 PM",
      runtime: "5m",
      lastActivity: "Waiting for runtime health check",
    },
    {
      id: "agent_f70d",
      name: "Macro Context",
      specialty: "Macro research",
      status: "completed",
      assignment:
        "Assess rates, dollar liquidity, export controls, and data-center capex conditions affecting the sector.",
      instanceId: "i-0c8ea5f1408371b96",
      startedAt: "10:49 AM",
      runtime: "1h 04m",
      lastActivity: "Memo delivered at 11:53 AM",
    },
    {
      id: "agent_21c8",
      name: "News Monitor",
      specialty: "Event research",
      status: "completed",
      assignment:
        "Collect material company, supplier, regulatory, and customer announcements from the prior 30 days.",
      instanceId: "i-0ee349b7db18a2d44",
      startedAt: "10:45 AM",
      runtime: "46m",
      lastActivity: "Event digest delivered at 11:31 AM",
    },
  ],
};

export const monitorTabs: MonitorTab[] = [
  { id: "mon", label: "Agent monitoring" },
  { id: "data", label: "Data review" },
  { id: "infra", label: "Infra review" },
];

export const monitorSubagents: MonitorSubagentStep[] = [
  {
    id: "subagent-1",
    name: "Subagent 1",
    description: "Pulls raw source records into local DuckDB",
  },
  {
    id: "subagent-2",
    name: "Subagent 2",
    description: "Infers schema and normalizes column types",
  },
  {
    id: "subagent-3",
    name: "Subagent 3",
    description: "Deduplicates rows against prior snapshots",
  },
  {
    id: "subagent-4",
    name: "Subagent 4",
    description: "Runs validation checks and flags anomalies",
  },
  {
    id: "subagent-5",
    name: "Subagent 5",
    description: "Enriches tables with reference lookups",
  },
  {
    id: "subagent-6",
    name: "Subagent 6",
    description: "Persists completed tables to S3",
  },
  {
    id: "subagent-7",
    name: "Subagent 7",
    description: "Evaluates merge candidates against existing tables",
  },
  {
    id: "subagent-8",
    name: "Subagent 8",
    description: "Promotes approved tables into RDS",
  },
];
