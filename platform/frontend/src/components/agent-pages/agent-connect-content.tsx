"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import {
  type ConnectInstructionsOrigin,
  LlmProxyConnectInstructions,
  McpGatewayConnectInstructions,
} from "@/components/agent-connect-instructions";
import { useAppName } from "@/lib/hooks/use-app-name";
import type { AgentPageKind } from "./agent-page-config";

type Agent = archestraApiTypes.GetAgentResponses["200"];

/**
 * "How do I use this?" for one agent-shaped resource, keyed by the route
 * family showing it rather than the stored type: a legacy profile reached
 * through the gateway pages gets the gateway instructions, through the proxy
 * pages the proxy ones.
 */
export function AgentConnectContent({
  kind,
  agent,
  origin,
}: {
  kind: AgentPageKind;
  agent: Agent;
  origin: ConnectInstructionsOrigin;
}) {
  const appName = useAppName();

  if (kind === "llm_proxy") {
    return <LlmProxyConnectInstructions proxy={agent} origin={origin} />;
  }
  if (kind === "mcp_gateway") {
    return <McpGatewayConnectInstructions gateway={agent} origin={origin} />;
  }
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">A2A Connection</h3>
        <p className="text-sm text-muted-foreground">
          Connect directly to this agent with {appName}&apos;s A2A endpoint,
          tokens, deep links, and optional email invocation.
        </p>
      </div>
      {/* The "dialog" layout is the complete one — chat apps, email and OAuth
          clients included; "page" belongs to the Messaging Channels tab, which
          has those as sibling tabs. */}
      <A2AConnectionInstructions agent={agent} layout="dialog" />
    </section>
  );
}
