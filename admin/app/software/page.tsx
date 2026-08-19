"use client";

import { ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Sidebar } from "@/components/sidebar";
import {
  isProjectsResponse,
  type ProjectSummary,
} from "@/lib/project-uploads";

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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const contextPickerRef = useRef<HTMLDivElement>(null);

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

  function toggleContextMenu() {
    if (contextOpen) {
      setContextOpen(false);
      return;
    }
    setContextOpen(true);
    void loadProjects();
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
                    <button type="button">Create a new project</button>
                    <label className="sr-only" htmlFor="software-project">
                      Pick an existing project
                    </label>
                    <select id="software-project" defaultValue="">
                      <option value="" disabled>
                        Pick an existing project
                      </option>
                      <option value="example-project-one">Example Project One</option>
                      <option value="example-project-two">Example Project Two</option>
                    </select>
                  </div>
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
                              selectedProject === project.name ? "is-selected" : undefined
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
              <button className="software-builder-submit" type="button">
                SUBMIT
              </button>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
