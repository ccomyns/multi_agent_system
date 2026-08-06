import { AgentMonitor } from "@/components/agent-monitor";
import { Sidebar } from "@/components/sidebar";

export default function Page() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body monitor-shell">
        <main className="monitor-main">
          <AgentMonitor />
        </main>
      </div>
    </div>
  );
}
