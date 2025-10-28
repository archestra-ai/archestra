import { inArray } from "drizzle-orm";
import mcpClient from "@/clients/mcp-client";
import db, { schema } from "@/database";
import { AgentToolModel, ToolModel } from "@/models";
import type { CommonToolCall, CommonToolResult, Tool } from "@/types";

/**
 * Persist tools if present in the request
 */
export const persistTools = async (
  tools: Array<{
    toolName: string;
    toolParameters?: Record<string, unknown>;
    toolDescription?: string;
  }>,
  agentId: string,
) => {
  for (const { toolName, toolParameters, toolDescription } of tools) {
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
