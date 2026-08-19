import { OrchestratorResultFiles } from "@/components/orchestrator-result-files";
import { Sidebar } from "@/components/sidebar";

export default async function OrchestratorUploadPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;

  return (
    <div className="app-shell app-layout">
      <Sidebar />
      <div className="app-body">
        <main className="data-mining-result-main">
          <OrchestratorResultFiles jobId={jobId} />
        </main>
      </div>
    </div>
  );
}
