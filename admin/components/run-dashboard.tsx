"use client";

import { ArrowRight, Beaker, Bot, Layers3, Sparkles } from "lucide-react";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import type { ActiveRun } from "@/lib/types";

export function RunDashboard({ run }: { run: ActiveRun }) {
  const [vision, setVision] = useState("");
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);

  function launchJob() {
    const objective = vision.trim();
    if (!objective) {
      return;
    }

    setActiveRun({
      ...run,
      id: "run_pending_integration",
      objective,
      status: "initializing",
      activeAgentCount: 0,
      agents: [],
    });
  }

  function launchBasicStressTest() {
    setActiveRun(run);
  }

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
            <span className="eyebrow">
              {activeRun ? "Live operation" : "Orchestration workspace"}
            </span>
            <h1>Multi Agent Run</h1>
            <p>
              {activeRun
                ? "Tasks delegated by the orchestrator and their current status."
                : "Define a research objective or run an admin test."}
            </p>
          </div>
        </header>

        {!activeRun ? (
          <section className="launch-card" aria-labelledby="launch-heading">
            <div className="launch-heading">
              <span className="launch-icon" aria-hidden="true">
                <Sparkles size={19} />
              </span>
              <div>
                <h2 id="launch-heading">What should the research team accomplish?</h2>
                <p>The orchestrator will turn this vision into focused subagent tasks.</p>
              </div>
            </div>

            <form
              className="launch-form"
              onSubmit={(event) => {
                event.preventDefault();
                launchJob();
              }}
            >
              <label htmlFor="research-vision">Research vision</label>
              <textarea
                id="research-vision"
                data-testid="research-vision"
                value={vision}
                onChange={(event) => setVision(event.target.value)}
                placeholder="Example: Assess semiconductor earnings quality and identify asymmetric risks before the next rebalance."
                maxLength={1200}
                rows={7}
              />
              <div className="launch-form-footer">
                <span>{vision.length} / 1,200</span>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={!vision.trim()}
                >
                  Launch job
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </form>

            <div className="admin-tests">
              <div>
                <span className="admin-tests-label">Admin test utilities</span>
                <p>Validate the eight-subagent concurrency boundary.</p>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={launchBasicStressTest}
              >
                <Beaker size={16} aria-hidden="true" />
                Basic Stress Test
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="task-card" aria-labelledby="task-heading">
              <div className="task-card-heading">
                <span className="task-icon" aria-hidden="true">
                  <Bot size={18} />
                </span>
                <div>
                  <span className="task-label">Original orchestrator task</span>
                  <span className="run-id mono">{activeRun.id}</span>
                </div>
              </div>
              <h2 id="task-heading">{activeRun.objective}</h2>
            </section>

            <section className="agents-card" aria-labelledby="agents-heading">
              <div className="agents-header">
                <div>
                  <h2 id="agents-heading">Subagent tasks</h2>
                  <p>Live execution status for each delegated task.</p>
                </div>

                <div className="capacity">
                  <span className="capacity-count">
                    <strong>{activeRun.activeAgentCount}</strong> /{" "}
                    {activeRun.maxActiveAgents} active
                  </span>
                  <div
                    className="capacity-slots"
                    aria-label={`${activeRun.activeAgentCount} of ${activeRun.maxActiveAgents} active agent slots`}
                  >
                    {Array.from(
                      { length: activeRun.maxActiveAgents },
                      (_, index) => (
                        <span
                          key={index}
                          className={
                            index < activeRun.activeAgentCount ? "filled" : undefined
                          }
                        />
                      ),
                    )}
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
                    {activeRun.agents.map((agent) => (
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

                {activeRun.agents.length === 0 && (
                  <div className="waiting-state" role="status">
                    <span className="waiting-icon" aria-hidden="true">
                      <Bot size={18} />
                    </span>
                    <strong>Waiting for subagent tasks</strong>
                    <p>The orchestrator is preparing its delegation plan.</p>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
