import {
  DatabaseManagement,
  type DatabaseResource,
} from "@/components/database-management";
import { Sidebar } from "@/components/sidebar";

export const dynamic = "force-dynamic";

export default function DatabaseManagementPage() {
  const resources: DatabaseResource[] = [
    {
      id: "agent-workspace",
      kind: "s3",
      label: "Agent Workspace",
      name: process.env.AGENT_WORKSPACE_BUCKET_NAME ?? null,
    },
    {
      id: "audit",
      kind: "s3",
      label: "Audit",
      name: process.env.AUDIT_BUCKET_NAME ?? null,
    },
    {
      id: "global-memory",
      kind: "s3",
      label: "Global Memory",
      name: process.env.GLOBAL_MEMORY_BUCKET_NAME ?? null,
    },
    {
      id: "jobs",
      kind: "dynamodb",
      label: "Jobs",
      name: process.env.JOBS_TABLE_NAME ?? null,
    },
    {
      id: "state",
      kind: "dynamodb",
      label: "State",
      name: process.env.STATE_TABLE_NAME ?? null,
    },
  ];

  return (
    <div className="app-shell app-layout">
      <Sidebar />

      <div className="app-body">
        <main className="database-management-main grid-surface">
          <DatabaseManagement resources={resources} />
        </main>
      </div>
    </div>
  );
}
