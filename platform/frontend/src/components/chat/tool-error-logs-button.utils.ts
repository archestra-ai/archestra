import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";

/**
 * Extracts the MCP server name from a full tool name.
 * Tool names follow the pattern: serverName__toolName
 */
export function extractMcpServerName(toolName: string): string | null {
  const separatorIndex = toolName.indexOf(MCP_SERVER_TOOL_NAME_SEPARATOR);
  if (separatorIndex === -1) return null;
  return toolName.slice(0, separatorIndex);
}
