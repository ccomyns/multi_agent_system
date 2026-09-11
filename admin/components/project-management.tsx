"use client";

import { ArrowLeft, ArrowRight, Database, Folder, RefreshCw, Search, Table2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { ResultTable } from "@/components/data-mining-result-viewer";
import type { DatabaseSummary, DatabaseTableSummary, DatabaseTablePage } from "@/lib/database-types";

export function useResource<T>(url: string | null) {
  const [state, setState] = useState<{ url: string | null; data?: T; error?: string }>({ url: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Unable to load this page.");
        if (!controller.signal.aborted) setState({ url, data: body as T });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ url, error: error instanceof Error ? error.message : "Unable to load this page." });
      });
    return () => controller.abort();
  }, [url, revision]);
  return {
    data: state.url === url ? state.data : undefined,
    error: state.url === url ? state.error : undefined,
    reload: () => { setState({ url: null }); setRevision((value) => value + 1); },
  };
}

export function LoadState({ error, retry, label }: { error?: string; retry: () => void; label: string }) {
  return <div className="project-state" role={error ? "alert" : "status"}>
    <p>{error ?? label}</p>{error ? <button className="project-refresh" onClick={retry}>Try again</button> : null}
  </div>;
}

export function ProjectFrame({ children }: { children: React.ReactNode }) {
  return <div className="app-shell app-layout"><Sidebar /><div className="app-body"><main className="project-main">{children}</main></div></div>;
}

export function ProjectManagement({ initialTab = "databases" }: { initialTab?: "databases" | "storage" }) {
  const [tab, setTab] = useState<"databases" | "storage">(initialTab);
  const [search, setSearch] = useState("");
  const databases = useResource<{ databases: DatabaseSummary[] }>(tab === "databases" ? "/api/databases" : null);
  const storage = useResource<{ projects: Array<{ name: string }> }>(tab === "storage" ? "/api/projects" : null);
  const active = tab === "databases" ? databases : storage;
  const items = tab === "databases" ? databases.data?.databases : storage.data?.projects;
  const filtered = items?.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  return <ProjectFrame>
    <header className="project-heading"><div><span className="eyebrow">Workspace</span><h1>Project Management</h1><p>Explore your databases and project file storage.</p></div></header>
    <div className="project-switch" aria-label="Project resources">
      <button aria-pressed={tab === "databases"} className={tab === "databases" ? "is-active" : ""} onClick={() => { setTab("databases"); setSearch(""); }}><Database size={17} />Databases</button>
      <button aria-pressed={tab === "storage"} className={tab === "storage" ? "is-active" : ""} onClick={() => { setTab("storage"); setSearch(""); }}><Folder size={17} />File Storage</button>
    </div>
    <section className="project-panel" aria-label={tab === "databases" ? "Databases" : "File Storage"}>
      <div className="project-toolbar"><div><h2>{tab === "databases" ? "Databases" : "Project folders"}</h2><p>{tab === "databases" ? "Select a database to explore its tables and records." : "Project folders in your global-memory storage."}</p></div><button className="project-refresh" onClick={active.reload}><RefreshCw size={14} />Refresh</button></div>
      <label className="project-search"><Search size={16} /><span className="sr-only">Search {tab === "databases" ? "databases" : "folders"}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === "databases" ? "Search databases…" : "Search folders…"} /></label>
      {!items ? <LoadState error={active.error} retry={active.reload} label="Loading resources…" /> : filtered?.length === 0 ? <div className="project-state">{search ? "No matching results." : tab === "databases" ? "No databases found." : "No project folders found."}</div> : <div className="project-resource-list">
        {filtered?.map((item) => tab === "databases" ? <Link className="project-resource" key={item.name} href={`/projects/databases/${encodeURIComponent(item.name)}`}><span className="project-resource-icon"><Database size={20} /></span><div><strong>{item.name}</strong><span>{"description" in item && item.description ? String(item.description) : "Browse tables and records"}</span></div><ArrowRight size={17} /></Link> : <Link className="project-resource" key={item.name} href={`/projects/storage/${encodeURIComponent(item.name)}`}><span className="project-resource-icon"><Folder size={20} /></span><div><strong>{item.name}</strong><span>{item.name}/</span></div><ArrowRight size={17} /></Link>)}
      </div>}
      {items ? <div className="project-list-footer">{items.length.toLocaleString()} {tab === "databases" ? "databases" : "folders"}</div> : null}
    </section>
  </ProjectFrame>;
}

export function DatabaseExplorer({ database }: { database: string }) {
  const base = `/api/databases/${encodeURIComponent(database)}/tables`;
  const tables = useResource<{ tables: DatabaseTableSummary[] }>(base);
  const [selection, setSelection] = useState<DatabaseTableSummary | null>(null);
  const [page, setPage] = useState(1);
  const selected = tables.data?.tables.find((table) => table.schema === selection?.schema && table.name === selection?.name) ?? tables.data?.tables[0];
  const params = selected ? new URLSearchParams({ schema: selected.schema, table: selected.name, page: String(page) }) : null;
  const records = useResource<DatabaseTablePage>(params ? `${base}?${params}` : null);
  const [search, setSearch] = useState("");
  const visibleTables = tables.data?.tables.filter((table) => `${table.schema}.${table.name}`.toLowerCase().includes(search.toLowerCase()));
  return <ProjectFrame>
    <Link className="data-mining-back-link project-back-link" href="/projects"><ArrowLeft size={14} />All databases</Link>
    <header className="project-heading"><div><span className="eyebrow">Database</span><h1>{database}</h1><p>Browse tables and records. Data is read-only.</p></div><button className="project-refresh" onClick={() => { tables.reload(); records.reload(); }}><RefreshCw size={14} />Refresh</button></header>
    {!tables.data ? <LoadState error={tables.error} retry={tables.reload} label="Loading tables…" /> : !tables.data.tables.length ? <div className="project-panel project-state"><Table2 size={28} /><h2>No tables yet</h2><p>This database has no accessible user tables.</p></div> : <div className="project-database-layout">
      <aside className="project-table-nav" aria-label="Database tables"><h2>Tables <span>{tables.data.tables.length}</span></h2><label className="project-search"><Search size={14} /><span className="sr-only">Search tables</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a table…" /></label>
        {visibleTables?.map((table) => <button key={JSON.stringify([table.schema, table.name])} aria-pressed={selected?.schema === table.schema && selected?.name === table.name} className={selected?.schema === table.schema && selected?.name === table.name ? "is-active" : ""} onClick={() => { setSelection(table); setPage(1); }}><Table2 size={15} /><span><strong>{table.name}</strong><small>{table.schema}</small></span></button>)}
        {!visibleTables?.length ? <p className="project-state">No matching tables.</p> : null}
      </aside>
      <div className="project-table-content">
        {selected ? <div className="project-table-title"><Table2 size={16} /><strong>{selected.schema}.{selected.name}</strong><span>{records.data?.columns.length ?? "—"} columns</span></div> : null}
        {!records.data ? <LoadState error={records.error} retry={records.reload} label="Loading records…" /> : selected ? <ResultTable table={{ id: "live-database", name: `${selected.schema}.${selected.name}`, primary_key: "", columns: records.data.columns.map((column) => ({ key: column.name, label: column.name, type: "text", hidden: false, nullable: column.nullable })), rows: records.data.rows }} pagination={{ page, pageSize: records.data.pageSize, hasMore: records.data.hasMore, onPageChange: setPage }} /> : null}
      </div>
    </div>}
  </ProjectFrame>;
}
