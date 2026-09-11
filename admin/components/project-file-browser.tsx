"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, File, Folder, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { LoadState, ProjectFrame, useResource } from "@/components/project-management";
import type { ProjectDirectoryResponse } from "@/lib/project-uploads";

const PAGE_SIZE = 100;
function formatBytes(size: number | null) {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function ProjectFileBrowser({ project, path }: { project: string; path: string }) {
  const base = `/projects/storage/${encodeURIComponent(project)}`;
  const folderLink = (directory: string) => directory ? `${base}?${new URLSearchParams({ path: directory })}` : base;
  const { data, error, reload } = useResource<ProjectDirectoryResponse>(`/api/projects/${encodeURIComponent(project)}/files?${new URLSearchParams({ path })}`);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = data?.entries.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase())) ?? [];
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const start = (safePage - 1) * PAGE_SIZE;
  const parts = path.split("/").filter(Boolean);
  const parent = parts.slice(0, -1).join("/");
  return <ProjectFrame>
    <Link className="data-mining-back-link project-back-link" href="/projects?tab=storage"><ArrowLeft size={14} />All project folders</Link>
    <header className="project-heading"><div><span className="eyebrow">File Storage</span><h1>{project}</h1><p>Browse the files and folders in this project.</p></div><button className="project-refresh" onClick={reload}><RefreshCw size={14} />Refresh</button></header>
    <nav className="project-breadcrumbs" aria-label="Folder breadcrumbs"><Link href="/projects?tab=storage">File Storage</Link><ChevronRight size={13} /><Link href={base} aria-current={!path ? "page" : undefined}>{project}</Link>{parts.map((part, index) => <span key={index}><ChevronRight size={13} /><Link href={folderLink(`${parts.slice(0, index + 1).join("/")}/`)} aria-current={index === parts.length - 1 ? "page" : undefined}>{part}</Link></span>)}</nav>
    <section className="project-panel project-file-panel" aria-label="Project files and folders">
      <div className="result-file-intro"><div><span>PROJECT CONTENTS</span><h2>{parts.at(-1) ?? project}</h2><p>Open a folder to view its contents.</p></div><span className="result-file-count">{data ? `${data.entries.length.toLocaleString()} items` : "Loading…"}</span></div>
      <div className="result-file-search"><Search size={15} /><label className="sr-only" htmlFor="project-file-search">Search files and folders</label><input id="project-file-search" type="search" placeholder="Search file or folder names" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></div>
      {path ? <Link className="project-parent-link" href={folderLink(parent ? `${parent}/` : "")}><ArrowLeft size={13} />Up one folder</Link> : null}
      <section className="result-file-sheet" aria-label="Directory contents">
        {!data ? <LoadState error={error} retry={reload} label="Loading folder contents…" /> : !filtered.length ? <div className="result-file-state"><Folder size={24} /><strong>{query ? "No matching files or folders" : "This folder is empty"}</strong><span>{query ? "Try a different name." : "Files saved to this folder will appear here."}</span></div> : <div className="result-file-grid-scroll"><table className="result-file-grid"><thead><tr><th>Name</th><th>Type</th><th>Location</th><th>Size</th><th>Last modified</th></tr></thead><tbody>
          {filtered.slice(start, start + PAGE_SIZE).map((entry) => <tr key={entry.path}><td>{entry.kind === "folder" ? <Link className="result-file-name" href={folderLink(entry.path)}><Folder size={15} /><span title={entry.name}>{entry.name}</span></Link> : <span className="result-file-name project-file-label"><File size={15} /><span title={entry.name}>{entry.name}</span></span>}</td><td>{entry.kind === "folder" ? "Folder" : "File"}</td><td><code title={`${project}/${path}`}>{project}/{path}</code></td><td>{formatBytes(entry.size)}</td><td><time dateTime={entry.modifiedAt ?? undefined}>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : "—"}</time></td></tr>)}
        </tbody></table></div>}
        {data && filtered.length > 0 ? <footer className="result-file-pagination"><span>Items {(start + 1).toLocaleString()}–{Math.min(start + PAGE_SIZE, filtered.length).toLocaleString()} of {filtered.length.toLocaleString()}</span><div><button aria-label="Previous file page" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}><ChevronLeft size={14} /></button><span>Page {safePage} of {pages}</span><button aria-label="Next file page" disabled={safePage === pages} onClick={() => setPage(safePage + 1)}><ChevronRight size={14} /></button></div></footer> : null}
      </section>
    </section>
  </ProjectFrame>;
}
