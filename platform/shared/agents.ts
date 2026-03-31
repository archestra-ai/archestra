import { TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME } from "./archestra-mcp-server";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "./consts";

/**
 * Prefix for agent delegation tools.
 * Format: agent__<slugified_agent_name>
 * These are dynamically generated and are not Archestra MCP tools.
 */
export const AGENT_TOOL_PREFIX = `agent${MCP_SERVER_TOOL_NAME_SEPARATOR}`;

/** Maximum number of suggested prompts per agent */
export const MAX_SUGGESTED_PROMPTS = 10;

/** Maximum character length for a suggested prompt's summary title (button label) */
export const MAX_SUGGESTED_PROMPT_TITLE_LENGTH = 50;

/** Maximum character length for a suggested prompt's full prompt text */
export const MAX_SUGGESTED_PROMPT_TEXT_LENGTH = 5000;

/**
 * Check if a tool name is an agent delegation tool (agent__<name>).
 */
export function isAgentTool(toolName: string): boolean {
  return toolName.startsWith(AGENT_TOOL_PREFIX);
}

export const SWAP_AGENT_POKE_TEXT =
  "(Agent was swapped. Please continue the conversation.)";
export const SWAP_AGENT_POKE_PREFIX = "(Switched to ";
export const SWAP_AGENT_POKE_AGENT_NAME_SUFFIX =
  ". Please continue the conversation.";
export const SWAP_AGENT_FAILED_POKE_TEXT =
  "(The agent swap failed — you are still the same agent. Briefly explain to the user that the switch did not happen and continue the conversation.)";
export const SWAP_TO_DEFAULT_AGENT_POKE_TEXT =
  "(Switched back to the default agent. Briefly explain why you switched back and continue the conversation.)";

export function makeSwapAgentPokeText(agentName: string): string {
  return `${SWAP_AGENT_POKE_PREFIX}${agentName}${SWAP_AGENT_POKE_AGENT_NAME_SUFFIX} If you have the ${TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME} tool and you don't have the right tools to fulfill the request, use it immediately — write a brief message explaining why you are switching back, then call ${TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME}.)`;
}
