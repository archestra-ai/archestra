import {
  ARCHESTRA_MCP_CATALOG_ID,
  BUILT_IN_AGENT_IDS,
  type PaginationQuery,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
} from "@shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { archestraMcpBranding } from "@/archestra-mcp-server";
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
  CredentialResolutionMode,
  InsertAgentTool,
  SortDirection,
  UpdateAgentTool,
} from "@/types";
import AgentTeamModel from "./agent-team";
import McpServerUserModel from "./mcp-server-user";

class AgentToolModel {
  // ============================================================================
  // DELEGATION METHODS
  // ============================================================================

  /**
   * Assign a delegation to a target agent.
   * Creates the delegation tool if it doesn't exist, then creates the agent_tool assignment.
   */
  static async assignDelegation(
    agentId: string,
    targetAgentId: string,
  ): Promise<void> {
    // Dynamically import to avoid circular dependency
    const { default: ToolModel } = await import("./tool");

    // Find or create the delegation tool for the target agent
    const tool = await ToolModel.findOrCreateDelegationTool(targetAgentId);

    // Assign the tool to the source agent
    await AgentToolModel.createIfNotExists(agentId, tool.id);
  }

  /**
   * Remove a delegation to a target agent.
   */
  static async removeDelegation(
    agentId: string,
    targetAgentId: string,
  ): Promise<boolean> {
    // Dynamically import to avoid circular dependency
    const { default: ToolModel } = await import("./tool");

    const tool = await ToolModel.findDelegationTool(targetAgentId);
    if (!tool) {
      return false;
    }

    return AgentToolModel.delete(agentId, tool.id);
  }

  /**
   * Get all agents that this agent can delegate to.
   * Optionally filters by user access when userId is provided.
   */
  static async getDelegationTargets(
    agentId: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      systemPrompt: string | null;
    }>
  > {
    const results = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        description: schema.agentsTable.description,
        systemPrompt: schema.agentsTable.systemPrompt,
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

    // Filter by user access if userId is provided
    if (userId && !isAgentAdmin) {
      const userAccessibleAgentIds =
        await AgentTeamModel.getUserAccessibleAgentIds(userId, false);
      return results.filter((r) => userAccessibleAgentIds.includes(r.id));
    }

    return results;
  }

  /**
   * Sync delegations for an agent - replaces all existing delegations with the new set.
   */
  static async syncDelegations(
    agentId: string,
    targetAgentIds: string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    // Get current delegation targets
    const currentTargets = await AgentToolModel.getDelegationTargets(agentId);
    const currentTargetIds = new Set(currentTargets.map((t) => t.id));
    const newTargetIds = new Set(targetAgentIds);

    // Find what to add and remove
    const toRemove = currentTargets.filter((t) => !newTargetIds.has(t.id));
    const toAdd = targetAgentIds.filter((id) => !currentTargetIds.has(id));

    // Remove old delegations
    for (const target of toRemove) {
      await AgentToolModel.removeDelegation(agentId, target.id);
    }

    // Add new delegations
    for (const targetId of toAdd) {
      await AgentToolModel.assignDelegation(agentId, targetId);
    }

    return {
      added: toAdd,
      removed: toRemove.map((t) => t.id),
    };
  }

