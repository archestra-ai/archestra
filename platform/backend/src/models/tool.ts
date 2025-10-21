import { desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ExtendedTool, InsertTool, Tool } from "@/types";
import AgentAccessControlModel from "./agent-access-control";
import AgentToolModel from "./agent-tool";

class ToolModel {
  static slugifyName(mcpServerName: string, toolName: string): string {
    return `${mcpServerName}__${toolName}`.toLowerCase().replace(/ /g, "_");
  }

  static async create(tool: InsertTool): Promise<Tool> {
    const [createdTool] = await db
      .insert(schema.toolsTable)
      .values(tool)
      .returning();
    return createdTool;
  }

  static async createToolIfNotExists(tool: InsertTool) {
    const [createdTool] = await db
      .insert(schema.toolsTable)
      .values(tool)
      .onConflictDoNothing()
      .returning();
    return createdTool;
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
    if (tool.agentId && userId && !isAdmin) {
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

  static async findAll(
    userId?: string,
    isAdmin?: boolean,
  ): Promise<ExtendedTool[]> {
    // Get all tools
    let query = db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
        parameters: schema.toolsTable.parameters,
        description: schema.toolsTable.description,
        createdAt: schema.toolsTable.createdAt,
        updatedAt: schema.toolsTable.updatedAt,
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        },
        mcpServer: {
          id: schema.mcpServersTable.id,
          name: schema.mcpServersTable.name,
        },
      })
      .from(schema.toolsTable)
      .leftJoin(
        schema.agentsTable,
        eq(schema.toolsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        schema.mcpServersTable,
        eq(schema.toolsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .orderBy(desc(schema.toolsTable.createdAt))
      .$dynamic();

    /**
     * Apply access control filtering for non-admins
     *
     * If the user is not an admin, we basically allow them to see all tools that are assigned to agents
     * they have access to, plus all "MCP tools" (tools that are not assigned to any agent).
     */
    if (userId && !isAdmin) {
      const accessibleAgentIds =
        await AgentAccessControlModel.getUserAccessibleAgentIds(userId);

      const mcpServerSourceClause = isNotNull(schema.toolsTable.mcpServerId);

      if (accessibleAgentIds.length === 0) {
        query = query.where(mcpServerSourceClause);
      } else {
        query = query.where(
          or(
            inArray(schema.toolsTable.agentId, accessibleAgentIds),
            mcpServerSourceClause,
          ),
        );
      }
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
    if (tool.agentId && userId && !isAdmin) {
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
}

export default ToolModel;
