import { AgentEditPage } from "@/components/agent-pages/agent-edit-page";

export const dynamic = "force-dynamic";

export default async function AgentEditPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentEditPage kind="agent" id={decodeURIComponent(id)} />;
}
