import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  max,
  min,
  or,
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import logger from "@/logging";
import type {
  InsertInteraction,
  Interaction,
  PaginationQuery,
  SortingQuery,
  UserInfo,
} from "@/types";
import AgentTeamModel from "./agent-team";
import LimitModel from "./limit";

/**
 * Escapes special LIKE pattern characters (%, _, \) to treat them as literals.
 * This prevents users from crafting searches that behave unexpectedly.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

/**
 * Extracts text content from a message content field.
 * Handles both string content and array of content blocks.
 */
function getMessageText(
  content: string | Array<{ text?: string; type?: string }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : (block.text ?? "")))
      .join(" ");
  }
  return "";
}

/**
 * Detects if a request is a "main" request or "subagent" request.
 *
 * Claude Code specific heuristic:
 * - Main requests have the "Task" tool available (can spawn subagents)
 * - Subagent requests don't have the "Task" tool
 * - Utility requests (single message like "count", "quota") are subagents
 * - Prompt suggestion requests (last message contains "prompt suggestion generator") are subagents
 *
 * For other session sources, all requests are considered "main" by default.
 */
function computeRequestType(
  request: unknown,
  sessionSource: string | null,
): "main" | "subagent" {
  // Only apply detection heuristics for Claude Code sessions
  if (sessionSource !== "claude_code") {
    return "main";
  }

  const req = request as {
    tools?: Array<{ name: string }>;
    messages?: Array<{
      content: string | Array<{ text?: string; type?: string }>;
      role: string;
    }>;
  };

  const messages = req?.messages ?? [];

  // Utility requests with single short message are subagents
  if (messages.length === 1) {
    const content = getMessageText(messages[0]?.content);
    // Single word utility messages like "count", "quota"
    if (content.length < 20 && !content.includes(" ")) {
      return "subagent";
    }
  }

  // Prompt suggestion generator requests are subagents (check last message)
  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    const lastContent = getMessageText(lastMessage?.content);
    if (lastContent.includes("prompt suggestion generator")) {
      return "subagent";
    }
  }

  const tools = req?.tools ?? [];
  const hasTaskTool = tools.some((tool) => tool.name === "Task");
  return hasTaskTool ? "main" : "subagent";
}

/**
 * Check if a string is a valid UUID format
 */
