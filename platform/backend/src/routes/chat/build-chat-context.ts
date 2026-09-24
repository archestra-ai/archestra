import {
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { Tool } from "ai";
import { buildAgentSystemPrompt } from "@/agents/agent-system-prompt";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import {
  getChatMcpTools,
  getChatMcpToolUiResourceUris,
} from "@/clients/chat-mcp-client";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import type { ChatTaskBridge } from "@/clients/chat-task-bridge";
import type { SubagentToolStreamBridge } from "@/clients/subagent-tool-stream";
import { ToolCallRepeatTracker } from "@/clients/tool-call-repeat-tracker";
import type { LockedChatAuditContext } from "@/content-encryption/locked-chat";
import type { CollectedHookRun } from "@/hooks/hook-run-parts";
import type { KbChunkForQuoteCheck } from "@/knowledge-base/quote-verification";
import { ConversationEnabledToolModel } from "@/models";
import { openappaEnabled } from "@/openappa/service";
import type { OpenedApp } from "@/services/apps/opened-app-context";
import type { ToolExposureMode } from "@/types";
import type { ConversationOrigin } from "@/types/conversation";

/**
 * Assemble everything the chat stream needs about its agent before the first
 * model call: the MCP tool set (with enabled-tool filtering), the tool UI
 * resource URIs, and the composed system prompt.
 */
export async function buildChatContext(params: {
  conversationId: string;
  conversationOrigin?: ConversationOrigin;
  agentId: string;
  agent: {
    name: string;
    systemPrompt: string | null;
    toolExposureMode: ToolExposureMode;
  };
  user: { id: string; email: string; name: string };
  organizationId: string;
  /** Whether tool-result images may be forwarded into this model's context. */
  modelAcceptsImageToolResults: boolean;
  /** Context injected by SessionStart hooks, appended to the system prompt. */
  hookSessionContext: string | undefined;
  /** The project's instructions, when this chat belongs to a project. */
  projectInstructions: string | undefined;
  /** The app this chat was opened with, when it was opened from one. */
  openedApp: OpenedApp | undefined;
  /** Filenames of the project's shared files, when this chat belongs to a project. */
  projectFileNames: string[] | undefined;
  /**
   * Hidden scope reminder for an OpenAPPA policy-target conversation (see
   * `readOpenAppaPolicyTargetContext`), appended to the policy-chat system
   * prompt below. Undefined for every other conversation, and ignored unless
   * `conversationOrigin` is "openappa".
   */
  openAppaPolicyTargetContext: string | undefined;
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
   * Locked chat: span content is suppressed and long calls never
   * detach into durable tasks.
   */
  suppressContentLogging: boolean;
  /**
   * Encrypts the tool-call logs and execution-claim results this run produces
   * under the conversation key. Null when the conversation has no escrow
   * record, which falls those surfaces back to redaction.
   */
  lockedChatAudit: LockedChatAuditContext | null;
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
    modelAcceptsImageToolResults,
    hookSessionContext,
    projectInstructions,
    openedApp,
    projectFileNames,
    openAppaPolicyTargetContext,
    hookRunCollector,
    kbChunksCollector,
    elicitation,
    subagentToolStream,
    taskBridge,
    abortSignal,
    suppressContentLogging,
    lockedChatAudit,
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
      modelAcceptsImageToolResults,
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
      lockedChatAudit,
    }),
    getChatMcpToolUiResourceUris(agentId),
  ]);

  const isPolicyChat =
    params.conversationOrigin === "openappa" && openappaEnabled();
  const availableTools = isPolicyChat
    ? Object.fromEntries(
        Object.entries(mcpTools).filter(([name]) =>
          POLICY_CHAT_TOOL_SHORT_NAMES.has(
            archestraMcpBranding.getToolShortName(name) ?? "",
          ),
        ),
      )
    : mcpTools;
  const baseSystemPrompt = await buildAgentSystemPrompt({
    agent: isPolicyChat
      ? {
          ...agent,
          name: "OpenAPPA",
          systemPrompt: null,
          toolExposureMode: "full" as const,
        }
      : agent,
    mcpTools: availableTools,
    organizationId,
    userId: user.id,
    agentId,
    user: { name: user.name, email: user.email },
    hookSessionContext,
    projectInstructions,
    openedApp,
    projectFileNames,
    // The stream above carries ask_user's question to the user and back.
    canAskUser: true,
  });
  const systemPrompt = isPolicyChat
    ? `${baseSystemPrompt ?? ""}\n\nThis conversation is dedicated to configuring this deployment's OpenAPPA policy. Your normal agent role does not apply here. Load the built-in appa-guide skill with archestra__load_skill before policy work, then follow its current workflow. Use the built-in OpenAPPA tools to read the current policy and relevant MCP tools, preview proposed changes and explain the diff, and publish only changes the user requested. Publishing creates a GitHub pull request when sync is configured, or saves a local revision otherwise. For questions or inspection, explain the current effective policy without saving. Never claim a proposed change is active until the policy tool confirms it.${openAppaPolicyTargetContext ? `\n\n${openAppaPolicyTargetContext}` : ""}`
    : baseSystemPrompt;

  return {
    mcpTools: availableTools,
    toolUiResourceUris,
    systemPrompt,
    toolSelection: {
      hasCustomSelection,
      enabledToolCount: enabledToolIds.length,
    },
    repeatTracker,
  };
}

const POLICY_CHAT_TOOL_SHORT_NAMES = new Set([
  "get_guardrails_policy",
  "validate_guardrails_policy",
  "preview_guardrails_policy_change",
  "update_guardrails_policy",
  "get_guardrails_policy_change_status",
  "list_mcp_server_deployments",
  "get_mcp_server_tools",
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_ASK_USER_SHORT_NAME,
]);
