import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  max,
  min,
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
 * Extract all prompt IDs from external agent IDs.
 * External agent IDs can be:
 * - A single prompt ID (UUID)
 * - A delegation chain (colon-separated UUIDs like "promptA:promptB:promptC")
 * - A non-UUID string like "Archestra Chat" (ignored)
 */
function extractAllPromptIdsFromExternalAgentIds(
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
 * Fetch prompt names for a list of prompt IDs.
 */
async function getPromptNamesById(
  promptIds: string[],
): Promise<Map<string, string>> {
  if (promptIds.length === 0) return new Map();

  const prompts = await db
    .select({ id: schema.promptsTable.id, name: schema.promptsTable.name })
    .from(schema.promptsTable)
    .where(inArray(schema.promptsTable.id, promptIds));

  return new Map(prompts.map((p) => [p.id, p.name]));
}

/**
 * Resolve an external agent ID to a human-readable label.
 * - Single prompt ID: Returns the prompt name
 * - Delegation chain: Returns only the last (most specific) prompt name
 * - Non-UUID: Returns null (will fall back to Main/Subagent)
 */
function resolveExternalAgentIdLabel(
  externalAgentId: string | null,
  promptNamesMap: Map<string, string>,
): string | null {
  if (!externalAgentId) return null;

  // Check if it's a delegation chain (contains colons)
  if (externalAgentId.includes(":")) {
    const parts = externalAgentId.split(":");
    // Get the last prompt ID in the chain (the actual executing agent)
    const lastPromptId = parts[parts.length - 1];
    if (isUuid(lastPromptId)) {
      return promptNamesMap.get(lastPromptId) ?? null;
    }
    return null;
  }

  // Single ID - return the prompt name if it exists
  if (isUuid(externalAgentId)) {
    return promptNamesMap.get(externalAgentId) ?? null;
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

    // Resolve external agent IDs (including delegation chains) to prompt names
    const allPromptIds = extractAllPromptIdsFromExternalAgentIds(
      data.map((i) => i.externalAgentId),
    );
    const promptNamesMap = await getPromptNamesById(allPromptIds);

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
        promptNamesMap,
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
      firstRequestTime: Date;
      lastRequestTime: Date;
      models: string[];
      profileId: string;
      profileName: string | null;
      externalAgentIds: string[];
      externalAgentIdLabels: (string | null)[]; // Resolved prompt names for external agent IDs
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

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // For sessions, we use COALESCE to give null sessionIds a unique identifier
    // based on the interaction ID so they appear as individual "sessions"
    // Cast id to text since session_id is VARCHAR and id is UUID
    const sessionGroupExpr = sql`COALESCE(${schema.interactionsTable.sessionId}, ${schema.interactionsTable.id}::text)`;

    // Get sessions grouped by sessionId (with null sessions as individual entries)
    // Use MAX for session_id and session_source to avoid grouping NULL values together
    // The sessionGroupExpr (COALESCE) ensures each NULL session_id row gets a unique group
    // For single interactions (null session), we include the interaction ID for direct navigation
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
          firstRequestTime: min(schema.interactionsTable.createdAt),
          lastRequestTime: max(schema.interactionsTable.createdAt),
          models: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.model}, ',')`,
          profileId: schema.interactionsTable.profileId,
          profileName: schema.agentsTable.name,
          externalAgentIds: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.externalAgentId}, ',')`,
          userNames: sql<string>`STRING_AGG(DISTINCT ${schema.usersTable.name}, ',')`,
          // Get the request from the most recent "main" interaction in this session
          // Excludes: prompt suggestion generator, title generation, and utility requests
          lastInteractionRequest: sql<unknown>`(ARRAY_AGG(
            ${schema.interactionsTable.request}
            ORDER BY ${schema.interactionsTable.createdAt} DESC
          ) FILTER (WHERE
            ${schema.interactionsTable.request}::text NOT LIKE '%prompt suggestion generator%'
            AND ${schema.interactionsTable.request}::text NOT LIKE '%Please write a 5-10 word title%'
            AND LENGTH(${schema.interactionsTable.request}->'messages'->0->>'content') > 20
          ))[1]`,
          lastInteractionType: sql<string>`(ARRAY_AGG(
            ${schema.interactionsTable.type}
            ORDER BY ${schema.interactionsTable.createdAt} DESC
          ) FILTER (WHERE
            ${schema.interactionsTable.request}::text NOT LIKE '%prompt suggestion generator%'
            AND ${schema.interactionsTable.request}::text NOT LIKE '%Please write a 5-10 word title%'
            AND LENGTH(${schema.interactionsTable.request}->'messages'->0->>'content') > 20
          ))[1]`,
          // Get conversation title if sessionId matches a conversation (for Archestra Chat sessions)
          conversationTitle: max(schema.conversationsTable.title),
          // For Claude Code sessions, extract title from the response to the title generation request
          // Claude Code sends "Please write a 5-10 word title..." and the response contains the title
          claudeCodeTitle: sql<string>`(ARRAY_AGG(
            ${schema.interactionsTable.response}->'content'->0->>'text'
            ORDER BY ${schema.interactionsTable.createdAt} DESC
          ) FILTER (WHERE ${schema.interactionsTable.request}::text LIKE '%Please write a 5-10 word title%'))[1]`,
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
        .where(whereClause),
    ]);

    // Collect all external agent IDs to resolve prompt names
    const allExternalAgentIds = sessionsData.flatMap((s) =>
      s.externalAgentIds ? s.externalAgentIds.split(",").filter(Boolean) : [],
    );
    const promptNamesMap = await getPromptNamesById(
      extractAllPromptIdsFromExternalAgentIds(allExternalAgentIds),
    );

    // Transform the data to the expected format
    const sessions = sessionsData.map((s) => {
      const externalAgentIds = s.externalAgentIds
        ? s.externalAgentIds.split(",").filter(Boolean)
        : [];

      return {
        sessionId: s.sessionId,
        sessionSource: s.sessionSource,
        interactionId: s.interactionId, // Only set for single interactions (null session)
        requestCount: Number(s.requestCount),
        totalInputTokens: Number(s.totalInputTokens) || 0,
        totalOutputTokens: Number(s.totalOutputTokens) || 0,
        totalCost: s.totalCost,
        totalBaselineCost: s.totalBaselineCost,
        firstRequestTime: s.firstRequestTime ?? new Date(),
        lastRequestTime: s.lastRequestTime ?? new Date(),
        models: s.models ? s.models.split(",").filter(Boolean) : [],
        profileId: s.profileId,
        profileName: s.profileName,
        externalAgentIds,
        externalAgentIdLabels: externalAgentIds.map((id) =>
          resolveExternalAgentIdLabel(id, promptNamesMap),
        ),
        userNames: s.userNames ? s.userNames.split(",").filter(Boolean) : [],
        lastInteractionRequest: s.lastInteractionRequest,
        lastInteractionType: s.lastInteractionType,
        conversationTitle: s.conversationTitle,
        claudeCodeTitle: s.claudeCodeTitle,
      };
    });

    return createPaginatedResult(sessions, Number(total), pagination);
  }
}

export default InteractionModel;
