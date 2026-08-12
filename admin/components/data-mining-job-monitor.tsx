"use client";

import { AlertTriangle, ArrowLeft, Database, Square } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { fetchJobMonitor } from "@/lib/job-monitor";
import type {
  JobMonitorSnapshot,
  MonitoredSubagentStatus,
  OrchestratorProgress,
} from "@/lib/job-monitor";
import type { AgentTelemetrySummary } from "@/lib/agent-telemetry";
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

function localClock(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function elapsed(start: string, finish: string | null) {
  const startMs = new Date(start).getTime();
  const finishMs = finish ? new Date(finish).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) return null;
  const seconds = Math.max(0, Math.floor((finishMs - startMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function telemetryFacts(telemetry: AgentTelemetrySummary | null, failed: boolean) {
  const total = telemetry?.usage.totalTokens;
  const tokenText = total === null || total === undefined
    ? "Tokens pending"
    : `${total.toLocaleString()} tokens`;
  if (!telemetry?.codexStartedAt) {
    return { tokenText, timingText: "Codex not started" };
  }
  const runtime = elapsed(telemetry.codexStartedAt, telemetry.codexFinishedAt);
  if (telemetry.codexFinishedAt || failed) {
    return { tokenText, timingText: `${failed ? "Failed · " : "Runtime "}${runtime ?? "unavailable"}` };
  }
  return { tokenText, timingText: `Started ${localClock(telemetry.codexStartedAt)}` };
}

export function DataMiningJobMonitor({ jobId }: { jobId: string }) {
  const router = useRouter();
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

  function viewOrchestrator() {
    router.push(`/jobs/${encodeURIComponent(jobId)}/orchestrator`);
  }

  if (snapshot === null) {
    return (
      <div className="data-mining-monitor-loading" aria-busy="true" aria-live="polite">
        <span className="data-mining-loading-spinner" aria-hidden="true" />
        <span>Loading job details…</span>
        {error ? <small>{error} Retrying automatically.</small> : null}
      </div>
    );
  }

  const progress = snapshot.progress;
  const task = snapshot.job.originalTask;
  const jobType = snapshot.job.typeOfJob ?? DEFAULT_JOB_TYPE;
  const subagents = snapshot.subagents;
  const jobIsActive =
    (snapshot.job.status === "initializing" || snapshot.job.status === "running");
  const jobIsSaved =
    (snapshot.job.status === "completed" || snapshot.job.status === "failed");
  const orchestratorFacts = telemetryFacts(
    snapshot.orchestratorTelemetry,
    snapshot.job.status === "failed",
  );

  return (
    <div className="data-mining-monitor">
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

      <section
        className="data-mining-panel orchestrator-panel is-result-viewable"
        aria-labelledby="orchestrator-panel-label"
        onClick={viewOrchestrator}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            viewOrchestrator();
          }
        }}
        role="link"
        tabIndex={0}
      >
        <div className="data-mining-panel-label" id="orchestrator-panel-label">
          ORCHESTRATOR PANEL
        </div>

        <div className="orchestrator-task" title={task}>
          <strong>Input Task:</strong> {task}
        </div>

        {snapshot.orchestratorError ? (
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
          <div className="orchestrator-progress-block">
            <div className="orchestrator-progress" aria-live="polite">
              <span className={`orchestrator-progress-dot progress-${progress}`} aria-hidden="true" />
              {PROGRESS_LABELS[progress]}
            </div>
            <div className="agent-compact-telemetry">
              <span>{orchestratorFacts.timingText}</span>
              <span>{orchestratorFacts.tokenText}</span>
            </div>
          </div>

          {jobIsActive ? (
            <button
              type="button"
              className="secondary-button monitor-end-job"
              onClick={(event) => {
                event.stopPropagation();
                void endJob();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
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
              {subagents.map((subagent, index) => {
                const facts = telemetryFacts(subagent.telemetry, subagent.status === "failed");
                return (
                <article
                  className={`subagent-monitor-card subagent-${subagent.status}`}
                  key={subagent.agentId}
                  title={subagent.task}
                  role="link"
                  tabIndex={0}
                  onClick={() => router.push(`/jobs/${encodeURIComponent(jobId)}/agents/${encodeURIComponent(subagent.agentId)}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      router.push(`/jobs/${encodeURIComponent(jobId)}/agents/${encodeURIComponent(subagent.agentId)}`);
                    }
                  }}
                >
                  <div className="subagent-card-heading">
                    <strong>Subagent {index + 1}</strong>
                    <span className="subagent-status-pill">
                      {SUBAGENT_STATUS_LABELS[subagent.status]}
                    </span>
                  </div>
                  <p>{subagent.task}</p>
                  <div className="agent-compact-telemetry subagent-compact-telemetry">
                    <span>{facts.timingText}</span>
                    <span>{facts.tokenText}</span>
                  </div>
                  <span className="subagent-card-id mono">{subagent.agentId}</span>
                  {subagent.error ? (
                    <span className="subagent-card-error">{subagent.error}</span>
                  ) : null}
                </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
