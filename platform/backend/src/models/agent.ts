import {
  DEFAULT_LLM_PROXY_NAME,
  DEFAULT_MCP_GATEWAY_NAME,
  type PaginationQuery,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  min,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { clearChatMcpClient } from "@/clients/chat-mcp-client";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import logger from "@/logging";
import type {
  Agent,
  AgentScope,
  AgentScopeFilter,
  AgentType,
  InsertAgent,
  SortingQuery,
  UpdateAgent,
} from "@/types";
import AgentConnectorAssignmentModel from "./agent-connector-assignment";
import AgentKnowledgeBaseModel from "./agent-knowledge-base";
import AgentLabelModel from "./agent-label";
import AgentSuggestedPromptModel from "./agent-suggested-prompt";
import AgentTeamModel from "./agent-team";
import MemberModel from "./member";
import ToolModel from "./tool";

class AgentModel {
  /**
   * Populate authorName on agents by looking up user names from the user table.
   */
  private static async populateAuthorNames(agents: Agent[]): Promise<void> {
    const authorIds = [
      ...new Set(
        agents.map((a) => a.authorId).filter((id): id is string => id !== null),
      ),
    ];
    if (authorIds.length === 0) return;

    const users = await db
      .select({ id: schema.usersTable.id, name: schema.usersTable.name })
      .from(schema.usersTable)
      .where(inArray(schema.usersTable.id, authorIds));

    const nameMap = new Map(users.map((u) => [u.id, u.name]));
    for (const agent of agents) {
      agent.authorName = agent.authorId
        ? (nameMap.get(agent.authorId) ?? null)
        : null;
    }
  }

  /**
   * Populate knowledgeBaseIds on agents via batch lookup from the junction table.
   */
  private static async populateKnowledgeBaseIds(
    agents: Agent[],
  ): Promise<void> {
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) return;

    const kbMap =
      await AgentKnowledgeBaseModel.getKnowledgeBaseIdsForAgents(agentIds);
    for (const agent of agents) {
      agent.knowledgeBaseIds = kbMap.get(agent.id) ?? [];
    }
  }

  /**
   * Populate suggestedPrompts on agents via batch lookup.
   */
  private static async populateSuggestedPrompts(
    agents: Agent[],
  ): Promise<void> {
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) return;

    const promptsMap = await AgentSuggestedPromptModel.getForAgents(agentIds);
    for (const agent of agents) {
      agent.suggestedPrompts = promptsMap.get(agent.id) ?? [];
    }
  }

  /**
   * Populate connectorIds on agents via batch lookup from the junction table.
   */
  private static async populateConnectorIds(agents: Agent[]): Promise<void> {
    const agentIds = agents.map((a) => a.id);
    if (agentIds.length === 0) return;

    const connectorMap =
      await AgentConnectorAssignmentModel.getConnectorIdsForAgents(agentIds);
    for (const agent of agents) {
      agent.connectorIds = connectorMap.get(agent.id) ?? [];
    }
  }

  static async create(
    {
      teams,
      labels,
      knowledgeBaseIds,
      connectorIds,
      suggestedPrompts,
      ...agent
    }: InsertAgent,
    authorId?: string,
  ): Promise<Agent> {
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
      .values({ ...agent, organizationId, ...(authorId && { authorId }) })
      .returning();

    // Assign teams to the agent if provided
    if (teams && teams.length > 0) {
      await AgentTeamModel.assignTeamsToAgent(createdAgent.id, teams);
    }

    // Assign labels to the agent if provided
    if (labels && labels.length > 0) {
      await AgentLabelModel.syncAgentLabels(createdAgent.id, labels);
    }

    // Assign knowledge bases if provided
    if (knowledgeBaseIds && knowledgeBaseIds.length > 0) {
      await AgentKnowledgeBaseModel.syncForAgent(
        createdAgent.id,
        knowledgeBaseIds,
      );
    }

    // Assign connectors if provided
    if (connectorIds && connectorIds.length > 0) {
      await AgentConnectorAssignmentModel.syncForAgent(
        createdAgent.id,
        connectorIds,
      );
    }

    // Sync suggested prompts if provided
    if (suggestedPrompts && suggestedPrompts.length > 0) {
      await AgentSuggestedPromptModel.syncForAgent(
        createdAgent.id,
        suggestedPrompts,
      );
    }

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
      knowledgeBaseIds: knowledgeBaseIds ?? [],
      connectorIds: connectorIds ?? [],
      suggestedPrompts: suggestedPrompts ?? [],
    };
  }

  /**
   * Find all agents with optional filtering by agentType or agentTypes
   */
  static async findAll(
    userId?: string,
    isAgentAdmin?: boolean,
    options?: {
      agentType?: AgentType;
      agentTypes?: AgentType[];
      excludeBuiltIn?: boolean;
      scope?: AgentScope;
    },
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

    // Filter by agentTypes if specified (array of types)
    if (options?.agentTypes && options.agentTypes.length > 0) {
      whereConditions.push(
        inArray(schema.agentsTable.agentType, options.agentTypes),
      );
    }
    // Filter by agentType if specified (single type, backwards compatible)
    else if (options?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, options.agentType));
    }

    // Exclude built-in agents when explicitly requested or when user is not an admin
    if (options?.excludeBuiltIn || !isAgentAdmin) {
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    }

    // Filter by scope if specified
    if (options?.scope) {
      whereConditions.push(eq(schema.agentsTable.scope, options.scope));
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
          knowledgeBaseIds: [],
          connectorIds: [],
          suggestedPrompts: [],
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

    await Promise.all([
      AgentModel.populateAuthorNames(agents),
      AgentModel.populateKnowledgeBaseIds(agents),
      AgentModel.populateConnectorIds(agents),
      AgentModel.populateSuggestedPrompts(agents),
    ]);

    return agents;
  }

  /**
   * Find all agents for an organization with optional filtering by agentType
   */
  static async findByOrganizationId(
    organizationId: string,
    options?: { agentType?: AgentType },
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

    const [
      teamsMap,
      labelsMap,
      kbMap,
      connectorMap,
      suggestedPromptsMap,
      toolsResult,
    ] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
      AgentKnowledgeBaseModel.getKnowledgeBaseIdsForAgents(agentIds),
      AgentConnectorAssignmentModel.getConnectorIdsForAgents(agentIds),
      AgentSuggestedPromptModel.getForAgents(agentIds),
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
      knowledgeBaseIds: kbMap.get(agent.id) || [],
      connectorIds: connectorMap.get(agent.id) || [],
      suggestedPrompts: suggestedPromptsMap.get(agent.id) || [],
    }));
  }

  /**
   * Find all agents for an organization filtered by accessible agent IDs
   * Returns only agents the user has access to via team membership
   */
  static async findByOrganizationIdAndAccessibleTeams(
    organizationId: string,
    accessibleAgentIds: string[],
    options?: { agentType?: AgentType },
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

    const [
      teamsMap,
      labelsMap,
      kbMap,
      connectorMap,
      suggestedPromptsMap,
      toolsResult,
    ] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgents(agentIds),
      AgentLabelModel.getLabelsForAgents(agentIds),
      AgentKnowledgeBaseModel.getKnowledgeBaseIdsForAgents(agentIds),
      AgentConnectorAssignmentModel.getConnectorIdsForAgents(agentIds),
      AgentSuggestedPromptModel.getForAgents(agentIds),
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
      knowledgeBaseIds: kbMap.get(agent.id) || [],
      connectorIds: connectorMap.get(agent.id) || [],
      suggestedPrompts: suggestedPromptsMap.get(agent.id) || [],
    }));
  }

  /**
   * Find all non-personal internal agents (excluding built-in agents).
   * Used to populate the agent selection dropdown in Teams/Slack/etc channels.
   * Personal agents are excluded because channels are shared — only org/team
   * scoped agents make sense for channel assignment.
   */
  static async findAllInternalAgents(): Promise<
    Pick<Agent, "id" | "name" | "scope" | "authorId">[]
  > {
    const agents = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        scope: schema.agentsTable.scope,
        authorId: schema.agentsTable.authorId,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          ne(schema.agentsTable.scope, "personal"),
        ),
      )
      .orderBy(asc(schema.agentsTable.name));

    return agents;
  }

  /**
   * Find all internal agents including personal ones authored by a specific user.
   * Used for DM agent selection where personal agents of the current user are allowed.
   */
  static async findAllInternalAgentsIncludingPersonal(
    userId: string,
  ): Promise<Pick<Agent, "id" | "name" | "scope" | "authorId">[]> {
    const agents = await db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
        scope: schema.agentsTable.scope,
        authorId: schema.agentsTable.authorId,
      })
      .from(schema.agentsTable)
      .where(
        and(
          eq(schema.agentsTable.agentType, "agent"),
          eq(schema.agentsTable.builtIn, false),
          or(
            ne(schema.agentsTable.scope, "personal"),
            and(
              eq(schema.agentsTable.scope, "personal"),
              eq(schema.agentsTable.authorId, userId),
            ),
          ),
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
    filters?: {
      name?: string;
      agentType?: AgentType;
      agentTypes?: AgentType[];
      scope?: AgentScopeFilter;
      teamIds?: string[];
      authorIds?: string[];
      excludeAuthorIds?: string[];
      labels?: Record<string, string[]>;
    },
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

    // Add agentTypes filter if provided (array of types)
    if (filters?.agentTypes && filters.agentTypes.length > 0) {
      whereConditions.push(
        inArray(schema.agentsTable.agentType, filters.agentTypes),
      );
    }
    // Add agentType filter if provided (single type, backwards compatible)
    else if (filters?.agentType !== undefined) {
      whereConditions.push(eq(schema.agentsTable.agentType, filters.agentType));
    }

    // Add scope filter if provided
    if (filters?.scope === "built_in") {
      whereConditions.push(eq(schema.agentsTable.builtIn, true));
    } else if (filters?.scope === "personal") {
      whereConditions.push(eq(schema.agentsTable.scope, "personal"));
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    } else if (filters?.scope === "team") {
      whereConditions.push(eq(schema.agentsTable.scope, "team"));
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    } else if (filters?.scope === "org") {
      whereConditions.push(eq(schema.agentsTable.scope, "org"));
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    } else {
      // No scope filter: exclude built-in agents by default.
      // Built-in agents are only shown when explicitly filtered via scope=built_in.
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    }

    // Hide built-in agents from non-admin users
    if (!isAgentAdmin) {
      whereConditions.push(eq(schema.agentsTable.builtIn, false));
    }

    // Add teamIds filter if provided (filter team-scoped agents by specific teams)
    if (filters?.teamIds && filters.teamIds.length > 0) {
      const agentIdsInTeams = await db
        .selectDistinct({ agentId: schema.agentTeamsTable.agentId })
        .from(schema.agentTeamsTable)
        .where(inArray(schema.agentTeamsTable.teamId, filters.teamIds));

      const ids = agentIdsInTeams.map((r) => r.agentId);
      if (ids.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }
      whereConditions.push(inArray(schema.agentsTable.id, ids));
    }

    // Add authorIds filter if provided (filter personal agents by owner)
    if (filters?.authorIds && filters.authorIds.length > 0) {
      whereConditions.push(
        inArray(schema.agentsTable.authorId, filters.authorIds),
      );
    }

    // Exclude specific authors if provided
    if (filters?.excludeAuthorIds && filters.excludeAuthorIds.length > 0) {
      const condition = or(
        isNull(schema.agentsTable.authorId),
        notInArray(schema.agentsTable.authorId, filters.excludeAuthorIds),
      );
      if (condition) {
        whereConditions.push(condition);
      }
    }

    // Add label filters if provided (AND across keys, OR within values)
    if (filters?.labels) {
      for (const [key, values] of Object.entries(filters.labels)) {
        const agentIdsWithLabel = await db
          .selectDistinct({ agentId: schema.agentLabelsTable.agentId })
          .from(schema.agentLabelsTable)
          .innerJoin(
            schema.labelKeysTable,
            eq(schema.agentLabelsTable.keyId, schema.labelKeysTable.id),
          )
          .innerJoin(
            schema.labelValuesTable,
            eq(schema.agentLabelsTable.valueId, schema.labelValuesTable.id),
          )
          .where(
            and(
              eq(schema.labelKeysTable.key, key),
              inArray(schema.labelValuesTable.value, values),
            ),
          );

        const ids = agentIdsWithLabel.map((r) => r.agentId);
        if (ids.length === 0) {
          return createPaginatedResult([], 0, pagination);
        }
        whereConditions.push(inArray(schema.agentsTable.id, ids));
      }
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
    if (sorting?.sortBy === "subagentsCount") {
      const subagentsCountSubquery = db
        .select({
          agentId: schema.agentToolsTable.agentId,
          subagentsCount: count(schema.agentToolsTable.toolId).as(
            "subagentsCount",
          ),
        })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(sql`${schema.toolsTable.delegateToAgentId} IS NOT NULL`)
        .groupBy(schema.agentToolsTable.agentId)
        .as("subagentsCounts");

      query = query
        .leftJoin(
          subagentsCountSubquery,
          eq(schema.agentsTable.id, subagentsCountSubquery.agentId),
        )
        .orderBy(
          direction(sql`COALESCE(${subagentsCountSubquery.subagentsCount}, 0)`),
        );
    } else if (sorting?.sortBy === "toolsCount") {
      const toolsCountSubquery = db
        .select({
          agentId: schema.agentToolsTable.agentId,
          toolsCount: count(schema.agentToolsTable.toolId).as("toolsCount"),
        })
        .from(schema.agentToolsTable)
        .groupBy(schema.agentToolsTable.agentId)
        .as("toolsCounts");

      query = query
        .leftJoin(
          toolsCountSubquery,
          eq(schema.agentsTable.id, toolsCountSubquery.agentId),
        )
        .orderBy(direction(sql`COALESCE(${toolsCountSubquery.toolsCount}, 0)`));
    } else if (sorting?.sortBy === "knowledgeSourcesCount") {
      const knowledgeSourcesCountSubquery = db
        .select({
          agentId: schema.agentsTable.id,
          knowledgeSourcesCount:
            sql<number>`(SELECT COUNT(*) FROM agent_knowledge_base WHERE agent_id = ${schema.agentsTable.id}) + (SELECT COUNT(*) FROM agent_connector_assignment WHERE agent_id = ${schema.agentsTable.id})`.as(
              "knowledgeSourcesCount",
            ),
        })
        .from(schema.agentsTable)
        .as("knowledgeSourcesCounts");

      query = query
        .leftJoin(
          knowledgeSourcesCountSubquery,
          eq(schema.agentsTable.id, knowledgeSourcesCountSubquery.agentId),
        )
        .orderBy(
          direction(
            sql`COALESCE(${knowledgeSourcesCountSubquery.knowledgeSourcesCount}, 0)`,
          ),
        );
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
          knowledgeBaseIds: [],
          connectorIds: [],
          suggestedPrompts: [],
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

    await Promise.all([
      AgentModel.populateAuthorNames(agents),
      AgentModel.populateKnowledgeBaseIds(agents),
      AgentModel.populateConnectorIds(agents),
      AgentModel.populateSuggestedPrompts(agents),
    ]);

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
      case "subagentsCount":
      case "knowledgeSourcesCount":
      case "team":
        // toolsCount, subagentsCount, knowledgeSourcesCount, and team sorting use a separate query path.
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
   * Batch fetch minimal agent data needed for permission checks.
   * Returns a Map of agentId -> { agentType, scope, authorId, teamIds }.
   * Much lighter than findById (no tool/label/knowledgeBase/connector joins).
   */
  static async findByIdsForPermissionCheck(ids: string[]): Promise<
    Map<
      string,
      {
        agentType: AgentType;
        scope: AgentScope;
        authorId: string | null;
        teamIds: string[];
      }
    >
  > {
    if (ids.length === 0) {
      return new Map();
    }

    const [agents, teamsMap] = await Promise.all([
      db
        .select({
          id: schema.agentsTable.id,
          agentType: schema.agentsTable.agentType,
          scope: schema.agentsTable.scope,
          authorId: schema.agentsTable.authorId,
        })
        .from(schema.agentsTable)
        .where(inArray(schema.agentsTable.id, ids)),
      AgentTeamModel.getTeamDetailsForAgents(ids),
    ]);

    const result = new Map<
      string,
      {
        agentType: AgentType;
        scope: AgentScope;
        authorId: string | null;
        teamIds: string[];
      }
    >();
    for (const agent of agents) {
      const teams = teamsMap.get(agent.id) ?? [];
      result.set(agent.id, {
        agentType: agent.agentType,
        scope: agent.scope,
        authorId: agent.authorId,
        teamIds: teams.map((t) => t.id),
      });
    }

    return result;
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
      .filter((tool): tool is NonNullable<typeof tool> => tool !== null);

    const [teams, labels, knowledgeBaseIds, connectorIds] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgent(id),
      AgentLabelModel.getLabelsForAgent(id),
      AgentKnowledgeBaseModel.getKnowledgeBaseIds(id),
      AgentConnectorAssignmentModel.getConnectorIds(id),
    ]);

    const result: Agent = {
      ...agent,
      tools,
      teams,
      labels,
      knowledgeBaseIds,
      connectorIds,
      suggestedPrompts: [],
    };

    await Promise.all([
      AgentModel.populateAuthorNames([result]),
      AgentModel.populateSuggestedPrompts([result]),
    ]);

    return result;
  }

  static async getMCPGatewayOrCreateDefault(
    organizationId?: string,
  ): Promise<Agent> {
    return AgentModel.getOrCreateDefaultByType(
      "mcp_gateway",
      DEFAULT_MCP_GATEWAY_NAME,
      organizationId,
    );
  }

  static async getLLMProxyOrCreateDefault(
    organizationId?: string,
  ): Promise<Agent> {
    return AgentModel.getOrCreateDefaultByType(
      "llm_proxy",
      DEFAULT_LLM_PROXY_NAME,
      organizationId,
    );
  }

  /**
   * Get the default profile (agentType: "profile" with isDefault: true).
   * Returns null if no default profile exists.
   * It's needed for backward compatibility with default profile which allowed llm proxy on without a uuid specified in the url.
   */
  static async getDefaultProfile(): Promise<Agent | null> {
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
      .where(
        and(
          eq(schema.agentsTable.isDefault, true),
          eq(schema.agentsTable.agentType, "profile"),
        ),
      );

    if (rows.length === 0) {
      return null;
    }

    const agent = rows[0].agents;
    const tools = rows
      .map((row) => row.tools)
      .filter((tool): tool is NonNullable<typeof tool> => tool !== null);

    return {
      ...agent,
      tools,
      teams: await AgentTeamModel.getTeamDetailsForAgent(agent.id),
      labels: await AgentLabelModel.getLabelsForAgent(agent.id),
      knowledgeBaseIds: await AgentKnowledgeBaseModel.getKnowledgeBaseIds(
        agent.id,
      ),
      connectorIds: await AgentConnectorAssignmentModel.getConnectorIds(
        agent.id,
      ),
      suggestedPrompts: [],
    };
  }

  private static async getOrCreateDefaultByType(
    agentType: "mcp_gateway" | "llm_proxy",
    defaultName: string,
    organizationId?: string,
  ): Promise<Agent> {
    // First, try to find an agent with isDefault=true and matching agentType
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
      .where(
        and(
          eq(schema.agentsTable.isDefault, true),
          eq(schema.agentsTable.agentType, agentType),
        ),
      );

    if (rows.length > 0) {
      // Default agent exists, return it
      const agent = rows[0].agents;
      const tools = rows
        .map((row) => row.tools)
        .filter((tool): tool is NonNullable<typeof tool> => tool !== null);

      return {
        ...agent,
        tools,
        teams: await AgentTeamModel.getTeamDetailsForAgent(agent.id),
        labels: await AgentLabelModel.getLabelsForAgent(agent.id),
        knowledgeBaseIds: await AgentKnowledgeBaseModel.getKnowledgeBaseIds(
          agent.id,
        ),
        connectorIds: await AgentConnectorAssignmentModel.getConnectorIds(
          agent.id,
        ),
        suggestedPrompts: [],
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
      name: defaultName,
      agentType,
      isDefault: true,
      organizationId: orgId || "",
      scope: "org",
      teams: [],
      labels: [],
    });
  }

  static async update(
    id: string,
    {
      teams,
      labels,
      knowledgeBaseIds,
      connectorIds,
      suggestedPrompts,
      ...agent
    }: Partial<UpdateAgent>,
  ): Promise<Agent | null> {
    let updatedAgent:
      | Omit<
          Agent,
          | "tools"
          | "teams"
          | "labels"
          | "knowledgeBaseIds"
          | "connectorIds"
          | "suggestedPrompts"
        >
      | undefined;

    // Fetch existing agent to check for name changes (needed for delegation tool sync)
    const [existingAgent] = await db
      .select()
      .from(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id));

    if (!existingAgent) {
      return null;
    }

    // If setting isDefault to true, unset isDefault for other agents of the same type
    if (agent.isDefault === true) {
      await db
        .update(schema.agentsTable)
        .set({ isDefault: false })
        .where(
          and(
            eq(schema.agentsTable.isDefault, true),
            eq(schema.agentsTable.agentType, existingAgent.agentType),
          ),
        );
    }

    // Only update agent table if there are fields to update
    if (Object.keys(agent).length > 0) {
      const [row] = await db
        .update(schema.agentsTable)
        .set(agent)
        .where(eq(schema.agentsTable.id, id))
        .returning();

      if (!row) {
        return null;
      }
      updatedAgent = row;

      // If name changed, sync delegation tool names and invalidate parent caches
      if (agent.name && agent.name !== existingAgent.name) {
        await ToolModel.syncDelegationToolNames(id, agent.name);

        // Invalidate tool cache for all parent agents so they pick up the new tool name
        const parentAgentIds = await ToolModel.getParentAgentIds(id);
        for (const parentAgentId of parentAgentIds) {
          clearChatMcpClient(parentAgentId);
        }
      }
    } else {
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

    // Sync knowledge base assignments if knowledgeBaseIds is provided
    if (knowledgeBaseIds !== undefined) {
      await AgentKnowledgeBaseModel.syncForAgent(id, knowledgeBaseIds);
    }

    // Sync connector assignments if connectorIds is provided
    if (connectorIds !== undefined) {
      await AgentConnectorAssignmentModel.syncForAgent(id, connectorIds);
    }

    // Sync suggested prompts if provided
    if (suggestedPrompts !== undefined) {
      await AgentSuggestedPromptModel.syncForAgent(id, suggestedPrompts);
    }

    const [
      toolRows,
      currentTeams,
      currentLabels,
      currentKbIds,
      currentConnectorIds,
      currentSuggestedPrompts,
    ] = await Promise.all([
      db
        .select({ tool: schema.toolsTable })
        .from(schema.agentToolsTable)
        .innerJoin(
          schema.toolsTable,
          eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
        )
        .where(eq(schema.agentToolsTable.agentId, updatedAgent?.id)),
      AgentTeamModel.getTeamDetailsForAgent(id),
      AgentLabelModel.getLabelsForAgent(id),
      AgentKnowledgeBaseModel.getKnowledgeBaseIds(id),
      AgentConnectorAssignmentModel.getConnectorIds(id),
      AgentSuggestedPromptModel.getForAgents([id]),
    ]);

    if (!updatedAgent) return null;

    return {
      ...updatedAgent,
      tools: toolRows.map((row) => row.tool),
      teams: currentTeams,
      labels: currentLabels,
      knowledgeBaseIds: currentKbIds,
      connectorIds: currentConnectorIds,
      suggestedPrompts: currentSuggestedPrompts.get(id) ?? [],
    };
  }

  /**
   * Find a built-in agent by its config name discriminator.
   * When organizationId is provided, scopes the query to that org
   * (important for multi-org deployments where each org has its own built-in agent row).
   */
  static async getBuiltInAgent(
    builtInName: string,
    organizationId?: string,
  ): Promise<Agent | null> {
    const conditions: SQL[] = [
      sql`${schema.agentsTable.builtInAgentConfig}->>'name' = ${builtInName}`,
    ];
    if (organizationId) {
      conditions.push(eq(schema.agentsTable.organizationId, organizationId));
    }

    const [row] = await db
      .select()
      .from(schema.agentsTable)
      .where(and(...conditions))
      .limit(1);

    if (!row) return null;

    const [teams, labels] = await Promise.all([
      AgentTeamModel.getTeamDetailsForAgent(row.id),
      AgentLabelModel.getLabelsForAgent(row.id),
    ]);

    const toolRows = await db
      .select({ tool: schema.toolsTable })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.agentToolsTable.agentId, row.id));

    return {
      ...row,
      tools: toolRows.map((r) => r.tool),
      teams,
      labels,
      knowledgeBaseIds: await AgentKnowledgeBaseModel.getKnowledgeBaseIds(
        row.id,
      ),
      connectorIds: await AgentConnectorAssignmentModel.getConnectorIds(row.id),
      suggestedPrompts: [],
    };
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentsTable)
      .where(eq(schema.agentsTable.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  /** Check if an agent has any Playwright tools assigned via agent_tools. */
  static async hasPlaywrightToolsAssigned(agentId: string): Promise<boolean> {
    const rows = await db
      .select({ id: schema.toolsTable.id })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agentId),
          eq(schema.toolsTable.catalogId, PLAYWRIGHT_MCP_CATALOG_ID),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Ensure a personal default chat agent exists for a member.
   * Idempotent: skips if member already has a defaultAgentId set.
   */
  static async ensurePersonalChatAgent(params: {
    userId: string;
    organizationId: string;
  }): Promise<void> {
    const { userId, organizationId } = params;

    const existingDefault = await MemberModel.getDefaultAgentId(
      userId,
      organizationId,
    );
    if (existingDefault !== null) return;

    const agent = await AgentModel.create(
      {
        organizationId,
        name: "My Assistant",
        agentType: "agent",
        scope: "personal",
        description: "Your personal chat assistant",
      },
      userId,
    );

    await ToolModel.assignDefaultArchestraToolsToAgent(agent.id);
    await MemberModel.setDefaultAgent(userId, organizationId, agent.id);

    logger.info(
      { userId, organizationId, agentId: agent.id },
      "Created personal default chat agent",
    );
  }
}

export default AgentModel;
