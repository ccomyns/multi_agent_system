import { JobComposer } from "@/components/job-composer";
import { Sidebar } from "@/components/sidebar";

export default function NewJobPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <main className="job-compose-main">
          <JobComposer />
        </main>
      </div>
    </div>
  );
}
