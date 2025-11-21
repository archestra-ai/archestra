import type { archestraApiTypes } from "@shared";

type AgentTool =
  archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number]["tool"];
type ToolListItem = archestraApiTypes.GetToolsResponses["200"]["data"][number];

export function isMcpTool(tool: AgentTool | ToolListItem) {
  if ("mcpServerName" in tool) {
    return Boolean(tool.mcpServerName || tool.catalogId);
  }
  return Boolean(tool.mcpServer || tool.catalogId);
}
