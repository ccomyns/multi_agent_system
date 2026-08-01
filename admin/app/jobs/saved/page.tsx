import { SavedJobs } from "@/components/saved-jobs";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";

export default function SavedJobsPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <TopBar title="Saved Jobs" />
        <main className="saved-jobs-main grid-surface">
          <SavedJobs />
        </main>
      </div>
    </div>
  );
}
