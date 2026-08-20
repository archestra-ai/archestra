import { AgentEditPage } from "@/components/agent-pages/agent-edit-page";

export const dynamic = "force-dynamic";

export default async function McpGatewayEditPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentEditPage kind="mcp_gateway" id={decodeURIComponent(id)} />;
}
