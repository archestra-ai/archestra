import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { serverCanAccessPage } from "@/lib/auth/auth.server";
import RunnerDetailPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function RunnerDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await serverCanAccessPage("/agents/runners"))) {
    return <ForbiddenPage />;
  }
  const { id } = await params;
  return <RunnerDetailPage runnerId={id} />;
}
