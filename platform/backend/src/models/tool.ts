import { desc, eq, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertTool, Tool, UpdateTool } from "@/types";
import AgentAccessControlModel from "./agent-access-control";
import AgentToolModel from "./agent-tool";

class ToolModel {
  static async create(tool: InsertTool): Promise<Tool> {
    const [createdTool] = await db
      .insert(schema.toolsTable)
      .values(tool)
      .returning();
    return createdTool;
  }

  static async createToolIfNotExists(tool: InsertTool) {
    return db.insert(schema.toolsTable).values(tool).onConflictDoNothing();
  }

  static async findById(
    id: string,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, id));

    if (!tool) {
      return null;
    }

    // Check access control for non-admins
    if (userId && !isAdmin) {
      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
        userId,
        tool.agentId,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    return tool;
  }

  static async findAll(userId?: string, isAdmin?: boolean) {
    let query = db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
        parameters: schema.toolsTable.parameters,
        description: schema.toolsTable.description,
        allowUsageWhenUntrustedDataIsPresent:
          schema.toolsTable.allowUsageWhenUntrustedDataIsPresent,
        toolResultTreatment: schema.toolsTable.toolResultTreatment,
        createdAt: schema.toolsTable.createdAt,
        updatedAt: schema.toolsTable.updatedAt,
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        },
      })
      .from(schema.toolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.toolsTable.agentId, schema.agentsTable.id),
      )
      .orderBy(desc(schema.toolsTable.createdAt))
      .$dynamic();

    // Apply access control filtering for non-admins
    if (userId && !isAdmin) {
      const accessibleAgentIds =
        await AgentAccessControlModel.getUserAccessibleAgentIds(userId);

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      query = query.where(
        inArray(schema.toolsTable.agentId, accessibleAgentIds),
      );
    }

    return query;
  }

  static async findByName(
    name: string,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.name, name));

    if (!tool) {
      return null;
    }

    // Check access control for non-admins
    if (userId && !isAdmin) {
      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
        userId,
        tool.agentId,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    return tool;
  }

  static async update(toolId: string, tool: UpdateTool) {
    const [updatedTool] = await db
      .update(schema.toolsTable)
      .set(tool)
      .where(eq(schema.toolsTable.id, toolId))
      .returning();
    if (!updatedTool) return null;
    return updatedTool;
  }

  /**
   * Assign an MCP tool to an agent
   */
  static async assignToAgent(toolId: string, agentId: string) {
    return AgentToolModel.create(agentId, toolId);
  }

  /**
   * Unassign an MCP tool from an agent
   */
  static async unassignFromAgent(toolId: string, agentId: string) {
    return AgentToolModel.delete(agentId, toolId);
  }

  /**
   * Get all tools for an agent (both proxy-sniffed and MCP tools)
   * Proxy-sniffed tools are those with agentId set directly
   * MCP tools are those assigned via the agent_tools junction table
   */
  static async getToolsByAgent(agentId: string): Promise<Tool[]> {
    // Get tool IDs assigned via junction table (MCP tools)
    const assignedToolIds = await AgentToolModel.findToolIdsByAgent(agentId);

    // Query for tools that are either:
    // 1. Directly associated with the agent (proxy-sniffed, agentId set)
    // 2. Assigned via junction table (MCP tools, agentId is null)
    const conditions = [eq(schema.toolsTable.agentId, agentId)];

    if (assignedToolIds.length > 0) {
      conditions.push(inArray(schema.toolsTable.id, assignedToolIds));
    }

    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(or(...conditions))
      .orderBy(desc(schema.toolsTable.createdAt));

    return tools;
  }

  /**
   * Get all tools for an MCP server
   */
  static async findByMcpServer(mcpServerId: string): Promise<Tool[]> {
    return await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.mcpServerId, mcpServerId))
      .orderBy(desc(schema.toolsTable.createdAt));
  }
}

export default ToolModel;
