"use client";

import { ArrowUp, Bot, Database, Sparkles, Square } from "lucide-react";
import { useRef, useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { DEFAULT_JOB_TYPE, jobTypeLabel } from "@/lib/jobs";
import type { JobType } from "@/lib/jobs";
import { useJobs } from "@/lib/use-jobs";

export function JobComposer() {
  const [query, setQuery] = useState("");
  const [jobType, setJobType] = useState<JobType>(DEFAULT_JOB_TYPE);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { activeJob: job, hydrated, pending, error, launch, end } = useJobs();

  async function submitJob() {
    const originalTask = query.trim();
    if (!originalTask || job || pending) {
      return;
    }

    if (await launch(originalTask, jobType)) {
      setQuery("");
    }
  }

  return (
    <div className={job ? "job-conversation has-job" : "job-conversation"}>
      {!job ? (
        <div className="job-compose-intro">
          <span className="job-compose-mark" aria-hidden="true">
            <Sparkles size={22} strokeWidth={1.8} />
          </span>
          <h1>What should the research team accomplish?</h1>
          <p>Start with the outcome you want. The orchestrator will plan the work.</p>
        </div>
      ) : (
        <div className="job-thread" aria-live="polite">
          <div className="job-thread-meta">
            <StatusBadge status={job.status} />
            <span className="mono">{job.jobId}</span>
          </div>

          <article className="job-user-message" aria-label="Original job request">
            <p>{job.originalTask}</p>
          </article>

          <div className="job-system-message">
            <span className="job-system-icon" aria-hidden="true">
              <Bot size={17} strokeWidth={1.8} />
            </span>
            <div>
              <strong>
                {job.orchestratorInstanceId
                  ? "Orchestrator launched"
                  : "Waiting on the orchestrator"}
              </strong>
              <p>
                {job.orchestratorInstanceId
                  ? "The orchestrator is booting and will report subagent activity under this EC2 instance ID."
                  : "The job record holds the lock. Its orchestrator instance ID is still null."}
              </p>

              <dl className="job-record-facts">
                <div>
                  <dt>Job type</dt>
                  <dd>{jobTypeLabel(job.typeOfJob)}</dd>
                </div>
                <div>
                  <dt>Orchestrator instance</dt>
                  <dd className="mono">{job.orchestratorInstanceId ?? "null"}</dd>
                </div>
              </dl>

              <button
                type="button"
                className="secondary-button job-end-button"
                onClick={() => void end(job.jobId)}
                disabled={pending}
              >
                <Square size={13} strokeWidth={2.2} aria-hidden="true" />
                {pending ? "Ending…" : "End job and release the lock"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error ? (
        <div className="job-error" role="alert">
          {error}
        </div>
      ) : null}

      <form
        className="job-compose-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submitJob();
        }}
      >
        <div className="job-prompt-form">
          <label className="sr-only" htmlFor="job-prompt">
            Research request
          </label>
          <textarea
            ref={textareaRef}
            id="job-prompt"
            data-testid="job-prompt"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitJob();
              }
            }}
            placeholder={
              job
                ? "This job is active. Only one job can run at a time."
                : "Describe the research job you want to run…"
            }
            disabled={!hydrated || Boolean(job) || pending}
            maxLength={4000}
            rows={3}
          />
          <div className="job-prompt-footer">
            <span>
              {job ? (
                <>
                  <Database size={13} aria-hidden="true" /> Job record holds the active-job lock
                </>
              ) : pending ? (
                "Claiming the lock and launching the orchestrator…"
              ) : (
                "Shift + Enter for a new line"
              )}
            </span>
            <button
              type="submit"
              className="job-send-button"
              aria-label="Create job"
              disabled={!hydrated || Boolean(job) || pending || !query.trim()}
            >
              <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        </div>
        <fieldset className="job-type-selector" disabled={!hydrated || Boolean(job) || pending}>
          <legend>Job type</legend>
          <button
            type="button"
            className={
              jobType === "data_mining" ? "job-type-button is-selected" : "job-type-button"
            }
            aria-pressed={jobType === "data_mining"}
            onClick={() => setJobType("data_mining")}
          >
            <Database size={14} aria-hidden="true" />
            Data Mining
          </button>
        </fieldset>
      </form>
    </div>
  );
}
