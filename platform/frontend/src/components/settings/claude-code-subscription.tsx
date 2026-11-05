"use client";

import { ClaudeCodeAccount } from "@/components/claude-code-account";
import { QueryLoadError } from "@/components/query-load-error";
import { useAgentOptionsPage } from "@/lib/agent-options.query";
import { useFeature } from "@/lib/config/config.query";

/**
 * Your Claude Pro or Max sign-in, on Personal Settings → Credentials when an
 * agent runs Claude Code. A failed agent lookup is shown, not hidden, so a
 * missing card never reads as "no Claude Code agent".
 */
export function ClaudeCodeSubscription() {
  const { agent, isError, refetch } = useClaudeCodeAgent();
  if (isError)
    return (
      <QueryLoadError
        title="Couldn't load your Claude Code agent"
        onRetry={refetch}
        className="mb-4 rounded-lg border py-8"
      />
    );
  if (!agent) return null;
  return (
    <div className="mb-4 overflow-hidden rounded-lg border bg-card">
      <ClaudeCodeAccount agentId={agent.id} variant="row" />
    </div>
  );
}

/** The agent that runs Claude Code, when the Agent Runtime is on. */
export function useClaudeCodeAgent() {
  const runtimeEnabled = useFeature("agentRuntime") === true;
  const agents = useAgentOptionsPage({
    filters: {
      agentType: "agent",
      excludeBuiltIn: true,
      runtimeCommand: "archestra-claude-code",
    },
    limit: 1,
    enabled: runtimeEnabled,
  });
  return {
    agent: runtimeEnabled ? agents.data?.pages[0]?.data[0] : undefined,
    isError: runtimeEnabled && agents.isError,
    isPending: runtimeEnabled && agents.isPending,
    refetch: () => void agents.refetch(),
  };
}
