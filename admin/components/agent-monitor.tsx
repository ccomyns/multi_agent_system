"use client";

import { useState } from "react";

import { monitorSubagents, monitorTabs } from "@/lib/mock-data";
import type { MonitorTabId } from "@/lib/types";

const BOX_TOP = 8;
const BOX_STEP = 36;
const BOX_HEIGHT = 26;
const BOX_WIDTH = 84;
const SUBAGENT_X = 210;

export function AgentMonitor() {
  const [activeTab, setActiveTab] = useState<MonitorTabId>("mon");
  const [diagramView, setDiagramView] = useState<"orchestrator" | "subagent">(
    "orchestrator",
  );

  return (
    <section className="monitor-card" aria-label="Agent monitoring">
      <div className="monitor-grid">
        <div className="monitor-diagram">
          <div className="monitor-view-tabs" role="group" aria-label="Diagram view">
            <button
              type="button"
              className={
                diagramView === "orchestrator"
                  ? "monitor-view-tab is-active"
                  : "monitor-view-tab"
              }
              aria-pressed={diagramView === "orchestrator"}
              onClick={() => setDiagramView("orchestrator")}
            >
              Orchestrator View
            </button>
            <button
              type="button"
              className={
                diagramView === "subagent"
                  ? "monitor-view-tab is-active"
                  : "monitor-view-tab"
              }
              aria-pressed={diagramView === "subagent"}
              onClick={() => setDiagramView("subagent")}
            >
              Subagent View
            </button>
          </div>

          <div className="monitor-canvas">
          <svg
            viewBox="0 0 300 294"
            xmlns="http://www.w3.org/2000/svg"
            className="monitor-svg"
            role="img"
            aria-labelledby="monitor-diagram-title"
          >
            <title id="monitor-diagram-title">
              Orchestrator agent fanning out to eight subagents
            </title>
            <defs>
              <marker
                id="mk-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0,1 L9,5 L0,9 z" />
              </marker>
            </defs>

            <path className="mk-wire" d="M102,147 H150 M150,21 V273" />
            {monitorSubagents.map((step, index) => {
              const arrowY = BOX_TOP + index * BOX_STEP + BOX_HEIGHT / 2;
              return (
                <path
                  key={`wire-${step.id}`}
                  className="mk-wire"
                  markerEnd="url(#mk-arrow)"
                  d={`M150,${arrowY} H${SUBAGENT_X}`}
                />
              );
            })}

            <g className="c-amber">
              <rect x="2" y="113" width="100" height="68" rx="4" />
              <text className="th" x="52" y="145" textAnchor="middle" fontSize="9">
                Orchestrator agent
              </text>
              <text className="ts" x="52" y="158" textAnchor="middle" fontSize="8">
                Task: xyz
              </text>
            </g>

            <g className="c-blue">
              {monitorSubagents.map((step, index) => {
                const boxY = BOX_TOP + index * BOX_STEP;
                return (
                  <g key={`box-${step.id}`}>
                    <rect
                      x={SUBAGENT_X}
                      y={boxY}
                      width={BOX_WIDTH}
                      height={BOX_HEIGHT}
                      rx="3"
                    />
                    <text
                      className="th"
                      x={SUBAGENT_X + BOX_WIDTH / 2}
                      y={boxY + 16}
                      textAnchor="middle"
                      fontSize="9"
                    >
                      {step.name}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
          </div>
        </div>

        <div className="monitor-panel">
          <div role="tablist" className="mk-tabs" aria-label="Monitoring views">
            {monitorTabs.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`mk-tab-${tab.id}`}
                  aria-controls={`mk-pane-${tab.id}`}
                  aria-selected={selected}
                  className={selected ? "mk-tab is-active" : "mk-tab"}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {activeTab === "mon" && (
            <div
              className="mk-pane"
              id="mk-pane-mon"
              role="tabpanel"
              aria-labelledby="mk-tab-mon"
            >
              {monitorSubagents.map((step) => (
                <div className="mk-row" key={step.id}>
                  <p className="mk-row-title">{step.name}</p>
                  <p className="mk-row-desc">{step.description}</p>
                </div>
              ))}
            </div>
          )}

          {activeTab === "data" && (
            <div
              className="mk-pane"
              id="mk-pane-data"
              role="tabpanel"
              aria-labelledby="mk-tab-data"
            >
              <p className="mk-note">Table-level diffs and merge decisions</p>
            </div>
          )}

          {activeTab === "infra" && (
            <div
              className="mk-pane"
              id="mk-pane-infra"
              role="tabpanel"
              aria-labelledby="mk-tab-infra"
            >
              <p className="mk-note">Instance health, boot times, and cost</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
