"use client";

import { AlertTriangle, ArrowLeft, Database, Square } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { fetchJobMonitor } from "@/lib/job-monitor";
import type {
  JobMonitorSnapshot,
  MonitoredSubagentStatus,
  OrchestratorProgress,
} from "@/lib/job-monitor";
import { DEFAULT_JOB_TYPE, jobTypeLabel, requestJobEnd } from "@/lib/jobs";

const POLL_INTERVAL_MS = 3000;

const PROGRESS_LABELS: Record<OrchestratorProgress, string> = {
  launching_orchestrator: "Launching Orchestrator",
  making_plan: "Making a Plan",
  coordinating_subagents: "Coordinating Subagents",
  done: "Done",
};

const SUBAGENT_STATUS_LABELS: Record<MonitoredSubagentStatus, string> = {
  queued: "Queued",
  provisioning: "Provisioning",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  terminated: "Terminated",
  unknown: "Unknown",
};

function describeError(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

export function DataMiningJobMonitor({ jobId }: { jobId: string }) {
  const [snapshot, setSnapshot] = useState<JobMonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const next = await fetchJobMonitor(jobId, signal);
      setSnapshot(next);
      setError(null);
      return next;
    },
    [jobId],
  );

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;

    async function poll() {
      controller = new AbortController();
      try {
        const next = await refresh(controller.signal);
        if (!disposed && !next.isTerminal) {
          timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (caught) {
        if (disposed || (caught instanceof Error && caught.name === "AbortError")) {
          return;
        }
        setError(describeError(caught, "The job monitor could not be refreshed."));
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [refresh]);

  async function endJob() {
    if (!snapshot || snapshot.isTerminal || ending) {
      return;
    }
    setEnding(true);
    setError(null);
    try {
      await requestJobEnd(jobId);
      await refresh();
    } catch (caught) {
      setError(describeError(caught, "The job could not be ended."));
    } finally {
      setEnding(false);
    }
  }

  const progress = snapshot?.progress ?? "launching_orchestrator";
  const task = snapshot?.job.originalTask ?? "Loading the original task…";
  const jobType = snapshot?.job.typeOfJob ?? DEFAULT_JOB_TYPE;
  const subagents = snapshot?.subagents ?? [];
  const jobIsActive =
    snapshot !== null &&
    (snapshot.job.status === "initializing" || snapshot.job.status === "running");
  const jobIsSaved =
    snapshot !== null &&
    (snapshot.job.status === "completed" || snapshot.job.status === "failed");

  return (
    <div className="data-mining-monitor" aria-busy={snapshot === null}>
      {jobIsSaved ? (
        <Link className="data-mining-back-link" href="/jobs/saved">
          <ArrowLeft size={12} strokeWidth={2} aria-hidden="true" />
          BACK TO SAVED JOBS
        </Link>
      ) : null}

      <div className="data-mining-panel-label data-mining-job-type">
        <Database size={12} strokeWidth={2} aria-hidden="true" />
        {jobTypeLabel(jobType).toUpperCase()}
      </div>

      <section className="data-mining-panel orchestrator-panel" aria-labelledby="orchestrator-panel-label">
        <div className="data-mining-panel-label" id="orchestrator-panel-label">
          ORCHESTRATOR PANEL
        </div>

        <div className="orchestrator-task" title={task}>
          <strong>Input Task:</strong> {task}
        </div>

        {snapshot?.orchestratorError ? (
          <div className="orchestrator-failure" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{snapshot.orchestratorError}</span>
          </div>
        ) : null}

        {error ? (
          <div className="monitor-refresh-error" role="status">
            {error} Retrying automatically.
          </div>
        ) : null}

        <div className="orchestrator-panel-footer">
          <div className="orchestrator-progress" aria-live="polite">
            <span className={`orchestrator-progress-dot progress-${progress}`} aria-hidden="true" />
            {PROGRESS_LABELS[progress]}
          </div>

          {jobIsActive ? (
            <button
              type="button"
              className="secondary-button monitor-end-job"
              onClick={() => void endJob()}
              disabled={ending}
            >
              <Square size={12} strokeWidth={2.2} aria-hidden="true" />
              {ending ? "Ending…" : "End Job"}
            </button>
          ) : null}
        </div>
      </section>

      <section className="data-mining-panel subagent-panel" aria-labelledby="subagent-panel-label">
        <div className="data-mining-panel-label" id="subagent-panel-label">
          SUBAGENT PANEL
        </div>

        <div className="subagent-card-scroll">
          {subagents.length === 0 ? (
            <div className="subagent-empty-state">
              <span>No subagents created yet.</span>
              <p>Cards will appear here when the orchestrator delegates its plan.</p>
            </div>
          ) : (
            <div className="subagent-card-grid" aria-live="polite">
              {subagents.map((subagent, index) => (
                <article
                  className={`subagent-monitor-card subagent-${subagent.status}`}
                  key={subagent.agentId}
                  title={subagent.task}
                >
                  <div className="subagent-card-heading">
                    <strong>Subagent {index + 1}</strong>
                    <span className="subagent-status-pill">
                      {SUBAGENT_STATUS_LABELS[subagent.status]}
                    </span>
                  </div>
                  <p>{subagent.task}</p>
                  <span className="subagent-card-id mono">{subagent.agentId}</span>
                  {subagent.error ? (
                    <span className="subagent-card-error">{subagent.error}</span>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
