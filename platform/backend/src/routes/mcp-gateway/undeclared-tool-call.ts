import {
  isAgentTool,
  isSkillTool,
  TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
  TOOL_INVOCATION_NOT_DIRECTLY_CALLABLE_REASON,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
  type ToolStateMcpToolError,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  disabledToolsNotRunMessage,
  toolsRequireRunToolMessage,
} from "@/archestra-mcp-server/tool-recovery-messages";
import { ToolModel } from "@/models";

// ===================================================================
// Public API
// ===================================================================

export interface UndeclaredToolCallRefusal {
  /** Model-facing recovery text: how to reach the tool, or that it is off. */
  message: string;
  /** The client-visible reason, for logs and blocked-call metrics. */
  reason: string;
  error: ToolStateMcpToolError;
}

/**
 * Refuse a direct gateway call to a tool the agent does not have.
 *
 * On the gateway the enabled set is the agent's *assigned* tools, so a name
 * outside it is a genuine authorization miss, and the gateway is itself the
 * party that would otherwise execute it. The refusal steers the model: when
 * the agent advertises the search_tools/run_tool dispatch pair
 * (`search_and_run_only` exposure), third-party tools are deliberately absent
 * from its list rather than disabled, so the model is told to retry through
 * run_tool instead of being told to stop.
 *
 * Built-in Archestra tools and agent/skill delegation tools are never refused
 * here — they are dispatched by their own handlers.
 */
export async function refuseUndeclaredMcpToolCall(params: {
  agentId: string;
  toolName: string;
  /**
   * Pre-fetched assigned tool names (plus any dynamically resolved tool the
   * caller will execute). Queried when omitted.
   */
  enabledToolNames?: Set<string>;
}): Promise<UndeclaredToolCallRefusal | null> {
  const { toolName } = params;
  if (
    archestraMcpBranding.isToolName(toolName) ||
    isAgentTool(toolName) ||
    isSkillTool(toolName)
  ) {
    return null;
  }

  const enabledToolNames =
    params.enabledToolNames ??
    (await ToolModel.getAssignedToolNames(params.agentId));
  // An agent with no assigned tools has nothing to compare against; the
  // execution path reports the missing tool itself.
  if (enabledToolNames.size === 0 || enabledToolNames.has(toolName)) {
    return null;
  }

  const dispatchPair = findDispatchToolNames(enabledToolNames);
  const message = dispatchPair
    ? toolsRequireRunToolMessage({ toolNames: [toolName], ...dispatchPair })
    : disabledToolsNotRunMessage([toolName]);
  return {
    message,
    reason: dispatchPair
      ? TOOL_INVOCATION_NOT_DIRECTLY_CALLABLE_REASON
      : TOOL_INVOCATION_DISABLED_FOR_CONVERSATION_REASON,
    error: {
      type: "tool_state",
      code: dispatchPair ? "tool_not_directly_callable" : "tool_not_enabled",
      message,
      toolName,
    },
  };
}

// ===================================================================
// Internal helpers
// ===================================================================

/**
 * The search_tools/run_tool pair as it appears in the enabled set, or null
 * when the set does not hold both. Located by short name so a custom-branded
 * prefix (e.g. `acme__run_tool`) is recognized and echoed back exactly as the
 * model sees it.
 */
function findDispatchToolNames(
  enabledToolNames: Set<string>,
): { searchToolsName: string; runToolName: string } | null {
  let searchToolsName: string | undefined;
  let runToolName: string | undefined;
  for (const name of enabledToolNames) {
    const shortName = archestraMcpBranding.getToolShortName(name);
    if (shortName === TOOL_SEARCH_TOOLS_SHORT_NAME) {
      searchToolsName = name;
    } else if (shortName === TOOL_RUN_TOOL_SHORT_NAME) {
      runToolName = name;
    }
  }
  return searchToolsName && runToolName
    ? { searchToolsName, runToolName }
    : null;
}
