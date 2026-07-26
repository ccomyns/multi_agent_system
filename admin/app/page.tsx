import { RunDashboard } from "@/components/run-dashboard";
import { activeRun } from "@/lib/mock-data";

export default function Page() {
  return <RunDashboard run={activeRun} />;
}
