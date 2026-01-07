import { isAgentTool } from "@shared";
import { getArchestraMcpTools } from "@/archestra-mcp-server";
import logger from "@/logging";
import { AgentToolModel, ToolModel } from "@/models";

/**
 * Persist tools if present in the request
 * Skips tools that are already connected to the agent via MCP servers
 * Also skips Archestra built-in tools and agent delegation tools
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
  logger.debug(
    { agentId, toolCount: tools.length },
    "[tools] persistTools: starting tool persistence",
  );

  if (tools.length === 0) {
    logger.debug({ agentId }, "[tools] persistTools: no tools to persist");
    return;
  }

  // Get names of all MCP tools already assigned to this agent
  const mcpToolNames = await ToolModel.getMcpToolNamesByAgent(agentId);
  const mcpToolNamesSet = new Set(mcpToolNames);
  logger.debug(
    { agentId, mcpToolCount: mcpToolNames.length },
    "[tools] persistTools: fetched existing MCP tools for agent",
  );

  // Get Archestra built-in tool names
  const archestraTools = getArchestraMcpTools();
  const archestraToolNamesSet = new Set(
    archestraTools.map((tool) => tool.name),
  );
  logger.debug(
    { archestraToolCount: archestraTools.length },
    "[tools] persistTools: fetched Archestra built-in tools",
  );

  // Filter out tools that are already available via MCP servers, are Archestra built-in tools,
  // or are agent delegation tools (agent__*). Also deduplicate by tool name to avoid constraint violations
  const seenToolNames = new Set<string>();
  const toolsToAutoDiscover = tools.filter(({ toolName }) => {
    if (
      mcpToolNamesSet.has(toolName) ||
      archestraToolNamesSet.has(toolName) ||
      isAgentTool(toolName) ||
      seenToolNames.has(toolName)
    ) {
      return false;
    }
    seenToolNames.add(toolName);
    return true;
  });

  logger.debug(
    {
      agentId,
      originalCount: tools.length,
      filteredCount: toolsToAutoDiscover.length,
      skippedMcpTools: tools.filter((t) => mcpToolNamesSet.has(t.toolName))
        .length,
      skippedArchestraTools: tools.filter((t) =>
        archestraToolNamesSet.has(t.toolName),
      ).length,
      skippedAgentTools: tools.filter((t) => isAgentTool(t.toolName)).length,
    },
    "[tools] persistTools: filtered tools for auto-discovery",
  );

  if (toolsToAutoDiscover.length === 0) {
    logger.debug(
      { agentId },
      "[tools] persistTools: no new tools to auto-discover",
    );
    return;
  }

  // Bulk create tools (single query to check existing + single insert for new)
  logger.debug(
    { agentId, toolCount: toolsToAutoDiscover.length },
    "[tools] persistTools: bulk creating tools",
  );
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
  logger.debug(
    { agentId, toolIdCount: toolIds.length },
    "[tools] persistTools: creating agent-tool relationships",
  );
  await AgentToolModel.createManyIfNotExists(agentId, toolIds);
  logger.debug(
    { agentId, createdToolCount: toolIds.length },
    "[tools] persistTools: tool persistence complete",
  );
};
