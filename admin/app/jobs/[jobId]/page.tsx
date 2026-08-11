import { DataMiningJobMonitor } from "@/components/data-mining-job-monitor";
import { Sidebar } from "@/components/sidebar";

export default async function DataMiningJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;

  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <main className="data-mining-monitor-main">
          <DataMiningJobMonitor jobId={jobId} />
        </main>
      </div>
    </div>
  );
}