  /**
   * Get all delegation connections for an organization (for canvas visualization).
   */
  static async getAllDelegationConnections(
    organizationId: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<
    Array<{
      sourceAgentId: string;
      sourceAgentName: string;
      targetAgentId: string;
      targetAgentName: string;
      toolId: string;
    }>
  > {
    const targetAgentsAlias = alias(schema.agentsTable, "targetAgent");

    let query = db
      .select({
        sourceAgentId: schema.agentToolsTable.agentId,
        sourceAgentName: schema.agentsTable.name,
        targetAgentId: schema.toolsTable.delegateToAgentId,
        targetAgentName: targetAgentsAlias.name,
        toolId: schema.agentToolsTable.toolId,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
      )
      .innerJoin(
        targetAgentsAlias,
        eq(schema.toolsTable.delegateToAgentId, targetAgentsAlias.id),
      )
      .where(
        and(
          isNotNull(schema.toolsTable.delegateToAgentId),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      )
      .$dynamic();

    // Apply access control filtering for non-agent admins
    if (userId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      query = query.where(
        inArray(schema.agentToolsTable.agentId, accessibleAgentIds),
      );
    }

    const results = await query;

    // Filter out null targetAgentIds (shouldn't happen but TypeScript needs this)
    return results.filter(
      (r): r is typeof r & { targetAgentId: string } =>
        r.targetAgentId !== null,
    );
  }

  // ============================================================================
  // ACCESS CONTROL HELPERS
  // ============================================================================

  /**
   * Get all MCP server IDs that a user has access to (through team membership or personal access).
   * Used for filtering agent_tools to only show assignments with accessible credentials.
   */
  private static async getUserAccessibleMcpServerIds(
    userId: string,
  ): Promise<string[]> {
    // Get MCP servers accessible through team membership
    const teamAccessibleServers = await db
      .select({ mcpServerId: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .innerJoin(
        schema.teamMembersTable,
        eq(schema.mcpServersTable.teamId, schema.teamMembersTable.teamId),
      )
      .where(eq(schema.teamMembersTable.userId, userId));

    const teamAccessibleIds = teamAccessibleServers.map((s) => s.mcpServerId);

    // Get personal MCP servers
    const personalIds =
      await McpServerUserModel.getUserPersonalMcpServerIds(userId);

    // Combine and deduplicate
    return [...new Set([...teamAccessibleIds, ...personalIds])];
  }

  // ============================================================================
  // STANDARD CRUD METHODS
  // ============================================================================

  static async create(
    agentId: string,
    toolId: string,
    options?: Partial<
      Pick<InsertAgentTool, "mcpServerId" | "credentialResolutionMode">
    >,
    organizationId?: string,
  ) {
    const [agentTool] = await db
      .insert(schema.agentToolsTable)
      .values({
        agentId,
        toolId,
        ...(options?.mcpServerId ? { mcpServerId: options.mcpServerId } : {}),
        ...(options?.credentialResolutionMode
          ? { credentialResolutionMode: options.credentialResolutionMode }
          : {}),
      })
      .returning();

    // Auto-configure policies if enabled (fire-and-forget).
    // This is intentionally best-effort: the agent-tool is returned immediately
    // while the policy configuration runs asynchronously. If the background
    // operation fails, the error is logged but does not affect the caller.
    AgentToolModel.triggerAutoConfigureIfEnabled(
      agentTool.id,
      agentId,
      toolId,
      organizationId,
    );

    return agentTool;
  }

  /**
   * Bulk insert multiple agent-tool assignments in a single query.
   * Checks auto-configure setting once (not per-row) to avoid N+1 queries.
   */
  static async bulkCreate(
    values: Array<{
      agentId: string;
      toolId: string;
      mcpServerId?: string | null;
      credentialResolutionMode?: CredentialResolutionMode;
    }>,
    organizationId?: string,
  ) {
    if (values.length === 0) return [];

    const rows = await db
      .insert(schema.agentToolsTable)
      .values(
        values.map((value) => ({
          agentId: value.agentId,
          toolId: value.toolId,
          ...(value.mcpServerId ? { mcpServerId: value.mcpServerId } : {}),
          credentialResolutionMode: normalizeCredentialResolutionMode(value),
        })),
      )
      .returning();

    // Fire auto-configure in background, checking the setting only once for all rows
    AgentToolModel.triggerBulkAutoConfigureIfEnabled(rows, organizationId);

    return rows;
  }

  /**
   * Check auto-configure setting once, then trigger for each tool.
   * Avoids N+1 getBuiltInAgent queries when bulk-creating assignments.
   */
  private static triggerBulkAutoConfigureIfEnabled(
    rows: Array<{ id: string; agentId: string; toolId: string }>,
    knownOrganizationId?: string,
  ) {
    if (rows.length === 0) return;

    const resolveOrgId = knownOrganizationId
      ? Promise.resolve(knownOrganizationId)
      : db
          .select({ organizationId: schema.agentsTable.organizationId })
          .from(schema.agentsTable)
          .where(eq(schema.agentsTable.id, rows[0].agentId))
          .limit(1)
          .then((r) => (r.length > 0 ? r[0].organizationId : null));

    resolveOrgId
      .then(async (orgId) => {
        if (!orgId) return;

        const { policyConfigurationService } = await import(
          "@/agents/subagents/policy-configuration"
        );
        const { default: AgentModel } = await import("./agent");

        // Check auto-configure setting ONCE for all rows
        const builtInAgent = await AgentModel.getBuiltInAgent(
          BUILT_IN_AGENT_IDS.POLICY_CONFIG,
          orgId,
        );
        const config = builtInAgent?.builtInAgentConfig;
        if (
          config?.name !== BUILT_IN_AGENT_IDS.POLICY_CONFIG ||
          !config.autoConfigureOnToolAssignment
        ) {
          return;
        }

        // Trigger per-tool (these are the actual policy configuration calls)
        for (const row of rows) {
          await policyConfigurationService.configurePoliciesForToolWithTimeout({
            toolId: row.toolId,
            organizationId: orgId,
          });
        }
      })
      .catch((error) => {
        logger.error(
          {
            rowCount: rows.length,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to trigger bulk auto-configure for new agent-tools",
        );
      });
  }

  private static triggerAutoConfigureIfEnabled(
    agentToolId: string,
    agentId: string,
    toolId: string,
    knownOrganizationId?: string,
  ) {
    const resolveOrgId = knownOrganizationId
      ? Promise.resolve(knownOrganizationId)
      : db
          .select({ organizationId: schema.agentsTable.organizationId })
          .from(schema.agentsTable)
          .where(eq(schema.agentsTable.id, agentId))
          .limit(1)
          .then((rows) => (rows.length > 0 ? rows[0].organizationId : null));

    resolveOrgId
      .then(async (orgId) => {
        if (!orgId) return;

        // Import at call site to avoid circular dependency
        const { policyConfigurationService } = await import(
          "@/agents/subagents/policy-configuration"
        );
        const { default: AgentModel } = await import("./agent");

        // Read auto-configure setting from the built-in Policy Config agent
        const builtInAgent = await AgentModel.getBuiltInAgent(
          BUILT_IN_AGENT_IDS.POLICY_CONFIG,
          orgId,
        );
        const config = builtInAgent?.builtInAgentConfig;
        if (
          config?.name === BUILT_IN_AGENT_IDS.POLICY_CONFIG &&
          config.autoConfigureOnToolAssignment
        ) {
          await policyConfigurationService.configurePoliciesForToolWithTimeout({
            toolId,
            organizationId: orgId,
          });
        }
      })
      .catch((error) => {
        logger.error(
          {
            agentToolId,
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to trigger auto-configure for new agent-tool",
        );
      });
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
    mcpServerId?: string | null,
  ) {
    const exists = await AgentToolModel.exists(agentId, toolId);
    if (!exists) {
      const options: Partial<Pick<InsertAgentTool, "mcpServerId">> = {};
      if (mcpServerId) {
        options.mcpServerId = mcpServerId;
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
      await db
        .insert(schema.agentToolsTable)
        .values(
          newToolIds.map((toolId) => ({
            agentId,
            toolId,
          })),
        )
        .onConflictDoNothing();
    }
  }

  /**
   * Bulk create agent-tool relationships for multiple agents and tools
   * Assigns all tools to all agents in a single query to avoid N+1
   */
  static async bulkCreateForAgentsAndTools(
    agentIds: string[],
    toolIds: string[],
    options?: Partial<Pick<InsertAgentTool, "mcpServerId">>,
  ): Promise<void> {
    if (agentIds.length === 0 || toolIds.length === 0) return;

    // Build all possible combinations
    const assignments: Array<{
      agentId: string;
      toolId: string;
      mcpServerId?: string | null;
    }> = [];

    for (const agentId of agentIds) {
      for (const toolId of toolIds) {
        assignments.push({
          agentId,
          toolId,
          ...(options?.mcpServerId ? { mcpServerId: options.mcpServerId } : {}),
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
    mcpServerId?: string | null,
    credentialResolutionMode?: CredentialResolutionMode | null,
  ): Promise<{ status: "created" | "updated" | "unchanged" }> {
    const normalizedMcpServerId = mcpServerId ?? null;
    const normalizedMode = normalizeCredentialResolutionMode({
      credentialResolutionMode,
    });
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
        Pick<InsertAgentTool, "mcpServerId" | "credentialResolutionMode">
      > = {};

      if (normalizedMcpServerId) {
        options.mcpServerId = normalizedMcpServerId;
      }

      options.credentialResolutionMode = normalizedMode;

      await AgentToolModel.create(agentId, toolId, options);
      return { status: "created" };
    }

    // Check if credentials need updating
    const needsUpdate =
      existing.mcpServerId !== normalizedMcpServerId ||
      existing.credentialResolutionMode !== normalizedMode;

    if (needsUpdate) {
      // Update credentials
      const updateData: Partial<
        Pick<UpdateAgentTool, "mcpServerId" | "credentialResolutionMode">
      > = {};

      updateData.mcpServerId = normalizedMcpServerId;
      updateData.credentialResolutionMode = normalizedMode;

      await AgentToolModel.update(existing.id, updateData);
      return { status: "updated" };
    }

    return { status: "unchanged" };
  }

  /**
   * Bulk create-or-update agent-tool assignments.
   * Fetches all existing assignments in a single query, then batch-inserts new ones
   * and individually updates those that need credential changes.
   */
  static async bulkCreateOrUpdateCredentials(
    assignments: Array<{
      agentId: string;
      toolId: string;
      mcpServerId?: string | null;
      credentialResolutionMode?: CredentialResolutionMode;
    }>,
    organizationId?: string,
  ): Promise<
    Array<{
      agentId: string;
      toolId: string;
      status: "created" | "updated" | "unchanged";
    }>
  > {
    if (assignments.length === 0) return [];

    // Build OR conditions for all (agentId, toolId) pairs
    const pairConditions = assignments.map((a) =>
      and(
        eq(schema.agentToolsTable.agentId, a.agentId),
        eq(schema.agentToolsTable.toolId, a.toolId),
      ),
    );

    // Batch fetch all existing assignments in one query
    const existing = await db
      .select()
      .from(schema.agentToolsTable)
      .where(or(...pairConditions));

    const existingMap = new Map(
      existing.map((e) => [`${e.agentId}:${e.toolId}`, e]),
    );

    const toCreate: Array<{
      agentId: string;
      toolId: string;
      mcpServerId?: string | null;
      resolveAtCallTime?: boolean;
      credentialResolutionMode?: CredentialResolutionMode;
    }> = [];
    const results: Array<{
      agentId: string;
      toolId: string;
      status: "created" | "updated" | "unchanged";
    }> = [];

    for (const assignment of assignments) {
      const key = `${assignment.agentId}:${assignment.toolId}`;
      const existingRow = existingMap.get(key);

      if (!existingRow) {
        // New assignment - collect for batch insert
        toCreate.push(assignment);
        results.push({
          agentId: assignment.agentId,
          toolId: assignment.toolId,
          status: "created",
        });
      } else {
        // Check if credentials need updating
        const needsUpdate =
          existingRow.mcpServerId !== (assignment.mcpServerId ?? null) ||
          existingRow.credentialResolutionMode !==
            normalizeCredentialResolutionMode(assignment);

        if (needsUpdate) {
          const updateData: Partial<
            Pick<UpdateAgentTool, "mcpServerId" | "credentialResolutionMode">
          > = {
            mcpServerId: assignment.mcpServerId ?? null,
            credentialResolutionMode:
              normalizeCredentialResolutionMode(assignment),
          };
          await AgentToolModel.update(existingRow.id, updateData);
          results.push({
            agentId: assignment.agentId,
            toolId: assignment.toolId,
            status: "updated",
          });
        } else {
          results.push({
            agentId: assignment.agentId,
            toolId: assignment.toolId,
            status: "unchanged",
          });
        }
      }
    }

    // Batch insert all new assignments in a single query
    if (toCreate.length > 0) {
      await AgentToolModel.bulkCreate(
        toCreate.map((a) => ({
          agentId: a.agentId,
          toolId: a.toolId,
          ...(a.mcpServerId ? { mcpServerId: a.mcpServerId } : {}),
          credentialResolutionMode: normalizeCredentialResolutionMode(a),
        })),
        organizationId,
      );
    }

    return results;
  }

  static async update(
    id: string,
    data: Partial<
      Pick<UpdateAgentTool, "mcpServerId" | "credentialResolutionMode">
    >,
  ) {
    const [agentTool] = await db
      .update(schema.agentToolsTable)
      .set({
        ...(data.mcpServerId !== undefined
          ? { mcpServerId: data.mcpServerId }
          : {}),
        ...(data.credentialResolutionMode
          ? { credentialResolutionMode: data.credentialResolutionMode }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.agentToolsTable.id, id))
      .returning();
    return agentTool;
  }

  /**
   * Find a single agent-tool relationship by ID, including joined agent and tool data.
   */
  static async findById(id: string): Promise<AgentTool | undefined> {
    const [row] = await db
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
      .where(eq(schema.agentToolsTable.id, id))
      .limit(1);
    return row;
  }

  /**
   * Find all agent-tool relationships with pagination, sorting, and filtering support.
   * When skipPagination is true, returns all matching records without applying limit/offset.
   */
  static async findAll(params: {
    pagination?: PaginationQuery;
    sorting?: {
      sortBy?: AgentToolSortBy;
      sortDirection?: SortDirection;
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
      // Filter by accessible agents (profiles)
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

      // Filter by accessible credentials (MCP servers)
      // Only show agent_tools where the user has access to the credential/execution source
      const accessibleMcpServerIds =
        await AgentToolModel.getUserAccessibleMcpServerIds(userId);

      // Build credential access condition:
      // - No static MCP server binding, OR
      // - Assigned MCP server is accessible
      const credentialAccessConditions: SQL[] = [
        isNull(schema.agentToolsTable.mcpServerId) as SQL,
      ];

      // Add accessible static MCP server bindings if user has any
      if (accessibleMcpServerIds.length > 0) {
        credentialAccessConditions.push(
          inArray(schema.agentToolsTable.mcpServerId, accessibleMcpServerIds),
        );
      }

      const credentialAccessCondition = or(...credentialAccessConditions);
      if (credentialAccessCondition) {
        whereConditions.push(credentialAccessCondition);
      }
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

    // Filter by origin (catalogId)
    if (filters?.origin) {
      whereConditions.push(eq(schema.toolsTable.catalogId, filters.origin));
    }

    // Filter by assigned MCP server owner
    if (filters?.mcpServerOwnerId) {
      // First, get all MCP server IDs owned by this user
      const mcpServerIds = await db
        .select({ id: schema.mcpServersTable.id })
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.ownerId, filters.mcpServerOwnerId))
        .then((rows) => rows.map((r) => r.id));

      if (mcpServerIds.length > 0) {
        const credentialCondition = inArray(
          schema.agentToolsTable.mcpServerId,
          mcpServerIds,
        );
        if (credentialCondition) {
          whereConditions.push(credentialCondition);
        }
      }
    }

    // Exclude Archestra built-in tools for test isolation
    if (filters?.excludeArchestraTools) {
      const excludeBuiltInToolsCondition = or(
        isNull(schema.toolsTable.catalogId),
        ne(schema.toolsTable.catalogId, ARCHESTRA_MCP_CATALOG_ID),
      );

      if (excludeBuiltInToolsCondition) {
        whereConditions.push(excludeBuiltInToolsCondition);
      }
    }

    // Always exclude the knowledge sources tool (auto-injected, not user-assignable)
    whereConditions.push(
      ne(
        schema.toolsTable.name,
        archestraMcpBranding.getToolName(
          TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
        ),
      ),
    );

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
   * Delete all static agent-tool assignments that use a specific MCP server.
   */
  static async deleteByExecutionSourceMcpServerId(
    mcpServerId: string,
  ): Promise<number> {
    const result = await db
      .delete(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.mcpServerId, mcpServerId));
    return result.rowCount ?? 0;
  }

  /**
   * Delete all static agent-tool assignments that use a specific MCP server.
   */
  static async deleteByCredentialSourceMcpServerId(
    mcpServerId: string,
  ): Promise<number> {
    return AgentToolModel.deleteByExecutionSourceMcpServerId(mcpServerId);
  }

  /**
   * Clean up invalid static MCP server assignments when a user is removed from a team.
   * Sets mcpServerId to null for agent-tools where:
   * - The assigned MCP server is owned by the removed user
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
          .set({ mcpServerId: null })
          .where(
            and(
              eq(schema.agentToolsTable.agentId, agentId),
              inArray(schema.agentToolsTable.mcpServerId, serverIds),
            ),
          );

        cleanedCount += result.rowCount ?? 0;
      }
    }

    return cleanedCount;
  }
}

export default AgentToolModel;

function normalizeCredentialResolutionMode(params: {
  resolveAtCallTime?: boolean;
  credentialResolutionMode?: CredentialResolutionMode | null;
}) {
  if (params.credentialResolutionMode) {
    return params.credentialResolutionMode;
  }

  return params.resolveAtCallTime ? "dynamic" : "static";
}
