import { Sidebar } from "@/components/sidebar";
import { TestingPanel } from "@/components/testing-panel";

export default function TestingPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <main className="testing-main">
          <TestingPanel />
        </main>
      </div>
    </div>
  );
}
