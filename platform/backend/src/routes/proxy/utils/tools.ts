import { getArchestraMcpTools } from "@/archestra-mcp-server";
import { AgentToolModel, ToolModel } from "@/models";

/**
 * Persist tools if present in the request
 * Skips tools that are already connected to the agent via MCP servers
 * Also skips Archestra built-in tools
 *
 * Uses bulk operations to avoid N+1 queries
 */
export const persistTools = async (
  tools: Array<{
    toolName: string;
    toolParameters?: Record<string, unknown>;
    toolDescription?: string;
  }>,
  agentId: string,
) => {
  if (tools.length === 0) {
    return;
  }

  // Get names of all MCP tools already assigned to this agent
  const mcpToolNames = await ToolModel.getMcpToolNamesByAgent(agentId);
  const mcpToolNamesSet = new Set(mcpToolNames);

  // Get Archestra built-in tool names
  const archestraTools = getArchestraMcpTools();
  const archestraToolNamesSet = new Set(
    archestraTools.map((tool) => tool.name),
  );

  // Filter out tools that are already available via MCP servers or are Archestra built-in tools
  // Also deduplicate by tool name (keep first occurrence) to avoid constraint violations
  const seenToolNames = new Set<string>();
  const toolsToAutoDiscover = tools.filter(({ toolName }) => {
    if (
      mcpToolNamesSet.has(toolName) ||
      archestraToolNamesSet.has(toolName) ||
      seenToolNames.has(toolName)
    ) {
      return false;
    }
    seenToolNames.add(toolName);
    return true;
  });

  if (toolsToAutoDiscover.length === 0) {
    return;
  }

  // Bulk create tools (single query to check existing + single insert for new)
  const createdTools = await ToolModel.bulkCreateProxyToolsIfNotExists(
    toolsToAutoDiscover.map(
      ({ toolName, toolParameters, toolDescription }) => ({
        name: toolName,
        parameters: toolParameters,
        description: toolDescription,
      }),
    ),
    agentId,
  );

  // Bulk create agent-tool relationships (single query to check existing + single insert for new)
  // Deduplicate tool IDs in case input contained duplicate tool names
  const toolIds = [...new Set(createdTools.map((tool) => tool.id))];
  await AgentToolModel.createManyIfNotExists(agentId, toolIds);
};
