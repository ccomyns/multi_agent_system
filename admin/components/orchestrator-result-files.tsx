"use client";

import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  File,
  Folder,
  Plus,
  RefreshCw,
  Search,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  isProjectsResponse,
  isProjectUploadResponse,
  type ProjectSummary,
} from "@/lib/project-uploads";
import {
  isResultArtifactsResponse,
  type ResultArtifact,
} from "@/lib/result-artifacts";

const FILES_PER_PAGE = 10;

type ProjectModalView = "upload" | "create";

function responseError(value: unknown, fallback: string) {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  )
    ? value.error
    : fallback;
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function parentPath(artifact: ResultArtifact) {
  const normalized = artifact.path.replace(/\/$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator === -1 ? "/result" : `/result/${normalized.slice(0, separator)}`;
}

export function OrchestratorResultFiles({ jobId }: { jobId: string }) {
  const [artifacts, setArtifacts] = useState<ResultArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const [projectModalView, setProjectModalView] = useState<ProjectModalView | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);

  const loadArtifacts = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(jobId)}/result-artifacts`,
        { cache: "no-store", signal },
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          responseError(payload, `Result artifact request failed (${response.status}).`),
        );
      }
      if (!isResultArtifactsResponse(payload)) {
        throw new Error("The admin server returned an unexpected result artifact list.");
      }
      setError(null);
      setArtifacts(payload.artifacts);
      setSelectedIds((current) => {
        const available = new Set(payload.artifacts.map((artifact) => artifact.id));
        return new Set([...current].filter((id) => available.has(id)));
      });
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "The result artifacts could not be loaded.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [jobId]);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(jobId)}/projects`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          responseError(payload, `Project request failed (${response.status}).`),
        );
      }
      if (!isProjectsResponse(payload)) {
        throw new Error("The admin server returned an unexpected project list.");
      }
      setProjects(payload.projects);
      setSelectedProject((current) =>
        payload.projects.some((project) => project.name === current) ? current : "",
      );
    } catch (caught) {
      setProjectsError(
        caught instanceof Error ? caught.message : "Projects could not be loaded.",
      );
    } finally {
      setProjectsLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      await loadArtifacts(controller.signal);
    }
    void load();
    return () => controller.abort();
  }, [loadArtifacts]);

  useEffect(() => {
    if (!projectModalView) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !uploading) {
        setProjectModalView(null);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [projectModalView, uploading]);

  const filteredArtifacts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return artifacts;
    return artifacts.filter((artifact) =>
      `${artifact.name} ${artifact.path}`.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [artifacts, query]);
  const pageCount = Math.max(1, Math.ceil(filteredArtifacts.length / FILES_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * FILES_PER_PAGE;
  const visibleArtifacts = filteredArtifacts.slice(start, start + FILES_PER_PAGE);
  const selectedArtifacts = useMemo(
    () => artifacts.filter((artifact) => selectedIds.has(artifact.id)),
    [artifacts, selectedIds],
  );

  function toggleArtifact(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openCreateProject() {
    setProjectName("");
    setProjectDescription("");
    setProjectActionError(null);
    setProjectModalView("create");
  }

  function openProjectModal() {
    setProjectActionError(null);
    setProjectModalView("upload");
    void loadProjects();
  }

  function closeProjectModal() {
    if (uploading) return;
    setProjectActionError(null);
    setProjectModalView(null);
  }

  function returnToProjectSelection() {
    if (uploading) return;
    setProjectActionError(null);
    setProjectModalView("upload");
  }

  async function uploadArtifacts(createProject: boolean) {
    if (uploading) return;
    const name = createProject ? projectName.trim() : selectedProject;
    if (!name) {
      setProjectActionError(
        createProject ? "Enter a project name." : "Select a project before uploading.",
      );
      return;
    }
    if (selectedArtifacts.length === 0) {
      setProjectActionError("Select at least one result file or folder to upload.");
      return;
    }

    setUploading(true);
    setProjectActionError(null);
    setUploadNotice(null);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactIds: selectedArtifacts.map((artifact) => artifact.id),
          createProject,
          description: createProject ? projectDescription.trim() : "",
          projectName: name,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          responseError(payload, `Project upload failed (${response.status}).`),
        );
      }
      if (!isProjectUploadResponse(payload)) {
        throw new Error("The admin server returned an unexpected upload result.");
      }

      setProjects((current) => {
        if (current.some((project) => project.name === payload.projectName)) return current;
        return [...current, { name: payload.projectName }].sort((left, right) =>
          left.name.localeCompare(right.name, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );
      });
      setSelectedProject(payload.projectName);
      setProjectName("");
      setProjectDescription("");
      setProjectModalView(null);
      setUploadNotice(
        `${payload.uploadedCount.toLocaleString()} ${payload.uploadedCount === 1 ? "object" : "objects"} uploaded to ${payload.projectName}.`,
      );
    } catch (caught) {
      setProjectActionError(
        caught instanceof Error ? caught.message : "The selected artifacts could not be uploaded.",
      );
    } finally {
      setUploading(false);
    }
  }

  function submitCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void uploadArtifacts(true);
  }

  return (
    <div className="agent-detail-page orchestrator-upload-page">
      <Link
        className="data-mining-back-link"
        href={`/jobs/${encodeURIComponent(jobId)}/orchestrator`}
      >
        <ArrowLeft size={12} strokeWidth={2} aria-hidden="true" />
        BACK TO ORCHESTRATOR
      </Link>

      <section className="agent-detail-viewer">
        <header className="agent-detail-header">
          <div>
            <span>ORCHESTRATOR DETAILS</span>
            <h1>Upload to Project</h1>
          </div>
          <nav className="agent-detail-tabs" aria-label="Orchestrator detail view">
            <Link href={`/jobs/${encodeURIComponent(jobId)}/orchestrator`}>
              <Clock3 size={12} aria-hidden="true" /> Telemetry
            </Link>
            <Link href={`/jobs/${encodeURIComponent(jobId)}/orchestrator?view=result`}>
              <Database size={12} aria-hidden="true" /> Final Result
            </Link>
            <Link className="is-active" href={`/jobs/${encodeURIComponent(jobId)}/orchestrator/upload`} aria-current="page">
              <Upload size={12} aria-hidden="true" /> Upload to Project
            </Link>
          </nav>
        </header>

        <div className="orchestrator-upload-content">
          <div className="result-file-intro">
            <div>
              <span>JOB RESULT ARTIFACTS</span>
              <h2>Select files and folders</h2>
              <p>Choose the result artifacts that should be included in the next upload step.</p>
            </div>
            <span className="result-file-count">
              {artifacts.length.toLocaleString()} {artifacts.length === 1 ? "item" : "items"}
            </span>
          </div>

          {uploadNotice ? (
            <div className="result-project-upload-notice" role="status">
              <span>{uploadNotice}</span>
              <button
                type="button"
                aria-label="Dismiss upload confirmation"
                onClick={() => setUploadNotice(null)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          ) : null}

          <div className="result-file-search">
            <Search size={15} aria-hidden="true" />
            <label className="sr-only" htmlFor="result-artifact-search">Search result files and folders</label>
            <input
              id="result-artifact-search"
              type="search"
              value={query}
              placeholder="Search file or folder names"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </div>

          <section className="result-file-sheet" aria-label="Result files and folders">
            {loading ? (
              <div className="result-file-state" aria-live="polite">
                <RefreshCw className="telemetry-spin" size={20} aria-hidden="true" />
                <strong>Loading result artifacts…</strong>
              </div>
            ) : error ? (
              <div className="result-file-state result-file-error" role="alert">
                <strong>Result artifacts could not be loaded</strong>
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    setError(null);
                    void loadArtifacts();
                  }}
                >
                  Try again
                </button>
              </div>
            ) : visibleArtifacts.length === 0 ? (
              <div className="result-file-state">
                <Search size={21} strokeWidth={1.6} aria-hidden="true" />
                <strong>{query ? "No matching artifacts" : "No result artifacts yet"}</strong>
                <span>
                  {query
                    ? "Try a different file or folder name."
                    : "Files will appear here after the job publishes them to /result."}
                </span>
              </div>
            ) : (
              <div className="result-file-grid-scroll">
                <table className="result-file-grid">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Location</th>
                      <th>Size</th>
                      <th>Last modified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleArtifacts.map((artifact) => {
                      const Icon = artifact.kind === "folder" ? Folder : File;
                      return (
                        <tr key={artifact.id} className={selectedIds.has(artifact.id) ? "is-selected" : ""}>
                          <td>
                            <label className="result-file-name">
                              <input
                                type="checkbox"
                                checked={selectedIds.has(artifact.id)}
                                onChange={() => toggleArtifact(artifact.id)}
                                aria-label={`Select ${artifact.path}`}
                              />
                              <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                              <span title={artifact.name}>{artifact.name}</span>
                            </label>
                          </td>
                          <td>{artifact.kind === "folder" ? "Folder" : "File"}</td>
                          <td><code title={parentPath(artifact)}>{parentPath(artifact)}</code></td>
                          <td>{formatBytes(artifact.size)}</td>
                          <td><time dateTime={artifact.lastModified ?? undefined}>{formatDate(artifact.lastModified)}</time></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!loading && !error && filteredArtifacts.length > 0 ? (
              <footer className="result-file-pagination">
                <span>
                  Items {(start + 1).toLocaleString()}–{Math.min(start + FILES_PER_PAGE, filteredArtifacts.length).toLocaleString()} of {filteredArtifacts.length.toLocaleString()}
                </span>
                <div>
                  <button
                    type="button"
                    aria-label="Previous artifact page"
                    disabled={safePage === 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    <ChevronLeft size={14} aria-hidden="true" />
                  </button>
                  <span>Page {safePage.toLocaleString()} of {pageCount.toLocaleString()}</span>
                  <button
                    type="button"
                    aria-label="Next artifact page"
                    disabled={safePage === pageCount}
                    onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </div>
              </footer>
            ) : null}

            <button
              className="result-file-upload-button"
              type="button"
              disabled={selectedArtifacts.length === 0}
              onClick={openProjectModal}
            >
              <Upload size={15} aria-hidden="true" />
              {selectedProject
                ? `Upload to ${selectedProject} (${selectedArtifacts.length.toLocaleString()})`
                : `Upload to Project (${selectedArtifacts.length.toLocaleString()})`}
            </button>
          </section>
        </div>
      </section>

      {projectModalView ? (
        <div className="result-file-modal-backdrop" onMouseDown={closeProjectModal}>
          <section
            className="result-file-modal result-project-flow-modal"
            role="dialog"
            aria-modal="true"
            aria-busy={uploading}
            aria-labelledby="project-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>
                  {projectModalView === "upload" && selectedProject
                    ? `UPLOAD TO ${selectedProject.toLocaleUpperCase()}`
                    : "UPLOAD TO PROJECT"}
                </span>
                <h2 id="project-modal-title">
                  {projectModalView === "upload" ? "Choose a destination" : "Create a Project"}
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close project dialog"
                disabled={uploading}
                onClick={closeProjectModal}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>

            {projectModalView === "upload" ? (
              <div className="result-project-upload-view">
                <p>Select an existing project or create a new destination for these artifacts.</p>
                <div className="result-modal-project-controls">
                  <button
                    className="result-project-create"
                    type="button"
                    disabled={uploading}
                    onClick={openCreateProject}
                  >
                    <span>
                      <strong>Create a Project</strong>
                      <small>Add a new project without leaving this popup.</small>
                    </span>
                    <Plus size={17} strokeWidth={1.8} aria-hidden="true" />
                  </button>

                  <label
                    className={selectedProject ? "result-project-select has-selection" : "result-project-select"}
                    htmlFor="result-project-select"
                  >
                    <span>Select a Project</span>
                    <div>
                      <select
                        id="result-project-select"
                        value={selectedProject}
                        disabled={projectsLoading || uploading}
                        onChange={(event) => {
                          setSelectedProject(event.target.value);
                          setProjectActionError(null);
                        }}
                      >
                        <option value="">
                          {projectsLoading
                            ? "Loading projects…"
                            : projectsError
                              ? "Projects unavailable"
                              : projects.length === 0
                                ? "No projects found"
                                : "Choose a project"}
                        </option>
                        {projects.map((project) => (
                          <option key={project.name} value={project.name}>{project.name}</option>
                        ))}
                      </select>
                    </div>
                  </label>
                </div>

                {projectsError ? (
                  <div className="result-project-inline-error" role="alert">
                    <span>{projectsError}</span>
                    <button type="button" disabled={projectsLoading} onClick={() => void loadProjects()}>
                      {projectsLoading ? "Loading…" : "Try again"}
                    </button>
                  </div>
                ) : null}

                {projectActionError ? (
                  <div className="result-project-action-error" role="alert">
                    {projectActionError}
                  </div>
                ) : null}

                <div className="result-modal-selection-heading">
                  <strong>Selected files and folders</strong>
                  <span>{selectedArtifacts.length.toLocaleString()} selected</span>
                </div>
                <ul>
                  {selectedArtifacts.map((artifact) => {
                    const Icon = artifact.kind === "folder" ? Folder : File;
                    return (
                      <li key={artifact.id}>
                        <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                        <span><strong>{artifact.name}</strong><code>/result/{artifact.path}</code></span>
                      </li>
                    );
                  })}
                </ul>
                <footer className="result-project-modal-actions">
                  <button className="secondary-button" type="button" disabled={uploading} onClick={closeProjectModal}>Cancel</button>
                  <button
                    className="result-project-submit"
                    type="button"
                    disabled={!selectedProject || uploading}
                    onClick={() => void uploadArtifacts(false)}
                  >
                    {uploading ? "Uploading…" : "Upload"}
                  </button>
                </footer>
              </div>
            ) : (
              <form className="result-project-create-view" onSubmit={submitCreateProject}>
                <button className="result-project-flow-back" type="button" disabled={uploading} onClick={returnToProjectSelection}>
                  <ArrowLeft size={13} aria-hidden="true" /> Back to project selection
                </button>
                <p>Enter a name and an optional description for the new project.</p>
                <div className="result-project-form-fields">
                  <label>
                    <span>Project name</span>
                    <input
                      autoFocus
                      required
                      maxLength={80}
                      disabled={uploading}
                      value={projectName}
                      placeholder="e.g. Customer Research"
                      onChange={(event) => setProjectName(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Short description <small>Optional</small></span>
                    <textarea
                      maxLength={240}
                      rows={3}
                      disabled={uploading}
                      value={projectDescription}
                      placeholder="What will this project contain?"
                      onChange={(event) => setProjectDescription(event.target.value)}
                    />
                  </label>
                </div>

                {projectActionError ? (
                  <div className="result-project-action-error" role="alert">
                    {projectActionError}
                  </div>
                ) : null}

                <footer className="result-project-modal-actions">
                  <button className="secondary-button" type="button" disabled={uploading} onClick={returnToProjectSelection}>Cancel</button>
                  <button className="result-project-submit" type="submit" disabled={uploading || !projectName.trim()}>
                    {uploading ? "Uploading…" : "Upload"}
                  </button>
                </footer>
              </form>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
