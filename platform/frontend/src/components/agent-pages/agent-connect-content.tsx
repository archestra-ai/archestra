"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import {
  type ConnectInstructionsOrigin,
  LlmProxyConnectInstructions,
  McpGatewayConnectInstructions,
} from "@/components/agent-connect-instructions";
import type { AgentPageKind } from "./agent-page-config";

type Agent = archestraApiTypes.GetAgentResponses["200"];

export function AgentConnectContent({
  kind,
  agent,
  origin,
}: {
  kind: AgentPageKind;
  agent: Agent;
  origin: ConnectInstructionsOrigin;
}) {
  if (kind === "llm_proxy") {
    return <LlmProxyConnectInstructions proxy={agent} origin={origin} />;
  }
  if (kind === "mcp_gateway") {
    return <McpGatewayConnectInstructions gateway={agent} origin={origin} />;
  }
  return <A2AConnectionInstructions agent={agent} layout="detail" />;
}
