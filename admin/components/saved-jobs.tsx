"use client";

import { BriefcaseBusiness, Inbox } from "lucide-react";
import Link from "next/link";

import { StatusBadge } from "@/components/status-badge";
import { usePreviewJobs } from "@/lib/jobs";

export function SavedJobs() {
  const { jobs, hydrated } = usePreviewJobs();

  return (
    <div className="saved-jobs-content">
      <header className="saved-jobs-heading">
        <div>
          <span className="eyebrow">Job history</span>
          <h1>Saved Jobs</h1>
          <p>Original requests and lifecycle state for your research jobs.</p>
        </div>
        <Link className="primary-button" href="/jobs/new">
          <BriefcaseBusiness size={15} aria-hidden="true" />
          {jobs.some((job) => job.status === "initializing" || job.status === "running")
            ? "View active job"
            : "Create a job"}
        </Link>
      </header>

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
            <article className="saved-job-card" key={job.jobId}>
              <div className="saved-job-card-topline">
                <span className="mono">{job.jobId}</span>
                <StatusBadge status={job.status} />
              </div>
              <p>{job.originalQuery}</p>
              <time dateTime={job.createdAt}>
                Created {new Date(job.createdAt).toLocaleString()}
              </time>
            </article>
          ))}
        </div>
      ) : null}

      <p className="job-preview-note">
        Static preview · these records currently use local browser storage, not a cloud
        database.
      </p>
    </div>
  );
}
