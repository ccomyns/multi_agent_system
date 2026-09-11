import { DatabaseExplorer } from "@/components/project-management";
export default async function DatabasePage({ params }: { params: Promise<{ database: string }> }) {
  const { database } = await params;
  return <DatabaseExplorer database={database} />;
}
