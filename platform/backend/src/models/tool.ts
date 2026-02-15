import {
  AGENT_TOOL_PREFIX,
  DEFAULT_ARCHESTRA_TOOL_NAMES,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  parseFullToolName,
  slugify,
  TOOL_QUERY_KNOWLEDGE_GRAPH_FULL_NAME,
} from "@shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notIlike,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getArchestraMcpTools } from "@/archestra-mcp-server";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import { getKnowledgeGraphProviderType } from "@/knowledge-graph";
import type {
  ExtendedTool,
  InsertTool,
  Tool,
  ToolFilters,
  ToolSortBy,
  ToolSortDirection,
  ToolWithAssignments,
  UpdateTool,
} from "@/types";
import AgentTeamModel from "./agent-team";
import AgentToolModel from "./agent-tool";
import McpServerModel from "./mcp-server";
import ToolInvocationPolicyModel from "./tool-invocation-policy";
import TrustedDataPolicyModel from "./trusted-data-policy";

class ToolModel {
  /**
   * Slugify a tool name to get a unique name for the MCP server's tool.
   * Ensures the result matches the pattern ^[a-zA-Z0-9_-]{1,128}$ required by LLM providers.
   */
  static slugifyName(mcpServerName: string, toolName: string): string {
    return `${mcpServerName}${MCP_SERVER_TOOL_NAME_SEPARATOR}${toolName}`
      .toLowerCase()
      .replace(/\s+/g, "_") // Replace whitespace with underscores
      .replace(/[^a-z0-9_-]/g, ""); // Remove any characters not allowed in tool names
  }

  /**
   * Unslugify a tool name to get the original tool name
   */
  static unslugifyName(slugifiedName: string): string {
    const { serverName, toolName } = parseFullToolName(slugifiedName);
    return serverName !== null ? toolName : slugifiedName;
  }

  static async create(tool: InsertTool): Promise<Tool> {
    const [createdTool] = await db
      .insert(schema.toolsTable)
      .values(tool)
      .returning();
    return createdTool;
  }

  static async update(
    id: string,
    data: Partial<
      Pick<
        UpdateTool,
        | "policiesAutoConfiguredAt"
        | "policiesAutoConfiguringStartedAt"
        | "policiesAutoConfiguredReasoning"
      >
    >,
  ): Promise<Tool | null> {
    const [updatedTool] = await db
      .update(schema.toolsTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(schema.toolsTable.id, id))
      .returning();
    return updatedTool || null;
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

    // Create default policies for new tools
    await ToolModel.createDefaultPolicies(createdTool.id);

    return createdTool;
  }

  /**
   * Create default policies for a newly created tool:
   * - Default invocation policy: block_when_context_is_untrusted (empty conditions)
   * - Default result policy: mark_as_untrusted (empty conditions)
   */
  static async createDefaultPolicies(toolId: string): Promise<void> {
    // Create default invocation policy
    await ToolInvocationPolicyModel.create({
      toolId,
      conditions: [],
      action: "block_when_context_is_untrusted",
      reason: null,
    });

    // Create default result policy
    await TrustedDataPolicyModel.create({
      toolId,
      conditions: [],
      action: "mark_as_untrusted",
      description: null,
    });
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
        delegateToAgentId: schema.toolsTable.delegateToAgentId,
        policiesAutoConfiguredAt: schema.toolsTable.policiesAutoConfiguredAt,
        policiesAutoConfiguringStartedAt:
          schema.toolsTable.policiesAutoConfiguringStartedAt,
        policiesAutoConfiguredReasoning:
          schema.toolsTable.policiesAutoConfiguredReasoning,
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
   * Includes: MCP server tools (catalogId set, including Archestra builtin tools)
   * Excludes: proxy-discovered tools (agentId set, catalogId null)
   *
   * Note: Archestra tools are no longer automatically assigned - they must be
   * explicitly assigned like any other MCP server tools.
   */
  static async getMcpToolsByAgent(agentId: string): Promise<Tool[]> {
    // Get tool IDs assigned via junction table (MCP tools)
    const assignedToolIds = await AgentToolModel.findToolIdsByAgent(agentId);

    if (assignedToolIds.length === 0) {
      return [];
    }

    // Return tools that are assigned via junction table AND are either:
    // - MCP tools (have catalogId set) - includes regular MCP server tools and Archestra builtin tools
    // - Delegation tools (have delegateToAgentId set)
    // Excludes proxy-discovered tools which have agentId set and catalogId null
    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(
        and(
          inArray(schema.toolsTable.id, assignedToolIds),
          or(
            isNotNull(schema.toolsTable.catalogId),
            isNotNull(schema.toolsTable.delegateToAgentId),
          ),
        ),
      )
      .orderBy(desc(schema.toolsTable.createdAt));

    return tools;
  }

  /**
   * Bulk create tools for an MCP server (catalog-based tools)
   * Fetches existing tools in a single query, then bulk inserts only new tools
   * Returns all tools (existing + newly created) to avoid N+1 queries
   */
  static async bulkCreateToolsIfNotExists(
    tools: Array<{
      name: string;
      description: string | null;
      parameters: Record<string, unknown>;
      catalogId: string;
      mcpServerId: string;
    }>,
  ): Promise<Tool[]> {
    if (tools.length === 0) {
      return [];
    }

    // Group tools by catalogId (all tools should have the same catalogId in practice)
    const catalogId = tools[0].catalogId;
    const toolNames = tools.map((t) => t.name);

    // Fetch all existing tools for this catalog in a single query
    const existingTools = await db
      .select()
      .from(schema.toolsTable)
      .where(
        and(
          isNull(schema.toolsTable.agentId),
          eq(schema.toolsTable.catalogId, catalogId),
          inArray(schema.toolsTable.name, toolNames),
        ),
      );

    const existingToolsByName = new Map(existingTools.map((t) => [t.name, t]));

    // Prepare tools to insert (only those that don't exist)
    const toolsToInsert: InsertTool[] = [];
    const resultTools: Tool[] = [];

    for (const tool of tools) {
      const existingTool = existingToolsByName.get(tool.name);
      if (existingTool) {
        resultTools.push(existingTool);
      } else {
        toolsToInsert.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          catalogId: tool.catalogId,
          mcpServerId: tool.mcpServerId,
          agentId: null,
        });
      }
    }

