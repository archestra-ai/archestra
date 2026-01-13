import type { archestraApiTypes } from "@shared";

export function isMcpTool(
  tool: archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number]["tool"],
) {
  return Boolean(tool.mcpServerName || tool.catalogId);
}

/**
 * Check if a tool is an MCP tool based on its properties
 * Works with ToolWithAssignments data structure
 */
export function isMcpToolByProperties(tool: {
  mcpServerName: string | null;
  catalogId: string | null;
}) {
  return Boolean(tool.mcpServerName || tool.catalogId);
}
