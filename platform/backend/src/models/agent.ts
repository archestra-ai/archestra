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
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  Agent,
  InsertAgent,
  PaginationQuery,
  SortingQuery,
  UpdateAgent,
} from "@/types";
import AgentLabelModel from "./agent-label";
import AgentTeamModel from "./agent-team";
import ToolModel from "./tool";

class AgentModel {
  static async create({
    teams,
    labels,
    ...agent
  }: InsertAgent): Promise<Agent> {
    const [createdAgent] = await db
      .insert(schema.agentsTable)
      .values(agent)
      .returning();

    // Assign teams to the agent if provided
    if (teams && teams.length > 0) {
      await AgentTeamModel.assignTeamsToAgent(createdAgent.id, teams);
    }

    // Assign labels to the agent if provided
    if (labels && labels.length > 0) {
      await AgentLabelModel.syncAgentLabels(createdAgent.id, labels);
    }

    // Assign Archestra built-in tools to the agent
    await ToolModel.assignArchestraToolsToAgent(createdAgent.id);

    // Get team details for the created agent
    const teamDetails =
      teams && teams.length > 0
        ? await AgentTeamModel.getTeamDetailsForAgent(createdAgent.id)
        : [];

    return {
      ...createdAgent,
      tools: [],
      teams: teamDetails,
      labels: await AgentLabelModel.getLabelsForAgent(createdAgent.id),
    };
  }

  static async findAll(
    userId?: string,
    isAgentAdmin?: boolean,
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
   * Find all agents with pagination, sorting, and filtering support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    filters?: { name?: string },
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
        .where(sql`NOT ${schema.toolsTable.name} LIKE 'archestra__%'`)
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
        schema.toolsTable,
        eq(schema.agentsTable.id, schema.toolsTable.agentId),
      )
      .where(eq(schema.agentsTable.id, id));

    if (rows.length === 0) {
      return null;
    }

    const agent = rows[0].agents;
    const tools = rows.map((row) => row.tools).filter((tool) => tool !== null);

    const teams = await AgentTeamModel.getTeamDetailsForAgent(id);
    const labels = await AgentLabelModel.getLabelsForAgent(id);

    return {
      ...agent,
      tools,
      teams,
      labels,
    };
  }

  static async getAgentOrCreateDefault(name?: string): Promise<Agent> {
    // First, try to find an agent with isDefault=true
    const rows = await db
      .select()
      .from(schema.agentsTable)
      .leftJoin(
        schema.toolsTable,
        eq(schema.agentsTable.id, schema.toolsTable.agentId),
      )
      .where(eq(schema.agentsTable.isDefault, true));

    if (rows.length > 0) {
      // Default agent exists, return it
      const agent = rows[0].agents;
      const tools = rows
        .map((row) => row.tools)
        .filter((tool) => tool !== null);

      return {
        ...agent,
        tools,
        teams: await AgentTeamModel.getTeamDetailsForAgent(agent.id),
        labels: await AgentLabelModel.getLabelsForAgent(agent.id),
      };
    }

    // No default agent exists, create one
    return AgentModel.create({
      name: name || DEFAULT_PROFILE_NAME,
      isDefault: true,
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

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default AgentModel;
