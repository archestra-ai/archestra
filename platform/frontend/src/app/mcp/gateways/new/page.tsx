import { AgentCreatePage } from "@/components/agent-pages/agent-create-page";

export const dynamic = "force-dynamic";

export default function NewMcpGatewayPageServer() {
  return <AgentCreatePage kind="mcp_gateway" />;
}
