"use client";

import { Database, HardDrive, RefreshCw } from "lucide-react";
import { useState } from "react";

export type DatabaseResource = {
  id: "agent-workspace" | "audit" | "global-memory" | "jobs" | "state";
  kind: "s3" | "dynamodb";
  label: string;
  name: string | null;
};

type S3ObjectPreview = {
  key: string;
  size: number;
  lastModified: string | null;
  storageClass: string | null;
};

type ResourcePreview =
  | {
      id: DatabaseResource["id"];
      kind: "s3";
      label: string;
      name: string;
      objects: S3ObjectPreview[];
      isTruncated: boolean;
      limit: number;
    }
  | {
      id: DatabaseResource["id"];
      kind: "dynamodb";
      label: string;
      name: string;
      items: Record<string, unknown>[];
      isTruncated: boolean;
      limit: number;
    };

function isErrorResponse(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function isResourcePreview(value: unknown): value is ResourcePreview {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  return (
    (value.kind === "s3" && "objects" in value && Array.isArray(value.objects)) ||
    (value.kind === "dynamodb" && "items" in value && Array.isArray(value.items))
  );
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function itemLabel(item: Record<string, unknown>, index: number) {
  const keys = [item.pk, item.sk].filter((value): value is string => typeof value === "string");
  return keys.length > 0 ? keys.join("  ·  ") : `Item ${index + 1}`;
}

export function DatabaseManagement({ resources }: { resources: DatabaseResource[] }) {
  const [selectedId, setSelectedId] = useState<DatabaseResource["id"] | null>(null);
  const [preview, setPreview] = useState<ResourcePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspectResource(resource: DatabaseResource) {
    setSelectedId(resource.id);
    setPreview(null);
    setError(null);
    setLoading(true);

    try {
      const response = await fetch(
        `/api/database?resource=${encodeURIComponent(resource.id)}`,
        { cache: "no-store" },
      );
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          isErrorResponse(payload) ? payload.error : `Resource read failed (${response.status}).`,
        );
      }
      if (!isResourcePreview(payload)) {
        throw new Error("The admin server returned an unexpected resource response.");
      }
      setPreview(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The resource could not be read.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="database-management-content">
      <header className="database-management-heading">
        <span className="eyebrow">AWS data browser</span>
        <h1>Database Management</h1>
        <p>
          Inspect the object metadata and records used by the multi-agent pipeline. This
          interface is read-only.
        </p>
      </header>

      <section aria-labelledby="database-resources-title">
        <h2 className="sr-only" id="database-resources-title">
          Available resources
        </h2>
        <div className="database-resource-grid">
          {resources.map((resource) => {
            const Icon = resource.kind === "s3" ? HardDrive : Database;
            const isSelected = selectedId === resource.id;
            return (
              <button
                className={
                  isSelected ? "database-resource-card is-selected" : "database-resource-card"
                }
                key={resource.id}
                type="button"
                onClick={() => inspectResource(resource)}
                aria-pressed={isSelected}
              >
                <span className="database-resource-icon" aria-hidden="true">
                  <Icon size={20} strokeWidth={1.8} />
                </span>
                <span className="database-resource-copy">
                  <span>{resource.kind === "s3" ? "S3 bucket" : "DynamoDB table"}</span>
                  <strong>{resource.label}</strong>
                  <code>{resource.name ?? "Not configured"}</code>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="database-preview" aria-live="polite">
        {!selectedId ? (
          <div className="database-preview-empty">
            <Database size={22} strokeWidth={1.6} aria-hidden="true" />
            <p>Select a bucket or table to inspect its contents.</p>
          </div>
        ) : null}

        {loading ? (
          <div className="database-preview-empty">
            <RefreshCw className="database-spin" size={21} strokeWidth={1.8} aria-hidden="true" />
            <p>Reading the selected resource…</p>
          </div>
        ) : null}

        {error ? (
          <div className="database-preview-error" role="alert">
            {error}
          </div>
        ) : null}

        {preview ? (
          <>
            <div className="database-preview-heading">
              <div>
                <span>{preview.kind === "s3" ? "S3 bucket" : "DynamoDB table"}</span>
                <h2>{preview.label}</h2>
                <code>{preview.name}</code>
              </div>
              <span className="database-result-count">
                {preview.kind === "s3" ? preview.objects.length : preview.items.length}{" "}
                {preview.kind === "s3" ? "objects" : "items"}
              </span>
            </div>

            {preview.kind === "s3" ? (
              preview.objects.length > 0 ? (
                <div className="database-object-list">
                  <div className="database-object-header" aria-hidden="true">
                    <span>Key</span>
                    <span>Size</span>
                    <span>Last modified</span>
                    <span>Class</span>
                  </div>
                  {preview.objects.map((object) => (
                    <div className="database-object-row" key={object.key}>
                      <code title={object.key}>{object.key}</code>
                      <span>{formatBytes(object.size)}</span>
                      <time dateTime={object.lastModified ?? undefined}>
                        {object.lastModified
                          ? new Date(object.lastModified).toLocaleString()
                          : "—"}
                      </time>
                      <span>{object.storageClass ?? "—"}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="database-no-results">This bucket is empty.</p>
              )
            ) : preview.items.length > 0 ? (
              <div className="database-item-list">
                {preview.items.map((item, index) => (
                  <details className="database-item" key={`${itemLabel(item, index)}-${index}`}>
                    <summary>
                      <code>{itemLabel(item, index)}</code>
                      <span>View JSON</span>
                    </summary>
                    <pre>{JSON.stringify(item, null, 2)}</pre>
                  </details>
                ))}
              </div>
            ) : (
              <p className="database-no-results">This table has no items.</p>
            )}

            {preview.isTruncated ? (
              <p className="database-limit-note">
                Showing the first {preview.limit} records. Additional records are available
                in AWS.
              </p>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
