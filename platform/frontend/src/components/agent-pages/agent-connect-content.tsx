"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import { McpGatewayConnectInstructions } from "@/components/agent-connect-instructions";
import type { AgentPageKind } from "./agent-page-config";

type Agent = archestraApiTypes.GetAgentResponses["200"];

export function AgentConnectContent({
  kind,
  agent,
}: {
  kind: AgentPageKind;
  agent: Agent;
}) {
  if (kind === "mcp_gateway") {
    return <McpGatewayConnectInstructions gateway={agent} />;
  }
  return <A2AConnectionInstructions agent={agent} layout="detail" />;
}
