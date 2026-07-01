import type { Tool } from "ai";
import { buildAgentSystemPrompt } from "@/agents/agent-system-prompt";
import {
  getChatMcpTools,
  getChatMcpToolUiResourceUris,
} from "@/clients/chat-mcp-client";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import type { SubagentToolStreamBridge } from "@/clients/subagent-tool-stream";
import { ToolCallRepeatTracker } from "@/clients/tool-call-repeat-tracker";
import type { CollectedHookRun } from "@/hooks/hook-run-parts";
import { ConversationEnabledToolModel } from "@/models";
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
  hookRunCollector: CollectedHookRun[];
  elicitation: ChatMcpElicitationBridge;
  subagentToolStream: SubagentToolStreamBridge;
  abortSignal: AbortSignal;
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
    hookRunCollector,
    elicitation,
    subagentToolStream,
    abortSignal,
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
      organizationId,
      // Pass conversationId as sessionId to group all chat requests (including delegated agents) together
      sessionId: conversationId,
      // Pass agentId as initial delegation chain (will be extended by delegated agents)
      delegationChain: agentId,
      abortSignal,
      elicitation,
      user,
      hookRunCollector,
      subagentToolStream,
      repeatTracker,
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
