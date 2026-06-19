import {
  buildUserSystemPromptContext,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { Tool } from "ai";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import {
  getChatMcpTools,
  getChatMcpToolUiResourceUris,
} from "@/clients/chat-mcp-client";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import type { CollectedHookRun } from "@/hooks/hook-run-parts";
import { ConversationEnabledToolModel, TeamModel } from "@/models";
import { buildSkillCatalogPrompt } from "@/skills/skill-catalog-prompt";
import {
  promptNeedsRendering,
  renderSystemPrompt,
  type UserSystemPromptContext,
} from "@/templating";
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
  hookRunCollector: CollectedHookRun[];
  elicitation: ChatMcpElicitationBridge;
  abortSignal: AbortSignal;
}): Promise<{
  mcpTools: Record<string, Tool>;
  toolUiResourceUris: Record<string, string>;
  systemPrompt: string | undefined;
  /** How the tool set was filtered — surfaced for the stream-start log line. */
  toolSelection: { hasCustomSelection: boolean; enabledToolCount: number };
}> {
  const {
    conversationId,
    agentId,
    agent,
    user,
    organizationId,
    hookSessionContext,
    hookRunCollector,
    elicitation,
    abortSignal,
  } = params;

  const [enabledToolIds, hasCustomSelection] = await Promise.all([
    ConversationEnabledToolModel.findByConversation(conversationId),
    ConversationEnabledToolModel.hasCustomSelection(conversationId),
  ]);

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
    }),
    getChatMcpToolUiResourceUris(agentId),
  ]);

  // Build template context only when prompts use Handlebars syntax
  let promptContext: UserSystemPromptContext | null = null;
  if (promptNeedsRendering(agent.systemPrompt)) {
    const userTeams = await TeamModel.getUserTeamsForOrganization({
      userId: user.id,
      organizationId,
    });
    promptContext = buildUserSystemPromptContext({
      userName: user.name,
      userEmail: user.email,
      userTeams: userTeams.map((t) => t.name),
    });
  }

  const renderedPrompt = renderSystemPrompt(agent.systemPrompt, promptContext);

  let toolResultInstructions: string = "";
  // Add MCP UI instruction when tools are available
  if (Object.keys(mcpTools).length > 0) {
    toolResultInstructions =
      "When a tool result includes a UI resource, it means an interactive UI was rendered for the user. Respond with at most one brief sentence. Never describe, list, or explain what the UI shows.";
  }

  const toolDenialInstruction =
    "When a tool execution is not approved by the user, do not retry it. Explain what happened and ask the user what they'd like to do instead.";

  const toolLoadingInstructions =
    agent.toolExposureMode === "search_and_run_only"
      ? buildLoadToolsWhenNeededSystemPrompt()
      : "";

  // eagerly list the agent's skills in the prompt (like Claude Code /
  // opencode), but only when the agent can actually load them.
  const skillCatalogPrompt =
    archestraMcpBranding.getToolName(TOOL_LOAD_SKILL_SHORT_NAME) in mcpTools
      ? await buildSkillCatalogPrompt({
          organizationId,
          userId: user.id,
          agentId,
        })
      : null;

  const systemPrompt =
    [
      toolLoadingInstructions,
      renderedPrompt,
      skillCatalogPrompt,
      toolDenialInstruction,
      toolResultInstructions,
      // Context returned by SessionStart hooks.
      hookSessionContext,
    ]
      .filter(Boolean)
      .join("\n\n") || undefined;

  return {
    mcpTools,
    toolUiResourceUris,
    systemPrompt,
    toolSelection: {
      hasCustomSelection,
      enabledToolCount: enabledToolIds.length,
    },
  };
}

// ===== Internal helpers =====

function buildLoadToolsWhenNeededSystemPrompt(): string {
  const searchToolsName = archestraMcpBranding.getToolName(
    TOOL_SEARCH_TOOLS_SHORT_NAME,
  );
  const runToolName = archestraMcpBranding.getToolName(
    TOOL_RUN_TOOL_SHORT_NAME,
  );

  return `Some available tools are not listed upfront and must be discovered. If the visible tools do not fit the task, call \`${searchToolsName}\` to find relevant tools, then call \`${runToolName}\` with a tool name it returned. Only pass \`${runToolName}\` a tool name that \`${searchToolsName}\` returned or that appeared verbatim earlier in this conversation; if you do not have an exact name, call \`${searchToolsName}\` first.

\`${runToolName}\` takes exactly two arguments: \`tool_name\` (the exact name) and \`tool_args\` (an object holding the target tool's own parameters). Put every target parameter inside \`tool_args\` — not alongside \`tool_name\`. For example, to call a tool \`acme__send_message\` that takes \`channel\` and \`text\`, call \`${runToolName}\` with \`{"tool_name": "acme__send_message", "tool_args": {"channel": "#general", "text": "hi"}}\`. The \`${searchToolsName}\` parameter signatures are summaries; if a \`${runToolName}\` call is rejected as invalid, the error describes the expected input (for third-party tools, the target tool's full input schema) — use it to correct the call.`;
}
