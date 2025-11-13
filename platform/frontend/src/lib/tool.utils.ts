import type { archestraApiTypes } from "@shared";

export function isMcpTool(
  tool:
    | archestraApiTypes.GetAllAgentToolsResponses["200"][number]["tool"]
    | archestraApiTypes.GetToolsResponses["200"][number],
) {
  // Handle both tool types - some have mcpServerName, others have mcpServer.name
  const mcpServerName =
    "mcpServerName" in tool ? tool.mcpServerName : tool.mcpServer?.name;

  return Boolean(mcpServerName || tool.catalogId);
}
