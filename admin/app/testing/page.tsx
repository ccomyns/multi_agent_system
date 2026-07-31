import { Sidebar } from "@/components/sidebar";
import { TestingPanel } from "@/components/testing-panel";
import { TopBar } from "@/components/top-bar";

export default function TestingPage() {
  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <TopBar title="Testing" />

        <main className="testing-main">
          <TestingPanel />
        </main>
      </div>
    </div>
  );
}
