"use client";

import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAgentCredentialReadiness } from "@/lib/agent.query";
import {
  type AgentConnectionGate,
  indexReadinessByAgent,
  listServerNames,
  resolveAgentConnectionGate,
} from "@/lib/chat/agent-connection-gate";
import { useMcpInstallOrchestrator } from "@/lib/mcp/mcp-install-orchestrator.hook";
import { McpInstallDialogs } from "./mcp-install-dialogs";

/**
 * Tells the user, before they send anything, that this agent leans on MCP
 * servers they have not connected — either as a heads-up that some of its tools
 * will not run, or as the reason the agent refuses to run at all — and connects
 * them right here rather than sending them to the registry to search for it.
 *
 * Renders nothing for the default agent configuration, which is the common
 * case; it is only the author's opt-in that makes this visible.
 */
export function AgentConnectionNotice({ agentId }: { agentId: string }) {
  const { data: readiness } = useAgentCredentialReadiness({ ids: [agentId] });
  const entry = indexReadinessByAgent(readiness).get(agentId);
  const gate = resolveAgentConnectionGate(entry);

  if (gate.kind === "ok") return null;
  return (
    <MissingConnectionNotice
      gate={gate}
      missing={entry?.missingConnections ?? []}
    />
  );
}

/**
 * Split out so the install orchestrator, and the registry catalog and server
 * list it loads, only mount when there is something to connect.
 */
function MissingConnectionNotice({
  gate,
  missing,
}: {
  gate: Exclude<AgentConnectionGate, { kind: "ok" }>;
  missing: { catalogId: string }[];
}) {
  const orchestrator = useMcpInstallOrchestrator();
  const servers = listServerNames(gate.serverNames);

  return (
    <InlineNotice>
      <KeyRound />
      <InlineNoticeText className="flex-1 truncate">
        {gate.kind === "block" ? (
          <span>
            This agent needs your connection to {servers} before it can run.
          </span>
        ) : (
          <span>
            You have not connected {servers}, so this agent&rsquo;s tools that
            use {missing.length === 1 ? "it" : "them"} will not run.
          </span>
        )}
      </InlineNoticeText>
      {/* Connecting is per server; with several outstanding this opens the
          first and the notice re-offers whatever is still missing. */}
      <Button
        size="xs"
        variant="outline"
        className="ml-auto shrink-0"
        onClick={() => {
          const next = missing[0];
          if (next) orchestrator.triggerInstallByCatalogId(next.catalogId);
        }}
      >
        <span>
          {missing.length === 1 ? "Connect" : `Connect ${missing.length}`}
        </span>
      </Button>
      <McpInstallDialogs orchestrator={orchestrator} />
    </InlineNotice>
  );
}
