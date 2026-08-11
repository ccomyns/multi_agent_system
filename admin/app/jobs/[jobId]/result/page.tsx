import { FinalResultViewer } from "@/components/final-result-viewer";
import { Sidebar } from "@/components/sidebar";

export default async function FinalResultPage({
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
          <FinalResultViewer jobId={jobId} />
        </main>
      </div>
    </div>
  );
}
