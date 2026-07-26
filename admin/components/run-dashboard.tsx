"use client";

import {
  Activity,
  Bot,
  Box,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  Layers3,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import type { ActiveRun, AgentStatus } from "@/lib/types";

type FilterStatus = "all" | AgentStatus;

const statusOptions: Array<{ value: FilterStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "provisioning", label: "Provisioning" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

function Detail({
  icon,
  label,
  value,
  mono = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="compute-detail">
      <span className="compute-detail-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <span className="detail-label">{label}</span>
        <span className={mono ? "detail-value mono" : "detail-value"}>{value}</span>
      </div>
    </div>
  );
}

function Meter({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="meter">
      <div className="meter-heading">
        <span>
          {icon}
          {label}
        </span>
        <strong>{value}%</strong>
      </div>
      <div
        className="meter-track"
        role="progressbar"
        aria-label={`${label} utilization`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <span style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

export function RunDashboard({ run }: { run: ActiveRun }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<FilterStatus>("all");
  const [lastUpdated, setLastUpdated] = useState("just now");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const visibleAgents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return run.agents.filter((agent) => {
      const matchesStatus = status === "all" || agent.status === status;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [
          agent.name,
          agent.specialty,
          agent.assignment,
          agent.instanceId ?? "",
          agent.lastActivity,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesStatus && matchesQuery;
    });
  }, [query, run.agents, status]);

  function refresh() {
    setIsRefreshing(true);
    window.setTimeout(() => {
      setLastUpdated(
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }).format(new Date()),
      );
      setIsRefreshing(false);
    }, 500);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Layers3 size={20} strokeWidth={1.8} />
          </span>
          <div>
            <strong>Research Control</strong>
            <span>Admin console</span>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          <a className="nav-item active" href="#multi-agent-run" aria-current="page">
            <Bot size={18} />
            Multi Agent Run
          </a>
        </nav>

        <div className="sidebar-footer">
          <span className="environment-dot" aria-hidden="true" />
          <div>
            <span>Environment</span>
            <strong>Development</strong>
          </div>
        </div>
      </aside>

      <main id="multi-agent-run" className="main-content">
        <header className="page-header">
          <div>
            <span className="eyebrow">Current operation</span>
            <h1>Multi Agent Run</h1>
            <p>One orchestrator coordinating financial research subagents.</p>
          </div>
          <div className="refresh-control">
            <span>Updated {lastUpdated}</span>
            <button type="button" onClick={refresh} disabled={isRefreshing}>
              <RefreshCw
                size={16}
                className={isRefreshing ? "spinning" : undefined}
                aria-hidden="true"
              />
              Refresh
            </button>
          </div>
        </header>

        <section className="run-overview" aria-labelledby="run-heading">
          <div className="run-summary">
            <div className="run-title-row">
              <StatusBadge status={run.status} />
              <span className="run-id mono">{run.id}</span>
            </div>
            <h2 id="run-heading">{run.objective}</h2>
          </div>
          <dl className="run-facts">
            <div>
              <dt>Started</dt>
              <dd>{run.createdAt}</dd>
            </div>
            <div>
              <dt>Elapsed</dt>
              <dd>{run.elapsed}</dd>
            </div>
            <div>
              <dt>Active agents</dt>
              <dd>
                {run.activeAgentCount} <span>of {run.maxActiveAgents}</span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="section compute-section" aria-labelledby="compute-heading">
          <div className="section-heading">
            <div>
              <span className="section-icon" aria-hidden="true">
                <Server size={18} />
              </span>
              <div>
                <h2 id="compute-heading">Orchestrator compute</h2>
                <p>EC2 instance hosting the active orchestrator process.</p>
              </div>
            </div>
            <StatusBadge status={run.orchestrator.state} />
          </div>

          <div className="compute-grid">
            <div className="compute-details">
              <Detail
                icon={<Box size={17} />}
                label="Instance ID"
                value={run.orchestrator.instanceId}
                mono
              />
              <Detail
                icon={<Cpu size={17} />}
                label="Instance type"
                value={run.orchestrator.instanceType}
              />
              <Detail
                icon={<Database size={17} />}
                label="Private IP"
                value={run.orchestrator.privateIp}
                mono
              />
              <Detail
                icon={<Activity size={17} />}
                label="Availability zone"
                value={run.orchestrator.availabilityZone}
              />
              <Detail
                icon={<Clock3 size={17} />}
                label="Launched"
                value={run.orchestrator.launchedAt}
              />
            </div>
            <div className="utilization">
              <span className="utilization-title">Host utilization</span>
              <Meter
                label="CPU"
                value={run.orchestrator.cpuUtilization}
                icon={<CircleGauge size={15} />}
              />
              <Meter
                label="Memory"
                value={run.orchestrator.memoryUtilization}
                icon={<HardDrive size={15} />}
              />
            </div>
          </div>
        </section>

        <section className="section agents-section" aria-labelledby="agents-heading">
          <div className="section-heading agents-heading">
            <div>
              <span className="section-icon" aria-hidden="true">
                <Bot size={18} />
              </span>
              <div>
                <h2 id="agents-heading">Subagents</h2>
                <p>Assignments and live activity for this run.</p>
              </div>
            </div>
            <div className="capacity">
              <span>{run.activeAgentCount} active</span>
              <div
                className="capacity-slots"
                aria-label={`${run.activeAgentCount} of ${run.maxActiveAgents} active agent slots`}
              >
                {Array.from({ length: run.maxActiveAgents }, (_, index) => (
                  <span
                    key={index}
                    className={index < run.activeAgentCount ? "filled" : undefined}
                  />
                ))}
              </div>
              <strong>{run.maxActiveAgents} max</strong>
            </div>
          </div>

          <div className="table-toolbar">
            <label className="search-control">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search subagents</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search agent or assignment"
              />
            </label>
            <label className="select-control">
              <SlidersHorizontal size={15} aria-hidden="true" />
              <span className="sr-only">Filter by status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as FilterStatus)}
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </label>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Current assignment</th>
                  <th>Instance</th>
                  <th>Runtime</th>
                  <th>Latest activity</th>
                </tr>
              </thead>
              <tbody>
                {visibleAgents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <div className="agent-identity">
                        <span className="agent-icon" aria-hidden="true">
                          <Bot size={16} />
                        </span>
                        <div>
                          <strong>{agent.name}</strong>
                          <span>{agent.specialty}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={agent.status} />
                    </td>
                    <td className="assignment">{agent.assignment}</td>
                    <td>
                      <span className="instance-id mono">
                        {agent.instanceId ?? "Pending"}
                      </span>
                    </td>
                    <td>
                      <span className="runtime">{agent.runtime}</span>
                      <span className="started">Since {agent.startedAt}</span>
                    </td>
                    <td>
                      <span className="activity-text">
                        {agent.status === "completed" && (
                          <CheckCircle2 size={15} aria-hidden="true" />
                        )}
                        {agent.lastActivity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {visibleAgents.length === 0 && (
              <div className="empty-state">
                <Search size={20} aria-hidden="true" />
                <strong>No matching subagents</strong>
                <span>Adjust the search or status filter.</span>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
