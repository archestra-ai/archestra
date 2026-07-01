import type {
  ClientFilter,
  InteractionSource,
  PaginationQuery,
} from "@archestra/shared";
import {
  CLAUDE_CLIENT_AGENT_IDS,
  CLAUDE_CLIENT_FILTER,
  isClaudeSessionSource,
  LEGACY_CLAUDE_CODE_SESSION_SOURCE,
} from "@archestra/shared";
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
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import logger from "@/logging";
import type {
  InsertInteraction,
  Interaction,
  InteractionAuthMethod,
  SessionSummary,
  SortingQuery,
  UserInfo,
} from "@/types";
import {
  InteractionAuthMethodSchema,
  normalizeInteractionResponse,
} from "@/types";
import { isUuid } from "@/utils/uuid";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import ConversationChatErrorModel from "./conversation-chat-error";
import InteractionDeltaManager from "./interaction-delta-manager";
import LimitModel from "./limit";

async function findChatErrorsForSessionId(sessionId: string | null) {
  if (!sessionId || !isUuid(sessionId)) {
    return [];
  }

  return ConversationChatErrorModel.findByConversation(sessionId);
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
 * Applies to the Claude agentic sources (Claude Code and Claude Desktop, both
 * built on the Claude Agent SDK); every other source is "main".
 *
 * Shared heuristics:
 * - Single short utility messages ("count", "quota") are subagents
 * - Prompt suggestion generator requests are subagents
 * - The Agent SDK spawns single-purpose tool sub-agents (e.g. web search) whose
 *   system prompt is "You are an assistant for performing a <tool> tool use"
 *
 * Source-specific: Claude Code main requests carry the "Task" tool (they can
 * spawn subagents) and subagents don't — so absence of "Task" means subagent.
 * Claude Desktop main agents do NOT carry the "Task" tool, so that negative
 * signal can't be used there; a Claude Desktop request that matched none of the
 * subagent markers is "main".
 */
function computeRequestType(
  request: unknown,
  sessionSource: string | null,
): "main" | "subagent" {
  // Only apply detection heuristics for Claude sessions (claude_metadata, plus
  // the legacy claude_code / claude_desktop values on older rows).
  if (!isClaudeSessionSource(sessionSource)) {
    return "main";
  }

  const req = request as {
    system?: string | Array<{ text?: string; type?: string }>;
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

  // Claude Agent SDK tool sub-agents (e.g. web search) are marked by their
  // system prompt. This is the reliable signal for Claude Desktop, whose main
  // agent — unlike Claude Code's — does not carry the Task tool.
  if (getMessageText(req?.system).includes("an assistant for performing a")) {
    return "subagent";
  }

  // Legacy rows only: newer Claude requests record session_source as
  // claude_metadata, which can no longer be distinguished from Claude Desktop,
  // so the Task-tool negative signal (unsafe for Desktop main agents) is not
  // applied to them — they fall through to the default below.
  if (sessionSource === LEGACY_CLAUDE_CODE_SESSION_SOURCE) {
    const tools = req?.tools ?? [];
    const hasTaskTool = tools.some((tool) => tool.name === "Task");
    return hasTaskTool ? "main" : "subagent";
  }

  return "main";
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
 * - Non-UUID: Returns the original string as-is
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

/**
 * Build a display name for an external agent ID.
 * - Single agent ID: Returns "AgentName" or the ID if not found
 * - Delegation chain: Returns "Agent1 → Agent2 → Agent3" format
 * - Non-UUID: Returns the original string as-is
 */
function buildExternalAgentDisplayName(
  externalAgentId: string,
  agentNamesMap: Map<string, string>,
): string {
  // Check if it's a delegation chain (contains colons)
  if (externalAgentId.includes(":")) {
    const parts = externalAgentId.split(":");
    const names = parts.map((part) => {
      if (isUuid(part)) {
        return agentNamesMap.get(part) ?? part.slice(0, 8);
      }
      return part;
    });
    return names.join(" → ");
  }

  // Single ID - return the agent name or truncated ID
  if (isUuid(externalAgentId)) {
    return agentNamesMap.get(externalAgentId) ?? externalAgentId.slice(0, 8);
  }

  // Non-UUID (like "Archestra Chat") - return as-is
  return externalAgentId;
}

/**
 * Strips null bytes (\u0000) from JSON-serializable data.
 * PostgreSQL JSONB rejects null byte unicode escape sequences, which can appear
 * in LLM responses (e.g., Gemini's thoughtSignature fields).
 */
function stripNullBytes<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.replaceAll("\u0000", "") as T;
  }
  if (Array.isArray(value)) {
    return value.map(stripNullBytes) as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = stripNullBytes(v);
    }
    return result as T;
  }
  return value;
}

