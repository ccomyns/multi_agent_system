"use client";

import { ArrowUp, Bot, Database, Sparkles } from "lucide-react";
import { useRef, useState } from "react";

import { createPreviewJob, findActivePreviewJob, usePreviewJobs } from "@/lib/jobs";

export function JobComposer() {
  const [query, setQuery] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { jobs, hydrated } = usePreviewJobs();
  const job = findActivePreviewJob(jobs);

  function submitJob() {
    const originalQuery = query.trim();
    if (!originalQuery || job) {
      return;
    }

    createPreviewJob(originalQuery);
    setQuery("");
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
            <div>
              <span className="job-status-dot" aria-hidden="true" />
              <span>Initializing</span>
            </div>
            <span className="mono">{job.jobId}</span>
          </div>

          <article className="job-user-message" aria-label="Original job request">
            <p>{job.originalQuery}</p>
          </article>

          <div className="job-system-message">
            <span className="job-system-icon" aria-hidden="true">
              <Bot size={17} strokeWidth={1.8} />
            </span>
            <div>
              <strong>Job request recorded</strong>
              <p>
                This is a static preview. Orchestrator launch and database persistence
                will be connected in the next phase.
              </p>
            </div>
          </div>
        </div>
      )}

      <form
        className="job-prompt-form"
        onSubmit={(event) => {
          event.preventDefault();
          submitJob();
        }}
      >
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
              submitJob();
            }
          }}
          placeholder={
            job
              ? "This job is active. Additional messages are not enabled yet."
              : "Describe the research job you want to run…"
          }
          disabled={!hydrated || Boolean(job)}
          maxLength={4000}
          rows={3}
        />
        <div className="job-prompt-footer">
          <span>
            {job ? (
              <>
                <Database size={13} aria-hidden="true" /> Browser preview record
              </>
            ) : (
              "Shift + Enter for a new line"
            )}
          </span>
          <button
            type="submit"
            className="job-send-button"
            aria-label="Create job"
            disabled={!hydrated || Boolean(job) || !query.trim()}
          >
            <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
}
