import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { and, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";

import { getArchestraMcpTools } from "@/archestra-mcp-server";
import db, { schema } from "@/database";
import type { ExtendedTool, InsertTool, Tool } from "@/types";
import AgentTeamModel from "./agent-team";
import AgentToolModel from "./agent-tool";

class ToolModel {
  /**
   * Slugify a tool name to get a unique name for the MCP server's tool
   */
  static slugifyName(mcpServerName: string, toolName: string): string {
    return `${mcpServerName}${MCP_SERVER_TOOL_NAME_SEPARATOR}${toolName}`
      .toLowerCase()
      .replace(/ /g, "_");
  }

  /**
   * Unslugify a tool name to get the original tool name
   */
  static unslugifyName(slugifiedName: string): string {
    const parts = slugifiedName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
    return parts.length > 1
      ? parts.slice(1).join(MCP_SERVER_TOOL_NAME_SEPARATOR)
      : slugifiedName;
  }

  static async create(tool: InsertTool): Promise<Tool> {
    const [createdTool] = await db
      .insert(schema.toolsTable)
      .values(tool)
      .returning();
    return createdTool;
  }

  static async createToolIfNotExists(tool: InsertTool): Promise<Tool> {
    // For Archestra built-in tools (both agentId and catalogId are null), check if tool already exists
    // This prevents duplicate Archestra tools since NULL != NULL in unique constraints
    if (!tool.agentId && !tool.catalogId) {
      const [existingTool] = await db
        .select()
        .from(schema.toolsTable)
        .where(
          and(
            isNull(schema.toolsTable.agentId),
            isNull(schema.toolsTable.catalogId),
            eq(schema.toolsTable.name, tool.name),
          ),
        );

      if (existingTool) {
        return existingTool;
      }
    }

    // For proxy-sniffed tools (agentId is set, catalogId is null), check if tool already exists
    // This prevents duplicate proxy-sniffed tools for the same agent
    if (tool.agentId && !tool.catalogId) {
      const [existingTool] = await db
        .select()
        .from(schema.toolsTable)
        .where(
          and(
            eq(schema.toolsTable.agentId, tool.agentId),
            eq(schema.toolsTable.name, tool.name),
            isNull(schema.toolsTable.catalogId),
          ),
        );

      if (existingTool) {
        return existingTool;
      }
    }

    // For MCP tools (agentId is null, catalogId is set), check if tool with same catalog and name already exists
    // This allows multiple installations of the same catalog to share tool definitions
    if (!tool.agentId && tool.catalogId) {
      const [existingTool] = await db
        .select()
        .from(schema.toolsTable)
        .where(
          and(
            isNull(schema.toolsTable.agentId),
            eq(schema.toolsTable.catalogId, tool.catalogId),
            eq(schema.toolsTable.name, tool.name),
          ),
        );

      if (existingTool) {
        return existingTool;
      }
    }

    const [createdTool] = await db
      .insert(schema.toolsTable)
      .values(tool)
      .onConflictDoNothing()
      .returning();

    // If tool already exists (conflict), fetch it
    if (!createdTool) {
      const [existingTool] = await db
        .select()
        .from(schema.toolsTable)
        .where(
          tool.agentId
            ? and(
                eq(schema.toolsTable.agentId, tool.agentId),
                eq(schema.toolsTable.name, tool.name),
              )
            : tool.catalogId
              ? and(
                  isNull(schema.toolsTable.agentId),
                  eq(schema.toolsTable.catalogId, tool.catalogId),
                  eq(schema.toolsTable.name, tool.name),
                )
              : and(
                  isNull(schema.toolsTable.agentId),
                  isNull(schema.toolsTable.catalogId),
                  eq(schema.toolsTable.name, tool.name),
                ),
        );
      return existingTool;
    }

    return createdTool;
  }

  static async findById(
    id: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, id));

    if (!tool) {
      return null;
    }

    // Check access control for non-agent admins
    if (tool.agentId && userId && !isAgentAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
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
    isAgentAdmin?: boolean,
  ): Promise<ExtendedTool[]> {
    // Get all tools
    let query = db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
        catalogId: schema.toolsTable.catalogId,
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
     * Apply access control filtering for users that are not agent admins
     *
     * If the user is not an admin, we basically allow them to see all tools that are assigned to agents
     * they have access to, plus all "MCP tools" (tools that are not assigned to any agent).
     */
    if (userId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

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
    isAgentAdmin?: boolean,
  ): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.name, name));

    if (!tool) {
      return null;
    }

    // Check access control for non-admins
    if (tool.agentId && userId && !isAgentAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
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

  /**
   * Get only MCP tools assigned to an agent (those from connected MCP servers)
   * Includes: MCP server tools (catalogId set) and Archestra built-in tools (both null)
   * Excludes: proxy-discovered tools (agentId set, catalogId null)
   *
   * Automatically assigns Archestra built-in tools to the agent if not already assigned.
   */
  static async getMcpToolsByAgent(agentId: string): Promise<Tool[]> {
    // Ensure Archestra built-in tools are assigned to this agent
    // This auto-migrates existing agents that were created before auto-assignment was added
    await ToolModel.assignArchestraToolsToAgent(agentId);

    // Get tool IDs assigned via junction table (MCP tools)
    const assignedToolIds = await AgentToolModel.findToolIdsByAgent(agentId);

    if (assignedToolIds.length === 0) {
      return [];
    }

    // Return tools that are assigned via junction table AND:
    // 1. Have catalogId set (regular MCP server tools), OR
    // 2. Have both catalogId AND agentId null (Archestra built-in tools)
    // This excludes proxy-discovered tools which have agentId set and catalogId null
    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(
        and(
          inArray(schema.toolsTable.id, assignedToolIds),
          or(
            isNotNull(schema.toolsTable.catalogId),
            and(
              isNull(schema.toolsTable.catalogId),
              isNull(schema.toolsTable.agentId),
            ),
          ),
        ),
      )
      .orderBy(desc(schema.toolsTable.createdAt));

    return tools;
  }

  /**
   * Assign Archestra built-in tools to an agent
   * Creates the tools globally if they don't exist, then assigns them via junction table
   */
  static async assignArchestraToolsToAgent(agentId: string): Promise<void> {
    const archestraTools = getArchestraMcpTools();

    for (const archestraTool of archestraTools) {
      // Create or get the tool (stored globally with catalogId and agentId both null)
      const tool = await ToolModel.createToolIfNotExists({
        name: archestraTool.name,
        description: archestraTool.description || null,
        parameters: archestraTool.inputSchema,
        catalogId: null,
        agentId: null,
      });

      // Assign tool to agent via junction table
      await AgentToolModel.createIfNotExists(agentId, tool.id);
    }
  }

  /**
   * Get names of all MCP tools assigned to an agent
   * Used to prevent autodiscovery of tools already available via MCP servers
   */
  static async getMcpToolNamesByAgent(agentId: string): Promise<string[]> {
    const mcpTools = await db
      .select({
        name: schema.toolsTable.name,
      })
      .from(schema.toolsTable)
      .innerJoin(
        schema.agentToolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          isNotNull(schema.toolsTable.mcpServerId), // Only MCP tools
        ),
      );

    return mcpTools.map((tool) => tool.name);
  }

  /**
   * Get MCP tools assigned to an agent
   */
  static async getMcpToolsAssignedToAgent(
    toolNames: string[],
    agentId: string,
  ): Promise<
    Array<{
      toolName: string;
      responseModifierTemplate: string | null;
      mcpServerSecretId: string | null;
      mcpServerName: string | null;
      mcpServerCatalogId: string | null;
      mcpServerId: string | null;
      credentialSourceMcpServerId: string | null;
      executionSourceMcpServerId: string | null;
      catalogId: string | null;
      catalogName: string | null;
    }>
  > {
    if (toolNames.length === 0) {
      return [];
    }

    const mcpTools = await db
      .select({
        toolName: schema.toolsTable.name,
        responseModifierTemplate:
          schema.agentToolsTable.responseModifierTemplate,
        mcpServerSecretId: schema.mcpServersTable.secretId,
        mcpServerName: schema.mcpServersTable.name,
        mcpServerCatalogId: schema.mcpServersTable.catalogId,
        credentialSourceMcpServerId:
          schema.agentToolsTable.credentialSourceMcpServerId,
        executionSourceMcpServerId:
          schema.agentToolsTable.executionSourceMcpServerId,
        mcpServerId: schema.mcpServersTable.id,
        catalogId: schema.toolsTable.catalogId,
        catalogName: schema.internalMcpCatalogTable.name,
      })
      .from(schema.toolsTable)
      .innerJoin(
        schema.agentToolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .leftJoin(
        schema.mcpServersTable,
        eq(schema.toolsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(schema.toolsTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          inArray(schema.toolsTable.name, toolNames),
          isNotNull(schema.toolsTable.catalogId), // Only MCP tools (have catalogId)
        ),
      );

    return mcpTools;
  }

  /**
   * Get all tools for a specific MCP server with their assignment counts and assigned agents
   */
  static async findByMcpServerId(mcpServerId: string): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      parameters: Record<string, unknown>;
      createdAt: Date;
      assignedAgentCount: number;
      assignedAgents: Array<{ id: string; name: string }>;
    }>
  > {
    const tools = await db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
        description: schema.toolsTable.description,
        parameters: schema.toolsTable.parameters,
        createdAt: schema.toolsTable.createdAt,
      })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.mcpServerId, mcpServerId))
      .orderBy(desc(schema.toolsTable.createdAt));

    // For each tool, get assigned agents
    const toolsWithAgents = await Promise.all(
      tools.map(async (tool) => {
        const assignments = await db
          .select({
            agentId: schema.agentToolsTable.agentId,
            agentName: schema.agentsTable.name,
          })
          .from(schema.agentToolsTable)
          .innerJoin(
            schema.agentsTable,
            eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
          )
          .where(eq(schema.agentToolsTable.toolId, tool.id));

        return {
          ...tool,
          parameters: tool.parameters ?? {},
          assignedAgentCount: assignments.length,
          assignedAgents: assignments.map((a) => ({
            id: a.agentId,
            name: a.agentName,
          })),
        };
      }),
    );

    return toolsWithAgents;
  }

  /**
   * Get all tools for a specific catalog item with their assignment counts and assigned agents
   * Used to show tools across all installations of the same catalog item
   */
  static async findByCatalogId(catalogId: string): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      parameters: Record<string, unknown>;
      createdAt: Date;
      assignedAgentCount: number;
      assignedAgents: Array<{ id: string; name: string }>;
    }>
  > {
    const tools = await db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
        description: schema.toolsTable.description,
        parameters: schema.toolsTable.parameters,
        createdAt: schema.toolsTable.createdAt,
      })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, catalogId))
      .orderBy(desc(schema.toolsTable.createdAt));

    // For each tool, get assigned agents
    const toolsWithAgents = await Promise.all(
      tools.map(async (tool) => {
        const assignments = await db
          .select({
            agentId: schema.agentToolsTable.agentId,
            agentName: schema.agentsTable.name,
          })
          .from(schema.agentToolsTable)
          .innerJoin(
            schema.agentsTable,
            eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
          )
          .where(eq(schema.agentToolsTable.toolId, tool.id));

        return {
          ...tool,
          parameters: tool.parameters ?? {},
          assignedAgentCount: assignments.length,
          assignedAgents: assignments.map((a) => ({
            id: a.agentId,
            name: a.agentName,
          })),
        };
      }),
    );

    return toolsWithAgents;
  }

  /**
   * Delete all tools for a specific catalog item
   * Used when the last MCP server installation for a catalog is removed
   * Returns the number of tools deleted
   */
  static async deleteByCatalogId(catalogId: string): Promise<number> {
    const result = await db
      .delete(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, catalogId));

    return result.rowCount || 0;
  }

  static async getByIds(ids: string[]): Promise<Tool[]> {
    return db
      .select()
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.id, ids));
  }
}

export default ToolModel;
