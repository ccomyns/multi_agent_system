import { JobHome } from "@/components/job-home";
import { Sidebar } from "@/components/sidebar";

export default function JobsPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <main className="jobs-main grid-surface">
          <JobHome />
        </main>
      </div>
    </div>
  );
}
