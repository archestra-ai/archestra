import type { TokenAuthContext } from "@/clients/mcp-client";

/**
 * Context for the Archestra MCP server
 */
export interface ArchestraContext {
  agent: {
    id: string;
    name: string;
  };
  conversationId?: string;
  /** ChatOps channel binding ID for Slack/MS Teams-triggered executions */
  chatOpsBindingId?: string;
  /** ChatOps thread identifier for thread-scoped agent overrides */
  chatOpsThreadId?: string;
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
}