/**
 * Join predicate linking an interaction's `session_id` (VARCHAR) to a
 * conversation's `id` (UUID) — used for Archestra Chat sessions whose
 * session_id IS the conversation id.
 *
 * The only reason a cast is needed at all is type compatibility: Postgres has no
 * `varchar = uuid` operator. We cast the TRUSTED side (`conversations.id::text`,
 * which can never fail) rather than the untrusted `session_id::uuid` — a non-uuid
 * session_id (e.g. some a2a / external-agent ids) would otherwise throw
 * "invalid input syntax for type uuid" and 500 the whole query (see utils/uuid.ts).
 * Comparing as text, a non-conversation session_id simply matches no row, and the
 * equality on the bare `session_id` column can use interactions_session_*_idx.
 * Conversation ids are generated as canonical lowercase uuids, so they match the
 * canonical lowercase form `id::text` produces.
 */
function sessionIdMatchesConversation(): SQL {
  return sql`${schema.interactionsTable.sessionId} = ${schema.conversationsTable.id}::text`;
}

class InteractionModel {
  static async existsByExecutionId(executionId: string): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.interactionsTable.id })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.executionId, executionId))
      .limit(1);
    return result !== undefined;
  }

  static async create(data: InsertInteraction) {
    // Snapshot the environment from the agent at creation time (single funnel
    // for all interaction writes) so per-environment cost-limit usage stays
    // stable under later agent reassignment. The agent is authoritative: when a
    // profile is present its current environment wins over any caller-supplied
    // value. Only profile-less system interactions may set it explicitly.
    const environmentId = data.profileId
      ? await AgentModel.findEnvironmentId(data.profileId)
      : (data.environmentId ?? null);

    // Sanitize JSONB fields to strip null bytes (\u0000) that PostgreSQL rejects
    const sanitized = {
      ...data,
      environmentId,
      request: stripNullBytes(data.request),
      processedRequest: stripNullBytes(data.processedRequest),
      response: stripNullBytes(data.response),
    };

    // Delta-encode Claude Code / Claude Desktop requests so we don't re-store the
    // whole conversation on every row (no-op for all other interactions).
    const { values, tip } =
      await InteractionDeltaManager.encodeOnWrite(sanitized);

    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values(values)
      .returning();

    if (tip) {
      InteractionDeltaManager.commitTip(interaction.id, tip);
    }

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

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          interaction: schema.interactionsTable,
          activeProfileId: schema.agentsTable.id,
        })
        .from(schema.interactionsTable)
        .leftJoin(
          schema.agentsTable,
          and(
            eq(schema.interactionsTable.profileId, schema.agentsTable.id),
            notDeleted(schema.agentsTable),
          ),
        )
        .where(whereClause)
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.interactionsTable)
        .where(whereClause),
    ]);
    const data = rows.map(({ interaction, activeProfileId }) => ({
      ...interaction,
      profileId: activeProfileId,
    }));

    // Resolve external agent IDs (including delegation chains) to agent names
    const allAgentIds = extractAllAgentIdsFromExternalAgentIds(
      data.map((i) => i.externalAgentId),
    );
    const agentNamesMap = await getAgentNamesById(allAgentIds);

    // Reconstruct full delta-encoded requests in a single batched query so the
    // API returns the same data as before delta-encoding was introduced.
    const reconstructed = await reconstructInteractionRequests(data);

    // Add computed requestType and externalAgentIdLabel fields to each interaction
    const dataWithComputedFields = data.map((interaction) => {
      const full = reconstructed.get(interaction.id);
      return {
        ...interaction,
        request: full?.request ?? interaction.request,
        processedRequest:
          full?.processedRequest ?? interaction.processedRequest,
        // Coerce a stored response that no longer matches its provider schema
        // into a serializable sentinel so one bad row can't 500 the whole list.
        response: normalizeInteractionResponse(
          interaction.type,
          interaction.response,
        ),
        // computeRequestType must run on the reconstructed (full) request — it
        // inspects messages.length and the first/last message content.
        requestType: computeRequestType(
          full?.request ?? interaction.request,
          interaction.sessionSource,
        ),
        // Resolve externalAgentId to human-readable label (supports delegation chains)
        externalAgentIdLabel: resolveExternalAgentIdLabel(
          interaction.externalAgentId,
          agentNamesMap,
        ),
      };
    });

    return createPaginatedResult(
      dataWithComputedFields as unknown as (Interaction & {
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
    const [row] = await db
      .select({
        interaction: schema.interactionsTable,
        activeProfileId: schema.agentsTable.id,
      })
      .from(schema.interactionsTable)
      .leftJoin(
        schema.agentsTable,
        and(
          eq(schema.interactionsTable.profileId, schema.agentsTable.id),
          notDeleted(schema.agentsTable),
        ),
      )
      .where(eq(schema.interactionsTable.id, id));

    if (!row) {
      return null;
    }
    const interaction = {
      ...row.interaction,
      profileId: row.activeProfileId,
    };

    // Check access control for non-agent admins
    if (userId && !isAgentAdmin) {
      // If profileId is null (agent was deleted), only admins can see the interaction
      if (!interaction.profileId) {
        return null;
      }
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        userId,
        interaction.profileId,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    const reconstructed = await InteractionDeltaManager.reconstructRow(
      interaction as unknown as {
        id: string;
        threadId: string | null;
        request: unknown;
        processedRequest: unknown;
      },
    );

    return {
      ...interaction,
      request: reconstructed.request,
      processedRequest: reconstructed.processedRequest,
      // Coerce a stored response that no longer matches its provider schema
      // into a serializable sentinel so a bad row can't 500 the detail route.
      response: normalizeInteractionResponse(
        interaction.type,
        interaction.response,
      ),
      chatErrors: await findChatErrorsForSessionId(interaction.sessionId),
    } as Interaction;
  }

  static async getAllInteractionsForProfile(
    profileId: string,
    whereClauses?: SQL[],
  ) {
    const rows = await db
      .select()
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.profileId, profileId),
          ...(whereClauses ?? []),
        ),
      )
      .orderBy(asc(schema.interactionsTable.createdAt));

    return withReconstructedRequests(rows);
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
      // `data` are raw Drizzle rows (they still carry the internal delta columns
      // that `withReconstructedRequests` needs); the public type omits them.
      (await withReconstructedRequests(data)) as unknown as Interaction[],
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
   * Get all unique external agent IDs with display names
   * Used for filtering dropdowns in the UI
   * Returns agent info (id and displayName) for the dropdown to display names but filter by id
   */
  static async getUniqueExternalAgentIds(
    requestingUserId?: string,
    isAgentAdmin?: boolean,
  ): Promise<{ id: string; displayName: string }[]> {
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

    const externalAgentIds = result
      .map((r) => r.externalAgentId)
      .filter((id): id is string => id !== null);

    // Get all unique agent IDs from the external agent IDs (including from chains)
    const allAgentIds =
      extractAllAgentIdsFromExternalAgentIds(externalAgentIds);
    const agentNamesMap = await getAgentNamesById(allAgentIds);

    // Build display names for each external agent ID
    return externalAgentIds.map((id) => ({
      id,
      displayName: buildExternalAgentDisplayName(id, agentNamesMap),
    }));
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
      // If profileId is null (agent was deleted), we can't update usage - skip silently
      if (!interaction.profileId) {
        logger.info(
          `Interaction ${interaction.id} has null profileId (agent deleted) - skipping limit update`,
        );
        return;
      }
      const agentTeamIds = await AgentTeamModel.getTeamsForAgent(
        interaction.profileId,
      );

      const updatePromises: Promise<void>[] = [];

      if (agentTeamIds.length === 0) {
        logger.warn(
          `Profile ${interaction.profileId} has no team assignments for interaction ${interaction.id}`,
        );

        // Even if agent has no teams, update organization limits for its own org.
        try {
          const organizationId = await AgentModel.findOrganizationId(
            interaction.profileId,
          );

          if (organizationId) {
            updatePromises.push(
              LimitModel.updateTokenLimitUsage(
                "organization",
                organizationId,
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

      if (interaction.userId) {
        updatePromises.push(
          LimitModel.updateTokenLimitUsage(
            "user",
            interaction.userId,
            model,
            inputTokens,
            outputTokens,
          ),
        );
      }

      if (interaction.virtualKeyId) {
        updatePromises.push(
          LimitModel.updateTokenLimitUsage(
            "virtual_key",
            interaction.virtualKeyId,
            model,
            inputTokens,
            outputTokens,
          ),
        );
      }

      // A passthrough virtual key accrues usage independently from the standard
      // virtual key (distinct limit entities), so record against both when present.
      if (interaction.passthroughVirtualKeyId) {
        updatePromises.push(
          LimitModel.updateTokenLimitUsage(
            "virtual_key",
            interaction.passthroughVirtualKeyId,
            model,
            inputTokens,
            outputTokens,
          ),
        );
      }

      // Update environment-level token cost limits using the environment
      // snapshotted on the interaction at creation time.
      if (interaction.environmentId) {
        updatePromises.push(
          LimitModel.updateTokenLimitUsage(
            "environment",
            interaction.environmentId,
            model,
            inputTokens,
            outputTokens,
          ),
        );
      }

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
      source?: InteractionSource;
      client?: ClientFilter;
      externalAgentId?: string;
      sessionId?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<PaginatedResult<SessionSummary>> {
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

    // Source filter
    if (filters?.source) {
      conditions.push(eq(schema.interactionsTable.source, filters.source));
    }

    // Client-app filter — queries external_agent_id (the client-attribution
    // column). CLAUDE_CLIENT_FILTER expands to every Claude client id, matched
    // case-insensitively (header values, auto-discovered, and backfilled).
    if (filters?.client === CLAUDE_CLIENT_FILTER) {
      // Lower both sides so the match stays case-insensitive even if a
      // mixed-case id is ever added to CLAUDE_CLIENT_AGENT_IDS.
      conditions.push(
        inArray(
          sql`lower(${schema.interactionsTable.externalAgentId})`,
          CLAUDE_CLIENT_AGENT_IDS.map((id) => id.toLowerCase()),
        ),
      );
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
          source: sql<InteractionSource | null>`CASE WHEN COUNT(DISTINCT ${schema.interactionsTable.source}) = 1 THEN MAX(${schema.interactionsTable.source}) ELSE NULL END`,
          sources: sql<
            InteractionSource[]
          >`ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${schema.interactionsTable.source} ORDER BY ${schema.interactionsTable.source}), NULL)`,
          // For single interactions (no session), return the interaction ID for direct navigation
          interactionId: sql<string>`CASE WHEN MAX(${schema.interactionsTable.sessionId}) IS NULL THEN MAX(${schema.interactionsTable.id}::text) ELSE NULL END`,
          requestCount: count(),
          totalInputTokens: sum(schema.interactionsTable.inputTokens),
          totalOutputTokens: sum(schema.interactionsTable.outputTokens),
          totalCacheReadTokens: sum(schema.interactionsTable.cacheReadTokens),
          totalCacheWriteTokens: sum(schema.interactionsTable.cacheWriteTokens),
          totalCost: sum(schema.interactionsTable.cost),
          totalBaselineCost: sum(schema.interactionsTable.baselineCost),
          totalToonCostSavings: sum(schema.interactionsTable.toonCostSavings),
          totalCacheSavings: sum(schema.interactionsTable.cacheSavings),
          // Count interactions where TOON was applied (has savings)
          toonAppliedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.toonCostSavings} IS NOT NULL AND CAST(${schema.interactionsTable.toonCostSavings} AS NUMERIC) > 0)`,
          // Count interactions by skip reason
          toonNotEnabledCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.toonSkipReason} = 'not_enabled')`,
          toonNotEffectiveCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.toonSkipReason} = 'not_effective')`,
          toonNoToolResultsCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.toonSkipReason} = 'no_tool_results')`,
          firstRequestTime: min(schema.interactionsTable.createdAt),
          lastRequestTime: max(schema.interactionsTable.createdAt),
          models: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.model}, ',')`,
          profileId: sql<string | null>`MAX(${schema.agentsTable.id}::text)`,
          profileName: max(schema.agentsTable.name),
          externalAgentIds: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.externalAgentId}, ',')`,
          authMethods: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.authMethod}, ',')`,
          authenticatedAppNames: sql<
            string[]
          >`ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${schema.interactionsTable.authenticatedAppName}), NULL)`,
          userNames: sql<string>`STRING_AGG(DISTINCT ${schema.usersTable.name}, ',')`,
          // Get conversation title if sessionId matches a conversation (for Archestra Chat sessions)
          conversationTitle: max(schema.conversationsTable.title),
        })
        .from(schema.interactionsTable)
        .leftJoin(
          schema.agentsTable,
          and(
            eq(schema.interactionsTable.profileId, schema.agentsTable.id),
            notDeleted(schema.agentsTable),
          ),
        )
        .leftJoin(
          schema.usersTable,
          eq(schema.interactionsTable.userId, schema.usersTable.id),
        )
        .leftJoin(schema.conversationsTable, sessionIdMatchesConversation())
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
        .leftJoin(schema.conversationsTable, sessionIdMatchesConversation())
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
        source: s.source,
        sources: s.sources ?? [],
        interactionId: s.interactionId, // Only set for single interactions (null session)
        requestCount: Number(s.requestCount),
        totalInputTokens: Number(s.totalInputTokens) || 0,
        totalOutputTokens: Number(s.totalOutputTokens) || 0,
        totalCacheReadTokens: Number(s.totalCacheReadTokens) || 0,
        totalCacheWriteTokens: Number(s.totalCacheWriteTokens) || 0,
        totalCost: s.totalCost,
        totalBaselineCost: s.totalBaselineCost,
        totalToonCostSavings: s.totalToonCostSavings,
        totalCacheSavings: s.totalCacheSavings,
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
        authMethods: parseInteractionAuthMethods(s.authMethods),
        authenticatedAppNames: s.authenticatedAppNames ?? [],
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

    // Use ROW_NUMBER() to limit interactions per session.
    // thread_id is selected so the chosen tip can be reconstructed from deltas.
    const interactionsResult = await db.execute<{
      id: string;
      session_id: string | null;
      thread_id: string | null;
      request: unknown;
      response: unknown;
      type: string;
      created_at: Date;
    }>(sql`
      WITH ranked AS (
        SELECT
          id, session_id, thread_id, request, response, type, created_at,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(session_id, id::text) ORDER BY created_at DESC) as rn
        FROM interactions
        WHERE ${whereClause}
      )
      SELECT id, session_id, thread_id, request, response, type, created_at
      FROM ranked
      WHERE rn <= ${INTERACTIONS_PER_SESSION}
      ORDER BY session_id, created_at DESC
    `);

    const interactions = interactionsResult.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      threadId: row.thread_id,
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
          // Check if request has valid content - support both OpenAI/Anthropic and Gemini formats
          // We accept any interaction that has a valid request structure, not just text content.
          // This ensures we don't skip requests with images, files, or function calls.
          const request = interaction.request as {
            // OpenAI/Anthropic format
            messages?: Array<{ content?: string | Array<unknown> }>;
            // Gemini format
            contents?: Array<{
              role?: string;
              parts?: Array<unknown>;
            }>;
          };

          // Check if request has valid content (messages or contents array with items)
          const hasOpenAiContent =
            Array.isArray(request?.messages) && request.messages.length > 0;
          const hasGeminiContent =
            Array.isArray(request?.contents) && request.contents.length > 0;

          if (hasOpenAiContent || hasGeminiContent) {
            lastMainInteraction = interaction;
          }
        }

        // Early exit if we found both (undefined = not yet searched for title)
        if (lastMainInteraction && claudeCodeTitle !== undefined) {
          break;
        }
      }

      if (lastMainInteraction || claudeCodeTitle) {
        // Reconstruct the chosen tip's full request from deltas (no-op for
        // legacy/non-delta rows). Only one tip per session is reconstructed.
        let tipRequest: unknown = lastMainInteraction?.request ?? null;
        if (lastMainInteraction && lastMainInteraction.threadId !== null) {
          const full = await InteractionDeltaManager.reconstructRow({
            id: lastMainInteraction.id,
            threadId: lastMainInteraction.threadId,
            request: lastMainInteraction.request,
            processedRequest: null,
          });
          tipRequest = full.request;
        }

        result.set(sessionKey, {
          request: tipRequest,
          type: lastMainInteraction?.type ?? "",
          claudeCodeTitle: claudeCodeTitle ?? null,
        });
      }
    }

    return result;
  }
}

export default InteractionModel;

/**
 * Batch-reconstruct full request/processedRequest for delta-encoded rows.
 * Legacy / non-Claude rows pass through untouched. One bounded query per call.
 */
function reconstructInteractionRequests(
  rows: {
    id: string;
    threadId: string | null;
    request: unknown;
    processedRequest?: unknown;
  }[],
): Promise<Map<string, { request: unknown; processedRequest: unknown }>> {
  return InteractionDeltaManager.reconstructMany(rows);
}

/**
 * Replace each row's delta-encoded request/processedRequest with the full
 * reconstructed values. Legacy / non-Claude rows are returned unchanged.
 */
async function withReconstructedRequests<
  T extends {
    id: string;
    threadId: string | null;
    request: unknown;
    processedRequest?: unknown;
  },
>(rows: T[]): Promise<T[]> {
  const reconstructed = await reconstructInteractionRequests(rows);
  return rows.map((row) => {
    const full = reconstructed.get(row.id);
    return full
      ? {
          ...row,
          request: full.request,
          processedRequest: full.processedRequest,
        }
      : row;
  });
}

function parseInteractionAuthMethods(
  value: string | null,
): InteractionAuthMethod[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .filter(Boolean)
    .flatMap((authMethod) => {
      const result = InteractionAuthMethodSchema.safeParse(authMethod);
      return result.success ? [result.data] : [];
    });
}
