"use client";

import { KeyRound } from "lucide-react";
import Link from "next/link";
import { useAgentCredentialReadiness } from "@/lib/agent.query";
import {
  indexReadinessByAgent,
  listServerNames,
  resolveAgentConnectionGate,
} from "@/lib/chat/agent-connection-gate";

/**
 * Tells the user, before they send anything, that this agent leans on MCP
 * servers they have not connected — either as a heads-up that some of its tools
 * will not run, or as the reason the agent refuses to run at all.
 *
 * Renders nothing for the default agent configuration, which is the common
 * case; it is only the author's opt-in that makes this visible.
 */
export function AgentConnectionNotice({ agentId }: { agentId: string }) {
  const { data: readiness } = useAgentCredentialReadiness();
  const gate = resolveAgentConnectionGate(
    indexReadinessByAgent(readiness).get(agentId),
  );

  if (gate.kind === "ok") return null;

  const servers = listServerNames(gate.serverNames);

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
      <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
      <p className="text-muted-foreground">
        {gate.kind === "block" ? (
          <span>
            This agent needs your connection to {servers} before it can run.
          </span>
        ) : (
          <span>
            You have not connected {servers}, so this agent&rsquo;s tools that
            use {gate.serverNames.length === 1 ? "it" : "them"} will not run.
          </span>
        )}{" "}
        <Link
          href="/mcp/registry"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Connect in the MCP registry
        </Link>
      </p>
    </div>
  );
}
