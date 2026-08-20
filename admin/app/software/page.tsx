"use client";

import { ChevronDown, GitBranch, LockKeyhole, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Sidebar } from "@/components/sidebar";
import {
  GITHUB_REPOSITORY_DESCRIPTION_MAX_LENGTH,
  GITHUB_REPOSITORY_NAME_MAX_LENGTH,
  isCreateGitHubRepositoryResponse,
  isGitHubRepositoriesResponse,
  repositoryNameError,
  type GitHubRepositorySummary,
} from "@/lib/github-repository-types";
import {
  isProjectsResponse,
  type ProjectSummary,
} from "@/lib/project-uploads";

interface PendingRepository {
  name: string;
  description: string;
}

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

export default function SoftwareBuilderPage() {
  const [contextOpen, setContextOpen] = useState(false);
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
  const [createRepositoryOpen, setCreateRepositoryOpen] = useState(false);
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryDescription, setRepositoryDescription] = useState("");
  const [repositoryFormError, setRepositoryFormError] = useState<string | null>(
    null,
  );
  const [pendingRepository, setPendingRepository] =
    useState<PendingRepository | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepositorySummary[]>([]);
  const [organization, setOrganization] = useState("");
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const [selectedRepository, setSelectedRepository] =
    useState<GitHubRepositorySummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const repositoryPickerRef = useRef<HTMLDivElement>(null);
  const contextPickerRef = useRef<HTMLDivElement>(null);
  const createRepositoryButtonRef = useRef<HTMLButtonElement>(null);

  const closeCreateRepository = useCallback(() => {
    setCreateRepositoryOpen(false);
    setRepositoryFormError(null);
    window.requestAnimationFrame(() => createRepositoryButtonRef.current?.focus());
  }, []);

  const loadRepositories = useCallback(async () => {
    setRepositoriesLoading(true);
    setRepositoriesError(null);
    try {
      const response = await fetch("/api/github/repositories", {
        cache: "no-store",
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          responseError(
            payload,
            `Repository request failed (${response.status}).`,
          ),
        );
      }
      if (!isGitHubRepositoriesResponse(payload)) {
        throw new Error("The admin server returned an unexpected repository list.");
      }
      setOrganization(payload.organization);
      setRepositories(payload.repositories);
      setSelectedRepository((current) => {
        if (!current) return null;
        return (
          payload.repositories.find((repository) => repository.id === current.id) ??
          null
        );
      });
    } catch (caught) {
      setRepositoriesError(
        caught instanceof Error
          ? caught.message
          : "Repositories could not be loaded.",
      );
    } finally {
      setRepositoriesLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
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
  }, []);

  useEffect(() => {
    if (!repositoryPickerOpen) return;

    function closeRepositoryMenu(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !repositoryPickerRef.current?.contains(event.target)
      ) {
        setRepositoryPickerOpen(false);
      }
    }

    function closeRepositoryMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setRepositoryPickerOpen(false);
    }

    document.addEventListener("mousedown", closeRepositoryMenu);
    window.addEventListener("keydown", closeRepositoryMenuOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeRepositoryMenu);
      window.removeEventListener("keydown", closeRepositoryMenuOnEscape);
    };
  }, [repositoryPickerOpen]);

  useEffect(() => {
    if (!contextOpen) return;

    function closeContextMenu(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !contextPickerRef.current?.contains(event.target)
      ) {
        setContextOpen(false);
      }
    }

    function closeContextMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setContextOpen(false);
    }

    document.addEventListener("mousedown", closeContextMenu);
    window.addEventListener("keydown", closeContextMenuOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeContextMenu);
      window.removeEventListener("keydown", closeContextMenuOnEscape);
    };
  }, [contextOpen]);

  useEffect(() => {
    if (!createRepositoryOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeCreateRepository();
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeCreateRepository, createRepositoryOpen]);

  function toggleRepositoryMenu() {
    setContextOpen(false);
    if (repositoryPickerOpen) {
      setRepositoryPickerOpen(false);
      return;
    }
    setRepositoryPickerOpen(true);
    void loadRepositories();
  }

  function toggleContextMenu() {
    setRepositoryPickerOpen(false);
    if (contextOpen) {
      setContextOpen(false);
      return;
    }
    setContextOpen(true);
    void loadProjects();
  }

  function openCreateRepository() {
    setRepositoryPickerOpen(false);
    setRepositoryName(pendingRepository?.name ?? "");
    setRepositoryDescription(pendingRepository?.description ?? "");
    setRepositoryFormError(null);
    setCreateRepositoryOpen(true);
  }

  function saveRepositoryDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedName = repositoryName.trim();
    const invalidName = repositoryNameError(normalizedName);
    if (invalidName) {
      setRepositoryFormError(invalidName);
      return;
    }

    setPendingRepository({
      name: normalizedName,
      description: repositoryDescription.trim(),
    });
    setSelectedRepository(null);
    setSubmitError(null);
    setSubmitNotice(null);
    closeCreateRepository();
  }

  async function submitSoftwareBuilder() {
    setSubmitError(null);
    setSubmitNotice(null);

    if (!pendingRepository) {
      if (selectedRepository) {
        setSubmitNotice(
          `${selectedRepository.fullName} is selected. No new repository was created.`,
        );
      }
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/github/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pendingRepository),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          responseError(
            payload,
            `Repository creation failed (${response.status}).`,
          ),
        );
      }
      if (!isCreateGitHubRepositoryResponse(payload)) {
        throw new Error("The admin server returned an unexpected repository.");
      }

      const createdRepository = payload.repository;
      setOrganization(payload.organization);
      setRepositories((current) =>
        [...current.filter((repository) => repository.id !== createdRepository.id), createdRepository].sort(
          (left, right) => left.name.localeCompare(right.name),
        ),
      );
      setSelectedRepository(createdRepository);
      setPendingRepository(null);
      setSubmitNotice(`${createdRepository.fullName} was created and selected.`);
    } catch (caught) {
      setSubmitError(
        caught instanceof Error
          ? caught.message
          : "The repository could not be created.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <main className="software-builder-main grid-surface">
          <div className="software-builder-workspace">
            <div className="software-builder-panels">
              <section className="software-builder-panel software-idea-panel">
                <h1>DESCRIBE YOUR IDEA</h1>
                <div className="software-builder-panel-body">
                  <label className="sr-only" htmlFor="software-idea">
                    Describe your software idea
                  </label>
                  <textarea
                    id="software-idea"
                    placeholder="Describe what you would like to build…"
                  />
                </div>
              </section>

              <section className="software-builder-panel software-repos-panel">
                <h2>GITHUB REPOS</h2>
                <div className="software-builder-panel-body">
                  <div className="software-repo-controls">
                    <button
                      ref={createRepositoryButtonRef}
                      className="software-create-repository-trigger"
                      data-testid="create-repository-trigger"
                      type="button"
                      onClick={openCreateRepository}
                    >
                      <span>
                        <strong>Create a new project</strong>
                        {pendingRepository ? (
                          <small>{pendingRepository.name}</small>
                        ) : null}
                      </span>
                      <GitBranch size={17} strokeWidth={1.8} aria-hidden="true" />
                    </button>

                    <div
                      className="software-repository-picker"
                      ref={repositoryPickerRef}
                    >
                      <button
                        className={
                          repositoryPickerOpen
                            ? "software-repository-picker-panel is-open"
                            : "software-repository-picker-panel"
                        }
                        data-testid="repository-picker-trigger"
                        type="button"
                        aria-expanded={repositoryPickerOpen}
                        aria-controls="software-repository-picker-menu"
                        onClick={toggleRepositoryMenu}
                      >
                        <span>
                          <strong>Pick an Existing Project</strong>
                          {selectedRepository ? (
                            <small>{selectedRepository.fullName}</small>
                          ) : organization ? (
                            <small>{organization}</small>
                          ) : null}
                        </span>
                        <ChevronDown
                          size={17}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      </button>

                      {repositoryPickerOpen ? (
                        <div
                          className="software-repository-picker-menu"
                          data-testid="repository-picker-menu"
                          id="software-repository-picker-menu"
                          role="listbox"
                          aria-label="GitHub organization repositories"
                        >
                          {repositoriesLoading ? (
                            <div className="software-context-state" role="status">
                              <RefreshCw
                                className="software-context-spin"
                                size={15}
                                aria-hidden="true"
                              />
                              Loading repositories…
                            </div>
                          ) : repositoriesError ? (
                            <div
                              className="software-context-state is-error"
                              role="alert"
                            >
                              <span>{repositoriesError}</span>
                              <button
                                type="button"
                                onClick={() => void loadRepositories()}
                              >
                                Try again
                              </button>
                            </div>
                          ) : repositories.length === 0 ? (
                            <div className="software-context-state">
                              No repositories found in this organization.
                            </div>
                          ) : (
                            <div className="software-repository-options">
                              {repositories.map((repository) => (
                                <button
                                  className={
                                    selectedRepository?.id === repository.id
                                      ? "is-selected"
                                      : undefined
                                  }
                                  key={repository.id}
                                  type="button"
                                  role="option"
                                  aria-selected={
                                    selectedRepository?.id === repository.id
                                  }
                                  onClick={() => {
                                    setSelectedRepository(repository);
                                    setPendingRepository(null);
                                    setSubmitError(null);
                                    setSubmitNotice(null);
                                    setRepositoryPickerOpen(false);
                                  }}
                                >
                                  <span>
                                    <strong>{repository.name}</strong>
                                    <small>
                                      {repository.description || repository.fullName}
                                    </small>
                                  </span>
                                  <em>{repository.visibility}</em>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {pendingRepository ? (
                    <div className="software-repository-pending" role="status">
                      <GitBranch size={16} strokeWidth={1.8} aria-hidden="true" />
                      <span>
                        <strong>{pendingRepository.name}</strong>
                        Will be created only when you click Submit.
                      </span>
                      <button type="button" onClick={openCreateRepository}>
                        Edit
                      </button>
                    </div>
                  ) : null}

                  {submitError ? (
                    <div className="software-repository-submit-state is-error" role="alert">
                      {submitError}
                    </div>
                  ) : submitNotice ? (
                    <div className="software-repository-submit-state" role="status">
                      {submitNotice}
                    </div>
                  ) : null}
                </div>
              </section>

              <div className="software-context-picker" ref={contextPickerRef}>
                <button
                  className={
                    contextOpen
                      ? "software-context-panel is-open"
                      : "software-context-panel"
                  }
                  type="button"
                  aria-expanded={contextOpen}
                  aria-controls="software-context-menu"
                  onClick={toggleContextMenu}
                >
                  <span>
                    <strong>Add Project Context</strong>
                    {selectedProject ? <small>{selectedProject}</small> : null}
                  </span>
                  <ChevronDown size={17} strokeWidth={1.8} aria-hidden="true" />
                </button>

                {contextOpen ? (
                  <div
                    className="software-context-menu"
                    id="software-context-menu"
                    role="listbox"
                    aria-label="Global memory projects"
                  >
                    {projectsLoading ? (
                      <div className="software-context-state" role="status">
                        <RefreshCw
                          className="software-context-spin"
                          size={15}
                          aria-hidden="true"
                        />
                        Loading projects…
                      </div>
                    ) : projectsError ? (
                      <div className="software-context-state is-error" role="alert">
                        <span>{projectsError}</span>
                        <button type="button" onClick={() => void loadProjects()}>
                          Try again
                        </button>
                      </div>
                    ) : projects.length === 0 ? (
                      <div className="software-context-state">
                        No project folders found.
                      </div>
                    ) : (
                      <div className="software-context-options">
                        {projects.map((project) => (
                          <button
                            className={
                              selectedProject === project.name
                                ? "is-selected"
                                : undefined
                            }
                            key={project.name}
                            type="button"
                            role="option"
                            aria-selected={selectedProject === project.name}
                            onClick={() => {
                              setSelectedProject(project.name);
                              setContextOpen(false);
                            }}
                          >
                            {project.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>

            <footer className="software-builder-actions">
              <button className="software-builder-footer-button" type="button">
                PAST JOBS
              </button>
              <button
                className="software-builder-submit"
                data-testid="software-builder-submit"
                type="button"
                disabled={
                  submitting || (!pendingRepository && !selectedRepository)
                }
                onClick={() => void submitSoftwareBuilder()}
              >
                {submitting ? "CREATING REPO…" : "SUBMIT"}
              </button>
            </footer>
          </div>
        </main>
      </div>

      {createRepositoryOpen ? (
        <div
          className="software-repository-modal-backdrop"
          onMouseDown={closeCreateRepository}
        >
          <section
            className="software-repository-modal"
            data-testid="create-repository-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="software-repository-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="software-repository-modal-header">
              <div className="software-repository-modal-heading">
                <span className="software-repository-modal-icon" aria-hidden="true">
                  <GitBranch size={21} strokeWidth={1.8} />
                </span>
                <div>
                  <h2 id="software-repository-modal-title">New GitHub Repo</h2>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close create repository dialog"
                onClick={closeCreateRepository}
              >
                <X size={17} aria-hidden="true" />
              </button>
            </header>

            <form onSubmit={saveRepositoryDetails}>
              <div className="software-repository-form-fields">
                <label htmlFor="software-repository-name">
                  <span>
                    Repository name <strong>Required</strong>
                  </span>
                  <input
                    autoFocus
                    id="software-repository-name"
                    name="repositoryName"
                    type="text"
                    required
                    maxLength={GITHUB_REPOSITORY_NAME_MAX_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                    value={repositoryName}
                    placeholder="e.g. customer-insights-dashboard"
                    onChange={(event) => {
                      setRepositoryName(event.target.value);
                      setRepositoryFormError(null);
                    }}
                  />
                  <small>
                    Letters, numbers, periods, hyphens, and underscores only.
                  </small>
                </label>

                <label htmlFor="software-repository-description">
                  <span>
                    Description <em>Optional</em>
                  </span>
                  <textarea
                    id="software-repository-description"
                    name="repositoryDescription"
                    rows={4}
                    maxLength={GITHUB_REPOSITORY_DESCRIPTION_MAX_LENGTH}
                    value={repositoryDescription}
                    placeholder="What does this repository do?"
                    onChange={(event) => {
                      setRepositoryDescription(event.target.value);
                      setRepositoryFormError(null);
                    }}
                  />
                  <small>
                    {repositoryDescription.length}/
                    {GITHUB_REPOSITORY_DESCRIPTION_MAX_LENGTH} characters
                  </small>
                </label>
              </div>

              <div className="software-repository-privacy-note">
                <LockKeyhole size={15} strokeWidth={1.8} aria-hidden="true" />
                <span>
                  <strong>Created on Submit</strong>
                  These details are staged here first. The private repository will
                  only be created when you click Submit.
                </span>
              </div>

              {repositoryFormError ? (
                <div className="software-repository-form-error" role="alert">
                  {repositoryFormError}
                </div>
              ) : null}

              <footer className="software-repository-modal-actions">
                <button
                  className="software-repository-cancel"
                  type="button"
                  onClick={closeCreateRepository}
                >
                  Cancel
                </button>
                <button
                  className="software-repository-create"
                  type="submit"
                  disabled={!repositoryName.trim()}
                >
                  <GitBranch size={15} strokeWidth={1.9} aria-hidden="true" />
                  Save details
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
