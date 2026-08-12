"use client";

import { ArrowLeft, Clock3, Database, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { isAgentTelemetryResponse } from "@/lib/agent-telemetry";
import type { AgentTelemetryResponse, TokenUsage } from "@/lib/agent-telemetry";

const POLL_INTERVAL_MS = 3000;
type DetailView = "telemetry" | "result";

function localTime(value: string | null) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function tokenValue(value: number | null) {
  return value === null ? "Not reported" : value.toLocaleString();
}

function duration(start: string | null, finish: string | null) {
  if (!start) return "Not available";
  const startMs = new Date(start).getTime();
  const finishMs = finish ? new Date(finish).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs)) return "Not available";
  const seconds = Math.max(0, Math.floor((finishMs - startMs) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${remainder}s`]
    .filter(Boolean)
    .join(" ");
}

function responseError(value: unknown, fallback: string) {
  return typeof value === "object" && value !== null && "error" in value &&
    typeof value.error === "string"
    ? value.error
    : fallback;
}

async function fetchTelemetry(jobId: string, agentId: string | null, signal?: AbortSignal) {
  const suffix = agentId
    ? `/agents/${encodeURIComponent(agentId)}/telemetry`
    : "/telemetry";
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}${suffix}`, {
    cache: "no-store",
    signal,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(responseError(payload, `Telemetry request failed (${response.status}).`));
  }
  if (!isAgentTelemetryResponse(payload)) {
    throw new Error("The admin server returned an unexpected telemetry response.");
  }
  return payload;
}

async function fetchFinalResult(jobId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/final-result`, {
    cache: "no-store",
    signal,
  });
  const body = await response.text();
  if (!response.ok) {
    let message = `Final result request failed (${response.status}).`;
    try {
      message = responseError(JSON.parse(body), message);
    } catch {
      // Keep the HTTP fallback for a non-JSON response.
    }
    throw new Error(message);
  }
  return body;
}

function TokenBreakdown({ usage }: { usage: TokenUsage }) {
  const fields = [
    ["Total", usage.totalTokens],
    ["Input", usage.inputTokens],
    ["Cached input", usage.cachedInputTokens],
    ["Cache write", usage.cacheWriteInputTokens],
    ["Output", usage.outputTokens],
    ["Reasoning output", usage.reasoningOutputTokens],
  ] as const;
  return (
    <dl className="telemetry-token-grid">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{tokenValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AgentTelemetryDetail({
  jobId,
  agentId = null,
  initialView = "telemetry",
}: {
  jobId: string;
  agentId?: string | null;
  initialView?: DetailView;
}) {
  const [view, setView] = useState<DetailView>(agentId ? "telemetry" : initialView);
  const [payload, setPayload] = useState<AgentTelemetryResponse | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchTelemetry(jobId, agentId, signal);
    setPayload(next);
    setError(null);
    return next;
  }, [agentId, jobId]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    async function poll() {
      controller = new AbortController();
      try {
        const next = await refresh(controller.signal);
        if (!disposed && !next.isTerminal) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (caught) {
        if (disposed || (caught instanceof Error && caught.name === "AbortError")) return;
        setError(caught instanceof Error ? caught.message : "Telemetry could not be loaded.");
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }
    void poll();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (view !== "result" || result !== null || resultError !== null) return;
    const controller = new AbortController();
    fetchFinalResult(jobId, controller.signal)
      .then(setResult)
      .catch((caught: unknown) => {
        if (!(caught instanceof Error && caught.name === "AbortError")) {
          setResultError(caught instanceof Error ? caught.message : "The final result could not be loaded.");
        }
      });
    return () => controller.abort();
  }, [jobId, result, resultError, view]);

  const telemetry = payload?.telemetry ?? null;
  return (
    <div className="agent-detail-page">
      <Link className="data-mining-back-link" href={`/jobs/${encodeURIComponent(jobId)}`}>
        <ArrowLeft size={12} strokeWidth={2} aria-hidden="true" />
        BACK TO JOB OVERVIEW
      </Link>

      <section className="agent-detail-viewer">
        <header className="agent-detail-header">
          <div>
            <span>{agentId ? "SUBAGENT DETAILS" : "ORCHESTRATOR DETAILS"}</span>
            <h1>{agentId ?? "Orchestrator"}</h1>
          </div>
          {!agentId ? (
            <div className="agent-detail-tabs" role="tablist" aria-label="Orchestrator detail view">
              <button className={view === "telemetry" ? "is-active" : ""} onClick={() => setView("telemetry")} type="button">
                <Clock3 size={12} aria-hidden="true" /> Telemetry
              </button>
              <button
                className={view === "result" ? "is-active" : ""}
                disabled={!payload?.isTerminal}
                onClick={() => setView("result")}
                type="button"
              >
                <Database size={12} aria-hidden="true" /> Final Result
              </button>
            </div>
          ) : null}
        </header>

        {view === "result" ? (
          <div className="agent-detail-result">
            {resultError ? <div className="agent-detail-message agent-detail-error">{resultError}</div> :
              result === null ? <div className="agent-detail-message">Loading final_result.json…</div> : <pre>{result}</pre>}
          </div>
        ) : payload === null ? (
          <div className="agent-detail-message">
            <RefreshCw className="telemetry-spin" size={18} aria-hidden="true" />
            {error ?? "Loading agent telemetry…"}
          </div>
        ) : (
          <div className="agent-detail-content">
            {error ? <div className="telemetry-refresh-warning">{error} Retrying automatically.</div> : null}
            <div className="agent-detail-task"><strong>Task:</strong> {payload.task}</div>
            {payload.error ? (
              <div className="agent-detail-run-error" role="alert">
                <strong>Run error</strong>
                <p>{payload.error}</p>
              </div>
            ) : null}
            <div className="telemetry-summary-grid">
              <div><span>Status</span><strong>{payload.status}</strong></div>
              <div><span>Codex started</span><strong>{localTime(telemetry?.codexStartedAt ?? null)}</strong></div>
              <div><span>Codex finished</span><strong>{localTime(telemetry?.codexFinishedAt ?? null)}</strong></div>
              <div><span>Runtime</span><strong>{duration(telemetry?.codexStartedAt ?? null, telemetry?.codexFinishedAt ?? null)}</strong></div>
              <div><span>Last activity</span><strong>{localTime(telemetry?.lastActivityAt ?? null)}</strong></div>
              <div><span>Latest checkpoint</span><strong>{telemetry?.currentCheckpoint?.replaceAll("_", " ") ?? "Not recorded"}</strong></div>
            </div>

            <section className="telemetry-section">
              <h2>Token usage</h2>
              {telemetry ? <TokenBreakdown usage={telemetry.usage} /> : <p>Token usage was not recorded for this run.</p>}
            </section>

            <section className="telemetry-section telemetry-timeline-section">
              <h2>Checkpoint timeline</h2>
              {payload.events.length ? (
                <ol className="telemetry-timeline">
                  {payload.events.map((event, index) => (
                    <li key={`${event.timestamp}-${event.checkpoint}-${index}`}>
                      <time>{localTime(event.timestamp)}</time>
                      <div><strong>{event.checkpoint.replaceAll("_", " ")}</strong><p>{event.detail}</p></div>
                      <span>{event.source === "runner" ? "VM" : "AWS"}</span>
                    </li>
                  ))}
                </ol>
              ) : <p>No checkpoint events were recorded for this run.</p>}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
