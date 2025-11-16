import type { archestraApiTypes } from "@shared";

export function isMcpTool(
  tool: archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number]["tool"],
) {
  return Boolean(tool.mcpServerName || tool.catalogId);
}
