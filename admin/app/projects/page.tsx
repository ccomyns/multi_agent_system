import { ProjectManagement } from "@/components/project-management";
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return <ProjectManagement key={tab} initialTab={tab === "storage" ? "storage" : "databases"} />;
}
