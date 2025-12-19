import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "./consts";

export function isArchestraMcpServerTool(toolName: string): boolean {
  return toolName.startsWith(
    `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`,
  );
}
