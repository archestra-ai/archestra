import { inArray } from "drizzle-orm";
import mcpClient from "@/clients/mcp-client";
import db, { schema } from "@/database";
import { AgentToolModel, ToolModel } from "@/models";
import type { CommonToolCall, CommonToolResult, Tool } from "@/types";

/**
 * Persist tools if present in the request
 * Skips tools that are already connected to the agent via MCP servers
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

  // Filter out tools that are already available via MCP servers
  const toolsToAutoDiscover = tools.filter(
    ({ toolName }) => !mcpToolNamesSet.has(toolName),
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

/**
 * Get tools assigned to an agent via the agent_tools junction table
 */
export const getAssignedMCPTools = async (agentId: string): Promise<Tool[]> => {
  const toolIds = await AgentToolModel.findToolIdsByAgent(agentId);

  if (toolIds.length === 0) {
    return [];
  }

  // Fetch full tool details
  const tools = await db
    .select()
    .from(schema.toolsTable)
    .where(inArray(schema.toolsTable.id, toolIds));

  return tools;
};

export const executeMcpToolCalls = async (
  toolCalls: CommonToolCall[],
  agentId: string,
): Promise<CommonToolResult[]> =>
  mcpClient.executeToolCalls(toolCalls, agentId);
