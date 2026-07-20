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

/**
 * Prefix for skill delegation tools.
 * Format: skill__<slugified_skill_name>
 * One is synthesized per accessible skill whose SKILL.md declares an `agent`;
 * calling it runs the skill (instructions + task) in that agent.
 */
export const SKILL_TOOL_PREFIX = `skill${MCP_SERVER_TOOL_NAME_SEPARATOR}`;

/**
 * Check if a tool name is a skill delegation tool (skill__<name>).
 */
export function isSkillTool(toolName: string): boolean {
  return toolName.startsWith(SKILL_TOOL_PREFIX);
}

// Hop-by-hop (RFC 7230) and protocol-level headers that must not be forwarded
export const BLOCKED_PASSTHROUGH_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export const MAX_PASSTHROUGH_HEADERS = 20;

export const HEADER_NAME_REGEX = /^[a-zA-Z0-9-]+$/;
