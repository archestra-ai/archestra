import { AgentCreatedPage } from "@/components/agent-pages/agent-created-page";

export const dynamic = "force-dynamic";

export default async function AgentCreatedPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentCreatedPage id={decodeURIComponent(id)} />;
}
