import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";

/**
 * Slugify a tool name to get a unique name for the MCP server's tool
 */
export function slugifyName(mcpServerName: string, toolName: string): string {
  return `${mcpServerName}${MCP_SERVER_TOOL_NAME_SEPARATOR}${toolName}`
    .toLowerCase()
    .replace(/ /g, "_");
}
