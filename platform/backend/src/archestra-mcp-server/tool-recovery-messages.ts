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
 * Recovery message for the LLM-proxy guardrail path, where one or more tools the
 * model tried to call were filtered out because they are disabled for the
 * conversation. Distinct from the run_tool dispatcher's per-call recovery: here
 * the calls were already emitted and dropped, so the steer also says not to
 * retry them.
 */
export function disabledToolsNotRunMessage(toolNames: string[]): string {
  const searchToolsName = archestraMcpBranding.getToolName(
    TOOL_SEARCH_TOOLS_SHORT_NAME,
  );
  const toolList = toolNames.join(", ");
  return (
    `The tools "${toolList}" are not enabled for this conversation and were ` +
    `not run. Do not call them again here. Use a tool that is available to ` +
    `you, or call ${searchToolsName} to discover the tools you can use.`
  );
}

/**
 * Soft warning prepended to a successful run_tool result when a short name was
 * recovered to its exact `server__tool` form. The call ran; this steers the
 * model to pass the exact name next time so the implicit short-name fallback is
 * not relied on.
 */
export function recoveredShortNameNotice(
  requestedName: string,
  fullName: string,
): string {
  const runToolName = archestraMcpBranding.getToolName(
    TOOL_RUN_TOOL_SHORT_NAME,
  );
  return (
    `Note: "${requestedName}" is not an exact tool name; it was interpreted as ` +
    `"${fullName}". Call ${runToolName} with the exact full name "${fullName}" ` +
    "(the server__tool form) next time — short names are accepted only as a " +
    "fallback and may stop resolving if another tool matches the same short name."
  );
}

/**
 * Recovery message when a short name matches more than one tool available to the
 * agent. Lists the candidate full names and asks the model to pick one rather
 * than guessing — the disambiguation half of the implicit short-name fallback.
 */
export function ambiguousShortNameMessage(
  requestedName: string,
  candidates: string[],
): string {
  const runToolName = archestraMcpBranding.getToolName(
    TOOL_RUN_TOOL_SHORT_NAME,
  );
  const list = candidates.map((name) => `"${name}"`).join(", ");
  return (
    `The name "${requestedName}" is ambiguous — it matches multiple tools ` +
    `available to this agent: ${list}. Call ${runToolName} again with the exact ` +
    "full name (the server__tool form) you intend. Do not guess tool names."
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