function isUuid(str: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Extract all agent IDs from external agent IDs.
 * External agent IDs can be:
 * - A single agent ID (UUID)
 * - A delegation chain (colon-separated UUIDs like "agentA:agentB:agentC")
 * - A non-UUID string like "Archestra Chat" (ignored)
 */
function extractAllAgentIdsFromExternalAgentIds(
  externalAgentIds: (string | null)[],
): string[] {
  const allIds = new Set<string>();

  for (const id of externalAgentIds) {
    if (!id) continue;

    // Check if it's a delegation chain (contains colons)
    if (id.includes(":")) {
      for (const part of id.split(":")) {
        if (isUuid(part)) {
          allIds.add(part);
        }
      }
    } else if (isUuid(id)) {
      allIds.add(id);
    }
  }

  return [...allIds];
}

/**
 * Fetch agent names for a list of agent IDs.
 */
async function getAgentNamesById(
  agentIds: string[],
): Promise<Map<string, string>> {
  if (agentIds.length === 0) return new Map();

  const agents = await db
    .select({ id: schema.agentsTable.id, name: schema.agentsTable.name })
    .from(schema.agentsTable)
    .where(inArray(schema.agentsTable.id, agentIds));

  return new Map(agents.map((a) => [a.id, a.name]));
}

/**
 * Resolve an external agent ID to a human-readable label.
 * - Single agent ID: Returns the agent name
 * - Delegation chain: Returns only the last (most specific) agent name
 * - Non-UUID: Returns null (will fall back to Main/Subagent)
 */
function resolveExternalAgentIdLabel(
  externalAgentId: string | null,
  agentNamesMap: Map<string, string>,
): string | null {
  if (!externalAgentId) return null;

  // Check if it's a delegation chain (contains colons)
  if (externalAgentId.includes(":")) {
    const parts = externalAgentId.split(":");
    // Get the last agent ID in the chain (the actual executing agent)
    const lastAgentId = parts[parts.length - 1];
    if (isUuid(lastAgentId)) {
      return agentNamesMap.get(lastAgentId) ?? null;
    }
    return null;
  }

  // Single ID - return the agent name if it exists
  if (isUuid(externalAgentId)) {
    return agentNamesMap.get(externalAgentId) ?? null;
  }

  // Non-UUID (like "Archestra Chat") - no label
  return null;
}

class InteractionModel {
  static async create(data: InsertInteraction) {
    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values(data)
      .returning();

    // Update usage tracking after interaction is created
    // Run in background to not block the response
    InteractionModel.updateUsageAfterInteraction(
      interaction as InsertInteraction & { id: string },
    ).catch((error) => {
      logger.error(
        { error },
        `Failed to update usage tracking for interaction ${interaction.id}`,
      );
    });

    return interaction;
  }

  /**
   * Find all interactions with pagination, sorting, and filtering support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    requestingUserId?: string,
    isAgentAdmin?: boolean,
    filters?: {
      profileId?: string;
      externalAgentId?: string;
      userId?: string;
      sessionId?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<PaginatedResult<Interaction>> {
    // Determine the ORDER BY clause based on sorting params
    const orderByClause = InteractionModel.getOrderByClause(sorting);

    // Build where clauses
    const conditions: SQL[] = [];

    // Access control filter
    if (requestingUserId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        requestingUserId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }

      conditions.push(
        inArray(schema.interactionsTable.profileId, accessibleAgentIds),
      );
    }

    // Profile filter (internal Archestra profile ID)
    if (filters?.profileId) {
      conditions.push(
        eq(schema.interactionsTable.profileId, filters.profileId),
      );
    }

    // External agent ID filter (from X-Archestra-Agent-Id header)
    if (filters?.externalAgentId) {
      conditions.push(
        eq(schema.interactionsTable.externalAgentId, filters.externalAgentId),
      );
    }

    // User ID filter (from X-Archestra-User-Id header)
    if (filters?.userId) {
      conditions.push(eq(schema.interactionsTable.userId, filters.userId));
    }

    // Session ID filter
    if (filters?.sessionId) {
      conditions.push(
        eq(schema.interactionsTable.sessionId, filters.sessionId),
      );
    }

    // Date range filter
    if (filters?.startDate) {
      conditions.push(
        gte(schema.interactionsTable.createdAt, filters.startDate),
      );
    }
    if (filters?.endDate) {
      conditions.push(lte(schema.interactionsTable.createdAt, filters.endDate));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.interactionsTable)
        .where(whereClause)
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.interactionsTable)
        .where(whereClause),
    ]);

    // Resolve external agent IDs (including delegation chains) to agent names
    const allAgentIds = extractAllAgentIdsFromExternalAgentIds(
      data.map((i) => i.externalAgentId),
    );
    const agentNamesMap = await getAgentNamesById(allAgentIds);

    // Add computed requestType and externalAgentIdLabel fields to each interaction
    const dataWithComputedFields = data.map((interaction) => ({
      ...interaction,
      requestType: computeRequestType(
        interaction.request,
        interaction.sessionSource,
      ),
      // Resolve externalAgentId to human-readable label (supports delegation chains)
      externalAgentIdLabel: resolveExternalAgentIdLabel(
        interaction.externalAgentId,
        agentNamesMap,
      ),
    }));

    return createPaginatedResult(
      dataWithComputedFields as (Interaction & {
        requestType: "main" | "subagent";
        externalAgentIdLabel: string | null;
      })[],
      Number(total),
      pagination,
    );
  }

  /**
   * Helper to get the appropriate ORDER BY clause based on sorting params
   */
  private static getOrderByClause(sorting?: SortingQuery) {
    const direction = sorting?.sortDirection === "asc" ? asc : desc;

    switch (sorting?.sortBy) {
      case "createdAt":
        return direction(schema.interactionsTable.createdAt);
      case "profileId":
        return direction(schema.interactionsTable.profileId);
      case "externalAgentId":
        return direction(schema.interactionsTable.externalAgentId);
      case "userId":
        return direction(schema.interactionsTable.userId);
      case "model":
        // Extract model from the JSONB request column
        // Wrap in parentheses to ensure correct precedence for the JSON operator
        return direction(
          sql`(${schema.interactionsTable.request} ->> 'model')`,
        );
      default:
        // Default: newest first
        return desc(schema.interactionsTable.createdAt);
    }
  }

  static async findById(
    id: string,
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<Interaction | null> {
    const [interaction] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, id));

    if (!interaction) {
      return null;
    }

    // Check access control for non-agent admins
    if (userId && !isAgentAdmin) {
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        interaction.profileId,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    return interaction as Interaction;
  }

  static async getAllInteractionsForProfile(
    profileId: string,
    whereClauses?: SQL[],
  ) {
    return db
      .select()
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.profileId, profileId),
          ...(whereClauses ?? []),
        ),
      )
      .orderBy(asc(schema.interactionsTable.createdAt));
  }

  /**
   * Get all interactions for a profile with pagination and sorting support
   */
  static async getAllInteractionsForProfilePaginated(
    profileId: string,
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    whereClauses?: SQL[],
  ): Promise<PaginatedResult<Interaction>> {
    const whereCondition = and(
      eq(schema.interactionsTable.profileId, profileId),
      ...(whereClauses ?? []),
    );

    const orderByClause = InteractionModel.getOrderByClause(sorting);

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.interactionsTable)
        .where(whereCondition)
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.interactionsTable)
        .where(whereCondition),
    ]);

    return createPaginatedResult(
      data as Interaction[],
      Number(total),
      pagination,
    );
  }

  static async getCount() {
    const [result] = await db
      .select({ total: count() })
      .from(schema.interactionsTable);
    return result.total;
  }

  /**
   * Get all unique external agent IDs
   * Used for filtering dropdowns in the UI
   */
  static async getUniqueExternalAgentIds(
    requestingUserId?: string,
    isAgentAdmin?: boolean,
  ): Promise<string[]> {
    // Build where clause for access control
    const conditions: SQL[] = [
      isNotNull(schema.interactionsTable.externalAgentId),
    ];

    if (requestingUserId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        requestingUserId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      conditions.push(
        inArray(schema.interactionsTable.profileId, accessibleAgentIds),
      );
    }

    const result = await db
      .selectDistinct({
        externalAgentId: schema.interactionsTable.externalAgentId,
      })
      .from(schema.interactionsTable)
      .where(and(...conditions))
      .orderBy(asc(schema.interactionsTable.externalAgentId));

    return result
      .map((r) => r.externalAgentId)
      .filter((id): id is string => id !== null);
  }

  /**
   * Get all unique user IDs with user names
   * Used for filtering dropdowns in the UI
   * Returns user info (id and name) for the dropdown to display names but filter by id
   */
  static async getUniqueUserIds(
    requestingUserId?: string,
    isAgentAdmin?: boolean,
  ): Promise<UserInfo[]> {
    // Build where clause for access control
    const conditions: SQL[] = [isNotNull(schema.interactionsTable.userId)];

    if (requestingUserId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        requestingUserId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return [];
      }

      conditions.push(
        inArray(schema.interactionsTable.profileId, accessibleAgentIds),
      );
    }

    // Get distinct user IDs from interactions and join with users table to get names
    const result = await db
      .selectDistinct({
        userId: schema.interactionsTable.userId,
        userName: schema.usersTable.name,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.interactionsTable.userId, schema.usersTable.id),
      )
      .where(and(...conditions))
      .orderBy(asc(schema.usersTable.name));

    return result
      .filter(
        (r): r is { userId: string; userName: string } => r.userId !== null,
      )
      .map((r) => ({
        id: r.userId,
        name: r.userName,
      }));
  }

  /**
   * Update usage limits after an interaction is created
   */
  static async updateUsageAfterInteraction(
    interaction: InsertInteraction & { id: string },
  ): Promise<void> {
    try {
      // Calculate token usage for this interaction
      const inputTokens = interaction.inputTokens || 0;
      const outputTokens = interaction.outputTokens || 0;
      const model = interaction.model;

      if (inputTokens === 0 && outputTokens === 0) {
        // No tokens used, nothing to update
        return;
      }

      if (!model) {
        logger.warn(
          `Interaction ${interaction.id} has no model - cannot update limits`,
        );
        return;
      }

      // Get agent's teams to update team and organization limits
      const agentTeamIds = await AgentTeamModel.getTeamsForAgent(
        interaction.profileId,
      );

      const updatePromises: Promise<void>[] = [];

      if (agentTeamIds.length === 0) {
        logger.warn(
          `Profile ${interaction.profileId} has no team assignments for interaction ${interaction.id}`,
        );

        // Even if agent has no teams, we should still try to update organization limits
        // We'll use a default organization approach - get the first organization from existing limits
        try {
          const existingOrgLimits = await db
            .select({ entityId: schema.limitsTable.entityId })
            .from(schema.limitsTable)
            .where(eq(schema.limitsTable.entityType, "organization"))
            .limit(1);

          if (existingOrgLimits.length > 0) {
            updatePromises.push(
              LimitModel.updateTokenLimitUsage(
                "organization",
                existingOrgLimits[0].entityId,
                model,
                inputTokens,
                outputTokens,
              ),
            );
          }
        } catch (error) {
          logger.error(
            { error },
            "Failed to find organization for agent with no teams",
          );
        }
      } else {
        // Get team details to access organizationId
        const teams = await db
          .select()
          .from(schema.teamsTable)
          .where(inArray(schema.teamsTable.id, agentTeamIds));

        // Update organization-level token cost limits (from first team's organization)
        if (teams.length > 0 && teams[0].organizationId) {
          updatePromises.push(
            LimitModel.updateTokenLimitUsage(
              "organization",
              teams[0].organizationId,
              model,
              inputTokens,
              outputTokens,
            ),
          );
        }

        // Update team-level token cost limits
        for (const team of teams) {
          updatePromises.push(
            LimitModel.updateTokenLimitUsage(
              "team",
              team.id,
              model,
              inputTokens,
              outputTokens,
            ),
          );
        }
      }

      // Update profile-level token cost limits (if any exist)
      updatePromises.push(
        LimitModel.updateTokenLimitUsage(
          "agent",
          interaction.profileId,
          model,
          inputTokens,
          outputTokens,
        ),
      );

      // Execute all updates in parallel
      await Promise.all(updatePromises);
    } catch (error) {
      logger.error({ error }, "Error updating usage limits after interaction");
      // Don't throw - usage tracking should not break interaction creation
    }
  }

  /**
   * Session summary returned by getSessions
   *
   * Performance optimization: This method splits the query into two phases:
   * 1. Fast aggregation query for session stats (no ARRAY_AGG on large JSON columns)
   * 2. Batch fetch of "last interaction" data using efficient indexed lookups
   *
   * The previous approach used ARRAY_AGG with FILTER on request::text which was O(n) on JSON size
   * and caused 17+ second queries due to scanning megabytes of JSON per session.
   */
  static async getSessions(
    pagination: PaginationQuery,
    requestingUserId?: string,
    isAgentAdmin?: boolean,
    filters?: {
      profileId?: string;
      userId?: string;
      externalAgentId?: string;
      sessionId?: string;
      startDate?: Date;
      endDate?: Date;
      search?: string;
    },
  ): Promise<
    PaginatedResult<{
      sessionId: string | null;
      sessionSource: string | null;
      interactionId: string | null; // Only set for single interactions (null session)
      requestCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCost: string | null;
      totalBaselineCost: string | null;
      totalToonCostSavings: string | null;
      toonSkipReasonCounts: {
        applied: number;
        notEnabled: number;
        notEffective: number;
        noToolResults: number;
      };
      firstRequestTime: Date;
      lastRequestTime: Date;
      models: string[];
      profileId: string;
      profileName: string | null;
      externalAgentIds: string[];
      externalAgentIdLabels: (string | null)[]; // Resolved agent names for external agent IDs
      userNames: string[];
      lastInteractionRequest: unknown | null;
      lastInteractionType: string | null;
      conversationTitle: string | null;
      claudeCodeTitle: string | null;
    }>
  > {
    // Build where clauses for access control
    const conditions: SQL[] = [];

    if (requestingUserId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        requestingUserId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return createPaginatedResult([], 0, pagination);
      }

      conditions.push(
        inArray(schema.interactionsTable.profileId, accessibleAgentIds),
      );
    }

    // Profile filter
    if (filters?.profileId) {
      conditions.push(
        eq(schema.interactionsTable.profileId, filters.profileId),
      );
    }

    // User filter
    if (filters?.userId) {
      conditions.push(eq(schema.interactionsTable.userId, filters.userId));
    }

    // External agent ID filter
    if (filters?.externalAgentId) {
      conditions.push(
        eq(schema.interactionsTable.externalAgentId, filters.externalAgentId),
      );
    }

    // Session ID filter
    if (filters?.sessionId) {
      conditions.push(
        eq(schema.interactionsTable.sessionId, filters.sessionId),
      );
    }

    // Date range filter
    if (filters?.startDate) {
      conditions.push(
        gte(schema.interactionsTable.createdAt, filters.startDate),
      );
    }
    if (filters?.endDate) {
      conditions.push(lte(schema.interactionsTable.createdAt, filters.endDate));
    }

    // Free-text search filter (case-insensitive)
    // Searches across: request messages content, response content (for titles), and conversation titles
    if (filters?.search) {
      const searchPattern = `%${escapeLikePattern(filters.search)}%`;
      const searchCondition = or(
        // Search in request messages content (JSONB)
        sql`${schema.interactionsTable.request}::text ILIKE ${searchPattern}`,
        // Search in response content (for Claude Code titles)
        sql`${schema.interactionsTable.response}::text ILIKE ${searchPattern}`,
        // Search in conversation title (for Archestra Chat sessions)
        sql`${schema.conversationsTable.title} ILIKE ${searchPattern}`,
      );
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // For sessions, we use COALESCE to give null sessionIds a unique identifier
    // based on the interaction ID so they appear as individual "sessions"
    // Cast id to text since session_id is VARCHAR and id is UUID
    const sessionGroupExpr = sql`COALESCE(${schema.interactionsTable.sessionId}, ${schema.interactionsTable.id}::text)`;

    // PHASE 1: Get sessions with lightweight aggregations (no ARRAY_AGG on large JSON)
    // This is the fast path - simple aggregations on indexed columns
    const [sessionsData, [{ total }]] = await Promise.all([
      db
        .select({
          sessionId: max(schema.interactionsTable.sessionId),
          sessionSource: max(schema.interactionsTable.sessionSource),
          // For single interactions (no session), return the interaction ID for direct navigation
          interactionId: sql<string>`CASE WHEN MAX(${schema.interactionsTable.sessionId}) IS NULL THEN MAX(${schema.interactionsTable.id}::text) ELSE NULL END`,
          requestCount: count(),
          totalInputTokens: sum(schema.interactionsTable.inputTokens),
          totalOutputTokens: sum(schema.interactionsTable.outputTokens),
          totalCost: sum(schema.interactionsTable.cost),
          totalBaselineCost: sum(schema.interactionsTable.baselineCost),
          totalToonCostSavings: sum(schema.interactionsTable.toonCostSavings),
          // Count interactions where TOON was applied (has savings)
          toonAppliedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.toonCostSavings} IS NOT NULL AND CAST(${schema.interactionsTable.toonCostSavings} AS NUMERIC) > 0)`,
          // Count interactions by skip reason
          toonNotEnabledCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.toonSkipReason} = 'not_enabled')`,
          toonNotEffectiveCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.toonSkipReason} = 'not_effective')`,
          toonNoToolResultsCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.toonSkipReason} = 'no_tool_results')`,
          firstRequestTime: min(schema.interactionsTable.createdAt),
          lastRequestTime: max(schema.interactionsTable.createdAt),
          models: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.model}, ',')`,
          profileId: schema.interactionsTable.profileId,
          profileName: schema.agentsTable.name,
          externalAgentIds: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.externalAgentId}, ',')`,
          userNames: sql<string>`STRING_AGG(DISTINCT ${schema.usersTable.name}, ',')`,
          // Get conversation title if sessionId matches a conversation (for Archestra Chat sessions)
          conversationTitle: max(schema.conversationsTable.title),
        })
        .from(schema.interactionsTable)
        .leftJoin(
          schema.agentsTable,
          eq(schema.interactionsTable.profileId, schema.agentsTable.id),
        )
        .leftJoin(
          schema.usersTable,
          eq(schema.interactionsTable.userId, schema.usersTable.id),
        )
        .leftJoin(
          schema.conversationsTable,
          // Only join when session_id is a valid UUID format (conversation IDs are UUIDs)
          // Non-UUID session IDs (like "a2a-...") won't match any conversation
          // Use CASE to safely handle the cast - only cast when length is 36 (UUID format)
          sql`CASE WHEN LENGTH(${schema.interactionsTable.sessionId}) = 36 THEN ${schema.interactionsTable.sessionId}::uuid END = ${schema.conversationsTable.id}`,
        )
        .where(whereClause)
        .groupBy(
          sessionGroupExpr,
          schema.interactionsTable.profileId,
          schema.agentsTable.name,
        )
        .orderBy(desc(max(schema.interactionsTable.createdAt)))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: sql<number>`COUNT(DISTINCT ${sessionGroupExpr})` })
        .from(schema.interactionsTable)
        .leftJoin(
          schema.conversationsTable,
          // Only join when session_id is a valid UUID format (conversation IDs are UUIDs)
          sql`CASE WHEN LENGTH(${schema.interactionsTable.sessionId}) = 36 THEN ${schema.interactionsTable.sessionId}::uuid END = ${schema.conversationsTable.id}`,
        )
        .where(whereClause),
    ]);

    // PHASE 2: Batch fetch "last interaction" info for all sessions
    // This is much faster than ARRAY_AGG because:
    // 1. We only fetch for the paginated sessions (typically 10-50 rows)
    // 2. Uses index on (session_id, created_at DESC)
    // 3. Filtering happens in JS on already-fetched data, not in SQL on JSON text
    const sessionKeys = sessionsData.map((s) => s.sessionId ?? s.interactionId);
    const lastInteractionMap =
      await InteractionModel.getLastInteractionsForSessions(
        sessionKeys.filter((k): k is string => k !== null),
      );

    // Collect all external agent IDs to resolve prompt names
    const allExternalAgentIds = sessionsData.flatMap((s) =>
      s.externalAgentIds ? s.externalAgentIds.split(",").filter(Boolean) : [],
    );
    const agentNamesMap = await getAgentNamesById(
      extractAllAgentIdsFromExternalAgentIds(allExternalAgentIds),
    );

    // Transform the data to the expected format
    const sessions = sessionsData.map((s) => {
      const externalAgentIds = s.externalAgentIds
        ? s.externalAgentIds.split(",").filter(Boolean)
        : [];

      const sessionKey = s.sessionId ?? s.interactionId;
      const lastInteraction = sessionKey
        ? lastInteractionMap.get(sessionKey)
        : null;

      return {
        sessionId: s.sessionId,
        sessionSource: s.sessionSource,
        interactionId: s.interactionId, // Only set for single interactions (null session)
        requestCount: Number(s.requestCount),
        totalInputTokens: Number(s.totalInputTokens) || 0,
        totalOutputTokens: Number(s.totalOutputTokens) || 0,
        totalCost: s.totalCost,
        totalBaselineCost: s.totalBaselineCost,
        totalToonCostSavings: s.totalToonCostSavings,
        toonSkipReasonCounts: {
          applied: Number(s.toonAppliedCount) || 0,
          notEnabled: Number(s.toonNotEnabledCount) || 0,
          notEffective: Number(s.toonNotEffectiveCount) || 0,
          noToolResults: Number(s.toonNoToolResultsCount) || 0,
        },
        firstRequestTime: s.firstRequestTime ?? new Date(),
        lastRequestTime: s.lastRequestTime ?? new Date(),
        models: s.models ? s.models.split(",").filter(Boolean) : [],
        profileId: s.profileId,
        profileName: s.profileName,
        externalAgentIds,
        externalAgentIdLabels: externalAgentIds.map((id) =>
          resolveExternalAgentIdLabel(id, agentNamesMap),
        ),
        userNames: s.userNames ? s.userNames.split(",").filter(Boolean) : [],
        lastInteractionRequest: lastInteraction?.request ?? null,
        lastInteractionType: lastInteraction?.type ?? null,
        conversationTitle: s.conversationTitle,
        claudeCodeTitle: lastInteraction?.claudeCodeTitle ?? null,
      };
    });

    return createPaginatedResult(sessions, Number(total), pagination);
  }

  /**
   * Batch fetch the "last main interaction" info for a list of sessions.
   *
   * This is optimized for performance:
   * - Uses window functions (ROW_NUMBER) instead of ARRAY_AGG to pick the first row
   * - Filtering for "main" vs "subagent" requests happens in JS, not SQL text scanning
   * - Returns only the needed columns, not the full interaction object
   *
   * For each session, returns the most recent interaction that qualifies as "main":
   * - Not a prompt suggestion generator request
   * - Not a title generation request
   * - Has meaningful content (message > 20 chars)
   */
  private static async getLastInteractionsForSessions(
    sessionKeys: string[],
  ): Promise<
    Map<
      string,
      { request: unknown; type: string; claudeCodeTitle: string | null }
    >
  > {
    if (sessionKeys.length === 0) {
      return new Map();
    }

    // Separate session IDs from interaction IDs (UUIDs)
    // Session IDs can be any string, but interaction IDs must be valid UUIDs
    const uuidKeys = sessionKeys.filter((k) => isUuid(k));

    // Fetch the most recent N interactions per session, ordered by created_at DESC
    // We limit to 20 per session since we only need the title and last main interaction,
    // which are typically among the most recent. This prevents fetching thousands of
    // interactions for long-running sessions.
    // We filter in JS (much faster than SQL text scanning for the title/prompt checks)
    const INTERACTIONS_PER_SESSION = 20;

    // Build the WHERE clause using Drizzle's sql template
    const sessionCondition =
      sessionKeys.length > 0
        ? sql`session_id IN (${sql.join(
            sessionKeys.map((k) => sql`${k}`),
            sql`, `,
          )})`
        : null;

    const uuidCondition =
      uuidKeys.length > 0
        ? sql`id IN (${sql.join(
            uuidKeys.map((k) => sql`${k}::uuid`),
            sql`, `,
          )})`
        : null;

    const whereConditions = [sessionCondition, uuidCondition].filter(Boolean);
    const whereClause =
      whereConditions.length === 1
        ? whereConditions[0]
        : sql.join(whereConditions as SQL[], sql` OR `);

    // Use ROW_NUMBER() to limit interactions per session
    const interactionsResult = await db.execute<{
      id: string;
      session_id: string | null;
      request: unknown;
      response: unknown;
      type: string;
      created_at: Date;
    }>(sql`
      WITH ranked AS (
        SELECT
          id, session_id, request, response, type, created_at,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(session_id, id::text) ORDER BY created_at DESC) as rn
        FROM interactions
        WHERE ${whereClause}
      )
      SELECT id, session_id, request, response, type, created_at
      FROM ranked
      WHERE rn <= ${INTERACTIONS_PER_SESSION}
      ORDER BY session_id, created_at DESC
    `);

    const interactions = interactionsResult.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      request: row.request,
      response: row.response,
      type: row.type,
      createdAt: row.created_at,
    }));

    // Group by session and find the "last main interaction" and "title interaction"
    const result = new Map<
      string,
      { request: unknown; type: string; claudeCodeTitle: string | null }
    >();

    // Group interactions by session key (sessionId or interaction id for single interactions)
    const groupedBySession = new Map<string, Array<(typeof interactions)[0]>>();
    for (const interaction of interactions) {
      const key = interaction.sessionId ?? interaction.id;
      const existing = groupedBySession.get(key) ?? [];
      existing.push(interaction);
      groupedBySession.set(key, existing);
    }

    // For each session, find the last "main" interaction and title
    for (const [sessionKey, sessionInteractions] of groupedBySession) {
      let lastMainInteraction: (typeof interactions)[0] | null = null;
      // undefined = not yet found, null = found but no text, string = found with text
      let claudeCodeTitle: string | null | undefined;

      // Interactions are already ordered by created_at DESC
      for (const interaction of sessionInteractions) {
        const requestStr = JSON.stringify(interaction.request);

        // Check for title generation request (Claude Code)
        if (
          requestStr.includes("Please write a 5-10 word title") &&
          claudeCodeTitle === undefined
        ) {
          // Extract title from response
          const response = interaction.response as {
            content?: Array<{ text?: string }>;
          };
          claudeCodeTitle = response?.content?.[0]?.text ?? null;
          continue;
        }

        // Skip if this is not a "main" interaction
        if (
          !lastMainInteraction &&
          !requestStr.includes("prompt suggestion generator") &&
          !requestStr.includes("Please write a 5-10 word title")
        ) {
          // Check message content length
          const request = interaction.request as {
            messages?: Array<{ content?: string | Array<{ text?: string }> }>;
          };
          const firstMessage = request?.messages?.[0]?.content;
          const contentText =
            typeof firstMessage === "string"
              ? firstMessage
              : Array.isArray(firstMessage)
                ? firstMessage
                    .map((c) => (typeof c === "string" ? c : (c.text ?? "")))
                    .join(" ")
                : "";

          if (contentText.length > 20) {
            lastMainInteraction = interaction;
          }
        }

        // Early exit if we found both (undefined = not yet searched for title)
        if (lastMainInteraction && claudeCodeTitle !== undefined) {
          break;
        }
      }

      if (lastMainInteraction || claudeCodeTitle) {
        result.set(sessionKey, {
          request: lastMainInteraction?.request ?? null,
          type: lastMainInteraction?.type ?? "",
          claudeCodeTitle: claudeCodeTitle ?? null,
        });
      }
    }

    return result;
  }
}

export default InteractionModel;
