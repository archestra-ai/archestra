import {
  buildUserSystemPromptContext,
  TOOL_LOAD_SKILL_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import type { Tool } from "ai";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { TeamModel, UserModel } from "@/models";
import { buildSkillCatalogPrompt } from "@/skills/skill-catalog-prompt";
import {
  promptNeedsRendering,
  renderSystemPrompt,
  type UserSystemPromptContext,
} from "@/templating";
import type { ToolExposureMode } from "@/types";

/** @public — canonical instruction text, asserted by the assembler tests. */
export const TOOL_DENIAL_INSTRUCTION =
  "When a tool execution is not approved by the user, do not retry it. Explain what happened and ask the user what they'd like to do instead.";

/** @public — canonical instruction text, asserted by the assembler tests. */
export const TOOL_UI_RESULT_INSTRUCTION =
  "When a tool result includes a UI resource, it means an interactive UI was rendered for the user. Respond with at most one brief sentence. Never describe, list, or explain what the UI shows.";

/**
 * Compose an agent's system prompt: render its base prompt (with Handlebars
 * user context when needed), eagerly list its loadable skills, and append the
 * tool-behavior instructions implied by its tool set and exposure mode. Shared
 * by the interactive chat path and the autonomous A2A path so both produce the
 * same prompt from the same inputs.
 */
export async function buildAgentSystemPrompt(params: {
  agent: {
    systemPrompt: string | null;
    toolExposureMode: ToolExposureMode;
  };
  mcpTools: Record<string, Tool>;
  organizationId: string;
  userId: string;
  agentId: string;
  /**
   * Pre-resolved invoking user. The chat path has it in hand; the A2A path
   * omits it and it is fetched on demand only when the prompt uses templating.
   */
  user?: { name: string; email: string };
  /** Context injected by SessionStart hooks (chat only), appended last. */
  hookSessionContext?: string;
}): Promise<string | undefined> {
  const {
    agent,
    mcpTools,
    organizationId,
    userId,
    agentId,
    user,
    hookSessionContext,
  } = params;

  const renderedPrompt = await renderAgentPrompt({
    systemPrompt: agent.systemPrompt,
    organizationId,
    userId,
    user,
  });

  const toolLoadingInstructions =
    agent.toolExposureMode === "search_and_run_only"
      ? buildLoadToolsWhenNeededSystemPrompt()
      : null;

  const toolResultInstructions =
    Object.keys(mcpTools).length > 0 ? TOOL_UI_RESULT_INSTRUCTION : null;

  // eagerly list the agent's skills in the prompt (like Claude Code /
  // opencode), but only when the agent can actually load them.
  const skillCatalogPrompt =
    archestraMcpBranding.getToolName(TOOL_LOAD_SKILL_SHORT_NAME) in mcpTools
      ? await buildSkillCatalogPrompt({ organizationId, userId, agentId })
      : null;

  return (
    [
      toolLoadingInstructions,
      renderedPrompt,
      skillCatalogPrompt,
      TOOL_DENIAL_INSTRUCTION,
      toolResultInstructions,
      hookSessionContext,
    ]
      .filter(Boolean)
      .join("\n\n") || undefined
  );
}

// ===== Internal helpers =====

async function renderAgentPrompt(params: {
  systemPrompt: string | null;
  organizationId: string;
  userId: string;
  user?: { name: string; email: string };
}): Promise<string | null> {
  const { systemPrompt, organizationId, userId, user } = params;

  // Build template context only when prompts use Handlebars syntax.
  let promptContext: UserSystemPromptContext | null = null;
  if (promptNeedsRendering(systemPrompt)) {
    const [resolvedUser, userTeams] = await Promise.all([
      user ?? UserModel.getById(userId),
      TeamModel.getUserTeamsForOrganization({ userId, organizationId }),
    ]);
    promptContext = buildUserSystemPromptContext({
      userName: resolvedUser?.name ?? "",
      userEmail: resolvedUser?.email ?? "",
      userTeams: userTeams.map((t) => t.name),
    });
  }

  return renderSystemPrompt(systemPrompt, promptContext);
}

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
