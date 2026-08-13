"use client";

import { ChevronLeft, ChevronRight, ExternalLink, Table2 } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  DataMiningCell,
  DataMiningColumn,
  DataMiningResult,
  DataMiningTable,
  FinalResultResponse,
} from "@/lib/data-mining-result";

const ROWS_PER_PAGE = 100;

function renderCell(value: DataMiningCell, column: DataMiningColumn) {
  if (value === null) return <span className="result-null">NULL</span>;
  if (column.type === "url" && typeof value === "string") {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" title={value}>
        <span>{value}</span>
        <ExternalLink size={11} aria-hidden="true" />
      </a>
    );
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

function ResultTable({ table, labelledBy }: { table: DataMiningTable; labelledBy?: string }) {
  const [page, setPage] = useState(1);
  const columns = useMemo(() => table.columns.filter((column) => !column.hidden), [table.columns]);
  const pageCount = Math.max(1, Math.ceil(table.rows.length / ROWS_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * ROWS_PER_PAGE;
  const rows = table.rows.slice(start, start + ROWS_PER_PAGE);

  return (
    <section
      className="result-sheet"
      id={`result-table-${table.id}`}
      role={labelledBy ? "tabpanel" : undefined}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : `${table.name} database table`}
    >
      <div className="result-sheet-summary">
        <div>
          <Table2 size={15} aria-hidden="true" />
          <strong>{table.name}</strong>
        </div>
        <span>{table.rows.length.toLocaleString()} {table.rows.length === 1 ? "row" : "rows"}</span>
      </div>

      {table.rows.length === 0 ? (
        <div className="result-empty-table">
          <Table2 size={22} strokeWidth={1.6} aria-hidden="true" />
          <strong>No rows were found</strong>
          <span>The table schema was created successfully, but it contains no records.</span>
        </div>
      ) : (
        <div className="result-grid-scroll">
          <table className="result-grid">
            <thead>
              <tr>
                <th className="result-row-number" aria-label="Row number">#</th>
                {columns.map((column) => <th key={column.key}>{column.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${String(row[table.primary_key])}-${start + rowIndex}`}>
                  <th className="result-row-number" scope="row">{start + rowIndex + 1}</th>
                  {columns.map((column) => (
                    <td key={column.key} className={`result-cell-${column.type}`}>
                      {renderCell(row[column.key], column)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {table.rows.length > 0 ? (
        <footer className="result-pagination">
          <span>
            Rows {(start + 1).toLocaleString()}–{Math.min(start + ROWS_PER_PAGE, table.rows.length).toLocaleString()} of {table.rows.length.toLocaleString()}
          </span>
          <div>
            <button
              type="button"
              aria-label="Previous result page"
              disabled={safePage === 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span>Page {safePage.toLocaleString()} of {pageCount.toLocaleString()}</span>
            <button
              type="button"
              aria-label="Next result page"
              disabled={safePage === pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}

function DatabaseResult({ result }: { result: DataMiningResult }) {
  const [activeTableId, setActiveTableId] = useState(result.tables[0].id);
  const activeTable = result.tables.find((table) => table.id === activeTableId) ?? result.tables[0];

  return (
    <div className="database-result-viewer">
      {result.tables.length === 2 ? (
        <div className="result-table-tabs" role="tablist" aria-label="Result database tables">
          {result.tables.map((table) => (
            <button
              key={table.id}
              id={`result-tab-${table.id}`}
              type="button"
              role="tab"
              aria-controls={`result-table-${table.id}`}
              aria-selected={table.id === activeTable.id}
              className={table.id === activeTable.id ? "is-active" : ""}
              onClick={() => setActiveTableId(table.id)}
            >
              {table.name}
              <span>{table.rows.length.toLocaleString()}</span>
            </button>
          ))}
        </div>
      ) : null}
      <ResultTable
        key={activeTable.id}
        table={activeTable}
        labelledBy={result.tables.length === 2 ? `result-tab-${activeTable.id}` : undefined}
      />
    </div>
  );
}

export function DataMiningResultViewer({ response }: { response: FinalResultResponse }) {
  if (response.view === "database") return <DatabaseResult result={response.result} />;
  return (
    <div className="json-result-fallback">
      <div className="json-result-notice" role="status">
        <strong>Database view unavailable</strong>
        <span>{response.schemaError} The valid JSON result is shown below.</span>
      </div>
      <pre>{JSON.stringify(response.result, null, 2)}</pre>
    </div>
  );
}
