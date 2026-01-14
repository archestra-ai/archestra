import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import logger from "@/logging";
import type {
  AgentTool,
  AgentToolFilters,
  AgentToolSortBy,
  AgentToolSortDirection,
  InsertAgentTool,
  PaginationQuery,
  UpdateAgentTool,
} from "@/types";
import AgentTeamModel from "./agent-team";

class AgentToolModel {
  static async create(
    agentId: string,
    toolId: string,
    options?: Partial<
      Pick<
        InsertAgentTool,
        | "responseModifierTemplate"
        | "credentialSourceMcpServerId"
        | "executionSourceMcpServerId"
      >
    >,
  ) {
    const [agentTool] = await db
      .insert(schema.agentToolsTable)
      .values({
        agentId,
        toolId,
        ...options,
      })
      .returning();

    // Auto-configure policies if enabled (run in background)
    // Import at top of method to avoid circular dependency
    const { agentToolAutoPolicyService } = await import(
      "./agent-tool-auto-policy"
    );
    const { default: OrganizationModel } = await import("./organization");

    // Get agent's organization via team relationship and trigger auto-configure in background
    db.select({ organizationId: schema.teamsTable.organizationId })
      .from(schema.agentTeamsTable)
      .innerJoin(
        schema.teamsTable,
        eq(schema.agentTeamsTable.teamId, schema.teamsTable.id),
      )
      .where(eq(schema.agentTeamsTable.agentId, agentId))
      .limit(1)
      .then(async (rows) => {
        if (rows.length === 0) return;

        const organizationId = rows[0].organizationId;
        const organization = await OrganizationModel.getById(organizationId);

        if (organization?.autoConfigureNewTools) {
          // Use the unified method with timeout and loading state management
          await agentToolAutoPolicyService.configurePoliciesForAgentToolWithTimeout(
            agentTool.id,
            organizationId,
          );
        }
      })
      .catch((error) => {
        logger.error(
          {
            agentToolId: agentTool.id,
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to trigger auto-configure for new agent-tool",
        );
      });

    return agentTool;
  }

  static async delete(agentId: string, toolId: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.agentToolsTable.toolId, toolId),
        ),
      );
    return result.rowCount !== null && result.rowCount > 0;
  }

  static async findToolIdsByAgent(agentId: string): Promise<string[]> {
    const results = await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agentId));
    return results.map((r) => r.toolId);
  }

  static async findAgentIdsByTool(toolId: string): Promise<string[]> {
    const results = await db
      .select({ agentId: schema.agentToolsTable.agentId })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.toolId, toolId));
    return results.map((r) => r.agentId);
  }

  static async findAllAssignedToolIds(): Promise<string[]> {
    const results = await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable);
    return [...new Set(results.map((r) => r.toolId))];
  }

  static async exists(agentId: string, toolId: string): Promise<boolean> {
    const [result] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.agentToolsTable.toolId, toolId),
        ),
      )
      .limit(1);
    return !!result;
  }

  static async createIfNotExists(
    agentId: string,
    toolId: string,
    credentialSourceMcpServerId?: string | null,
    executionSourceMcpServerId?: string | null,
  ) {
    const exists = await AgentToolModel.exists(agentId, toolId);
    if (!exists) {
      const options: Partial<
        Pick<
          InsertAgentTool,
          | "responseModifierTemplate"
          | "credentialSourceMcpServerId"
          | "executionSourceMcpServerId"
        >
      > = {};

      // Only include credentialSourceMcpServerId if it has a real value
      if (credentialSourceMcpServerId) {
        options.credentialSourceMcpServerId = credentialSourceMcpServerId;
      }

      // Only include executionSourceMcpServerId if it has a real value
      if (executionSourceMcpServerId) {
        options.executionSourceMcpServerId = executionSourceMcpServerId;
      }

      return await AgentToolModel.create(agentId, toolId, options);
    }
    return null;
  }

  /**
   * Bulk create agent-tool relationships in one query to avoid N+1
   */
  static async createManyIfNotExists(
    agentId: string,
    toolIds: string[],
  ): Promise<void> {
    if (toolIds.length === 0) return;

    // Check which tools are already assigned
    const existingAssignments = await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          inArray(schema.agentToolsTable.toolId, toolIds),
        ),
      );

    const existingToolIds = new Set(existingAssignments.map((a) => a.toolId));
    const newToolIds = toolIds.filter((toolId) => !existingToolIds.has(toolId));

    if (newToolIds.length > 0) {
      await db.insert(schema.agentToolsTable).values(
        newToolIds.map((toolId) => ({
          agentId,
          toolId,
        })),
      );
    }
  }

  /**
   * Bulk create agent-tool relationships for multiple agents and tools
   * Assigns all tools to all agents in a single query to avoid N+1
   */
  static async bulkCreateForAgentsAndTools(
    agentIds: string[],
    toolIds: string[],
    options?: Partial<
      Pick<
        InsertAgentTool,
        | "responseModifierTemplate"
        | "credentialSourceMcpServerId"
        | "executionSourceMcpServerId"
      >
    >,
  ): Promise<void> {
    if (agentIds.length === 0 || toolIds.length === 0) return;

    // Build all possible combinations
    const assignments: Array<{
      agentId: string;
      toolId: string;
      responseModifierTemplate?: string | null;
      credentialSourceMcpServerId?: string | null;
      executionSourceMcpServerId?: string | null;
    }> = [];

    for (const agentId of agentIds) {
      for (const toolId of toolIds) {
        assignments.push({
          agentId,
          toolId,
          ...options,
        });
      }
    }

    // Check which assignments already exist
    const existingAssignments = await db
      .select({
        agentId: schema.agentToolsTable.agentId,
        toolId: schema.agentToolsTable.toolId,
      })
      .from(schema.agentToolsTable)
      .where(
        and(
          inArray(schema.agentToolsTable.agentId, agentIds),
          inArray(schema.agentToolsTable.toolId, toolIds),
        ),
      );

    const existingSet = new Set(
      existingAssignments.map((a) => `${a.agentId}:${a.toolId}`),
    );

    // Filter out existing assignments
    const newAssignments = assignments.filter(
      (a) => !existingSet.has(`${a.agentId}:${a.toolId}`),
    );

    if (newAssignments.length > 0) {
      await db
        .insert(schema.agentToolsTable)
        .values(newAssignments)
        .onConflictDoNothing();
    }
  }

  /**
   * Creates a new agent-tool assignment or updates credentials if it already exists.
   * Returns the status: "created", "updated", or "unchanged".
   */
  static async createOrUpdateCredentials(
    agentId: string,
    toolId: string,
    credentialSourceMcpServerId?: string | null,
    executionSourceMcpServerId?: string | null,
    useDynamicTeamCredential?: boolean,
  ): Promise<{ status: "created" | "updated" | "unchanged" }> {
    // Check if assignment already exists
    const [existing] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.agentToolsTable.toolId, toolId),
        ),
      )
      .limit(1);

    if (!existing) {
      // Create new assignment
      const options: Partial<
        Pick<
          InsertAgentTool,
          | "responseModifierTemplate"
          | "credentialSourceMcpServerId"
          | "executionSourceMcpServerId"
          | "useDynamicTeamCredential"
        >
      > = {};

      if (credentialSourceMcpServerId) {
        options.credentialSourceMcpServerId = credentialSourceMcpServerId;
      }

      if (executionSourceMcpServerId) {
        options.executionSourceMcpServerId = executionSourceMcpServerId;
      }

      if (useDynamicTeamCredential !== undefined) {
        options.useDynamicTeamCredential = useDynamicTeamCredential;
      }

      await AgentToolModel.create(agentId, toolId, options);
      return { status: "created" };
    }

    // Check if credentials need updating
    const needsUpdate =
      existing.credentialSourceMcpServerId !==
        (credentialSourceMcpServerId ?? null) ||
      existing.executionSourceMcpServerId !==
        (executionSourceMcpServerId ?? null) ||
      (useDynamicTeamCredential !== undefined &&
        existing.useDynamicTeamCredential !== useDynamicTeamCredential);

    if (needsUpdate) {
      // Update credentials
      const updateData: Partial<
        Pick<
          UpdateAgentTool,
          | "credentialSourceMcpServerId"
          | "executionSourceMcpServerId"
          | "useDynamicTeamCredential"
        >
      > = {};

      // Always set credential fields to ensure they're updated correctly
      updateData.credentialSourceMcpServerId =
        credentialSourceMcpServerId ?? null;
      updateData.executionSourceMcpServerId =
        executionSourceMcpServerId ?? null;

      if (useDynamicTeamCredential !== undefined) {
        updateData.useDynamicTeamCredential = useDynamicTeamCredential;
      }

      await AgentToolModel.update(existing.id, updateData);
      return { status: "updated" };
    }

    return { status: "unchanged" };
  }

  static async update(
    id: string,
    data: Partial<
      Pick<
        UpdateAgentTool,
        | "responseModifierTemplate"
        | "credentialSourceMcpServerId"
        | "executionSourceMcpServerId"
        | "useDynamicTeamCredential"
        | "policiesAutoConfiguredAt"
        | "policiesAutoConfiguringStartedAt"
        | "policiesAutoConfiguredReasoning"
      >
    >,
  ) {
    const [agentTool] = await db
      .update(schema.agentToolsTable)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(schema.agentToolsTable.id, id))
      .returning();
    return agentTool;
  }

  /**
   * Find all agent-tool relationships with pagination, sorting, and filtering support.
   * When skipPagination is true, returns all matching records without applying limit/offset.
   */
  static async findAll(params: {
    pagination?: PaginationQuery;
    sorting?: {
      sortBy?: AgentToolSortBy;
      sortDirection?: AgentToolSortDirection;
    };
    filters?: AgentToolFilters;
    userId?: string;
    isAgentAdmin?: boolean;
    skipPagination?: boolean;
  }): Promise<PaginatedResult<AgentTool>> {
    const {
      pagination = { limit: 20, offset: 0 },
      sorting,
      filters,
      userId,
      isAgentAdmin,
      skipPagination = false,
    } = params;
    // Build WHERE conditions
    const whereConditions: SQL[] = [];

    // Apply access control filtering for users that are not agent admins
    if (userId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }

      whereConditions.push(
        inArray(schema.agentToolsTable.agentId, accessibleAgentIds),
      );
    }

    // Filter by search query (tool name)
    if (filters?.search) {
      whereConditions.push(
        sql`LOWER(${schema.toolsTable.name}) LIKE ${`%${filters.search.toLowerCase()}%`}`,
      );
    }

    // Filter by agent
    if (filters?.agentId) {
      whereConditions.push(eq(schema.agentToolsTable.agentId, filters.agentId));
    }

    // Filter by origin (either "llm-proxy" or a catalogId)
    if (filters?.origin) {
      if (filters.origin === "llm-proxy") {
        // LLM Proxy tools have null catalogId
        whereConditions.push(sql`${schema.toolsTable.catalogId} IS NULL`);
      } else {
        // MCP tools have a catalogId
        whereConditions.push(eq(schema.toolsTable.catalogId, filters.origin));
      }
    }

    // Filter by credential owner (check both credential source and execution source)
    if (filters?.mcpServerOwnerId) {
      // First, get all MCP server IDs owned by this user
      const mcpServerIds = await db
        .select({ id: schema.mcpServersTable.id })
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.ownerId, filters.mcpServerOwnerId))
        .then((rows) => rows.map((r) => r.id));

      if (mcpServerIds.length > 0) {
        const credentialCondition = or(
          inArray(
            schema.agentToolsTable.credentialSourceMcpServerId,
            mcpServerIds,
          ),
          inArray(
            schema.agentToolsTable.executionSourceMcpServerId,
            mcpServerIds,
          ),
        );
        if (credentialCondition) {
          whereConditions.push(credentialCondition);
        }
      }
    }

    // Exclude Archestra built-in tools for test isolation
    // Note: Use escape character to treat underscores literally (not as wildcards)
    // Double backslash needed: JS consumes one level, SQL gets the other
    if (filters?.excludeArchestraTools) {
      whereConditions.push(
        sql`${schema.toolsTable.name} NOT LIKE 'archestra\\_\\_%' ESCAPE '\\'`,
      );
    }

    const whereClause =
      whereConditions.length > 0 ? and(...whereConditions) : undefined;

    // Determine the ORDER BY clause based on sorting params
    const direction = sorting?.sortDirection === "asc" ? asc : desc;
    let orderByClause: SQL;

    switch (sorting?.sortBy) {
      case "name":
        orderByClause = direction(schema.toolsTable.name);
        break;
      case "agent":
        orderByClause = direction(schema.agentsTable.name);
        break;
      case "origin":
        // Sort by catalogId (null values last for LLM Proxy)
        orderByClause = direction(
          sql`CASE WHEN ${schema.toolsTable.catalogId} IS NULL THEN '2-llm-proxy' ELSE '1-mcp' END`,
        );
        break;
      default:
        orderByClause = direction(schema.agentToolsTable.createdAt);
        break;
    }

    // Build the base data query
    const baseDataQuery = db
      .select({
        ...getTableColumns(schema.agentToolsTable),
        agent: {
          id: schema.agentsTable.id,
          name: schema.agentsTable.name,
        },
        tool: {
          id: schema.toolsTable.id,
          name: schema.toolsTable.name,
          description: schema.toolsTable.description,
          parameters: schema.toolsTable.parameters,
          createdAt: schema.toolsTable.createdAt,
          updatedAt: schema.toolsTable.updatedAt,
          catalogId: schema.toolsTable.catalogId,
          mcpServerId: schema.toolsTable.mcpServerId,
          mcpServerName: schema.mcpServersTable.name,
          mcpServerCatalogId: schema.mcpServersTable.catalogId,
        },
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
      )
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .leftJoin(
        schema.mcpServersTable,
        eq(schema.toolsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .where(whereClause)
      .orderBy(orderByClause)
      .$dynamic();

    // Apply pagination only if not skipped
    const dataQuery = skipPagination
      ? baseDataQuery
      : baseDataQuery.limit(pagination.limit).offset(pagination.offset);

    // Run both queries in parallel
    const [data, [{ total }]] = await Promise.all([
      dataQuery,
      db
        .select({ total: count() })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.agentsTable,
          eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
        )
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .leftJoin(
          schema.mcpServersTable,
          eq(schema.toolsTable.mcpServerId, schema.mcpServersTable.id),
        )
        .where(whereClause),
    ]);

    // When skipping pagination, return all data with correct metadata
    // Use Math.max(1, data.length) to avoid division by zero when data is empty
    if (skipPagination) {
      return createPaginatedResult(data, data.length, {
        limit: Math.max(1, data.length),
        offset: 0,
      });
    }

    return createPaginatedResult(data, Number(total), pagination);
  }

  /**
   * Delete all agent-tool assignments that use a specific MCP server as their execution source.
   * Used when a local MCP server is deleted/uninstalled.
   */
  static async deleteByExecutionSourceMcpServerId(
    mcpServerId: string,
  ): Promise<number> {
    const result = await db
      .delete(schema.agentToolsTable)
      .where(
        eq(schema.agentToolsTable.executionSourceMcpServerId, mcpServerId),
      );
    return result.rowCount ?? 0;
  }

  /**
   * Delete all agent-tool assignments that use a specific MCP server as their credential source.
   * Used when a remote MCP server is deleted/uninstalled.
   */
  static async deleteByCredentialSourceMcpServerId(
    mcpServerId: string,
  ): Promise<number> {
    const result = await db
      .delete(schema.agentToolsTable)
      .where(
        eq(schema.agentToolsTable.credentialSourceMcpServerId, mcpServerId),
      );
    return result.rowCount ?? 0;
  }

  /**
   * Clean up invalid credential sources when a user is removed from a team.
   * Sets credentialSourceMcpServerId to null for agent-tools where:
   * - The credential source is a personal token owned by the removed user
   * - The user no longer has access to the agent through any team
   */
  static async cleanupInvalidCredentialSourcesForUser(
    userId: string,
    teamId: string,
    isAgentAdmin: boolean,
  ): Promise<number> {
    // Get all agents assigned to this team
    const agentsInTeam = await db
      .select({ agentId: schema.agentTeamsTable.agentId })
      .from(schema.agentTeamsTable)
      .where(eq(schema.agentTeamsTable.teamId, teamId));

    if (agentsInTeam.length === 0) {
      return 0;
    }

    const agentIds = agentsInTeam.map((a) => a.agentId);

    // Get all MCP servers owned by this user
    const userServers = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.ownerId, userId));

    if (userServers.length === 0) {
      return 0;
    }

    const serverIds = userServers.map((s) => s.id);

    // For each agent, check if user still has access through other teams
    let cleanedCount = 0;

    for (const agentId of agentIds) {
      // Check if user still has access to this agent through other teams
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        agentId,
        isAgentAdmin,
      );

      // If user no longer has access, clean up their personal tokens
      if (!hasAccess) {
        const result = await db
          .update(schema.agentToolsTable)
          .set({ credentialSourceMcpServerId: null })
          .where(
            and(
              eq(schema.agentToolsTable.agentId, agentId),
              inArray(
                schema.agentToolsTable.credentialSourceMcpServerId,
                serverIds,
              ),
            ),
          );

        cleanedCount += result.rowCount ?? 0;
      }
    }

    return cleanedCount;
  }
}

export default AgentToolModel;
