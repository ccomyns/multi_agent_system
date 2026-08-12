import { AgentTelemetryDetail } from "@/components/agent-telemetry-detail";
import { Sidebar } from "@/components/sidebar";

export default async function SubagentDetailPage({
  params,
}: {
  params: Promise<{ jobId: string; agentId: string }>;
}) {
  const { jobId, agentId } = await params;
  return (
    <div className="app-shell app-layout">
      <Sidebar />
      <div className="app-body">
        <main className="data-mining-result-main">
          <AgentTelemetryDetail jobId={jobId} agentId={agentId} />
        </main>
      </div>
    </div>
  );
}
