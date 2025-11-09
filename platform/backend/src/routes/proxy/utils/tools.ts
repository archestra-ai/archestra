import { getArchestraMcpTools } from "@/archestra-mcp-server";
import { AgentToolModel, ToolModel } from "@/models";

/**
 * Persist tools if present in the request
 * Skips tools that are already connected to the agent via MCP servers
 * Also skips Archestra built-in tools
 */
export const persistTools = async (
  tools: Array<{
    toolName: string;
    toolParameters?: Record<string, unknown>;
    toolDescription?: string;
  }>,
  agentId: string,
) => {
  // Get names of all MCP tools already assigned to this agent
  const mcpToolNames = await ToolModel.getMcpToolNamesByAgent(agentId);
  const mcpToolNamesSet = new Set(mcpToolNames);

  // Get Archestra built-in tool names
  const archestraTools = getArchestraMcpTools();
  const archestraToolNamesSet = new Set(
    archestraTools.map((tool) => tool.name),
  );

  // Filter out tools that are already available via MCP servers or are Archestra built-in tools
  const toolsToAutoDiscover = tools.filter(
    ({ toolName }) =>
      !mcpToolNamesSet.has(toolName) && !archestraToolNamesSet.has(toolName),
  );

  // Persist only the tools that are not already available via MCP
  for (const {
    toolName,
    toolParameters,
    toolDescription,
  } of toolsToAutoDiscover) {
    // Create or get the tool
    const tool = await ToolModel.createToolIfNotExists({
      name: toolName,
      parameters: toolParameters,
      description: toolDescription,
      agentId,
    });

    // Create the agent-tool relationship
    await AgentToolModel.createIfNotExists(agentId, tool.id);
  }
};
