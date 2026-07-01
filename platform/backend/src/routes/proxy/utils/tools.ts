import { isAgentTool } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import logger from "@/logging";
import { ToolModel } from "@/models";

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

  // Get names of tools that already exist in the database (any type: catalog, proxy, etc.)
  const existingToolNames = await ToolModel.getExistingToolNames(
    tools.map((t) => t.toolName),
  );
  const existingToolNamesSet = new Set(existingToolNames);
  logger.debug(
    { agentId, existingToolCount: existingToolNames.length },
    "[tools] persistTools: fetched existing tools globally",
  );

  // Filter out tools that already exist in the database, are Archestra built-in
  // tools, or are agent delegation tools (agent__*). Also deduplicate by tool name
  // to avoid constraint violations.
  //
  // Built-ins are matched with `archestraMcpBranding.isToolName`, which recognizes
  // BOTH the default `archestra__` prefix and the org's branded prefix
  // (e.g. `archestra_staging__`). A client (including chat routed through this proxy)
  // can hand us a built-in under the off-brand prefix; matching only the current
  // brand would auto-discover that twin, and seeding would later promote it into the
  // catalog as a duplicate built-in.
  const seenToolNames = new Set<string>();
  const toolsToAutoDiscover = tools.filter(({ toolName }) => {
    if (
      existingToolNamesSet.has(toolName) ||
      archestraMcpBranding.isToolName(toolName) ||
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
      skippedExistingTools: tools.filter((t) =>
        existingToolNamesSet.has(t.toolName),
      ).length,
      skippedArchestraTools: tools.filter((t) =>
        archestraMcpBranding.isToolName(t.toolName),
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
  await ToolModel.bulkCreateProxyToolsIfNotExists(
    toolsToAutoDiscover.map(
      ({ toolName, toolParameters, toolDescription }) => ({
        name: toolName,
        parameters: toolParameters,
        description: toolDescription,
      }),
    ),
    agentId,
  );

  logger.debug(
    { agentId, toolCount: toolsToAutoDiscover.length },
    "[tools] persistTools: tool persistence complete",
  );
};
