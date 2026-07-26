"use client";

import { Bot, Layers3 } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import type { ActiveRun } from "@/lib/types";

export function RunDashboard({ run }: { run: ActiveRun }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#multi-agent-run" aria-label="Research Control home">
          <span className="brand-mark" aria-hidden="true">
            <Layers3 size={19} strokeWidth={1.8} />
          </span>
          <span className="brand-copy">
            <strong>Research Control</strong>
            <span>Admin console</span>
          </span>
        </a>

        <div className="environment">
          <span className="environment-dot" aria-hidden="true" />
          Development
        </div>
      </header>

      <main id="multi-agent-run" className="main-content">
        <header className="page-header">
          <div>
            <span className="eyebrow">Live operation</span>
            <h1>Multi Agent Run</h1>
            <p>Tasks delegated by the orchestrator and their current status.</p>
          </div>
        </header>

        <section className="task-card" aria-labelledby="task-heading">
          <div className="task-card-heading">
            <span className="task-icon" aria-hidden="true">
              <Bot size={18} />
            </span>
            <div>
              <span className="task-label">Original orchestrator task</span>
              <span className="run-id mono">{run.id}</span>
            </div>
          </div>
          <h2 id="task-heading">{run.objective}</h2>
        </section>

        <section className="agents-card" aria-labelledby="agents-heading">
          <div className="agents-header">
            <div>
              <h2 id="agents-heading">Subagent tasks</h2>
              <p>Live execution status for each delegated task.</p>
            </div>

            <div className="capacity">
              <span className="capacity-count">
                <strong>{run.activeAgentCount}</strong> / {run.maxActiveAgents} active
              </span>
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
            </div>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Runtime</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {run.agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <div className="task-cell">
                        <span className="agent-icon" aria-hidden="true">
                          <Bot size={16} />
                        </span>
                        <div>
                          <strong>{agent.assignment}</strong>
                          <span>{agent.name}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="runtime">{agent.runtime}</span>
                    </td>
                    <td>
                      <StatusBadge status={agent.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
