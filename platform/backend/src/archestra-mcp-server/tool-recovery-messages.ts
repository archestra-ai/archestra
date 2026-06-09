import {
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "./branding";

// Branded tool names (`archestraMcpBranding.getToolName`) are used throughout so
// the names match exactly what the model sees in its tool list and system prompt:
// a custom-branded org exposes these tools under a different prefix, and naming
// the canonical `archestra__*` form would point the model at a tool it cannot
// see, defeating the recovery loop.

/**
 * Recovery-oriented message for a third-party tool name that is not available to
 * the agent (hallucinated or simply not assigned). Steers the model at
 * search_tools — the intended discovery path — then run_tool.
 *
 * Shared by the run_tool dispatcher (`run-tool.ts`) and the gateway execution
 * path (`clients/mcp-client.ts`) so both surfaces stay verbatim-consistent.
 */
export function unavailableThirdPartyToolMessage(toolName: string): string {
  const searchToolsName = archestraMcpBranding.getToolName(
    TOOL_SEARCH_TOOLS_SHORT_NAME,
  );
  const runToolName = archestraMcpBranding.getToolName(
    TOOL_RUN_TOOL_SHORT_NAME,
  );
  return (
    `No tool named "${toolName}" is available to this agent. It may not exist ` +
    `or is not assigned to this conversation. Call ${searchToolsName} with a ` +
    "description of the capability you need to find the exact tool name, then " +
    `call ${runToolName} again. Do not guess tool names.`
  );
}

/**
 * Recovery message for a tool that exists and is assigned but has been disabled
 * for the current conversation via the per-conversation tool selection. Distinct
 * from `unavailableThirdPartyToolMessage` (which is about non-existent / not
 * assigned tools): here the tool is real, just not enabled in this conversation.
 */
export function toolNotEnabledForConversationMessage(toolName: string): string {
  const searchToolsName = archestraMcpBranding.getToolName(
    TOOL_SEARCH_TOOLS_SHORT_NAME,
  );
  return (
    `Tool "${toolName}" is not enabled for this conversation. Call ` +
    `${searchToolsName} to see the tools available here, then call run_tool ` +
    "with one of those. Do not guess tool names."
  );
}

/**
 * Generic discovery steer appended after an "unknown tool"/"not assigned"
 * preamble. Single source of truth for the dispatch-surface recovery hint used
 * by `executeArchestraTool` (`index.ts`).
 */
export function toolDiscoverySteer(): string {
  const searchToolsName = archestraMcpBranding.getToolName(
    TOOL_SEARCH_TOOLS_SHORT_NAME,
  );
  return `Call ${searchToolsName} to discover the tools available to you, then use an exact name it returns. Do not guess tool names.`;
}
