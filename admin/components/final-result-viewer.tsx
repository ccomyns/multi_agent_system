"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

function describeError(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function responseError(body: string, fallback: string) {
  try {
    const payload: unknown = JSON.parse(body);
    if (
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
    ) {
      return payload.error;
    }
  } catch {
    // The server may return plain text for an upstream failure.
  }
  return fallback;
}

async function fetchFinalResult(jobId: string, signal?: AbortSignal) {
  const response = await fetch(
    `/api/jobs/${encodeURIComponent(jobId)}/final-result`,
    { cache: "no-store", signal },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      responseError(body, `The final result request failed (${response.status}).`),
    );
  }
  return body;
}

export function FinalResultViewer({ jobId }: { jobId: string }) {
  const [resultText, setResultText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();

    async function load() {
      try {
        const body = await fetchFinalResult(jobId, controller.signal);
        if (!disposed) {
          setResultText(body);
        }
      } catch (caught) {
        if (disposed || (caught instanceof Error && caught.name === "AbortError")) {
          return;
        }
        setError(describeError(caught, "The final result could not be loaded."));
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [jobId]);

  async function retry() {
    setLoading(true);
    setError(null);
    try {
      setResultText(await fetchFinalResult(jobId));
    } catch (caught) {
      setError(describeError(caught, "The final result could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="final-result-page">
      <Link className="data-mining-back-link" href={`/jobs/${encodeURIComponent(jobId)}`}>
        <ArrowLeft size={12} strokeWidth={2} aria-hidden="true" />
        BACK TO JOB OVERVIEW
      </Link>

      <section className="final-result-viewer" aria-labelledby="final-result-title">
        <header className="final-result-header">
          <div>
            <span>ORCHESTRATOR OUTPUT</span>
            <h1 id="final-result-title">final_result.json</h1>
          </div>
        </header>

        <div className="final-result-content" aria-busy={loading}>
          {loading ? (
            <div className="final-result-message">Loading final_result.json…</div>
          ) : error ? (
            <div className="final-result-message final-result-error" role="alert">
              <p>{error}</p>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void retry()}
              >
                Retry
              </button>
            </div>
          ) : (
            <pre>{resultText}</pre>
          )}
        </div>
      </section>
    </div>
  );
}
