"use client";

import {
  ArrowUp,
  Bot,
  Database,
  FileJson,
  FileSpreadsheet,
  Paperclip,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { DEFAULT_JOB_TYPE, jobDetailHref, jobTypeLabel } from "@/lib/jobs";
import type { JobType } from "@/lib/jobs";
import { useJobs } from "@/lib/use-jobs";

const MAX_ANCHOR_FILE_BYTES = 25 * 1024 * 1024;
const ACCEPTED_ANCHOR_EXTENSIONS = new Set([".json", ".xlsx", ".xls", ".xlsm"]);

function fileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function anchorFileError(file: File) {
  if (!ACCEPTED_ANCHOR_EXTENSIONS.has(fileExtension(file.name))) {
    return "Attach a JSON or Excel file (.json, .xlsx, .xls, or .xlsm).";
  }
  if (file.size === 0) {
    return "The anchor file is empty.";
  }
  if (file.size > MAX_ANCHOR_FILE_BYTES) {
    return "The anchor file must be 25 MB or smaller.";
  }
  return null;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function JobComposer() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [jobType, setJobType] = useState<JobType>(DEFAULT_JOB_TYPE);
  const [anchorFile, setAnchorFile] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const { activeJob: job, hydrated, pending, error, launch, end } = useJobs();

  const canAttach = hydrated && !job && !pending;

  function selectAnchorFile(file: File) {
    const validationError = anchorFileError(file);
    if (validationError) {
      setAttachmentError(validationError);
      return;
    }
    setAnchorFile(file);
    setAttachmentError(null);
  }

  useEffect(() => {
    function includesFiles(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }

    function onDragEnter(event: DragEvent) {
      if (!canAttach || !includesFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDraggingFile(true);
    }

    function onDragOver(event: DragEvent) {
      if (!canAttach || !includesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    function onDragLeave(event: DragEvent) {
      if (!canAttach || !includesFiles(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDraggingFile(false);
    }

    function onDrop(event: DragEvent) {
      if (!canAttach || !includesFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFile(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length !== 1) {
        setAttachmentError("Drop one anchor file per job.");
        return;
      }
      selectAnchorFile(files[0]);
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [canAttach]);

  async function submitJob() {
    const originalTask = query.trim();
    if (!originalTask || job || pending) {
      return;
    }

    const launchedJob = await launch(originalTask, jobType, anchorFile);
    if (launchedJob) {
      setQuery("");
      setAnchorFile(null);
      router.push(jobDetailHref(launchedJob));
    }
  }

  return (
    <div className={job ? "job-conversation has-job" : "job-conversation"}>
      {isDraggingFile ? (
        <div className="job-file-drop-overlay" aria-hidden="true">
          <div>
            <Paperclip size={22} strokeWidth={1.8} />
            <strong>Drop to attach anchor data</strong>
            <span>JSON or Excel, up to 25 MB</span>
          </div>
        </div>
      ) : null}
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

      {error || attachmentError ? (
        <div className="job-error" role="alert">
          {error ?? attachmentError}
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
          {anchorFile ? (
            <div className="job-anchor-file" aria-label="Attached anchor file">
              <span className="job-anchor-file-icon" aria-hidden="true">
                {fileExtension(anchorFile.name) === ".json" ? (
                  <FileJson size={16} />
                ) : (
                  <FileSpreadsheet size={16} />
                )}
              </span>
              <span className="job-anchor-file-copy">
                <strong>{anchorFile.name}</strong>
                <span>{formatFileSize(anchorFile.size)} · Anchor data</span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${anchorFile.name}`}
                onClick={() => {
                  setAnchorFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                disabled={!canAttach}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <div className="job-prompt-footer">
            <span>
              {job ? (
                <>
                  <Database size={13} aria-hidden="true" /> Job record holds the active-job lock
                </>
              ) : pending ? (
                anchorFile
                  ? "Uploading anchor data and launching the orchestrator…"
                  : "Claiming the lock and launching the orchestrator…"
              ) : (
                "Shift + Enter for a new line"
              )}
            </span>
            <span className="job-prompt-actions">
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept=".json,.xlsx,.xls,.xlsm,application/json,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                tabIndex={-1}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) selectAnchorFile(file);
                }}
              />
              <button
                type="button"
                className="job-attach-button"
                aria-label="Attach JSON or Excel anchor data"
                title="Attach anchor data"
                onClick={() => fileInputRef.current?.click()}
                disabled={!canAttach}
              >
                <Paperclip size={17} strokeWidth={1.9} aria-hidden="true" />
              </button>
              <button
                type="submit"
                className="job-send-button"
                aria-label="Create job"
                disabled={!hydrated || Boolean(job) || pending || !query.trim()}
              >
                <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
              </button>
            </span>
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
