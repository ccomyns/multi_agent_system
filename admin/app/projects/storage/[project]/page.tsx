import { ProjectFileBrowser } from "@/components/project-file-browser";
export default async function ProjectStoragePage({ params, searchParams }: { params: Promise<{ project: string }>; searchParams: Promise<{ path?: string }> }) {
  const { project } = await params;
  const { path = "" } = await searchParams;
  return <ProjectFileBrowser key={JSON.stringify([project, path])} project={project} path={path} />;
}
