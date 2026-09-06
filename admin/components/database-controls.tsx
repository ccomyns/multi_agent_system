"use client";

import { ChevronDown, Database, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { databaseNameError, DATABASE_DESCRIPTION_MAX_LENGTH, isDatabaseSummary, type DatabaseSummary } from "@/lib/database-types";

export interface DatabaseSelection {
  name: string;
  description: string | null;
  create: boolean;
}

export function DatabaseControls({ value, onChange, disabled }: {
  value: DatabaseSelection | null;
  onChange: (value: DatabaseSelection | null) => void;
  disabled: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const modal = useRef<HTMLElement>(null);

  function closeModal() {
    setModalOpen(false);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!pickerOpen) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) setPickerOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); window.removeEventListener("keydown", escape); };
  }, [pickerOpen]);

  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModal();
      if (event.key !== "Tab") return;
      const elements = modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea');
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keyboard);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", keyboard); };
  }, [modalOpen]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/databases", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Databases could not be loaded.");
      if (!Array.isArray(payload.databases) || !payload.databases.every(isDatabaseSummary)) throw new Error("The server returned an unexpected database list.");
      setDatabases(payload.databases);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Databases could not be loaded."); }
    finally { setLoading(false); }
  }

  function openModal() {
    setPickerOpen(false);
    setName(value?.create ? value.name : "");
    setDescription(value?.create ? value.description ?? "" : "");
    setFormError(null);
    setModalOpen(true);
  }

  return <>
    <div className="software-repo-controls software-database-controls">
      <button ref={trigger} className="software-create-repository-trigger" data-testid="create-database-trigger" type="button" disabled={disabled} onClick={openModal}>
        <span><strong>Create a New Database</strong>{value?.create ? <small>{value.name}</small> : null}</span>
        <Database size={17} aria-hidden="true" />
      </button>
      <div className="software-repository-picker" ref={picker}>
        <button className={`software-repository-picker-panel${pickerOpen ? " is-open" : ""}`} data-testid="database-picker-trigger" type="button" disabled={disabled} aria-expanded={pickerOpen} aria-controls="software-database-menu" onClick={() => { setPickerOpen(!pickerOpen); if (!pickerOpen) void load(); }}>
          <span><strong>Pick an Existing Database</strong>{value && !value.create ? <small>{value.name}</small> : null}</span>
          <ChevronDown size={17} aria-hidden="true" />
        </button>
        {pickerOpen ? <div className="software-context-menu" id="software-database-menu" data-testid="database-picker-menu">
          {loading ? <div className="software-context-state" role="status">Loading databases…</div>
            : error ? <div className="software-context-state is-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>Try again</button></div>
            : databases.length === 0 ? <div className="software-context-state">No databases found.</div>
            : <div className="software-context-options software-database-options">
              {databases.map((database) => (
                <button
                  key={database.name}
                  className={value?.name === database.name && !value.create ? "is-selected" : undefined}
                  type="button"
                  disabled={disabled || !database.managed}
                  aria-pressed={value?.name === database.name && !value.create}
                  onClick={() => { onChange({ ...database, create: false }); setPickerOpen(false); }}
                >
                  <strong>{database.name}</strong>
                  {!database.managed ? <small>Unavailable — managed credentials required</small> : null}
                  {database.description ? <small>{database.description}</small> : null}
                </button>
              ))}
            </div>}
        </div> : null}
      </div>
    </div>
    {value ? <div className="software-repository-pending" role="status"><Database size={16} aria-hidden="true" /><span><strong>{value.name}</strong>{value.create ? "Will be created only when you click Submit." : "Selected runtime database."}</span>{value.create ? <button type="button" disabled={disabled} onClick={openModal}>Edit</button> : null}<button type="button" disabled={disabled} onClick={() => onChange(null)}>Clear</button></div> : null}
    {modalOpen ? <div className="software-repository-modal-backdrop" onMouseDown={closeModal}>
      <section ref={modal} className="software-repository-modal" data-testid="create-database-dialog" role="dialog" aria-modal="true" aria-labelledby="software-database-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="software-repository-modal-header"><div className="software-repository-modal-heading"><Database size={21} aria-hidden="true" /><h2 id="software-database-title">New Database</h2></div><button type="button" aria-label="Close create database dialog" onClick={closeModal}><X size={17} /></button></header>
        <form onSubmit={(event) => {
          event.preventDefault();
          const invalid = databaseNameError(name.trim());
          if (invalid) { setFormError(invalid); return; }
          onChange({ name: name.trim(), description: description.trim(), create: true });
          closeModal();
        }}>
          <div className="software-repository-form-fields">
            <label htmlFor="software-database-name"><span>Database name <strong>Required</strong></span><input autoFocus id="software-database-name" required maxLength={63} autoComplete="off" spellCheck={false} value={name} placeholder="e.g. customer_insights" onChange={(event) => { setName(event.target.value); setFormError(null); }} /><small>Lowercase letters, numbers, and underscores; start with a letter.</small></label>
            <label htmlFor="software-database-description"><span>Description <em>Optional</em></span><textarea id="software-database-description" rows={3} maxLength={DATABASE_DESCRIPTION_MAX_LENGTH} value={description} onChange={(event) => setDescription(event.target.value)} /><small>{description.length}/{DATABASE_DESCRIPTION_MAX_LENGTH} characters</small></label>
          </div>
          <div className="software-repository-privacy-note"><Database size={15} aria-hidden="true" /><span><strong>Created on Submit</strong>Save these details now. The database will only be created when you click Submit.</span></div>
          {formError ? <div className="software-repository-form-error" role="alert">{formError}</div> : null}
          <footer className="software-repository-modal-actions"><button className="software-repository-cancel" type="button" onClick={closeModal}>Cancel</button><button className="software-repository-create" type="submit" disabled={!name.trim()}>Save details</button></footer>
        </form>
      </section>
    </div> : null}
  </>;
}
