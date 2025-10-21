import type { Anthropic } from "@/types";
import { ToolModel } from "@/models";

/**
 * Get MCP tools assigned to an agent and convert them to Anthropic format
 */
export async function getMcpToolsForAgent(
  agentId: string,
): Promise<Anthropic.Types.Tool[]> {
  // Fetch all tools for the agent
  const allTools = await ToolModel.getToolsByAgent(agentId);

  // Filter for MCP tools only
  const mcpTools = allTools.filter((tool) => tool.source === "mcp_server");

  // Convert to Anthropic format
  return mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.parameters as Record<string, unknown>,
  }));
}

/**
 * Merge MCP tools with proxy-sniffed tools from the request
 * Removes duplicates based on tool name
 */
export function mergeTools(
  requestTools: Anthropic.Types.Tool[] | undefined,
  mcpTools: Anthropic.Types.Tool[],
): Anthropic.Types.Tool[] {
  if (!requestTools || requestTools.length === 0) {
    return mcpTools;
  }

  // Create a map of tool names from request tools
  const requestToolNames = new Set(requestTools.map((t) => t.name));

  // Filter out MCP tools that are already in the request
  const uniqueMcpTools = mcpTools.filter(
    (t) => !requestToolNames.has(t.name),
  );

  // Merge both arrays
  return [...requestTools, ...uniqueMcpTools];
}
