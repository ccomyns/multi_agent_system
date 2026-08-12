import { AgentTelemetryDetail } from "@/components/agent-telemetry-detail";
import { Sidebar } from "@/components/sidebar";

export default async function OrchestratorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const [{ jobId }, query] = await Promise.all([params, searchParams]);
  return (
    <div className="app-shell app-layout">
      <Sidebar />
      <div className="app-body">
        <main className="data-mining-result-main">
          <AgentTelemetryDetail
            jobId={jobId}
            initialView={query.view === "result" ? "result" : "telemetry"}
          />
        </main>
      </div>
    </div>
  );
}
