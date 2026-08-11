import type { Tool } from "ai";
import { buildAgentSystemPrompt } from "@/agents/agent-system-prompt";
import {
  getChatMcpTools,
  getChatMcpToolUiResourceUris,
} from "@/clients/chat-mcp-client";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import type { ChatTaskBridge } from "@/clients/chat-task-bridge";
import type { SubagentToolStreamBridge } from "@/clients/subagent-tool-stream";
import { ToolCallRepeatTracker } from "@/clients/tool-call-repeat-tracker";
import type { IncognitoAuditContext } from "@/content-encryption/incognito";
import type { CollectedHookRun } from "@/hooks/hook-run-parts";
import type { KbChunkForQuoteCheck } from "@/knowledge-base/quote-verification";
import { ConversationEnabledToolModel } from "@/models";
import type { OpenedApp } from "@/services/apps/opened-app-context";
import type { ToolExposureMode } from "@/types";

/**
 * Assemble everything the chat stream needs about its agent before the first
 * model call: the MCP tool set (with enabled-tool filtering), the tool UI
 * resource URIs, and the composed system prompt.
 */
export async function buildChatContext(params: {
  conversationId: string;
  agentId: string;
  agent: {
    name: string;
    systemPrompt: string | null;
    toolExposureMode: ToolExposureMode;
  };
  user: { id: string; email: string; name: string };
  organizationId: string;
  /** Context injected by SessionStart hooks, appended to the system prompt. */
  hookSessionContext: string | undefined;
  /** The project's instructions, when this chat belongs to a project. */
  projectInstructions: string | undefined;
  /** The app this chat was opened with, when it was opened from one. */
  openedApp: OpenedApp | undefined;
  /** Filenames of the project's shared files, when this chat belongs to a project. */
  projectFileNames: string[] | undefined;
  hookRunCollector: CollectedHookRun[];
  /**
   * Per-turn sink for the KB chunks `query_knowledge_sources` returns, absent
   * when quote verification is disabled (see kbChunksCollector on
   * ChatToolContext).
   */
  kbChunksCollector: KbChunkForQuoteCheck[] | undefined;
  elicitation: ChatMcpElicitationBridge;
  subagentToolStream: SubagentToolStreamBridge;
  taskBridge: ChatTaskBridge;
  abortSignal: AbortSignal;
  /**
   * Incognito conversation: span content is suppressed and long calls never
   * detach into durable tasks.
   */
  suppressContentLogging: boolean;
  /**
   * Encrypts the tool-call logs and execution-claim results this run produces
   * under the conversation key. Null when the conversation has no escrow
   * record, which falls those surfaces back to redaction.
   */
  incognitoAudit: IncognitoAuditContext | null;
}): Promise<{
  mcpTools: Record<string, Tool>;
  toolUiResourceUris: Record<string, string>;
  systemPrompt: string | undefined;
  /** How the tool set was filtered — surfaced for the stream-start log line. */
  toolSelection: { hasCustomSelection: boolean; enabledToolCount: number };
  /** Per-run tracker shared with the stream's repeated-call stop condition. */
  repeatTracker: ToolCallRepeatTracker;
}> {
  const {
    conversationId,
    agentId,
    agent,
    user,
    organizationId,
    hookSessionContext,
    projectInstructions,
    openedApp,
    projectFileNames,
    hookRunCollector,
    kbChunksCollector,
    elicitation,
    subagentToolStream,
    taskBridge,
    abortSignal,
    suppressContentLogging,
    incognitoAudit,
  } = params;

  const [enabledToolIds, hasCustomSelection] = await Promise.all([
    ConversationEnabledToolModel.findByConversation(conversationId),
    ConversationEnabledToolModel.hasCustomSelection(conversationId),
  ]);

  // One tracker per run, shared with the stream's repeated-call stop condition.
  const repeatTracker = new ToolCallRepeatTracker();

  // Fetch MCP tools with enabled tool filtering
  // Pass undefined if no custom selection (use all tools)
  // Pass the actual array (even if empty) if there is custom selection
  const [mcpTools, toolUiResourceUris] = await Promise.all([
    getChatMcpTools({
      agentName: agent.name,
      agentId,
      userId: user.id,
      enabledToolIds: hasCustomSelection ? enabledToolIds : undefined,
      conversationId,
      // The exchange tools' "app" side keys off the access-verified open app;
      // external apps have no owned namespace, so only "owned" threads an id.
      openedAppId: openedApp?.kind === "owned" ? openedApp.id : undefined,
      organizationId,
      // Pass conversationId as sessionId to group all chat requests (including delegated agents) together
      sessionId: conversationId,
      // Pass agentId as initial delegation chain (will be extended by delegated agents)
      delegationChain: agentId,
      abortSignal,
      elicitation,
      user,
      hookRunCollector,
      kbChunksCollector,
      subagentToolStream,
      taskBridge,
      repeatTracker,
      suppressContentLogging,
      incognitoAudit,
    }),
    getChatMcpToolUiResourceUris(agentId),
  ]);

  const systemPrompt = await buildAgentSystemPrompt({
    agent,
    mcpTools,
    organizationId,
    userId: user.id,
    agentId,
    user: { name: user.name, email: user.email },
    hookSessionContext,
    projectInstructions,
    openedApp,
    projectFileNames,
  });

  return {
    mcpTools,
    toolUiResourceUris,
    systemPrompt,
    toolSelection: {
      hasCustomSelection,
      enabledToolCount: enabledToolIds.length,
    },
    repeatTracker,
  };
}
