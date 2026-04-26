import type { TokenAuthContext } from "@/clients/mcp-client";

/**
 * ChatOps channel binding context — present when the agent is running inside
 * a Slack or MS Teams conversation rather than a Web UI conversation.
 * Used by swap_agent to update the channel binding instead of a DB conversation.
 */
export interface ChatOpsBindingContext {
  /** The chat provider (e.g. "slack" or "ms-teams") */
  provider: string;
  /** The channel ID for this binding */
  channelId: string;
  /** The workspace ID for this binding */
  workspaceId: string;
  /** The database ID of the chatops_channel_binding row */
  bindingId: string;
}

/**
 * Context for the Archestra MCP server
 */
export interface ArchestraContext {
  agent: {
    id: string;
    name: string;
  };
  conversationId?: string;
  userId?: string;
  /** The ID of the current internal agent (for agent delegation tool lookup) */
  agentId?: string;
  /** The organization ID */
  organizationId?: string;
  /** Token authentication context */
  tokenAuth?: TokenAuthContext;
  /** Session ID for grouping related LLM requests in logs */
  sessionId?: string;
  /**
   * Delegation chain of agent IDs (colon-separated).
   * Used to track the path of delegated agent calls.
   * E.g., "agentA:agentB" means agentA delegated to agentB.
   */
  delegationChain?: string;
  /** Schedule trigger run ID — when set, artifact_write targets the run instead of a conversation */
  scheduleTriggerRunId?: string;
  /** Optional cancellation signal from parent chat/tool execution */
  abortSignal?: AbortSignal;
  /** Whether the current caller context is still trusted/safe */
  contextIsTrusted?: boolean;
  /**
   * ChatOps binding context — present when the agent is invoked from Slack or
   * MS Teams. swap_agent uses this to update the channel binding's agentId so
   * subsequent messages in the same channel are routed to the new agent.
   */
  chatopsBinding?: ChatOpsBindingContext;
}
