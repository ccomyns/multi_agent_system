"use client";

import { FlaskConical, Play } from "lucide-react";
import { useState } from "react";

type CallResult = {
  call: number;
  status: number;
};

type StressReport = {
  invocations: number;
  expectedLimit: number;
  accepted: number;
  rejected: number;
  passed: boolean;
  calls: CallResult[];
};

function buildMockReport(invocations: number, expectedLimit: number): StressReport {
  const accepted = Math.min(invocations, expectedLimit);
  const rejected = Math.max(0, invocations - expectedLimit);
  const calls = Array.from({ length: invocations }, (_, index) => ({
    call: index + 1,
    status: index < expectedLimit ? 201 : 429,
  }));
  return {
    invocations,
    expectedLimit,
    accepted,
    rejected,
    passed: accepted === expectedLimit && rejected === invocations - expectedLimit,
    calls,
  };
}

export function TestingPanel() {
  const [invocations, setInvocations] = useState(9);
  const [expectedLimit, setExpectedLimit] = useState(8);
  const [orchestratorId, setOrchestratorId] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [report, setReport] = useState<StressReport | null>(null);

  function runStressTest() {
    setStatus("running");
    setReport(null);
    window.setTimeout(() => {
      setReport(buildMockReport(invocations, expectedLimit));
      setStatus("done");
    }, 700);
  }

  return (
    <div className="launch-card stress-card">
      <div className="launch-heading">
        <span className="launch-icon" aria-hidden="true">
          <FlaskConical size={19} strokeWidth={1.8} />
        </span>
        <div>
          <h2>Subagent concurrency stress test</h2>
          <p>
            Fire repeated spawn requests at the subagent-manager Lambda and confirm the
            concurrency boundary holds. This is a static preview — not yet wired to AWS.
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

      <div className="stress-footer">
        <span>
          {status === "running"
            ? "Running…"
            : "Sends spawn requests sequentially, then checks accepted vs. rejected (429)."}
        </span>
        <button
          type="button"
          className="primary-button"
          onClick={runStressTest}
          disabled={status === "running"}
        >
          <Play size={15} strokeWidth={2} />
          {status === "running" ? "Running…" : "Run stress test"}
        </button>
      </div>

      {report ? (
        <div className="stress-results">
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
              .map((call) => `call=${call.call} status=${call.status}`)
              .join("\n")}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
