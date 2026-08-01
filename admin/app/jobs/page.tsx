import { JobHome } from "@/components/job-home";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";

export default function JobsPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <TopBar title="Launch a Job" />
        <main className="jobs-main grid-surface">
          <JobHome />
        </main>
      </div>
    </div>
  );
}
