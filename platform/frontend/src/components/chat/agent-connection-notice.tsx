"use client";

import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAgentCredentialReadiness } from "@/lib/agent.query";
import {
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
export function AgentConnectionNotice({
  agentId,
  className,
}: {
  agentId: string;
  className?: string;
}) {
  const { data: readiness } = useAgentCredentialReadiness();
  const orchestrator = useMcpInstallOrchestrator();
  const entry = indexReadinessByAgent(readiness).get(agentId);
  const gate = resolveAgentConnectionGate(entry);

  if (gate.kind === "ok") return null;

  const missing = entry?.missingConnections ?? [];
  const servers = listServerNames(gate.serverNames);

  return (
    <InlineNotice className={className}>
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
        size="sm"
        variant="outline"
        className="ml-auto h-6 shrink-0 px-2 text-[11px]"
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
