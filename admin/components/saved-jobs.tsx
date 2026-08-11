"use client";

import { BriefcaseBusiness, Inbox } from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/status-badge";
import { jobDetailHref, jobTypeLabel } from "@/lib/jobs";
import { useJobs } from "@/lib/use-jobs";

export function SavedJobs() {
  const { jobs, activeJob, hydrated, error } = useJobs();

  return (
    <div className="saved-jobs-content">
      <header className="saved-jobs-heading">
        <div>
          <span className="eyebrow">Job history</span>
          <h1>Saved Jobs</h1>
          <p>Original requests and lifecycle state for your research jobs.</p>
        </div>
        <Link
          className="primary-button"
          href={activeJob ? jobDetailHref(activeJob) : "/jobs/new"}
        >
          <BriefcaseBusiness size={15} aria-hidden="true" />
          {activeJob ? "View active job" : "Create a job"}
        </Link>
      </header>

      {error ? (
        <div className="job-error" role="alert">
          {error}
        </div>
      ) : null}

      {hydrated && jobs.length === 0 ? (
        <div className="saved-jobs-empty">
          <span aria-hidden="true">
            <Inbox size={22} strokeWidth={1.7} />
          </span>
          <strong>No saved jobs yet</strong>
          <p>Your first submitted research request will appear here.</p>
        </div>
      ) : null}

      {jobs.length > 0 ? (
        <div className="saved-job-list">
          {jobs.map((job) => (
            <Link
              className="saved-job-card saved-job-card-link"
              href={jobDetailHref(job)}
              key={job.jobId}
            >
              <div className="saved-job-card-topline">
                <span className="mono">{job.jobId}</span>
                <StatusBadge status={job.status} />
              </div>
              <p>{job.originalTask}</p>
              <dl className="saved-job-card-facts">
                <div>
                  <dt>Job type</dt>
                  <dd>{jobTypeLabel(job.typeOfJob)}</dd>
                </div>
                <div>
                  <dt>Orchestrator instance</dt>
                  <dd className="mono">{job.orchestratorInstanceId ?? "null"}</dd>
                </div>
              </dl>
              <time dateTime={job.createdAt}>
                Created {new Date(job.createdAt).toLocaleString()}
              </time>
            </Link>
          ))}
        </div>
      ) : null}

      <p className="job-preview-note">
        Job records and the single active-job lock live in DynamoDB.
      </p>
    </div>
  );
}
