import { AgentMonitor } from "@/components/agent-monitor";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";

export default function Page() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body monitor-shell">
        <TopBar title="Multi Agent System" />

        <main className="monitor-main">
          <AgentMonitor />
        </main>
      </div>
    </div>
  );
}
