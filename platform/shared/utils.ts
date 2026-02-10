import {
  AGENT_TOOL_PREFIX,
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "./consts";

/**
 * Parse a fully-qualified MCP tool name into server name and raw tool name.
 * Splits on the LAST "__" to handle server names that contain "__"
 * (e.g., "upstash__context7__resolve-library-id" → server: "upstash__context7", tool: "resolve-library-id").
 */
export function parseFullToolName(fullName: string): {
  serverName: string | null;
  toolName: string;
} {
  const index = fullName.lastIndexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
  if (index <= 0) return { serverName: null, toolName: fullName };
  return {
    serverName: fullName.substring(0, index),
    toolName: fullName.substring(index + MCP_SERVER_TOOL_NAME_SEPARATOR.length),
  };
}

export function isArchestraMcpServerTool(toolName: string): boolean {
  return toolName.startsWith(
    `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`,
  );
}

/**
 * Check if a tool name is an agent delegation tool (agent__<name>)
 * Agent tools are separate from Archestra tools - they enable prompt-to-prompt delegation
 */
export function isAgentTool(toolName: string): boolean {
  return toolName.startsWith(AGENT_TOOL_PREFIX);
}

/**
 * Check if a value is a BYOS vault reference (path#key format)
 * Type guard to narrow string | undefined to string
 */
export function isVaultReference(value: string | undefined): value is string {
  if (!value) return false;
  // Vault references look like "secret/data/path/to/secret#keyname"
  // They contain a # and the part before # looks like a path
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) return false;
  const path = value.substring(0, hashIndex);
  // Basic check: path should contain "/" and not be too short
  return path.includes("/") && path.length > 5;
}

/**
 * Parse a vault reference into path and key
 */
export function parseVaultReference(value: string): {
  path: string;
  key: string;
} {
  const hashIndex = value.indexOf("#");
  return {
    path: value.substring(0, hashIndex),
    key: value.substring(hashIndex + 1),
  };
}

export function formatSecretStorageType(
  storageType: "vault" | "external_vault" | "database" | "none" | undefined,
): string {
  switch (storageType) {
    case "vault":
      return "Vault";
    case "external_vault":
      return "External Vault";
    case "database":
      return "Database";
    default:
      return "None";
  }
}

/**
 * Slugify a name to create a URL-safe identifier
 * Used for generating tool names from prompt/agent names
 */
export function slugify(name: string): string {
  const slugified = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  // Trim leading and trailing underscores without backtracking regex
  let start = 0;
  let end = slugified.length;
  while (start < end && slugified[start] === "_") start++;
  while (end > start && slugified[end - 1] === "_") end--;

  return slugified.slice(start, end);
}

/**
 * Check if a tool name is a Playwright/browser MCP tool.
 * Matches tools from Playwright MCP server (e.g., microsoft__playwright-mcp__browser_navigate)
 * and tools with browser_ prefix.
 */
export function isBrowserMcpTool(toolName: string): boolean {
  return toolName.includes("playwright") || toolName.startsWith("browser_");
}
