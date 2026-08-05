import type { SensitiveContextOrigin } from "@archestra/shared";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import type { ChatTaskBridge } from "@/clients/chat-task-bridge";
import type { TokenAuthContext } from "@/clients/mcp-client";
import type { SubagentToolStreamBridge } from "@/clients/subagent-tool-stream";

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
  /**
   * The owned app the chat's UI currently has open, set ONLY by the chat route
   * after `resolveOpenedApp` re-verified the viewer's access this turn. The
   * agent-side exchange tool (`copy_file`) keys its "app" side off this — never
   * off a tool argument — so an agent can only reach the namespace of the app
   * the user is actually looking at. Distinct from `appId`: that is "this call
   * IS the app runtime"; this is "the chat has an app open".
   */
  openedAppId?: string;
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
  /** Schedule trigger run ID — identifies the scheduled run this execution belongs to */
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
   * What flipped the caller's session into the sensitive state, when known.
   * Meaningful only when `contextIsTrusted` is false; used to phrase
   * sensitive-context policy blocks so they name the origin.
   */
  sensitiveContextOrigin?: SensitiveContextOrigin;
  /**
   * Bridge that surfaces a delegated child agent's tool calls on the caller's
   * conversation surface. Present only when a chat stream is driving the call;
   * absent in headless executions (no conversation surface to render onto). One
   * instance is shared down the delegation chain so nested calls surface too.
   */
  subagentToolStream?: SubagentToolStreamBridge;
  /**
   * Bridge that detaches a long-running dispatched call into a durable,
   * cancellable task. Matters most for `run_tool`: in `search_and_run_only`
   * mode every third-party tool call arrives through it, so without this the
   * agents most likely to call a slow tool would be the ones that never got a
   * task. Absent in headless executions, where nobody is watching.
   */
  taskBridge?: ChatTaskBridge;
  /**
   * The id of the tool call currently executing. Set on the delegation path so
   * the child's surfaced tool calls can be attributed to the delegation call
   * (`agent__<slug>`) that spawned them, and on the `run_tool` path so a task
   * card attaches to the call the user can actually see.
   */
  currentToolCallId?: string;
  /**
   * Chat can pause before execution for user approval. When true, tools that
   * require approval are allowed to continue because the chat harness already
   * handled the approval gate.
   */
  approvalRequiredPoliciesHandled?: boolean;
  /**
   * Incognito conversation: any real tool dispatch made on behalf of this call
   * (e.g. `run_tool` reaching mcpClient) must persist a content-redacted
   * mcp_tool_calls row.
   */
  suppressContentLogging?: boolean;
}
