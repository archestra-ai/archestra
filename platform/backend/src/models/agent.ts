import { DEFAULT_PROFILE_NAME, isArchestraMcpServerTool } from "@shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  min,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type { AgentHistoryEntry } from "@/database/schemas/agent";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  Agent,
  AgentVersionsResponse,
  InsertAgent,
  PaginationQuery,
  SortingQuery,
  UpdateAgent,
} from "@/types";
import type { ChatOpsProviderType } from "@/types/chatops";
import AgentLabelModel from "./agent-label";
import AgentTeamModel from "./agent-team";
import ToolModel from "./tool";

class AgentModel {
  static async create({
    teams,
    labels,
    ...agent
  }: InsertAgent): Promise<Agent> {
    // Auto-assign organizationId if not provided
    let organizationId = agent.organizationId;
    if (!organizationId) {
      const [firstOrg] = await db
        .select({ id: schema.organizationsTable.id })
        .from(schema.organizationsTable)
        .limit(1);
      organizationId = firstOrg?.id || "";
    }

    const [createdAgent] = await db
      .insert(schema.agentsTable)
      .values({ ...agent, organizationId })
      .returning();

    // Assign teams to the agent if provided
    if (teams && teams.length > 0) {
      await AgentTeamModel.assignTeamsToAgent(createdAgent.id, teams);
    }

    // Assign labels to the agent if provided
    if (labels && labels.length > 0) {
      await AgentLabelModel.syncAgentLabels(createdAgent.id, labels);
    }

    // Assign default Archestra tools (artifact_write, todo_write) to new profiles
    await ToolModel.assignDefaultArchestraToolsToAgent(createdAgent.id);

    // For internal agents, create a delegation tool so other agents can delegate to this one
    if (createdAgent.agentType === "agent") {
      await ToolModel.findOrCreateDelegationTool(createdAgent.id);
    }

    // Get team details and tools for the created agent
    const [teamDetails, assignedTools] = await Promise.all([
      teams && teams.length > 0
        ? AgentTeamModel.getTeamDetailsForAgent(createdAgent.id)
        : Promise.resolve([]),
      db
        .select({ tool: schema.toolsTable })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(eq(schema.agentToolsTable.agentId, createdAgent.id)),
    ]);

    return {
      ...createdAgent,
      tools: assignedTools.map((row) => row.tool),
      teams: teamDetails,
      labels: await AgentLabelModel.getLabelsForAgent(createdAgent.id),
    };
  }

  /**
   * Find all agents with optional filtering by agentType
   */
  static async findAll(
    userId?: string,
    isAgentAdmin?: boolean,
    options?: { agentType?: "mcp_gateway" | "agent" },
  ): Promise<Agent[]> {
    let query = db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentToolsTable,
        eq(schema.agentsTable.id, schema.agentToolsTable.agentId),
      )
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .$dynamic();

    // Build where conditions
    const whereConditions: SQL[] = [];

