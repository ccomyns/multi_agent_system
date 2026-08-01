import { JobComposer } from "@/components/job-composer";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";

export default function NewJobPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <TopBar title="Create a Job" />
        <main className="job-compose-main">
          <JobComposer />
        </main>
      </div>
    </div>
  );
}
