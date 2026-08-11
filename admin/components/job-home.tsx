"use client";

import { ArrowRight, Clock3, FolderOpen, SquarePen } from "lucide-react";
import Link from "next/link";

import { jobDetailHref } from "@/lib/jobs";
import { useJobs } from "@/lib/use-jobs";

export function JobHome() {
  const { activeJob, error } = useJobs();

  return (
    <div className="job-home-content">
      <header className="job-home-heading">
        <span className="eyebrow">Single-job workspace</span>
        <h1>What would you like to do?</h1>
        <p>Create a new research job or return to work you have already started.</p>
      </header>

      {activeJob ? (
        <div className="active-job-notice" role="status">
          <Clock3 size={16} aria-hidden="true" />
          <span>
            <strong>One job is currently active.</strong> The job table holds the lock for{" "}
            <span className="mono">{activeJob.jobId}</span>, so a new job cannot start until
            it ends.
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="job-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="job-choice-grid">
        <Link
          className="job-choice-card"
          href={activeJob ? jobDetailHref(activeJob) : "/jobs/new"}
        >
          <span className="job-choice-icon is-primary" aria-hidden="true">
            <SquarePen size={23} strokeWidth={1.8} />
          </span>
          <span className="job-choice-copy">
            <strong>{activeJob ? "View Active Job" : "Create a Job"}</strong>
            <span>
              {activeJob
                ? "Return to the job that is already in progress."
                : "Describe a research objective for the multi-agent system."}
            </span>
          </span>
          <ArrowRight className="job-choice-arrow" size={18} aria-hidden="true" />
        </Link>

        <Link className="job-choice-card" href="/jobs/saved">
          <span className="job-choice-icon" aria-hidden="true">
            <FolderOpen size={23} strokeWidth={1.8} />
          </span>
          <span className="job-choice-copy">
            <strong>Saved Jobs</strong>
            <span>Review active and completed research requests.</span>
          </span>
          <ArrowRight className="job-choice-arrow" size={18} aria-hidden="true" />
        </Link>
      </div>

      <p className="job-preview-note">
        Job records and the single active-job lock live in DynamoDB.
      </p>
    </div>
  );
}
