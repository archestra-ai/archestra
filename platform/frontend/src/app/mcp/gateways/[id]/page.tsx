import { AgentDetailPage } from "@/components/agent-pages/agent-detail-page";

export const dynamic = "force-dynamic";

export default async function McpGatewayDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AgentDetailPage kind="mcp_gateway" id={decodeURIComponent(id)} />;
}
