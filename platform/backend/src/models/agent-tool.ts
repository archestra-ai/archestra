import {
  ARCHESTRA_MCP_CATALOG_ID,
  type PaginationQuery,
  TOOL_QUERY_KNOWLEDGE_SOURCES_SHORT_NAME,
} from "@archestra/shared";
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
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  AgentTool,
  AgentToolFilters,
  AgentToolSortBy,
  CredentialResolutionMode,
  InsertAgentTool,
  InternalMcpCatalogServerType,
  McpServerAgentUsage,
  ResourceVisibilityScope,
  SortDirection,
  UpdateAgentTool,
} from "@/types";
import AgentTeamModel from "./agent-team";
import AgentVersionModel from "./agent-version";
import McpServerUserModel from "./mcp-server-user";

class AgentToolModel {
  // ============================================================================
  // DELEGATION METHODS
  // ============================================================================

  static async cloneAssignments(params: {
    fromAgentId: string;
    toAgentId: string;
  }): Promise<void> {
    const { fromAgentId, toAgentId } = params;

    const rows = await db
      .select({
        ...getTableColumns(schema.agentToolsTable),
      })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, fromAgentId));

    if (rows.length === 0) return;

    await db
      .insert(schema.agentToolsTable)
      .values(
        rows.map((r) => ({
          agentId: toAgentId,
          toolId: r.toolId,
          mcpServerId: r.mcpServerId,
          credentialResolutionMode: r.credentialResolutionMode,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [schema.agentToolsTable.agentId, schema.agentToolsTable.toolId],
        set: {
          mcpServerId: sql`excluded.mcp_server_id`,
          credentialResolutionMode: sql`excluded.credential_resolution_mode`,
          updatedAt: new Date(),
        },
      });
  }

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

    // Delegation assignment changes the agent's tool surface — fork a version.
    await AgentVersionModel.forkIfChangedBestEffort(agentId);
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

    return AgentToolModel.delete({ agentId, toolId: tool.id });
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
          notDeleted(schema.agentsTable),
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
          notDeleted(schema.agentsTable),
          notDeleted(targetAgentsAlias),
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
   * Get all MCP server IDs that a user has access to (through team
   * membership, personal access, or org-scoped installations).
   * Used for filtering agent_tools to only show assignments with accessible credentials.
   */
  private static async getUserAccessibleMcpServerIds(
    userId: string,
    organizationId?: string,
  ): Promise<string[]> {
    // Get MCP servers accessible through team membership
    const teamAccessibleServers = await db
      .select({ mcpServerId: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .innerJoin(
        schema.teamMembersTable,
        eq(schema.mcpServersTable.teamId, schema.teamMembersTable.teamId),
      )
      .where(
        and(
          eq(schema.teamMembersTable.userId, userId),
          // Active installs only — a soft-deleted install grants no access.
          notDeleted(schema.mcpServersTable),
        ),
      );

    const teamAccessibleIds = teamAccessibleServers.map((s) => s.mcpServerId);

    // Get personal MCP servers
    const personalIds =
      await McpServerUserModel.getUserPersonalMcpServerIds(userId);

    const orgScopedIds = organizationId
      ? await db
          .select({ mcpServerId: schema.mcpServersTable.id })
          .from(schema.mcpServersTable)
          .innerJoin(
            schema.internalMcpCatalogTable,
            eq(
              schema.mcpServersTable.catalogId,
              schema.internalMcpCatalogTable.id,
            ),
          )
          .where(
            and(
              eq(schema.mcpServersTable.scope, "org"),
              eq(schema.internalMcpCatalogTable.organizationId, organizationId),
              // Active installs only — a soft-deleted install grants no access.
              notDeleted(schema.mcpServersTable),
            ),
          )
          .then((rows) => rows.map((s) => s.mcpServerId))
      : [];

    // Combine and deduplicate
    return [
      ...new Set([...teamAccessibleIds, ...personalIds, ...orgScopedIds]),
    ];
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
    _organizationId?: string,
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

    return agentTool;
  }

  /**
   * Insert-or-update several agent-tool assignments in a single statement.
   *
   * `ON CONFLICT` rather than a plain insert so a caller holding a mix of new
   * and already-assigned pairs needs no per-row UPDATE. That matters because the
   * bulk routes run this inside a transaction: a per-row loop would hold write
   * locks on `agent_tools` for as many round trips as there are rows, so lock
   * hold time would scale with batch size.
   */
  static async bulkUpsert(
    values: Array<{
      agentId: string;
      toolId: string;
      mcpServerId?: string | null;
      credentialResolutionMode?: CredentialResolutionMode;
      resolveAtCallTime?: boolean;
    }>,
    _organizationId?: string,
    tx?: Transaction,
  ) {
    if (values.length === 0) return [];
    const dbx = tx ?? db;

    // Row locks are taken in the order this VALUES list names them, so a stable
    // order keeps two concurrent upserts with overlapping pairs from deadlocking
    // against each other. It says nothing about a caller that also DELETEs rows
    // in a separate statement of the same transaction — that order is not
    // coordinated with this one.
    //
    // Byte order, not locale collation: the keys are UUID pairs, so there is no
    // collation question to answer, and a locale-sensitive comparator would make
    // the lock order depend on the process's resolved ICU locale.
    const sortKey = (v: { agentId: string; toolId: string }) =>
      `${v.agentId}:${v.toolId}`;
    const ordered = [...values].sort((a, b) => {
      const keyA = sortKey(a);
      const keyB = sortKey(b);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });

    const rows = await dbx
      .insert(schema.agentToolsTable)
      .values(
        ordered.map((value) => ({
          agentId: value.agentId,
          toolId: value.toolId,
          // Explicit null, never an omitted key. The conflict clause below sets
          // `excluded.mcp_server_id`, which is whatever this row proposed —
          // omitting the column would make it default to null on insert but
          // leave a stale pin in place on update, so the same input would clear
          // a pin or not depending on whether the row already existed.
          mcpServerId: value.mcpServerId ?? null,
          credentialResolutionMode: normalizeCredentialResolutionMode(value),
        })),
      )
      .onConflictDoUpdate({
        target: [schema.agentToolsTable.agentId, schema.agentToolsTable.toolId],
        set: {
          mcpServerId: sql`excluded.mcp_server_id`,
          credentialResolutionMode: sql`excluded.credential_resolution_mode`,
          // Set explicitly: this is an INSERT statement, so the column's
          // `$onUpdate` never fires for the conflict path.
          updatedAt: new Date(),
        },
      })
      .returning();

    return rows;
  }

  static async delete(params: {
    agentId: string;
    toolId: string;
    /** See `AgentToolAssignmentRequest.deferVersionFork`. */
    deferVersionFork?: boolean;
  }): Promise<boolean> {
    const { agentId, toolId } = params;
    // RETURNING (not rowCount) so the deleted flag is reliable — the fork below
    // and callers key off it, and rowCount is not dependable under PGlite.
    const rows = await db
      .delete(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.agentToolsTable.toolId, toolId),
        ),
      )
      .returning({ toolId: schema.agentToolsTable.toolId });
    const deleted = rows.length > 0;
    if (deleted && !params.deferVersionFork) {
      // Tool surface changed — fork a version. Covers unassign via REST, the
      // MCP sync tool, and removeDelegation.
      await AgentVersionModel.forkIfChangedBestEffort(agentId);
    }
    return deleted;
  }

  static async deleteAllForAgent(agentId: string): Promise<number> {
    const result = await db
      .delete(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agentId));
    return result.rowCount ?? 0;
  }

  static async deleteCatalogToolsForAgent(agentId: string): Promise<number> {
    const catalogToolIds =
      await AgentToolModel.findCatalogToolIdsByAgent(agentId);
    const deleted = await AgentToolModel.bulkDelete(agentId, catalogToolIds);
    return deleted.length;
  }

  /**
   * Delete several of one agent's assignments in a single statement, returning
   * the tool ids that were actually removed. RETURNING (not rowCount) for the
   * same reason as `delete` above: rowCount is not dependable under PGlite, and
   * bulk callers distinguish a real removal from a tool that was not assigned.
   */
  static async bulkDelete(
    agentId: string,
    toolIds: string[],
    tx?: Transaction,
  ): Promise<string[]> {
    if (toolIds.length === 0) return [];
    const dbx = tx ?? db;

    const rows = await dbx
      .delete(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          inArray(schema.agentToolsTable.toolId, toolIds),
        ),
      )
      .returning({ toolId: schema.agentToolsTable.toolId });

    return rows.map((row) => row.toolId);
  }

  static async findToolIdsByAgent(agentId: string): Promise<string[]> {
    const results = await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agentId));
    return results.map((r) => r.toolId);
  }

  /**
   * Full assignment identity per tool, not just the tool id. The version
   * restore compares live assignments against a snapshot's, and the credential
   * binding is part of what a version records: two rows with the same toolId
   * but a different server or resolution mode are different configurations, so
   * an id-only read would report "unchanged" and silently skip restoring them.
   */
  static async findAssignmentsByAgent(
    agentId: string,
  ): Promise<AgentToolAssignment[]> {
    return db
      .select({
        toolId: schema.agentToolsTable.toolId,
        mcpServerId: schema.agentToolsTable.mcpServerId,
        credentialResolutionMode:
          schema.agentToolsTable.credentialResolutionMode,
      })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.agentId, agentId));
  }

  /**
   * The agent's assignments that pin one installed MCP connection — a binding
   * the runtime follows as written. Returns the tool name plus the connection
   * identity the assignment rules evaluate (scope/team/owner), so a caller can
   * re-check pins the agent already holds against a scope or team membership
   * it does not have yet. Soft-deleted connections are skipped: a pin to one
   * resolves nothing either way.
   */
  static async findStaticPinnedAssignmentsByAgent(agentId: string): Promise<
    {
      toolId: string;
      toolName: string;
      mcpServer: {
        id: string;
        name: string;
        ownerId: string | null;
        teamId: string | null;
        scope: ResourceVisibilityScope;
        serverType: InternalMcpCatalogServerType;
      };
    }[]
  > {
    const rows = await db
      .select({
        toolId: schema.agentToolsTable.toolId,
        toolName: schema.toolsTable.name,
        id: schema.mcpServersTable.id,
        name: schema.mcpServersTable.name,
        ownerId: schema.mcpServersTable.ownerId,
        teamId: schema.mcpServersTable.teamId,
        scope: schema.mcpServersTable.scope,
        serverType: schema.mcpServersTable.serverType,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.agentToolsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          // The mode is the whole test: only `dynamic` resolves the connection
          // per caller at call time, so every other mode leaves `mcpServerId`
          // as a pin the runtime targets. A null `mcpServerId` needs no
          // predicate of its own — the join above already drops those rows.
          ne(schema.agentToolsTable.credentialResolutionMode, "dynamic"),
          notDeleted(schema.mcpServersTable),
        ),
      );

    return rows.map(({ toolId, toolName, ...mcpServer }) => ({
      toolId,
      toolName,
      mcpServer,
    }));
  }

  /**
   * Batched {@link findAssignmentsByAgent}, keyed by agent id. Agents with no
   * assignments still get an (empty) entry, so a caller snapshotting a set of
   * agents does not have to distinguish "no rows" from "not queried".
   */
  static async findAssignmentsByAgents(
    agentIds: string[],
  ): Promise<Map<string, AgentToolAssignment[]>> {
    const byAgent = new Map<string, AgentToolAssignment[]>(
      agentIds.map((agentId) => [agentId, []]),
    );
    if (agentIds.length === 0) return byAgent;

    const rows = await db
      .select({
        agentId: schema.agentToolsTable.agentId,
        toolId: schema.agentToolsTable.toolId,
        mcpServerId: schema.agentToolsTable.mcpServerId,
        credentialResolutionMode:
          schema.agentToolsTable.credentialResolutionMode,
      })
      .from(schema.agentToolsTable)
      .where(inArray(schema.agentToolsTable.agentId, agentIds));

    for (const { agentId, ...assignment } of rows) {
      byAgent.get(agentId)?.push(assignment);
    }
    return byAgent;
  }

  static async findCatalogToolIdsByAgent(agentId: string): Promise<string[]> {
    const results = await db
      .select({ toolId: schema.agentToolsTable.toolId })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          isNotNull(schema.toolsTable.catalogId),
          isNull(schema.toolsTable.delegateToAgentId),
          // A soft-deleted catalog's tools are not resolvable for the agent.
          notDeleted(schema.toolsTable),
        ),
      );
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

  /**
   * Get the distinct agents that have tools explicitly assigned from each of
   * the given MCP servers, in one query to avoid N+1.
   *
   * An assignment counts toward a server when it is statically pinned to that
   * server (`agent_tools.mcp_server_id`), or when it is unpinned (dynamic
   * credential resolution) and the tool belongs to the server's catalog — a
   * dynamic assignment can resolve to any install of the catalog at call time.
   */
  static async getAssignedAgentDetailsForMcpServers(
    mcpServerIds: string[],
  ): Promise<Map<string, McpServerAgentUsage[]>> {
    const agentsMap = new Map<string, McpServerAgentUsage[]>();
    for (const mcpServerId of mcpServerIds) {
      agentsMap.set(mcpServerId, []);
    }
    if (mcpServerIds.length === 0) {
      return agentsMap;
    }

    const assignments = await db
      .selectDistinct({
        mcpServerId: schema.mcpServersTable.id,
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
        agentType: schema.agentsTable.agentType,
        scope: schema.agentsTable.scope,
        ownerId: schema.agentsTable.authorId,
        ownerEmail: schema.usersTable.email,
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
      // Personal agents share a name across members, so the owner is what
      // tells them apart in the UI. LEFT JOIN: `author_id` is nullable and
      // nulls out when the author is deleted.
      .leftJoin(
        schema.usersTable,
        eq(schema.agentsTable.authorId, schema.usersTable.id),
      )
      .innerJoin(
        schema.mcpServersTable,
        or(
          eq(schema.agentToolsTable.mcpServerId, schema.mcpServersTable.id),
          and(
            isNull(schema.agentToolsTable.mcpServerId),
            eq(schema.toolsTable.catalogId, schema.mcpServersTable.catalogId),
          ),
        ),
      )
      .where(
        and(
          inArray(schema.mcpServersTable.id, mcpServerIds),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(asc(schema.agentsTable.name), asc(schema.agentsTable.id));

    for (const { mcpServerId, agentId, agentName, ...agent } of assignments) {
      agentsMap.get(mcpServerId)?.push({
        id: agentId,
        name: agentName,
        ...agent,
      });
    }

    return agentsMap;
  }

  static async getToolsForAgent(agentId: string) {
    const results = await db
      .select({ tool: schema.toolsTable })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.agentToolsTable.agentId, agentId));

    return results.map((r) => r.tool);
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
    options?: Partial<
      Pick<InsertAgentTool, "mcpServerId" | "credentialResolutionMode">
    >,
    tx?: Transaction,
  ): Promise<void> {
    if (agentIds.length === 0 || toolIds.length === 0) return;
    const dbx = tx ?? db;

    // Build all possible combinations
    const assignments: Array<{
      agentId: string;
      toolId: string;
      mcpServerId?: string | null;
      credentialResolutionMode?: CredentialResolutionMode;
    }> = [];

    for (const agentId of agentIds) {
      for (const toolId of toolIds) {
        assignments.push({
          agentId,
          toolId,
          ...(options?.mcpServerId ? { mcpServerId: options.mcpServerId } : {}),
          ...(options?.credentialResolutionMode
            ? { credentialResolutionMode: options.credentialResolutionMode }
            : {}),
        });
      }
    }

    // Check which assignments already exist
    const existingAssignments = await dbx
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
      await dbx
        .insert(schema.agentToolsTable)
        .values(newAssignments)
        .onConflictDoNothing();
    }

    if (
      (options?.mcpServerId || options?.credentialResolutionMode) &&
      existingAssignments.length > 0
    ) {
      await dbx
        .update(schema.agentToolsTable)
        .set({
          ...(options.mcpServerId ? { mcpServerId: options.mcpServerId } : {}),
          ...(options.credentialResolutionMode
            ? { credentialResolutionMode: options.credentialResolutionMode }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(schema.agentToolsTable.agentId, agentIds),
            inArray(schema.agentToolsTable.toolId, toolIds),
          ),
        );
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
   *
   * Classifies every pair against one batched read, then writes every pair that
   * actually changed with a single upsert. The statement count inside a caller's
   * transaction is therefore fixed rather than proportional to the batch.
   */
  static async bulkCreateOrUpdateCredentials(
    assignments: Array<{
      agentId: string;
      toolId: string;
      mcpServerId?: string | null;
      credentialResolutionMode?: CredentialResolutionMode;
    }>,
    organizationId?: string,
    tx?: Transaction,
  ): Promise<
    Array<{
      agentId: string;
      toolId: string;
      status: "created" | "updated" | "unchanged";
    }>
  > {
    if (assignments.length === 0) return [];
    const dbx = tx ?? db;

    // Chunked: the predicate is one `OR` group per pair, two bind params each,
    // and this is the FIRST statement in the function — so an oversized batch
    // would trip Postgres' 65535-parameter cap here, before any of the work
    // below, no matter what the callers cap their request bodies at.
    const existingMap = new Map<
      string,
      {
        mcpServerId: string | null;
        credentialResolutionMode: CredentialResolutionMode;
      }
    >();
    for (
      let offset = 0;
      offset < assignments.length;
      offset += EXISTING_LOOKUP_CHUNK_SIZE
    ) {
      const chunk = assignments.slice(
        offset,
        offset + EXISTING_LOOKUP_CHUNK_SIZE,
      );
      const existing = await dbx
        .select({
          agentId: schema.agentToolsTable.agentId,
          toolId: schema.agentToolsTable.toolId,
          mcpServerId: schema.agentToolsTable.mcpServerId,
          credentialResolutionMode:
            schema.agentToolsTable.credentialResolutionMode,
        })
        .from(schema.agentToolsTable)
        .where(
          or(
            ...chunk.map((a) =>
              and(
                eq(schema.agentToolsTable.agentId, a.agentId),
                eq(schema.agentToolsTable.toolId, a.toolId),
              ),
            ),
          ),
        );
      for (const row of existing) {
        existingMap.set(`${row.agentId}:${row.toolId}`, row);
      }
    }

    // Keyed, not a list: one upsert cannot name the same conflict target twice
    // ("ON CONFLICT DO UPDATE command cannot affect row a second time"), and a
    // body repeating a pair is a client mistake, not a reason to fail the save.
    // Among the occurrences that need a write, the last one wins, mirroring the
    // sequential writes this replaced.
    const toUpsert = new Map<string, (typeof assignments)[number]>();
    const results: Array<{
      agentId: string;
      toolId: string;
      status: "created" | "updated" | "unchanged";
    }> = [];

    for (const assignment of assignments) {
      const key = `${assignment.agentId}:${assignment.toolId}`;
      const existingRow = existingMap.get(key);

      if (!existingRow) {
        toUpsert.set(key, assignment);
        results.push({
          agentId: assignment.agentId,
          toolId: assignment.toolId,
          status: "created",
        });
        continue;
      }

      const needsUpdate =
        existingRow.mcpServerId !== (assignment.mcpServerId ?? null) ||
        existingRow.credentialResolutionMode !==
          normalizeCredentialResolutionMode(assignment);

      if (needsUpdate) {
        // Only changed pairs reach the write. An `unchanged` row included here
        // would have its `updatedAt` bumped by the conflict clause for a write
        // that alters nothing else.
        toUpsert.set(key, assignment);
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

    await AgentToolModel.bulkUpsert([...toUpsert.values()], organizationId, tx);

    return results;
  }

  static async update(
    id: string,
    data: Partial<
      Pick<UpdateAgentTool, "mcpServerId" | "credentialResolutionMode">
    >,
    tx?: Transaction,
  ) {
    const [agentTool] = await (tx ?? db)
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
      .where(
        and(eq(schema.agentToolsTable.id, id), notDeleted(schema.agentsTable)),
      )
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
    organizationId?: string;
    isAgentAdmin?: boolean;
    skipPagination?: boolean;
  }): Promise<PaginatedResult<AgentTool>> {
    const {
      pagination = { limit: 20, offset: 0 },
      sorting,
      filters,
      userId,
      organizationId,
      isAgentAdmin,
      skipPagination = false,
    } = params;
    // Build WHERE conditions
    const whereConditions: SQL[] = [notDeleted(schema.agentsTable)];

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
        await AgentToolModel.getUserAccessibleMcpServerIds(
          userId,
          organizationId,
        );

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

  /** Count of agent↔tool links for agents in the organization (audit footprint). */
  static async countAssignmentsForOrganization(
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ c: count() })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentToolsTable.agentId, schema.agentsTable.id),
      )
      .where(eq(schema.agentsTable.organizationId, organizationId));
    return { agentToolAssignmentCount: Number(row?.c ?? 0) };
  }

  static async findByIdForAudit(
    assignmentId: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [scoped] = await db
      .select({
        assignmentId: schema.agentToolsTable.id,
        agentId: schema.agentToolsTable.agentId,
        agentName: schema.agentsTable.name,
        toolId: schema.toolsTable.id,
        toolName: schema.toolsTable.name,
        mcpServerId: schema.agentToolsTable.mcpServerId,
        credentialResolutionMode:
          schema.agentToolsTable.credentialResolutionMode,
        updatedAt: schema.agentToolsTable.updatedAt,
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
      .where(
        and(
          eq(schema.agentToolsTable.id, assignmentId),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!scoped) return null;

    return AgentToolModel.toAuditSnapshot(scoped);
  }

  /** Used by `/api/agents/:agentId/tools/:toolId` where `resourceId` is the tool id. */
  static async findByAgentAndToolForAudit(
    agentId: string,
    toolId: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [scoped] = await db
      .select({
        assignmentId: schema.agentToolsTable.id,
        agentId: schema.agentToolsTable.agentId,
        agentName: schema.agentsTable.name,
        toolId: schema.toolsTable.id,
        toolName: schema.toolsTable.name,
        mcpServerId: schema.agentToolsTable.mcpServerId,
        credentialResolutionMode:
          schema.agentToolsTable.credentialResolutionMode,
        updatedAt: schema.agentToolsTable.updatedAt,
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
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.agentToolsTable.toolId, toolId),
          eq(schema.agentsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    if (!scoped) return null;

    return AgentToolModel.toAuditSnapshot(scoped);
  }

  private static toAuditSnapshot(scoped: {
    assignmentId: string;
    agentId: string;
    agentName: string;
    toolId: string;
    toolName: string;
    mcpServerId: string | null;
    credentialResolutionMode: string;
    updatedAt: Date;
  }): Record<string, unknown> {
    return {
      id: scoped.assignmentId,
      agentId: scoped.agentId,
      agentName: scoped.agentName,
      toolId: scoped.toolId,
      toolName: scoped.toolName,
      mcpServerId: scoped.mcpServerId ?? null,
      credentialResolutionMode: scoped.credentialResolutionMode,
      updatedAt: scoped.updatedAt.toISOString(),
    };
  }
}

export default AgentToolModel;

/**
 * One agent's binding of a tool: the tool plus the credential identity that
 * makes two rows with the same `toolId` different configurations.
 */
type AgentToolAssignment = {
  toolId: string;
  mcpServerId: string | null;
  credentialResolutionMode: CredentialResolutionMode;
};

/**
 * Pairs per existing-assignment lookup in `bulkCreateOrUpdateCredentials`. Two
 * bind params per pair, so this keeps a chunk an order of magnitude below
 * Postgres' 65535-parameter statement cap.
 */
const EXISTING_LOOKUP_CHUNK_SIZE = 2000;

function normalizeCredentialResolutionMode(params: {
  resolveAtCallTime?: boolean;
  credentialResolutionMode?: CredentialResolutionMode | null;
}) {
  if (params.credentialResolutionMode) {
    return params.credentialResolutionMode;
  }

  return params.resolveAtCallTime ? "dynamic" : "static";
}
