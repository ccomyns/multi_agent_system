import { SavedJobs } from "@/components/saved-jobs";
import { Sidebar } from "@/components/sidebar";

export default function SavedJobsPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <main className="saved-jobs-main grid-surface">
          <SavedJobs />
        </main>
      </div>
    </div>
  );
}
