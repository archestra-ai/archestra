import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import type { TokenAuthContext } from "@/clients/mcp-client";

/**
 * Context for the Archestra MCP server
 */
export interface ArchestraContext {
  agent: {
    id: string;
    name: string;
  };
  /**
   * Id of a persisted `conversations` row. Only ever a real conversation id —
   * tools may persist it as a foreign key. Absent in headless executions
   * (direct A2A, ChatOps, schedule triggers, incoming email).
   */
  conversationId?: string;
  /**
   * Opaque key scoping per-execution state (browser tabs, MCP client cache,
   * headless sandboxes). Equals `conversationId` in UI chat; a generated UUID
   * in headless executions. Never persist it as a conversation id.
   */
  isolationKey?: string;
  /** ChatOps channel binding ID for Slack/MS Teams-triggered executions */
  chatOpsBindingId?: string;
  /** ChatOps thread identifier for thread-scoped agent overrides */
  chatOpsThreadId?: string;
  userId?: string;
  /** The ID of the current internal agent (for agent delegation tool lookup) */
  agentId?: string;
  /**
   * The app whose runtime made this call, set ONLY by the app-bound MCP proxy
   * (`POST /api/mcp/app/:appId`). The App Data Store tools key off this — never
   * off a tool argument — so an app can only touch its own data store.
   */
  appId?: string;
  /** The organization ID */
  organizationId?: string;
  /** Virtual API key ID used for the request */
  virtualKeyId?: string;
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
  /**
   * Bridge for asking the user a structured question mid-execution (the chat
   * elicitation round-trip). Present only when a chat stream is driving the
   * call; absent in headless executions, where a built-in tool must degrade to
   * a typed `no_viewer` outcome rather than block.
   */
  elicitation?: ChatMcpElicitationBridge;
  /** Whether the current caller context is still trusted/safe */
  contextIsTrusted?: boolean;
  /**
   * Chat can pause before execution for user approval. When true, tools that
   * require approval are allowed to continue because the chat harness already
   * handled the approval gate.
   */
  approvalRequiredPoliciesHandled?: boolean;
}
