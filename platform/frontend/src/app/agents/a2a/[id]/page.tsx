import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { A2aRemoteAgentDetailPage } from "@/components/a2a-remote-agent-page";
import { serverCanAccessPage } from "@/lib/auth/auth.server";

export const dynamic = "force-dynamic";

export default async function A2aRemoteAgentDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await serverCanAccessPage("/agents/a2a"))) {
    return <ForbiddenPage />;
  }
  const { id } = await params;
  return <A2aRemoteAgentDetailPage id={decodeURIComponent(id)} />;
}
