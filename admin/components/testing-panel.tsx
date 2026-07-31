"use client";

import { AlertTriangle, FlaskConical, Play } from "lucide-react";
import { useState } from "react";

import type {
  StressTestError,
  StressTestLaunch,
  StressTestReport,
} from "@/lib/stress-test";

function isErrorResponse(value: unknown): value is StressTestError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

function isLaunchResponse(value: unknown): value is StressTestLaunch {
  return (
    typeof value === "object" &&
    value !== null &&
    "orchestratorId" in value &&
    typeof value.orchestratorId === "string" &&
    "instanceId" in value &&
    typeof value.instanceId === "string" &&
    "startedAt" in value &&
    typeof value.startedAt === "string"
  );
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function TestingPanel() {
  const [invocations, setInvocations] = useState(9);
  const [expectedLimit, setExpectedLimit] = useState(8);
  const [orchestratorId, setOrchestratorId] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [report, setReport] = useState<StressTestReport | null>(null);
  const [launch, setLaunch] = useState<StressTestLaunch | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runStressTest() {
    setStatus("running");
    setReport(null);
    setLaunch(null);
    setError(null);

    try {
      const response = await fetch("/api/stress-tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invocations, expectedLimit, orchestratorId }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        throw new Error(
          isErrorResponse(payload) ? payload.error : `Stress test failed (${response.status}).`,
        );
      }

      if (!isLaunchResponse(payload)) {
        throw new Error("The admin server returned an unexpected launch response.");
      }

      setLaunch(payload);

      for (let attempt = 0; attempt < 200; attempt += 1) {
        await wait(3000);
        const query = new URLSearchParams({
          orchestratorId: payload.orchestratorId,
          instanceId: payload.instanceId,
        });
        const statusResponse = await fetch(`/api/stress-tests?${query}`, {
          cache: "no-store",
        });
        const statusPayload: unknown = await statusResponse.json();
        if (!statusResponse.ok) {
          throw new Error(
            isErrorResponse(statusPayload)
              ? statusPayload.error
              : `Could not read stress-test status (${statusResponse.status}).`,
          );
        }
        if (
          typeof statusPayload === "object" &&
          statusPayload !== null &&
          "status" in statusPayload &&
          statusPayload.status === "failed" &&
          "error" in statusPayload &&
          typeof statusPayload.error === "string"
        ) {
          throw new Error(statusPayload.error);
        }
        if (
          typeof statusPayload === "object" &&
          statusPayload !== null &&
          "status" in statusPayload &&
          statusPayload.status === "complete" &&
          "report" in statusPayload
        ) {
          setReport(statusPayload.report as StressTestReport);
          setStatus("done");
          return;
        }
      }

      throw new Error("The stress test did not finish within 10 minutes.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The stress test could not be completed.");
      setStatus("error");
    }
  }

  const parametersAreValid =
    Number.isInteger(invocations) &&
    invocations >= 2 &&
    invocations <= 100 &&
    Number.isInteger(expectedLimit) &&
    expectedLimit >= 1 &&
    expectedLimit < invocations;

  return (
    <div className="launch-card stress-card">
      <div className="launch-heading">
        <span className="launch-icon" aria-hidden="true">
          <FlaskConical size={19} strokeWidth={1.8} />
        </span>
        <div>
          <h2>Subagent concurrency stress test</h2>
          <p>
            Launch a self-terminating orchestrator that fires repeated spawn requests at
            the subagent-manager Lambda and confirms the concurrency boundary holds.
          </p>
        </div>
      </div>

      <div className="stress-grid">
        <div className="stress-field">
          <label htmlFor="stress-invocations">Invocations</label>
          <input
            id="stress-invocations"
            type="number"
            min={1}
            max={100}
            value={invocations}
            onChange={(event) => setInvocations(Number(event.target.value))}
          />
        </div>

        <div className="stress-field">
          <label htmlFor="stress-limit">Expected concurrency limit</label>
          <input
            id="stress-limit"
            type="number"
            min={1}
            max={100}
            value={expectedLimit}
            onChange={(event) => setExpectedLimit(Number(event.target.value))}
          />
        </div>

        <div className="stress-field stress-field-wide">
          <label htmlFor="stress-orchestrator">Orchestrator ID (optional)</label>
          <input
            id="stress-orchestrator"
            type="text"
            placeholder="auto-generated (stress-…)"
            value={orchestratorId}
            onChange={(event) => setOrchestratorId(event.target.value)}
          />
        </div>
      </div>

      <div className="stress-warning" role="note">
        <AlertTriangle size={16} strokeWidth={1.9} aria-hidden="true" />
        <span>
          This launches up to {expectedLimit || 0} real subagent EC2 instances and may incur
          AWS charges. Instances use the configured self-termination policy.
        </span>
      </div>

      <div className="stress-footer">
        <span>
          {status === "running"
            ? launch
              ? `Running on ${launch.instanceId}. Waiting for its S3 report…`
              : "Launching the stress-test orchestrator…"
            : parametersAreValid
              ? "Checks accepted responses against the first expected 429 rejection."
              : "Invocations must be 2–100 and greater than the expected limit."}
        </span>
        <button
          type="button"
          className="primary-button"
          onClick={runStressTest}
          disabled={status === "running" || !parametersAreValid}
        >
          <Play size={15} strokeWidth={2} />
          {status === "running" ? "Running…" : "Run stress test"}
        </button>
      </div>

      {error ? (
        <div className="stress-error" role="alert">
          {error}
        </div>
      ) : null}

      {launch && !report ? (
        <div className="stress-run-meta stress-run-pending" role="status">
          <span>
            Orchestrator <strong className="mono">{launch.orchestratorId}</strong>
          </span>
          <span>
            Instance <strong className="mono">{launch.instanceId}</strong>
          </span>
        </div>
      ) : null}

      {report ? (
        <div className="stress-results">
          <div className="stress-run-meta">
            <span>
              Orchestrator <strong className="mono">{report.orchestratorId}</strong>
            </span>
            <span>{new Date(report.runAt).toLocaleString()}</span>
          </div>
          <div className="stress-metrics">
            <span className={report.passed ? "stress-pill is-pass" : "stress-pill is-fail"}>
              {report.passed ? "PASS" : "FAIL"}
            </span>
            <div className="stress-metric">
              <strong>{report.accepted}</strong>
              <span>accepted (201)</span>
            </div>
            <div className="stress-metric">
              <strong>{report.rejected}</strong>
              <span>rejected (429)</span>
            </div>
            <div className="stress-metric">
              <strong>{report.invocations}</strong>
              <span>invocations</span>
            </div>
          </div>

          <pre className="stress-log">
            {report.calls
              .map(
                (call) =>
                  `call=${call.call} status=${call.status} body=${JSON.stringify(call.body)}`,
              )
              .join("\n")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