    // Bulk insert new tools if any
    if (toolsToInsert.length > 0) {
      const insertedTools = await db
        .insert(schema.toolsTable)
        .values(toolsToInsert)
        .onConflictDoNothing()
        .returning();

      // Create default policies for newly inserted tools
      for (const tool of insertedTools) {
        await ToolModel.createDefaultPolicies(tool.id);
      }

      // If some tools weren't inserted due to conflict, fetch them
      if (insertedTools.length < toolsToInsert.length) {
        const insertedNames = new Set(insertedTools.map((t) => t.name));
        const missingNames = toolsToInsert
          .filter((t) => !insertedNames.has(t.name))
          .map((t) => t.name);

        if (missingNames.length > 0) {
          const conflictTools = await db
            .select()
            .from(schema.toolsTable)
            .where(
              and(
                isNull(schema.toolsTable.agentId),
                eq(schema.toolsTable.catalogId, catalogId),
                inArray(schema.toolsTable.name, missingNames),
              ),
            );
          resultTools.push(...insertedTools, ...conflictTools);
        } else {
          resultTools.push(...insertedTools);
        }
      } else {
        resultTools.push(...insertedTools);
      }
    }

    // Return tools in the same order as input
    const resultToolsByName = new Map(resultTools.map((t) => [t.name, t]));
    return tools
      .map((t) => resultToolsByName.get(t.name))
      .filter((t): t is Tool => t !== undefined);
  }

  /**
   * Seed Archestra built-in tools in the database.
   * Creates the Archestra catalog entry if it doesn't exist (for FK constraint),
   * then creates/updates tools with the catalog ID.
   * Called during server startup to ensure Archestra tools exist.
   *
   * Also migrates any pre-existing "discovered" Archestra tools (catalog_id = NULL)
   * to use the proper catalog ID.
   */
  static async seedArchestraTools(catalogId: string): Promise<void> {
    // Ensure the Archestra catalog entry exists in the database for FK constraint
    // This is a no-op if the entry already exists
    await db
      .insert(schema.internalMcpCatalogTable)
      .values({
        id: catalogId,
        name: "Archestra",
        description:
          "Built-in Archestra tools for managing profiles, limits, policies, and MCP servers.",
        serverType: "builtin",
        requiresAuth: false,
      })
      .onConflictDoNothing();

    const archestraTools = getArchestraMcpTools();
    const archestraToolNames = archestraTools.map((t) => t.name);

    // Migrate pre-existing "discovered" Archestra tools (catalog_id = NULL) to use the catalog
    // This handles tools that were auto-discovered via proxy before the catalog was introduced
    await db
      .update(schema.toolsTable)
      .set({ catalogId })
      .where(
        and(
          isNull(schema.toolsTable.catalogId),
          isNull(schema.toolsTable.agentId),
          inArray(schema.toolsTable.name, archestraToolNames),
        ),
      );

    // Get all existing Archestra tools in a single query (now including migrated ones)
    const existingTools = await db
      .select()
      .from(schema.toolsTable)
      .where(
        and(
          eq(schema.toolsTable.catalogId, catalogId),
          inArray(schema.toolsTable.name, archestraToolNames),
        ),
      );

    const existingToolsByName = new Map(existingTools.map((t) => [t.name, t]));

    // Prepare tools to insert (only those that don't exist)
    const toolsToInsert: InsertTool[] = [];

    for (const archestraTool of archestraTools) {
      const existingTool = existingToolsByName.get(archestraTool.name);
      if (!existingTool) {
        toolsToInsert.push({
          name: archestraTool.name,
          description: archestraTool.description || null,
          parameters: archestraTool.inputSchema,
          catalogId,
          agentId: null,
        });
      }
    }

    // Bulk insert new tools if any
    if (toolsToInsert.length > 0) {
      await db.insert(schema.toolsTable).values(toolsToInsert).returning();
    }
  }

  /**
   * Assign Archestra built-in tools to an agent.
   * Assumes tools have already been seeded via seedArchestraTools().
   */
  static async assignArchestraToolsToAgent(
    agentId: string,
    catalogId: string,
  ): Promise<void> {
    // Get all Archestra tools from the catalog
    const archestraTools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, catalogId));

    const toolIds = archestraTools.map((t) => t.id);

    // Assign all tools to agent in bulk to avoid N+1
    await AgentToolModel.createManyIfNotExists(agentId, toolIds);
  }

  /**
   * Assign default Archestra tools to an agent.
   *
   * Default tools are those listed in {@link DEFAULT_ARCHESTRA_TOOL_NAMES}:
   * - artifact_write: for artifact management
   * - todo_write: for task tracking
   * - query_knowledge_graph: for querying the knowledge graph (only if KG is configured)
   *
   * Only tools that have already been seeded (via {@link seedArchestraTools})
   * will be assigned. If none of the default tools exist, this method skips assignment.
   */
  static async assignDefaultArchestraToolsToAgent(
    agentId: string,
  ): Promise<void> {
    // Create a copy to avoid mutating the shared constant
    const assignedDefaultTools = [...DEFAULT_ARCHESTRA_TOOL_NAMES];
    if (!getKnowledgeGraphProviderType()) {
      const index = assignedDefaultTools.indexOf(
        TOOL_QUERY_KNOWLEDGE_GRAPH_FULL_NAME,
      );
      if (index !== -1) {
        assignedDefaultTools.splice(index, 1); // Remove query_knowledge_graph tool if knowledge graph is not configured
      }
    }

    const defaultTools = await db
      .select({ id: schema.toolsTable.id })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.name, assignedDefaultTools));

    if (defaultTools.length === 0) {
      // Tools not yet seeded, skip assignment
      return;
    }

    const toolIds = defaultTools.map((t) => t.id);

    // Assign tools to agent in bulk
    await AgentToolModel.createManyIfNotExists(agentId, toolIds);
  }

  /**
   * Get names of all MCP tools assigned to an agent.
   * Used to prevent autodiscovery of tools already available via MCP servers.
   */
  static async getMcpToolNamesByAgent(agentId: string): Promise<string[]> {
    const assignedMcpTools = await db
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

    return assignedMcpTools.map((t) => t.name);
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
      useDynamicTeamCredential: boolean;
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
        useDynamicTeamCredential:
          schema.agentToolsTable.useDynamicTeamCredential,
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

    const toolIds = tools.map((tool) => tool.id);

    // Get all agent assignments for these tools in one query to avoid N+1
    const assignments = await db
      .select({
        toolId: schema.agentToolsTable.toolId,
        agentId: schema.agentToolsTable.agentId,
        agentName: schema.agentsTable.name,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
      )
      .where(inArray(schema.agentToolsTable.toolId, toolIds));

    // Group assignments by tool ID
    const assignmentsByTool = new Map<
      string,
      Array<{ id: string; name: string }>
    >();

    for (const toolId of toolIds) {
      assignmentsByTool.set(toolId, []);
    }

    for (const assignment of assignments) {
      const toolAssignments = assignmentsByTool.get(assignment.toolId) || [];
      toolAssignments.push({
        id: assignment.agentId,
        name: assignment.agentName,
      });
      assignmentsByTool.set(assignment.toolId, toolAssignments);
    }

    // Build tools with their assigned agents
    const toolsWithAgents = tools.map((tool) => {
      const assignedAgents = assignmentsByTool.get(tool.id) || [];

      return {
        ...tool,
        parameters: tool.parameters ?? {},
        assignedAgentCount: assignedAgents.length,
        assignedAgents,
      };
    });

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

    const toolIds = tools.map((tool) => tool.id);

    // Get all agent assignments for these tools in one query to avoid N+1
    const assignments = await db
      .select({
        toolId: schema.agentToolsTable.toolId,
        agentId: schema.agentToolsTable.agentId,
        agentName: schema.agentsTable.name,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
      )
      .where(inArray(schema.agentToolsTable.toolId, toolIds));

    // Group assignments by tool ID
    const assignmentsByTool = new Map<
      string,
      Array<{ id: string; name: string }>
    >();

    for (const toolId of toolIds) {
      assignmentsByTool.set(toolId, []);
    }

    for (const assignment of assignments) {
      const toolAssignments = assignmentsByTool.get(assignment.toolId) || [];
      toolAssignments.push({
        id: assignment.agentId,
        name: assignment.agentName,
      });
      assignmentsByTool.set(assignment.toolId, toolAssignments);
    }

    // Build tools with their assigned agents
    const toolsWithAgents = tools.map((tool) => {
      const assignedAgents = assignmentsByTool.get(tool.id) || [];

      return {
        ...tool,
        parameters: tool.parameters ?? {},
        assignedAgentCount: assignedAgents.length,
        assignedAgents,
      };
    });

    return toolsWithAgents;
  }

  /**
   * Get basic tool info (name and catalogId) for multiple catalogs in a single query.
   * Used for batch loading tools across multiple catalogs.
   */
  static async getToolNamesByCatalogIds(
    catalogIds: string[],
  ): Promise<Array<{ name: string; catalogId: string }>> {
    if (catalogIds.length === 0) {
      return [];
    }

    const tools = await db
      .select({
        name: schema.toolsTable.name,
        catalogId: schema.toolsTable.catalogId,
      })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.catalogId, catalogIds));

    // Filter out any nulls (catalogId is nullable in schema)
    return tools.filter(
      (t): t is { name: string; catalogId: string } => t.catalogId !== null,
    );
  }

  /**
   * Get tool IDs for multiple catalogs in a single query.
   * Used for batch loading tool IDs across multiple catalogs.
   */
  static async getToolIdsByCatalogIds(catalogIds: string[]): Promise<string[]> {
    if (catalogIds.length === 0) {
      return [];
    }

    const tools = await db
      .select({
        id: schema.toolsTable.id,
      })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.catalogId, catalogIds));

    return tools.map((t) => t.id);
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

  /**
   * Sync tools for a catalog item - updates existing tools and creates new ones.
   * Unlike bulkCreateToolsIfNotExists, this method:
   * - Matches tools by their RAW name (the part after `__`), not the full slugified name
   * - Renames tools when catalog name changes (preserving tool ID, policies, and assignments)
   * - Updates description and parameters when they change
   *
   * This ensures that when a catalog item is renamed, existing tools are updated rather than
   * duplicated, preserving all policy configurations and profile assignments.
   *
   * @returns Object with created, updated, and unchanged tool arrays for logging
   */
  static async syncToolsForCatalog(
    tools: Array<{
      name: string;
      description: string | null;
      parameters: Record<string, unknown>;
      catalogId: string;
      mcpServerId: string;
      /** The original tool name from the MCP server (e.g., "generate_text") */
      rawToolName?: string;
    }>,
  ): Promise<{
    created: Tool[];
    updated: Tool[];
    unchanged: Tool[];
    deleted: Tool[];
  }> {
    if (tools.length === 0) {
      return { created: [], updated: [], unchanged: [], deleted: [] };
    }

    const catalogId = tools[0].catalogId;

    // Fetch ALL existing tools for this catalog (regardless of name)
    // This allows us to match by raw tool name even when catalog name changed
    const existingTools = await db
      .select()
      .from(schema.toolsTable)
      .where(
        and(
          isNull(schema.toolsTable.agentId),
          eq(schema.toolsTable.catalogId, catalogId),
        ),
      );

    // Create a map of existing tools by their RAW name (part after `__`)
    // This allows matching when catalog name changes
    // WHY: We use the LAST part after `__` to handle server names that contain `__`
    // e.g., "huggingface__remote-mcp__generate_text" -> raw name is "generate_text"
    // WHY: We lowercase raw names for matching since slugifyName() lowercases tool names,
    // but MCP servers may return tool names with different casing
    //
    // IMPORTANT: Handle duplicates gracefully. If multiple tools have the same raw name
    // (from previous buggy reinstalls), prefer the one that matches the NEW tool name pattern.
    // This ensures we update the correct tool and avoid cascade-deleting agent_tools.
    const newToolNames = new Set(tools.map((t) => t.name.toLowerCase()));
    const existingToolsByRawName = new Map<string, Tool>();
    for (const tool of existingTools) {
      // Extract the raw tool name by taking the part after the LAST `__`
      // This handles cases where server names contain `__` (e.g., huggingface__remote-mcp)
      const lastSeparatorIndex = tool.name.lastIndexOf(
        MCP_SERVER_TOOL_NAME_SEPARATOR,
      );
      const rawName =
        lastSeparatorIndex !== -1
          ? tool.name.slice(
              lastSeparatorIndex + MCP_SERVER_TOOL_NAME_SEPARATOR.length,
            )
          : tool.name;
      const rawNameLower = rawName.toLowerCase();

      // Check if we already have a tool with this raw name
      const existingEntry = existingToolsByRawName.get(rawNameLower);
      if (existingEntry) {
        // Duplicate found! Prefer the one whose name matches the new naming pattern
        // This handles the case where old tools (old-name__tool) and new tools (new-name__tool) both exist
        const existingMatchesNewPattern = newToolNames.has(
          existingEntry.name.toLowerCase(),
        );
        const currentMatchesNewPattern = newToolNames.has(
          tool.name.toLowerCase(),
        );

        if (!existingMatchesNewPattern && currentMatchesNewPattern) {
          // Current tool matches new pattern, prefer it
          existingToolsByRawName.set(rawNameLower, tool);
        }
        // Otherwise keep the existing entry (first one wins, or it already matches new pattern)
      } else {
        // Store with lowercase key for case-insensitive matching
        existingToolsByRawName.set(rawNameLower, tool);
      }
    }

    const created: Tool[] = [];
    const updated: Tool[] = [];
    const unchanged: Tool[] = [];
    const toolsToInsert: InsertTool[] = [];

    for (const tool of tools) {
      // Use rawToolName if provided, otherwise extract from the slugified name
      // rawToolName is the original name from the MCP server (e.g., "generate_text")
      let rawName: string;
      if (tool.rawToolName) {
        rawName = tool.rawToolName;
      } else {
        // Fallback: extract from the slugified name using last separator
        const lastSeparatorIndex = tool.name.lastIndexOf(
          MCP_SERVER_TOOL_NAME_SEPARATOR,
        );
        rawName =
          lastSeparatorIndex !== -1
            ? tool.name.slice(
                lastSeparatorIndex + MCP_SERVER_TOOL_NAME_SEPARATOR.length,
              )
            : tool.name;
      }
      // Lookup with lowercase key for case-insensitive matching
      const existingTool = existingToolsByRawName.get(rawName.toLowerCase());

      if (existingTool) {
        // Check what needs updating
        const nameChanged = existingTool.name !== tool.name;
        const descriptionChanged =
          existingTool.description !== tool.description;
        const parametersChanged =
          JSON.stringify(existingTool.parameters) !==
          JSON.stringify(tool.parameters);

        if (nameChanged || descriptionChanged || parametersChanged) {
          // Update existing tool (including rename if catalog name changed)
          const [updatedTool] = await db
            .update(schema.toolsTable)
            .set({
              name: tool.name, // This handles renaming when catalog name changes
              description: tool.description,
              parameters: tool.parameters,
              updatedAt: new Date(),
            })
            .where(eq(schema.toolsTable.id, existingTool.id))
            .returning();

          if (updatedTool) {
            updated.push(updatedTool);
          }
        } else {
          unchanged.push(existingTool);
        }
      } else {
        // New tool - prepare for bulk insert
        toolsToInsert.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          catalogId: tool.catalogId,
          mcpServerId: tool.mcpServerId,
          agentId: null,
        });
      }
    }

    // Bulk insert new tools if any
    if (toolsToInsert.length > 0) {
      const insertedTools = await db
        .insert(schema.toolsTable)
        .values(toolsToInsert)
        .onConflictDoNothing()
        .returning();

      // Create default policies for newly inserted tools
      for (const tool of insertedTools) {
        await ToolModel.createDefaultPolicies(tool.id);
      }

      created.push(...insertedTools);
    }

    // Cleanup: Delete orphaned tools that weren't synced
    // This handles the case where tools were renamed (old name tools are now orphaned)
    // or tools were removed from the MCP server
    const syncedToolIds = new Set([
      ...created.map((t) => t.id),
      ...updated.map((t) => t.id),
      ...unchanged.map((t) => t.id),
    ]);

    // Build a map of synced tools by raw name for transferring assignments
    const syncedToolsByRawName = new Map<string, Tool>();
    for (const tool of [...created, ...updated, ...unchanged]) {
      const lastSeparatorIndex = tool.name.lastIndexOf(
        MCP_SERVER_TOOL_NAME_SEPARATOR,
      );
      const rawName =
        lastSeparatorIndex !== -1
          ? tool.name
              .slice(lastSeparatorIndex + MCP_SERVER_TOOL_NAME_SEPARATOR.length)
              .toLowerCase()
          : tool.name.toLowerCase();
      syncedToolsByRawName.set(rawName, tool);
    }

    const orphanedTools = existingTools.filter((t) => !syncedToolIds.has(t.id));

    if (orphanedTools.length > 0) {
      // Transfer agent_tools and policies from orphaned tools to their matching synced tools
      // This preserves profile assignments when duplicate tools exist from previous buggy reinstalls
      for (const orphanedTool of orphanedTools) {
        const lastSeparatorIndex = orphanedTool.name.lastIndexOf(
          MCP_SERVER_TOOL_NAME_SEPARATOR,
        );
        const rawName =
          lastSeparatorIndex !== -1
            ? orphanedTool.name
                .slice(
                  lastSeparatorIndex + MCP_SERVER_TOOL_NAME_SEPARATOR.length,
                )
                .toLowerCase()
            : orphanedTool.name.toLowerCase();

        const targetTool = syncedToolsByRawName.get(rawName);
        if (targetTool && targetTool.id !== orphanedTool.id) {
          // Transfer agent_tools: update toolId to point to the synced tool
          // Use ON CONFLICT DO NOTHING to handle cases where assignment already exists
          const agentToolsToTransfer = await db
            .select()
            .from(schema.agentToolsTable)
            .where(eq(schema.agentToolsTable.toolId, orphanedTool.id));

          for (const agentTool of agentToolsToTransfer) {
            // Check if the target tool already has an assignment for this agent
            const existingAssignment = await db
              .select()
              .from(schema.agentToolsTable)
              .where(
                and(
                  eq(schema.agentToolsTable.agentId, agentTool.agentId),
                  eq(schema.agentToolsTable.toolId, targetTool.id),
                ),
              )
              .limit(1);

            if (existingAssignment.length === 0) {
              // No existing assignment, create one for the target tool
              await db.insert(schema.agentToolsTable).values({
                agentId: agentTool.agentId,
                toolId: targetTool.id,
                responseModifierTemplate: agentTool.responseModifierTemplate,
                credentialSourceMcpServerId:
                  agentTool.credentialSourceMcpServerId,
                executionSourceMcpServerId:
                  agentTool.executionSourceMcpServerId,
                useDynamicTeamCredential: agentTool.useDynamicTeamCredential,
              });
            }
          }
        }
      }

      // Now safe to delete orphaned tools - agent_tools have been transferred
      await db.delete(schema.toolsTable).where(
        inArray(
          schema.toolsTable.id,
          orphanedTools.map((t) => t.id),
        ),
      );
    }

    return { created, updated, unchanged, deleted: orphanedTools };
  }

  /**
   * Delete a tool by ID.
   * Only allows deletion of auto-discovered tools (no mcpServerId).
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.toolsTable)
      .where(
        and(
          eq(schema.toolsTable.id, id),
          isNull(schema.toolsTable.mcpServerId),
        ),
      );

    return (result.rowCount || 0) > 0;
  }

  static async getByIds(ids: string[]): Promise<Tool[]> {
    return db
      .select()
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.id, ids));
  }

  /**
   * Get tool names by IDs
   * Used to map tool IDs to names for filtering
   */
  static async getNamesByIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }

    const tools = await db
      .select({ name: schema.toolsTable.name })
      .from(schema.toolsTable)
      .where(inArray(schema.toolsTable.id, ids));

    return tools.map((t) => t.name);
  }

  /**
   * Bulk create proxy-sniffed tools for an agent (tools discovered via LLM proxy)
   * Fetches existing tools in a single query, then bulk inserts only new tools
   * Returns all tools (existing + newly created) to avoid N+1 queries
   */
  static async bulkCreateProxyToolsIfNotExists(
    tools: Array<{
      name: string;
      description?: string | null;
      parameters?: Record<string, unknown>;
    }>,
    agentId: string,
  ): Promise<Tool[]> {
    if (tools.length === 0) {
      return [];
    }

    const toolNames = tools.map((t) => t.name);

    // Fetch all existing tools for this agent in a single query
    const existingTools = await db
      .select()
      .from(schema.toolsTable)
      .where(
        and(
          eq(schema.toolsTable.agentId, agentId),
          isNull(schema.toolsTable.catalogId),
          inArray(schema.toolsTable.name, toolNames),
        ),
      );

    const existingToolsByName = new Map(existingTools.map((t) => [t.name, t]));

    // Prepare tools to insert (only those that don't exist)
    const toolsToInsert: InsertTool[] = [];
    const resultTools: Tool[] = [];

    for (const tool of tools) {
      const existingTool = existingToolsByName.get(tool.name);
      if (existingTool) {
        resultTools.push(existingTool);
      } else {
        toolsToInsert.push({
          name: tool.name,
          description: tool.description ?? null,
          parameters: tool.parameters ?? {},
          catalogId: null,
          mcpServerId: null,
          agentId,
        });
      }
    }

    // Bulk insert new tools if any
    if (toolsToInsert.length > 0) {
      const insertedTools = await db
        .insert(schema.toolsTable)
        .values(toolsToInsert)
        .onConflictDoNothing()
        .returning();

      // Create default policies for newly inserted tools
      for (const tool of insertedTools) {
        await ToolModel.createDefaultPolicies(tool.id);
      }

      // If some tools weren't inserted due to conflict, fetch them
      if (insertedTools.length < toolsToInsert.length) {
        const insertedNames = new Set(insertedTools.map((t) => t.name));
        const missingNames = toolsToInsert
          .filter((t) => !insertedNames.has(t.name))
          .map((t) => t.name);

        if (missingNames.length > 0) {
          const conflictTools = await db
            .select()
            .from(schema.toolsTable)
            .where(
              and(
                eq(schema.toolsTable.agentId, agentId),
                isNull(schema.toolsTable.catalogId),
                inArray(schema.toolsTable.name, missingNames),
              ),
            );
          resultTools.push(...insertedTools, ...conflictTools);
        } else {
          resultTools.push(...insertedTools);
        }
      } else {
        resultTools.push(...insertedTools);
      }
    }

    // Return tools in the same order as input
    const resultToolsByName = new Map(resultTools.map((t) => [t.name, t]));
    return tools
      .map((t) => resultToolsByName.get(t.name))
      .filter((t): t is Tool => t !== undefined);
  }

  /**
   * Find or create a delegation tool for a target agent.
   * Delegation tools are used by internal agents to delegate tasks to other agents.
   */
  static async findOrCreateDelegationTool(
    targetAgentId: string,
  ): Promise<Tool> {
    // Check if delegation tool already exists
    const [existingTool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.delegateToAgentId, targetAgentId))
      .limit(1);

    if (existingTool) {
      return existingTool;
    }

    // Get target agent for naming
    const [targetAgent] = await db
      .select({ id: schema.agentsTable.id, name: schema.agentsTable.name })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, targetAgentId))
      .limit(1);

    if (!targetAgent) {
      throw new Error(`Target agent not found: ${targetAgentId}`);
    }

    // Create delegation tool
    const toolName = `${AGENT_TOOL_PREFIX}${slugify(targetAgent.name)}`;
    const [tool] = await db
      .insert(schema.toolsTable)
      .values({
        name: toolName,
        description: `Delegate task to agent: ${targetAgent.name}`,
        delegateToAgentId: targetAgentId,
        agentId: null,
        catalogId: null,
        mcpServerId: null,
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The task or message to send to the agent",
            },
          },
          required: ["message"],
        },
      })
      .returning();

    return tool;
  }

  /**
   * Find a delegation tool by target agent ID
   */
  static async findDelegationTool(targetAgentId: string): Promise<Tool | null> {
    const [tool] = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.delegateToAgentId, targetAgentId))
      .limit(1);

    return tool || null;
  }

  /**
   * Get delegation tools assigned to an agent with target agent details
   */
  static async getDelegationToolsByAgent(agentId: string): Promise<
    Array<{
      tool: Tool;
      targetAgent: {
        id: string;
        name: string;
        description: string | null;
        systemPrompt: string | null;
      };
    }>
  > {
    const results = await db
      .select({
        tool: schema.toolsTable,
        targetAgent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
          description: schema.agentsTable.description,
          systemPrompt: schema.agentsTable.systemPrompt,
        },
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        eq(schema.toolsTable.delegateToAgentId, schema.agentsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          isNotNull(schema.toolsTable.delegateToAgentId),
        ),
      );

    return results;
  }

  /**
   * Sync delegation tool names when an agent is renamed.
   * Updates the tool name for all tools that delegate to this agent.
   * @param targetAgentId - The agent ID that was renamed
   * @param newName - The new name of the agent
   */
  static async syncDelegationToolNames(
    targetAgentId: string,
    newName: string,
  ): Promise<void> {
    const newToolName = `${AGENT_TOOL_PREFIX}${slugify(newName)}`;

    await db
      .update(schema.toolsTable)
      .set({
        name: newToolName,
        description: `Delegate task to agent: ${newName}`,
      })
      .where(eq(schema.toolsTable.delegateToAgentId, targetAgentId));
  }

  /**
   * Find all agent IDs that have delegation tools pointing to the target agent.
   * Used to invalidate caches when target agent is renamed.
   */
  static async getParentAgentIds(targetAgentId: string): Promise<string[]> {
    const results = await db
      .selectDistinct({ agentId: schema.agentToolsTable.agentId })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.toolsTable.delegateToAgentId, targetAgentId));

    return results.map((r) => r.agentId);
  }

  /**
   * Find all tools with their profile assignments.
   * Returns one entry per tool (grouped by tool), with all assignments embedded.
   * Only returns tools that have at least one assignment.
   */
  static async findAllWithAssignments(params: {
    pagination?: { limit?: number; offset?: number };
    sorting?: {
      sortBy?: ToolSortBy;
      sortDirection?: ToolSortDirection;
    };
    filters?: ToolFilters;
    userId?: string;
    isAgentAdmin?: boolean;
  }): Promise<PaginatedResult<ToolWithAssignments>> {
    const {
      pagination = { limit: 20, offset: 0 },
      sorting,
      filters,
      userId,
      isAgentAdmin,
    } = params;

    // Build WHERE conditions for tools
    const toolWhereConditions: ReturnType<typeof sql>[] = [];

    // Filter by search query (tool name)
    if (filters?.search) {
      toolWhereConditions.push(
        ilike(schema.toolsTable.name, `%${filters.search}%`),
      );
    }

    // Filter by origin (either "llm-proxy" or a catalogId)
    if (filters?.origin) {
      if (filters.origin === "llm-proxy") {
        // LLM Proxy tools have null catalogId but agentId is set
        toolWhereConditions.push(isNull(schema.toolsTable.catalogId));
        toolWhereConditions.push(isNotNull(schema.toolsTable.agentId));
      } else {
        // MCP tools have a catalogId
        toolWhereConditions.push(
          eq(schema.toolsTable.catalogId, filters.origin),
        );
      }
    }

    // Exclude Archestra built-in tools
    if (filters?.excludeArchestraTools) {
      toolWhereConditions.push(
        notIlike(schema.toolsTable.name, "archestra__%"),
      );
    }

    // Apply access control filtering for users that are not agent admins
    // Get accessible agent IDs for filtering assignments
    let accessibleAgentIds: string[] | undefined;
    let accessibleMcpServerIds: Set<string> | undefined;
    if (userId && !isAgentAdmin) {
      const [agentIds, mcpServers] = await Promise.all([
        AgentTeamModel.getUserAccessibleAgentIds(userId, false),
        McpServerModel.findAll(userId, false),
      ]);
      accessibleAgentIds = agentIds;
      accessibleMcpServerIds = new Set(mcpServers.map((s) => s.id));

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, {
          limit: pagination.limit ?? 20,
          offset: pagination.offset ?? 0,
        });
      }
    }

    // Build the combined WHERE clause
    const toolWhereClause =
      toolWhereConditions.length > 0 ? and(...toolWhereConditions) : undefined;

    // Subquery to get tools that have at least one assignment (with access control)
    const assignmentConditions = accessibleAgentIds
      ? and(
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
          inArray(schema.agentToolsTable.agentId, accessibleAgentIds),
        )
      : eq(schema.agentToolsTable.toolId, schema.toolsTable.id);

    // Count subquery for assignment count (with access control)
    const assignmentCountSubquery = sql<number>`(
      SELECT COUNT(*) FROM ${schema.agentToolsTable}
      WHERE ${assignmentConditions}
    )`;

    // Determine the ORDER BY clause based on sorting params
    const direction = sorting?.sortDirection === "asc" ? asc : desc;
    let orderByClause: ReturnType<typeof asc>;

    switch (sorting?.sortBy) {
      case "name":
        orderByClause = direction(schema.toolsTable.name);
        break;
      case "origin":
        // Sort by catalogId (null values for LLM Proxy)
        orderByClause = direction(
          sql`CASE WHEN ${schema.toolsTable.catalogId} IS NULL THEN '2-llm-proxy' ELSE '1-mcp' END`,
        );
        break;
      case "assignmentCount":
        orderByClause = direction(assignmentCountSubquery);
        break;
      default:
        orderByClause = direction(schema.toolsTable.createdAt);
        break;
    }

    // Query for tools that have at least one assignment
    const toolsWithCount = await db
      .select({
        id: schema.toolsTable.id,
        name: schema.toolsTable.name,
        description: schema.toolsTable.description,
        parameters: schema.toolsTable.parameters,
        catalogId: schema.toolsTable.catalogId,
        mcpServerId: schema.toolsTable.mcpServerId,
        mcpServerName: schema.mcpServersTable.name,
        mcpServerCatalogId: schema.mcpServersTable.catalogId,
        createdAt: schema.toolsTable.createdAt,
        updatedAt: schema.toolsTable.updatedAt,
        assignmentCount: assignmentCountSubquery,
      })
      .from(schema.toolsTable)
      .leftJoin(
        schema.mcpServersTable,
        eq(schema.toolsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .where(toolWhereClause)
      .orderBy(orderByClause)
      .limit(pagination.limit ?? 20)
      .offset(pagination.offset ?? 0);

    // Get total count
    const [{ total }] = await db
      .select({ total: count() })
      .from(schema.toolsTable)
      .where(toolWhereClause);

    if (toolsWithCount.length === 0) {
      return createPaginatedResult([], 0, {
        limit: pagination.limit ?? 20,
        offset: pagination.offset ?? 0,
      });
    }

    // Get all assignments for these tools in one query
    const toolIds = toolsWithCount.map((t) => t.id as string);
    const assignmentWhereConditions = [
      inArray(schema.agentToolsTable.toolId, toolIds),
    ];

    // Apply access control to assignments
    if (accessibleAgentIds) {
      assignmentWhereConditions.push(
        inArray(schema.agentToolsTable.agentId, accessibleAgentIds),
      );
    }

    // Aliases for credential source and execution source MCP servers and their owners
    const credentialMcpServerAlias = alias(
      schema.mcpServersTable,
      "credentialMcpServer",
    );
    const credentialOwnerAlias = alias(schema.usersTable, "credentialOwner");
    const executionMcpServerAlias = alias(
      schema.mcpServersTable,
      "executionMcpServer",
    );
    const executionOwnerAlias = alias(schema.usersTable, "executionOwner");

    const assignments = await db
      .select({
        toolId: schema.agentToolsTable.toolId,
        agentToolId: schema.agentToolsTable.id,
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
        credentialSourceMcpServerId:
          schema.agentToolsTable.credentialSourceMcpServerId,
        credentialOwnerEmail: credentialOwnerAlias.email,
        executionSourceMcpServerId:
          schema.agentToolsTable.executionSourceMcpServerId,
        executionOwnerEmail: executionOwnerAlias.email,
        useDynamicTeamCredential:
          schema.agentToolsTable.useDynamicTeamCredential,
        responseModifierTemplate:
          schema.agentToolsTable.responseModifierTemplate,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
      )
      .leftJoin(
        credentialMcpServerAlias,
        eq(
          schema.agentToolsTable.credentialSourceMcpServerId,
          credentialMcpServerAlias.id,
        ),
      )
      .leftJoin(
        credentialOwnerAlias,
        eq(credentialMcpServerAlias.ownerId, credentialOwnerAlias.id),
      )
      .leftJoin(
        executionMcpServerAlias,
        eq(
          schema.agentToolsTable.executionSourceMcpServerId,
          executionMcpServerAlias.id,
        ),
      )
      .leftJoin(
        executionOwnerAlias,
        eq(executionMcpServerAlias.ownerId, executionOwnerAlias.id),
      )
      .where(and(...assignmentWhereConditions));

    // Group assignments by tool ID
    const assignmentsByToolId = new Map<
      string,
      Array<{
        agentToolId: string;
        agent: { id: string; name: string };
        credentialSourceMcpServerId: string | null;
        credentialOwnerEmail: string | null;
        executionSourceMcpServerId: string | null;
        executionOwnerEmail: string | null;
        useDynamicTeamCredential: boolean;
        responseModifierTemplate: string | null;
      }>
    >();

    for (const assignment of assignments) {
      const existing = assignmentsByToolId.get(assignment.toolId) || [];

      // Check if user has access to the credential MCP server
      // If not accessible, don't include the owner email (frontend will show "Owner outside your team")
      const credentialServerAccessible =
        !accessibleMcpServerIds ||
        !assignment.credentialSourceMcpServerId ||
        accessibleMcpServerIds.has(assignment.credentialSourceMcpServerId);
      const executionServerAccessible =
        !accessibleMcpServerIds ||
        !assignment.executionSourceMcpServerId ||
        accessibleMcpServerIds.has(assignment.executionSourceMcpServerId);

      existing.push({
        agentToolId: assignment.agentToolId,
        agent: {
          id: assignment.agentId,
          name: assignment.agentName,
        },
        credentialSourceMcpServerId: assignment.credentialSourceMcpServerId,
        credentialOwnerEmail: credentialServerAccessible
          ? assignment.credentialOwnerEmail
          : null,
        executionSourceMcpServerId: assignment.executionSourceMcpServerId,
        executionOwnerEmail: executionServerAccessible
          ? assignment.executionOwnerEmail
          : null,
        useDynamicTeamCredential: assignment.useDynamicTeamCredential,
        responseModifierTemplate: assignment.responseModifierTemplate,
      });
      assignmentsByToolId.set(assignment.toolId, existing);
    }

    // Build the final result
    const result: ToolWithAssignments[] = toolsWithCount.map((tool) => ({
      id: tool.id as string,
      name: tool.name as string,
      description: tool.description as string | null,
      parameters: (tool.parameters as Record<string, unknown>) ?? {},
      catalogId: tool.catalogId as string | null,
      mcpServerId: tool.mcpServerId as string | null,
      mcpServerName: tool.mcpServerName as string | null,
      mcpServerCatalogId: tool.mcpServerCatalogId as string | null,
      createdAt: tool.createdAt as Date,
      updatedAt: tool.updatedAt as Date,
      assignmentCount: Number(tool.assignmentCount),
      assignments: assignmentsByToolId.get(tool.id as string) || [],
    }));

    return createPaginatedResult(result, Number(total), {
      limit: pagination.limit ?? 20,
      offset: pagination.offset ?? 0,
    });
  }
}

export default ToolModel;