    // Filter by agentType if specified
    if (options?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, options.agentType));
    }

    // Apply access control filtering for non-agent admins
    if (userId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      whereConditions.push(inArray(schema.agentsTable.id, accessibleAgentIds));
    }

    // Apply all where conditions if any exist
    if (whereConditions.length > 0) {
      query = query.where(and(...whereConditions));
    }

    const rows = await query;

    // Group the flat join results by agent
    const agentsMap = new Map<string, Agent>();

    for (const row of rows) {
      const agent = row.agents;
      const tool = row.tools;

      if (!agentsMap.has(agent.id)) {
        agentsMap.set(agent.id, {
          ...agent,
          tools: [],
          teams: [] as Array<{ id: string; name: string }>,
          labels: [],
        });
      }

      // Add tool if it exists (leftJoin returns null for agents with no tools)
      if (tool) {
        agentsMap.get(agent.id)?.tools.push(tool);
      }
    }

    const agents = Array.from(agentsMap.values());
    const agentIds = agents.map((agent) => agent.id);

    // Populate teams and labels for all agents with bulk queries to avoid N+1
    const [teamsMap, labelsMap] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
    ]);

    // Assign teams and labels to each agent
    for (const agent of agents) {
      agent.teams = teamsMap.get(agent.id) || [];
      agent.labels = labelsMap.get(agent.id) || [];
    }

    return agents;
  }

  /**
   * Find all agents for an organization with optional filtering by agentType
   */
  static async findByOrganizationId(
    organizationId: string,
    options?: { agentType?: "mcp_gateway" | "agent" },
  ): Promise<Agent[]> {
    const whereConditions: SQL[] = [
      eq(schema.agentsTable.organizationId, organizationId),
    ];

    if (options?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, options.agentType));
    }

    const agents = await db
      .select()
      .from(schema.agentsTable)
      .where(and(...whereConditions))
      .orderBy(desc(schema.agentsTable.createdAt));

    // Get tools, teams, and labels for all agents
    const agentIds = agents.map((a) => a.id);

    if (agentIds.length === 0) {
      return [];
    }

    const [teamsMap, labelsMap, toolsResult] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
      db
        .select({
          agentId: schema.agentToolsTable.agentId,
          tool: schema.toolsTable,
        })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(inArray(schema.agentToolsTable.agentId, agentIds)),
    ]);

    // Group tools by agent
    const toolsByAgent = new Map<
      string,
      (typeof schema.toolsTable.$inferSelect)[]
    >();
    for (const row of toolsResult) {
      const existing = toolsByAgent.get(row.agentId) || [];
      existing.push(row.tool);
      toolsByAgent.set(row.agentId, existing);
    }

    return agents.map((agent) => ({
      ...agent,
      tools: toolsByAgent.get(agent.id) || [],
      teams: teamsMap.get(agent.id) || [],
      labels: labelsMap.get(agent.id) || [],
    }));
  }

  /**
   * Find all agents for an organization filtered by accessible agent IDs
   * Returns only agents the user has access to via team membership
   */
  static async findByOrganizationIdAndAccessibleTeams(
    organizationId: string,
    accessibleAgentIds: string[],
    options?: { agentType?: "mcp_gateway" | "agent" },
  ): Promise<Agent[]> {
    if (accessibleAgentIds.length === 0) {
      return [];
    }

    const whereConditions: SQL[] = [
      eq(schema.agentsTable.organizationId, organizationId),
      inArray(schema.agentsTable.id, accessibleAgentIds),
    ];

    if (options?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, options.agentType));
    }

    const agents = await db
      .select()
      .from(schema.agentsTable)
      .where(and(...whereConditions))
      .orderBy(desc(schema.agentsTable.createdAt));

    const agentIds = agents.map((a) => a.id);

    if (agentIds.length === 0) {
      return [];
    }

    const [teamsMap, labelsMap, toolsResult] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
      db
        .select({
          agentId: schema.agentToolsTable.agentId,
          tool: schema.toolsTable,
        })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(inArray(schema.agentToolsTable.agentId, agentIds)),
    ]);

    // Group tools by agent
    const toolsByAgent = new Map<
      string,
      (typeof schema.toolsTable.$inferSelect)[]
    >();
    for (const row of toolsResult) {
      const existing = toolsByAgent.get(row.agentId) || [];
      existing.push(row.tool);
      toolsByAgent.set(row.agentId, existing);
    }

    return agents.map((agent) => ({
      ...agent,
      tools: toolsByAgent.get(agent.id) || [],
      teams: teamsMap.get(agent.id) || [],
      labels: labelsMap.get(agent.id) || [],
    }));
  }

  /**
   * Find all internal agents that allow a specific chatops provider.
   * Used to populate the agent selection dropdown in Teams/Slack/etc.
   * Returns only internal agents where the provider is in the allowedChatops array.
   */
  static async findByAllowedChatopsProvider(
    provider: ChatOpsProviderType,
  ): Promise<Pick<Agent, "id" | "name">[]> {
    const agents = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.agentType, "agent"),
          sql`${schema.agentsTable.allowedChatops} @> ${JSON.stringify([provider])}::jsonb`,
        ),
      )
      .orderBy(asc(schema.agentsTable.name));

    return agents;
  }

  /**
   * Find all agents with pagination, sorting, and filtering support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    filters?: { name?: string; agentType?: "mcp_gateway" | "agent" },
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<PaginatedResult<Agent>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = AgentModel.getOrderByClause(sorting);

    // Build where clause for filters and access control
    const whereConditions: SQL[] = [];

    // Add name filter if provided
    if (filters?.name) {
      whereConditions.push(ilike(schema.agentsTable.name, `%${filters.name}%`));
    }

    // Add agentType filter if provided
    if (filters?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, filters.agentType));
    }

    // Apply access control filtering for non-agent admins
    if (userId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        userId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }

      whereConditions.push(inArray(schema.agentsTable.id, accessibleAgentIds));
    }

    const whereClause =
      whereConditions.length > 0 ? and(...whereConditions) : undefined;

    // Step 1: Get paginated agent IDs with proper sorting
    // This ensures LIMIT/OFFSET applies to agents, not to joined rows with tools
    let query = db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(whereClause)
      .$dynamic();

    const direction = sorting?.sortDirection === "asc" ? asc : desc;

    // Add sorting-specific joins and order by
    if (sorting?.sortBy === "toolsCount") {
      const toolsCountSubquery = db
        .select({
          agentId: schema.agentToolsTable.agentId,
          toolsCount: count(schema.agentToolsTable.toolId).as("toolsCount"),
        })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        // Double backslash needed: JS consumes one level, SQL gets the other
        .where(
          sql`NOT ${schema.toolsTable.name} LIKE 'archestra\\_\\_%' ESCAPE '\\'`,
        )
        .groupBy(schema.agentToolsTable.agentId)
        .as("toolsCounts");

      query = query
        .leftJoin(
          toolsCountSubquery,
          eq(schema.agentsTable.id, toolsCountSubquery.agentId),
        )
        .orderBy(direction(sql`COALESCE(${toolsCountSubquery.toolsCount}, 0)`));
    } else if (sorting?.sortBy === "team") {
      const teamNameSubquery = db
        .select({
          agentId: schema.agentTeamsTable.agentId,
          teamName: min(schema.teamsTable.name).as("teamName"),
        })
        .from(schema.agentTeamsTable)
        .leftJoin(
          schema.teamsTable,
          eq(schema.agentTeamsTable.teamId, schema.teamsTable.id),
        )
        .groupBy(schema.agentTeamsTable.agentId)
        .as("teamNames");

      query = query
        .leftJoin(
          teamNameSubquery,
          eq(schema.agentsTable.id, teamNameSubquery.agentId),
        )
        .orderBy(direction(sql`COALESCE(${teamNameSubquery.teamName}, '')`));
    } else {
      query = query.orderBy(orderByClause);
    }

    const sortedAgents = await query
      .limit(pagination.limit)
      .offset(pagination.offset);

    const sortedAgentIds = sortedAgents.map((a) => a.id);

    // If no agents match, return early
    if (sortedAgentIds.length === 0) {
      const [{ total }] = await db
        .select({ total: count() })
        .from(schema.agentsTable)
        .where(whereClause);
      return createPaginatedResult([], Number(total), pagination);
    }

    // Step 2: Get full agent data with tools for the paginated agent IDs
    const [agentsData, [{ total: totalResult }]] = await Promise.all([
      db
        .select()
        .from(schema.agentsTable)
        .leftJoin(
          schema.agentToolsTable,
          eq(schema.agentsTable.id, schema.agentToolsTable.agentId),
        )
        .leftJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(inArray(schema.agentsTable.id, sortedAgentIds)),
      db.select({ total: count() }).from(schema.agentsTable).where(whereClause),
    ]);

    // Sort in memory to maintain the order from the sorted query
    const orderMap = new Map(sortedAgentIds.map((id, index) => [id, index]));
    agentsData.sort(
      (a, b) =>
        (orderMap.get(a.agents.id) ?? 0) - (orderMap.get(b.agents.id) ?? 0),
    );

    // Group the flat join results by agent
    const agentsMap = new Map<string, Agent>();

    for (const row of agentsData) {
      const agent = row.agents;
      const tool = row.tools;

      if (!agentsMap.has(agent.id)) {
        agentsMap.set(agent.id, {
          ...agent,
          tools: [],
          teams: [] as Array<{ id: string; name: string }>,
          labels: [],
        });
      }

      // Add tool if it exists and is not an Archestra MCP tool (leftJoin returns null for agents with no tools)
      if (tool && !isArchestraMcpServerTool(tool.name)) {
        agentsMap.get(agent.id)?.tools.push(tool);
      }
    }

    const agents = Array.from(agentsMap.values());
    const agentIds = agents.map((agent) => agent.id);

    // Populate teams and labels for all agents with bulk queries to avoid N+1
    const [teamsMap, labelsMap] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
    ]);

    // Assign teams and labels to each agent
    for (const agent of agents) {
      agent.teams = teamsMap.get(agent.id) || [];
      agent.labels = labelsMap.get(agent.id) || [];
    }

    return createPaginatedResult(agents, Number(totalResult), pagination);
  }

  /**
   * Helper to get the appropriate ORDER BY clause based on sorting params
   */
  private static getOrderByClause(sorting?: SortingQuery) {
    const direction = sorting?.sortDirection === "asc" ? asc : desc;

    switch (sorting?.sortBy) {
      case "name":
        return direction(schema.agentsTable.name);
      case "createdAt":
        return direction(schema.agentsTable.createdAt);
      case "toolsCount":
      case "team":
        // toolsCount and team sorting use a separate query path (see lines 168-267).
        // This fallback should never be reached for these sort types.
        return direction(schema.agentsTable.createdAt); // Fallback
      default:
        // Default: newest first
        return desc(schema.agentsTable.createdAt);
    }
  }

  /**
   * Check if an agent exists without loading related data (teams, labels, tools).
   * Use this for validation to avoid N+1 queries in bulk operations.
   */
  static async exists(id: string): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id))
      .limit(1);

    return result !== undefined;
  }

  /**
   * Batch check if multiple agents exist.
   * Returns a Set of agent IDs that exist.
   */
  static async existsBatch(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }

    const results = await db
      .select({ id: schema.agentsTable.id })
      .from(schema.agentsTable)
      .where(inArray(schema.agentsTable.id, ids));

    return new Set(results.map((r) => r.id));
  }

  static async findById(
    id: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<Agent | null> {
    // Check access control for non-agent admins
    if (userId && !isAgentAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        id,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentToolsTable,
        eq(schema.agentsTable.id, schema.agentToolsTable.agentId),
      )
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.agentsTable.id, id));

    if (rows.length === 0) {
      return null;
    }

    const agent = rows[0].agents;
    const tools = rows
      .map((row) => row.tools)
      .filter(
        (tool): tool is NonNullable<typeof tool> =>
          tool !== null && !isArchestraMcpServerTool(tool.name),
      );

    const teams = await AgentTeamModel.getTeamDetailsForAgent(id);
    const labels = await AgentLabelModel.getLabelsForAgent(id);

    return {
      ...agent,
      tools,
      teams,
      labels,
    };
  }

  static async getAgentOrCreateDefault(
    name?: string,
    organizationId?: string,
  ): Promise<Agent> {
    // First, try to find an agent with isDefault=true
    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.agentToolsTable,
        eq(schema.agentsTable.id, schema.agentToolsTable.agentId),
      )
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.agentsTable.isDefault, true));

    if (rows.length > 0) {
      // Default agent exists, return it
      const agent = rows[0].agents;
      const tools = rows
        .map((row) => row.tools)
        .filter(
          (tool): tool is NonNullable<typeof tool> =>
            tool !== null && !isArchestraMcpServerTool(tool.name),
        );

      return {
        ...agent,
        tools,
        teams: await AgentTeamModel.getTeamDetailsForAgent(agent.id),
        labels: await AgentLabelModel.getLabelsForAgent(agent.id),
      };
    }

    // No default agent exists, create one
    // If organizationId not provided, use first organization
    let orgId = organizationId;
    if (!orgId) {
      const [firstOrg] = await db
        .select({ id: schema.organizationsTable.id })
        .from(schema.organizationsTable)
        .limit(1);
      orgId = firstOrg?.id;
    }

    return AgentModel.create({
      name: name || DEFAULT_PROFILE_NAME,
      isDefault: true,
      organizationId: orgId || "",
      teams: [],
      labels: [],
    });
  }

  static async update(
    id: string,
    { teams, labels, ...agent }: Partial<UpdateAgent>,
  ): Promise<Agent | null> {
    let updatedAgent: Omit<Agent, "tools" | "teams" | "labels"> | undefined;

    // If setting isDefault to true, unset all other agents' isDefault first
    if (agent.isDefault === true) {
      await db
        .update(schema.agentsTable)
        .set({ isDefault: false })
        .where(eq(schema.agentsTable.isDefault, true));
    }

    // Only update agent table if there are fields to update
    if (Object.keys(agent).length > 0) {
      [updatedAgent] = await db
        .update(schema.agentsTable)
        .set(agent)
        .where(eq(schema.agentsTable.id, id))
        .returning();

      if (!updatedAgent) {
        return null;
      }
    } else {
      // If only updating teams, fetch the existing agent
      const [existingAgent] = await db
        .select()
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, id));

      if (!existingAgent) {
        return null;
      }

      updatedAgent = existingAgent;
    }

    // Sync team assignments if teams is provided
    if (teams !== undefined) {
      await AgentTeamModel.syncAgentTeams(id, teams);
    }

    // Sync label assignments if labels is provided
    if (labels !== undefined) {
      await AgentLabelModel.syncAgentLabels(id, labels);
    }

    // Fetch the tools for the updated agent
    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.agentId, updatedAgent.id));

    // Fetch current teams and labels
    const currentTeams = await AgentTeamModel.getTeamDetailsForAgent(id);
    const currentLabels = await AgentLabelModel.getLabelsForAgent(id);

    return {
      ...updatedAgent,
      tools,
      teams: currentTeams,
      labels: currentLabels,
    };
  }

  /**
   * Update an internal agent with versioning - creates a new version by pushing current to history.
   * Only applies to internal agents (agentType='agent').
   * The agent ID stays the same (no FK migration needed).
   */
  static async updateWithVersion(
    id: string,
    input: Partial<UpdateAgent>,
  ): Promise<Agent | null> {
    const agent = await AgentModel.findById(id);
    if (!agent || agent.agentType !== "agent") {
      return null;
    }

    // Create history entry from current state
    const historyEntry: AgentHistoryEntry = {
      version: agent.promptVersion || 1,
      userPrompt: agent.userPrompt || null,
      systemPrompt: agent.systemPrompt || null,
      createdAt: agent.updatedAt.toISOString(),
    };

    // Update in-place with new version
    const [updated] = await db
      .update(schema.agentsTable)
      .set({
        name: input.name ?? agent.name,
        systemPrompt: input.systemPrompt ?? agent.systemPrompt,
        userPrompt: input.userPrompt ?? agent.userPrompt,
        allowedChatops: input.allowedChatops ?? agent.allowedChatops,
        promptVersion: (agent.promptVersion || 1) + 1,
        promptHistory: sql`${schema.agentsTable.promptHistory} || ${JSON.stringify([historyEntry])}::jsonb`,
      })
      .where(eq(schema.agentsTable.id, id))
      .returning();

    if (!updated) {
      return null;
    }

    // Sync tool names if name changed
    if (input.name && input.name !== agent.name) {
      await ToolModel.syncDelegationToolNames(id, input.name);
    }

    return AgentModel.findById(id);
  }

  /**
   * Rollback an internal agent to a specific version number.
   * Copies content from history entry to current fields and increments version.
   * Only applies to internal agents (agentType='agent').
   */
  static async rollback(
    id: string,
    targetVersion: number,
  ): Promise<Agent | null> {
    const agent = await AgentModel.findById(id);
    if (!agent || agent.agentType !== "agent") {
      return null;
    }

    // Find the target version in history
    const targetEntry = agent.promptHistory?.find(
      (h) => h.version === targetVersion,
    );
    if (!targetEntry) {
      return null;
    }

    // Create history entry from current state before rollback
    const historyEntry: AgentHistoryEntry = {
      version: agent.promptVersion || 1,
      userPrompt: agent.userPrompt || null,
      systemPrompt: agent.systemPrompt || null,
      createdAt: agent.updatedAt.toISOString(),
    };

    // Rollback by copying target content to current and incrementing version
    const [updated] = await db
      .update(schema.agentsTable)
      .set({
        userPrompt: targetEntry.userPrompt,
        systemPrompt: targetEntry.systemPrompt,
        promptVersion: (agent.promptVersion || 1) + 1,
        promptHistory: sql`${schema.agentsTable.promptHistory} || ${JSON.stringify([historyEntry])}::jsonb`,
      })
      .where(eq(schema.agentsTable.id, id))
      .returning();

    if (!updated) {
      return null;
    }

    return AgentModel.findById(id);
  }

  /**
   * Get all versions of an internal agent (current + history).
   * Only applies to internal agents (agentType='agent').
   */
  static async getVersions(
    agentId: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<AgentVersionsResponse | null> {
    const agent = await AgentModel.findById(agentId, userId, isAgentAdmin);
    if (!agent || agent.agentType !== "agent") {
      return null;
    }

    return {
      current: agent,
      history: agent.promptHistory || [],
    };
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default AgentModel;
