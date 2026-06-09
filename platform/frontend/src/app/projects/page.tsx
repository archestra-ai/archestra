import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { serverCanAccessPage } from "@/lib/auth/auth.server";
import ProjectsPageClient from "./page.client";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  if (!(await serverCanAccessPage("/projects"))) {
    return <ForbiddenPage />;
  }
  return <ProjectsPageClient />;
}
