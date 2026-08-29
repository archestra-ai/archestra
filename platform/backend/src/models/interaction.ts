import type {
  ClientFilter,
  InteractionSource,
  PaginationQuery,
} from "@archestra/shared";
import {
  clientFilterToAgentIds,
  DynamicInteraction,
  isClaudeSessionSource,
  LEGACY_CLAUDE_CODE_SESSION_SOURCE,
  TimeInMs,
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
  or,
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import {
  decryptInteractionContent,
  encryptInteractionContent,
  readInteractionRow,
} from "@/content-encryption/audit-rows";
import type { LockedChatAuditContext } from "@/content-encryption/locked-chat";
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
  InteractionVirtualKey,
  SessionSummary,
  SessionUnattributedReason,
  SortingQuery,
  UserInfo,
} from "@/types";
import {
  InteractionAuthMethodSchema,
  LAST_USER_MESSAGE_PREVIEW_MAX_LENGTH,
  normalizeInteractionResponse,
} from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import { repairLoneSurrogateText } from "@/utils/lone-surrogates";
import { isUuid, uuidv7 } from "@/utils/uuid";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import ConversationChatErrorModel from "./conversation-chat-error";
import InteractionDeltaManager from "./interaction-delta-manager";
import LimitModel from "./limit";
import VirtualApiKeyModel from "./virtual-api-key";

/**
 * How long a session total stays reusable across pages of the same filter set.
 * Long enough to cover a client paging through the whole result, short enough
 * that a total on screen is never meaningfully behind the table.
 */
const SESSION_TOTAL_CACHE_TTL_MS = 30 * TimeInMs.Second;

/**
 * Session totals keyed by filter set (see getSessions). Per-pod and in-process
 * on purpose: the value is cheap to recompute on a miss, so it is not worth a
 * round-trip to the distributed cache to share it between pods. Bounded well
 * above the number of distinct filter combinations in flight at once.
 */
const sessionTotalCache = new LRUCacheManager<number>({
  maxSize: 500,
  defaultTtl: SESSION_TOTAL_CACHE_TTL_MS,
});

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
  source: string | null,
): "main" | "subagent" {
  // Archestra Chat marks its auxiliary LLM calls with a `chat:<subtype>` source
  // (title generation, context compaction, tool-call repair); the user's own
  // turn is plain "chat". These auxiliary calls are sub-agent work — title
  // generation and compaction even run under dedicated built-in sub-agents — so
  // the session detail view must badge them as "subagent". A chat session's
  // session_source is not a Claude source, so without this the heuristics below
  // would fall through to "main" and mislabel every auxiliary chat call.
  if (source?.startsWith("chat:")) {
    return "subagent";
  }

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
 * Strips characters PostgreSQL JSONB cannot store from JSON-serializable data.
 *
 * Two kinds, both of which appear in real LLM traffic and both of which fail the
 * insert outright — losing the whole interaction row rather than one field:
 *  - Null bytes (\u0000), which JSONB rejects as an escape sequence (e.g. in
 *    Gemini's thoughtSignature fields).
 *  - Unpaired UTF-16 surrogates, half an astral character left by a completion
 *    or tool result cut mid-character. JSONB is UTF-8, which cannot encode one.
 */
function stripUnstorableChars<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return repairLoneSurrogateText(value.replaceAll("\u0000", "")) as T;
  }
  if (Array.isArray(value)) {
    return value.map(stripUnstorableChars) as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = stripUnstorableChars(v);
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

  /**
   * @param auditContext when present, this interaction belongs to a locked-chat
   * conversation: its content columns are encrypted under that conversation's
   * browser-held key and the row is stamped with the discriminator, instead of
   * being encrypted under the server key (or left plaintext).
   */
  static async create(
    data: InsertInteraction,
    auditContext?: LockedChatAuditContext | null,
    opts?: {
      /**
       * Environment to stamp instead of the executing agent's own. The proxy
       * supplies it for advisor consultations (loopback-verified), which bill
       * to the delegating caller's environment because the advisor's row is
       * org-wide and env-less.
       */
      environmentIdOverride?: string;
    },
  ) {
    const audit = auditContext ?? null;
    // Snapshot the environment from the agent at creation time (single funnel
    // for all interaction writes) so per-environment cost-limit usage stays
    // stable under later agent reassignment. The agent is authoritative: when a
    // profile is present its current environment wins over any caller-supplied
    // value. Only profile-less system interactions may set it explicitly, and
    // only the proxy's verified advisor-delegation path may override it.
    const environmentId =
      opts?.environmentIdOverride ??
      (data.profileId
        ? await AgentModel.findEnvironmentId(data.profileId)
        : (data.environmentId ?? null));

    // Sanitize JSONB fields to strip null bytes (\u0000) that PostgreSQL rejects
    const sanitized = {
      ...data,
      environmentId,
      request: stripUnstorableChars(data.request),
      processedRequest: stripUnstorableChars(data.processedRequest),
      response: stripUnstorableChars(data.response),
    };

    // Delta-encode Claude Code / Claude Desktop requests so we don't re-store the
    // whole conversation on every row (no-op for all other interactions, and
    // disabled entirely under content encryption — see isEligible).
    //
    // LockedChat rows are excluded outright. Today they could not qualify anyway
    // (isEligible demands a Claude session source, and these are chat sources),
    // but relying on that coincidence would be fragile: a delta chain mixes rows
    // across requests and only the request that created a row carries its key,
    // so a chain spanning keys could not be reconstructed by any reader.
    const { values, tip } = audit
      ? { values: sanitized, tip: null }
      : await InteractionDeltaManager.encodeOnWrite(sanitized);

    const [interaction] = await db
      .insert(schema.interactionsTable)
      // Monotonic v7 id: created_at ties happen under load, and the delta
      // manager's "most recent interaction" lookup breaks ties with the id.
      .values({ id: uuidv7(), ...encryptInteractionContent(values, audit) })
      .returning();
    // The RETURNING row is this method's public return value — decrypt it so
    // callers never see envelopes. Safe for locked-chat rows too: this caller
    // supplied the very key that just encrypted them.
    decryptInteractionContent(interaction, audit);

    if (tip) {
      InteractionDeltaManager.commitTip(interaction.id, tip);
    }

    // Update usage tracking after interaction is created
    // Run in background to not block the response
    trackBackgroundWork(
      InteractionModel.updateUsageAfterInteraction(
        interaction as InsertInteraction & { id: string },
      ).catch((error) => {
        logger.error(
          { error },
          `Failed to update usage tracking for interaction ${interaction.id}`,
        );
      }),
    );

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
          interaction.source,
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
        // The scalar column, NOT `request ->> 'model'`: the jsonb payload can
        // be an encrypted envelope under content encryption, and the scalar is
        // populated for every row anyway.
        return direction(schema.interactionsTable.model);
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
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    readInteractionRow(interaction);
    // SPDX-SnippetEnd

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
      .orderBy(
        asc(schema.interactionsTable.createdAt),
        asc(schema.interactionsTable.id),
      );

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

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Enterprise data-retention sweep: delete interactions older than the
   * retention window, leaf-first.
   *
   * A row is only deletable when no other row references it as `parent_id`,
   * so delta chains erode tip-first across iterations and any ancestor of a
   * fresh surviving row is retained — reconstruction for survivors can never
   * truncate, and the deployed `ON DELETE RESTRICT` self-FK can never fire by
   * design. A concurrent insert racing the NOT EXISTS check trips the FK
   * (23503); that batch is skipped and re-evaluated on the next sweep.
   *
   * The cutoff is computed in SQL (`now() - make_interval(...)`): `created_at`
   * is `timestamp without time zone`, and a JS Date parameter would shift by
   * the host's UTC offset.
   */
  static async deleteExpired(params: {
    retentionDays: number;
    batchSize?: number;
    maxBatches?: number;
  }): Promise<number> {
    const batchSize = params.batchSize ?? 1000;
    const maxBatches = params.maxBatches ?? 500;
    let totalDeleted = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      let deleted: number;
      try {
        const result = await db.execute<{ deleted: number }>(sql`
          WITH fence AS (
            SELECT i.id
            FROM ${schema.interactionsTable} AS i
            WHERE i.created_at < now()::timestamp - make_interval(days => ${params.retentionDays})
              AND NOT EXISTS (
                SELECT 1 FROM ${schema.interactionsTable} AS c
                WHERE c.parent_id = i.id
              )
            LIMIT ${batchSize}
          ),
          removed AS (
            DELETE FROM ${schema.interactionsTable}
            WHERE id IN (SELECT id FROM fence)
            RETURNING 1
          )
          SELECT COUNT(*)::int AS deleted FROM removed
        `);
        deleted = Number(result.rows[0]?.deleted ?? 0);
      } catch (error) {
        // Most likely the parent_id RESTRICT FK racing a concurrent insert
        // that chained onto a row selected for deletion. Safe to stop — the
        // next sweep re-evaluates leaves from scratch.
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            totalDeleted,
          },
          "interaction retention sweep: batch failed, deferring to next run",
        );
        return totalDeleted;
      }

      totalDeleted += deleted;
      // Leaf-first must loop even on short batches: deleting tips can expose
      // their parents as new leaves. Only an empty round means done.
      if (deleted === 0) break;
    }

    return totalDeleted;
  }
  // SPDX-SnippetEnd

  /**
   * Get all unique external agent IDs with display names
   * Used for filtering dropdowns in the UI
   * Returns agent info (id and displayName) for the dropdown to display names but filter by id
   */
  static async getUniqueExternalAgentIds(
    requestingUserId?: string,
    isAgentAdmin?: boolean,
    /** Narrow to rows attributed to this user (the own-logs log:read view). */
    ownUserId?: string,
  ): Promise<{ id: string; displayName: string }[]> {
    // Build where clause for access control
    const conditions: SQL[] = [
      isNotNull(schema.interactionsTable.externalAgentId),
    ];
    if (ownUserId) {
      conditions.push(eq(schema.interactionsTable.userId, ownUserId));
    }

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

    // Put the most active users first so a large organization's filter surfaces
    // likely choices before its alphabetical tail. Names and ids close ties to
    // keep the order stable between requests.
    const activityCount = count();
    const result = await db
      .select({
        userId: schema.interactionsTable.userId,
        userName: schema.usersTable.name,
      })
      .from(schema.interactionsTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.interactionsTable.userId, schema.usersTable.id),
      )
      .where(and(...conditions))
      .groupBy(schema.interactionsTable.userId, schema.usersTable.name)
      .orderBy(
        desc(activityCount),
        asc(schema.usersTable.name),
        asc(schema.interactionsTable.userId),
      );

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
      // Subscription-billed interactions (e.g. Claude Pro/Max OAuth credentials)
      // cost the organization $0, so they must not burn down token-cost limits.
      if (interaction.billingMode === "subscription") {
        logger.debug(
          `Interaction ${interaction.id} is subscription-billed - skipping limit update`,
        );
        return;
      }

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
    // column). Each filter value expands to its client's agent ids, matched
    // case-insensitively (header values, auto-discovered, and backfilled).
    if (filters?.client) {
      // Lower both sides so the match stays case-insensitive even if a
      // mixed-case id is ever added to a client's agent-id set.
      conditions.push(
        inArray(
          sql`lower(${schema.interactionsTable.externalAgentId})`,
          clientFilterToAgentIds(filters.client).map((id) => id.toLowerCase()),
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

    // The session total is the same for every page of one filter set, but the
    // count it needs scans `interactions` — the largest, write-hot table — so
    // paying it per page made a client walking the pages re-run a full scan on
    // every request (the dominant cost of this endpoint, and enough on its own
    // to push the query into statement timeout as the table grows). Compute it
    // for the first page of a sweep and reuse it for the rest; a total that
    // trails new rows by at most SESSION_TOTAL_CACHE_TTL_MS is the intended
    // trade, since it only sizes the pager.
    const sessionTotalCacheKey = JSON.stringify([
      requestingUserId ?? null,
      isAgentAdmin ?? false,
      filters?.profileId ?? null,
      filters?.userId ?? null,
      filters?.source ?? null,
      filters?.client ?? null,
      filters?.externalAgentId ?? null,
      filters?.sessionId ?? null,
      filters?.startDate?.toISOString() ?? null,
      filters?.endDate?.toISOString() ?? null,
    ]);
    const cachedTotal = sessionTotalCache.get(sessionTotalCacheKey);

    // PHASE 1: Find only the session keys for this page. The summary query has
    // several joins and aggregates; applying LIMIT after all of that made every
    // page summarize every session in the table before discarding almost all of
    // the work. Selecting the page first keeps the expensive phase bounded by
    // the requested page instead of total history size.
    const [sessionPage, [{ total }]] = await Promise.all([
      db
        .select({
          sessionId: max(schema.interactionsTable.sessionId),
          interactionId: sql<
            string | null
          >`CASE WHEN MAX(${schema.interactionsTable.sessionId}) IS NULL THEN MAX(${schema.interactionsTable.id}::text) ELSE NULL END`,
        })
        .from(schema.interactionsTable)
        .where(whereClause)
        .groupBy(sessionGroupExpr)
        .orderBy(desc(max(schema.interactionsTable.createdAt)))
        .limit(pagination.limit)
        .offset(pagination.offset),
      // Total = distinct sessions + sessionless interactions (each its own
      // "session"). Counted without COUNT(DISTINCT COALESCE(session_id,
      // id::text)) — the per-row uuid cast defeats the session_id index — and
      // without the conversations join the summary query needs for titles: the
      // filters only touch interactions columns, and joining on the
      // conversations PK can't change the count.
      cachedTotal !== undefined
        ? [{ total: cachedTotal }]
        : db
            .select({
              total: sql<number>`COUNT(DISTINCT ${schema.interactionsTable.sessionId}) + COUNT(*) FILTER (WHERE ${schema.interactionsTable.sessionId} IS NULL)`,
            })
            .from(schema.interactionsTable)
            .where(whereClause),
    ]);

    if (cachedTotal === undefined) {
      sessionTotalCache.set(sessionTotalCacheKey, Number(total));
    }

    if (sessionPage.length === 0) {
      return createPaginatedResult([], Number(total), pagination);
    }

    const pageSessionIds = sessionPage.flatMap((session) =>
      session.sessionId ? [session.sessionId] : [],
    );
    const pageInteractionIds = sessionPage.flatMap((session) =>
      session.interactionId ? [session.interactionId] : [],
    );
    const pageConditions: SQL[] = [];
    if (pageSessionIds.length > 0) {
      pageConditions.push(
        inArray(schema.interactionsTable.sessionId, pageSessionIds),
      );
    }
    if (pageInteractionIds.length > 0) {
      pageConditions.push(
        inArray(schema.interactionsTable.id, pageInteractionIds),
      );
    }
    const pageCondition =
      pageConditions.length === 1 ? pageConditions[0] : or(...pageConditions);
    const pageWhereClause = whereClause
      ? and(whereClause, pageCondition)
      : pageCondition;

    // PHASE 2: Aggregate and join only the sessions selected above.
    const sessionsData = await db
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
        // `totalCost` is the full list-price estimate across the session.
        // `totalBilledCost` / `totalSubscriptionCost` split it by billing mode
        // (metered = billed spend; subscription = flat-rate, not billed), so a
        // session's Cost cell can show what was actually charged plus what the
        // subscription-covered portion would have cost. A session may mix modes
        // (e.g. a mid-session switch), so both filtered sums are needed.
        totalCost: sum(schema.interactionsTable.cost),
        totalBilledCost: sql<
          string | null
        >`SUM(${schema.interactionsTable.cost}) FILTER (WHERE ${schema.interactionsTable.billingMode} = 'metered')`,
        totalSubscriptionCost: sql<
          string | null
        >`SUM(${schema.interactionsTable.cost}) FILTER (WHERE ${schema.interactionsTable.billingMode} = 'subscription')`,
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
        // Attribute the session to its primary (non-built-in) agent. A chat
        // session mixes the user's agent with built-in utility subagents (e.g.
        // title generation), all sharing one session_id; without the FILTER,
        // MAX(id) and MAX(name) could resolve to different interactions and
        // surface the utility subagent. Preferring built_in = false keeps id
        // and name from the same agent; COALESCE falls back to any agent for
        // sessions that only ran built-in agents. API/Claude-Code sessions have
        // a single profile per session, so this is a no-op for them.
        profileId: sql<
          string | null
        >`COALESCE(MAX(${schema.agentsTable.id}::text) FILTER (WHERE ${schema.agentsTable.builtIn} = false), MAX(${schema.agentsTable.id}::text))`,
        profileName: sql<
          string | null
        >`COALESCE(MAX(${schema.agentsTable.name}) FILTER (WHERE ${schema.agentsTable.builtIn} = false), MAX(${schema.agentsTable.name}))`,
        externalAgentIds: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.externalAgentId}, ',')`,
        authMethods: sql<string>`STRING_AGG(DISTINCT ${schema.interactionsTable.authMethod}, ',')`,
        authenticatedAppNames: sql<
          string[]
        >`ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${schema.interactionsTable.authenticatedAppName}), NULL)`,
        // ARRAY_AGG (not STRING_AGG) — user names can contain commas
        // (e.g. "Last, First" display names), so a delimited string can't
        // be split back apart reliably
        userNames: sql<
          string[]
        >`ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${schema.usersTable.name} ORDER BY ${schema.usersTable.name}), NULL)`,
        // Ids alongside names: two members can share a display name, which
        // collapses them into a single entry above and leaves consumers
        // matching on an ambiguous string. Ids identify the actual users.
        userIds: sql<
          string[]
        >`ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${schema.usersTable.id}), NULL)`,
        // Both virtual-key columns, aggregated as ids and resolved to names in
        // phase 3. A request can carry one of each: a standard key for the
        // provider credential and a passthrough key for the acting user.
        virtualKeyIds: sql<
          string[]
        >`ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${schema.interactionsTable.virtualKeyId}::text), NULL)`,
        passthroughVirtualKeyIds: sql<
          string[]
        >`ARRAY_REMOVE(ARRAY_AGG(DISTINCT ${schema.interactionsTable.passthroughVirtualKeyId}::text), NULL)`,
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
      .where(pageWhereClause)
      // A session is identified by its session id alone (COALESCE(session_id,
      // id) for sessionless rows). profile_id / agent name must NOT be part of
      // the group key: an Archestra Chat writes its title-generation call under
      // a separate built-in subagent, so grouping by agent split one chat into
      // two "sessions". This matches the `total` count above, which already
      // counts distinct session ids only. Agent attribution is aggregated in
      // the SELECT (MAX) instead of being part of the key.
      .groupBy(sessionGroupExpr)
      .orderBy(desc(max(schema.interactionsTable.createdAt)));

    // PHASE 3: Batch fetch "last interaction" info for all sessions
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

    // Resolve every virtual key referenced by the page in one query, rather
    // than per session.
    const virtualKeyMap = await VirtualApiKeyModel.findSummariesByIds({
      ids: sessionsData.flatMap((s) => [
        ...(s.virtualKeyIds ?? []),
        ...(s.passthroughVirtualKeyIds ?? []),
      ]),
    });

    // Transform the data to the expected format
    const sessions = sessionsData.map((s) => {
      const externalAgentIds = s.externalAgentIds
        ? s.externalAgentIds.split(",").filter(Boolean)
        : [];
      const authMethods = parseInteractionAuthMethods(s.authMethods);
      const userIds = s.userIds ?? [];

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
        totalBilledCost: s.totalBilledCost,
        totalSubscriptionCost: s.totalSubscriptionCost,
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
        authMethods,
        authenticatedAppNames: s.authenticatedAppNames ?? [],
        userNames: s.userNames ?? [],
        userIds,
        unattributedReason: deriveUnattributedReason(userIds, authMethods),
        // Deduplicated across both columns: the two hold disjoint keys today
        // (each header rejects the other's key type), but a key reported twice
        // would render as two identical badges, so do not rely on that here.
        virtualKeys: [
          ...new Set([
            ...(s.virtualKeyIds ?? []),
            ...(s.passthroughVirtualKeyIds ?? []),
          ]),
        ]
          .map((id) => virtualKeyMap.get(id))
          .filter((key): key is InteractionVirtualKey => key !== undefined)
          .sort((a, b) => a.name.localeCompare(b.name)),
        lastUserMessagePreview: lastInteraction?.lastUserMessagePreview ?? null,
        lastInteractionType: lastInteraction?.lastInteractionType ?? null,
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
      {
        lastUserMessagePreview: string | null;
        lastInteractionType: string | null;
        claudeCodeTitle: string | null;
      }
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

    // Per-key top-N via LATERAL instead of one `session_id IN (...) OR
    // id IN (...)` query ranked with ROW_NUMBER(): the window form had to
    // materialize and sort EVERY interaction of every listed session —
    // request/response payloads included — before discarding all but the
    // first N, which pushed busy organizations into statement timeout. The
    // LATERAL branch is one (session_id, created_at DESC) index descent per
    // key that stops after N rows; sessionless interaction ids are a separate
    // primary-key lookup (each such row is its own "session", so N does not
    // apply). A uuid key that matches a row owned by a *different* session is
    // no longer fetched — the JS below grouped such rows under a key nobody
    // asked for and never read them.
    const sessionKeyList = sql.join(
      sessionKeys.map((k) => sql`${k}`),
      sql`, `,
    );
    const sessionlessBranch =
      uuidKeys.length > 0
        ? sql`
      UNION ALL
      SELECT id, session_id, thread_id, request, response, type, created_at,
             locked_chat_conversation_id
      FROM interactions
      WHERE id IN (${sql.join(
        uuidKeys.map((k) => sql`${k}::uuid`),
        sql`, `,
      )})
        AND session_id IS NULL`
        : sql``;

    // thread_id is selected so the chosen tip can be reconstructed from deltas.
    const interactionsResult = await db.execute<{
      id: string;
      session_id: string | null;
      thread_id: string | null;
      request: unknown;
      response: unknown;
      type: string;
      created_at: Date;
      // Selected so readInteractionRow can tell a locked-chat row from an
      // ordinary one; without it the guard cannot fire and a DEK envelope
      // would be handed to the server-key decryptor.
      locked_chat_conversation_id: string | null;
    }>(sql`
      -- id DESC tiebreak: turns within one session commonly land on the same
      -- millisecond, and created_at alone leaves their order undefined — which
      -- let an earlier turn be picked as the session's latest, showing a stale
      -- preview. Ids are monotonic UUIDv7, so they settle the tie by true
      -- insertion order (the same tiebreak the write path already uses to
      -- resolve a delta parent).
      SELECT t.id, t.session_id, t.thread_id, t.request, t.response, t.type,
             t.created_at, t.locked_chat_conversation_id
      FROM (SELECT DISTINCT k.key FROM unnest(ARRAY[${sessionKeyList}]::text[]) AS k(key)) keys
      CROSS JOIN LATERAL (
        SELECT id, session_id, thread_id, request, response, type, created_at,
               locked_chat_conversation_id
        FROM interactions
        WHERE session_id = keys.key
        ORDER BY created_at DESC, id DESC
        LIMIT ${INTERACTIONS_PER_SESSION}
      ) t
      ${sessionlessBranch}
      ORDER BY session_id, created_at DESC, id DESC
    `);

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Raw-SQL rows bypass the model select paths — decrypt before the JS
    // content scanning below.
    for (const row of interactionsResult.rows) {
      readInteractionRow(row);
    }
    // SPDX-SnippetEnd

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
      {
        lastUserMessagePreview: string | null;
        lastInteractionType: string | null;
        claudeCodeTitle: string | null;
      }
    >();

    // Group interactions by session key (sessionId or interaction id for single interactions)
    const groupedBySession = new Map<string, Array<(typeof interactions)[0]>>();
    for (const interaction of interactions) {
      const key = interaction.sessionId ?? interaction.id;
      const existing = groupedBySession.get(key) ?? [];
      existing.push(interaction);
      groupedBySession.set(key, existing);
    }

    // For each session, find the last "main" interaction and title. Selection
    // is pure, so it runs for every session first and the chosen tips are
    // reconstructed in one batch below — reconstructing inside this loop issued
    // a recursive ancestor query per session, i.e. one per row on the page.
    const selectedPerSession = new Map<
      string,
      {
        lastMainInteraction: (typeof interactions)[0] | null;
        claudeCodeTitle: string | null | undefined;
      }
    >();

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
            // OpenAI/Anthropic chat-completions format
            messages?: Array<{ content?: string | Array<unknown> }>;
            // OpenAI Responses format (e.g. Codex) carries turns in `input`
            input?: Array<unknown>;
            // Gemini format
            contents?: Array<{
              role?: string;
              parts?: Array<unknown>;
            }>;
          };

          // Check if request has valid content (a messages / input / contents
          // array with items) across all supported provider request shapes.
          const hasOpenAiContent =
            Array.isArray(request?.messages) && request.messages.length > 0;
          const hasResponsesContent =
            Array.isArray(request?.input) && request.input.length > 0;
          const hasGeminiContent =
            Array.isArray(request?.contents) && request.contents.length > 0;

          if (hasOpenAiContent || hasResponsesContent || hasGeminiContent) {
            lastMainInteraction = interaction;
          }
        }

        // Early exit if we found both (undefined = not yet searched for title)
        if (lastMainInteraction && claudeCodeTitle !== undefined) {
          break;
        }
      }

      if (lastMainInteraction || claudeCodeTitle) {
        selectedPerSession.set(sessionKey, {
          lastMainInteraction,
          claudeCodeTitle,
        });
      }
    }

    // Reconstruct every chosen tip's full request from deltas in one pass (a
    // no-op for legacy/non-delta rows, which reconstructMany returns as-is).
    // Still at most one tip per session, now in a single ancestor query.
    const reconstructed = await InteractionDeltaManager.reconstructMany(
      [...selectedPerSession.values()]
        .map(({ lastMainInteraction }) => lastMainInteraction)
        .filter((tip): tip is (typeof interactions)[0] => tip !== null)
        .map((tip) => ({
          id: tip.id,
          threadId: tip.threadId,
          request: tip.request,
          processedRequest: null,
        })),
    );

    for (const [
      sessionKey,
      { lastMainInteraction, claudeCodeTitle },
    ] of selectedPerSession) {
      const tipRequest = lastMainInteraction
        ? (reconstructed.get(lastMainInteraction.id)?.request ??
          lastMainInteraction.request)
        : null;

      result.set(sessionKey, {
        lastUserMessagePreview: lastMainInteraction
          ? buildLastUserMessagePreview(tipRequest, lastMainInteraction.type)
          : null,
        lastInteractionType: lastMainInteraction?.type ?? null,
        claudeCodeTitle: claudeCodeTitle ?? null,
      });
    }

    return result;
  }

  /**
   * Number of distinct users with at least one attributed interaction since
   * `since`. Backs the `llm_active_users` gauge.
   *
   * Deliberately an aggregate: per-user identity is not exported to Prometheus
   * (a user_id label would multiply every LLM metric's series count by the size
   * of the org — the same reason external_agent_id is not a label). Per-user
   * detail belongs to the statistics API, which reads this table directly.
   */
  static async countDistinctActiveUsersSince(since: Date): Promise<number> {
    const [row] = await db
      .select({
        activeUsers: sql<number>`CAST(COUNT(DISTINCT ${schema.interactionsTable.userId}) AS INTEGER)`,
      })
      .from(schema.interactionsTable)
      .where(
        and(
          gte(schema.interactionsTable.createdAt, since),
          isNotNull(schema.interactionsTable.userId),
        ),
      );

    return Number(row?.activeUsers) || 0;
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
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // Decrypt in place BEFORE delta folding — every list read path funnels
  // through here, and callers keep using the same row objects afterwards.
  for (const row of rows) {
    readInteractionRow(row);
  }
  // SPDX-SnippetEnd
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

/**
 * Derive the short last-user-message preview shown by the sessions listing,
 * using the same provider-aware parsing as the interaction detail view.
 * Returns null when the request has no extractable user text or an
 * unsupported provider shape — the listing renders its fallback instead.
 */
function buildLastUserMessagePreview(
  request: unknown,
  type: string,
): string | null {
  try {
    const interaction = new DynamicInteraction({
      request,
      response: {},
      type,
    } as never);
    const message = interaction.getLastUserMessage().trim();
    if (!message) {
      return null;
    }
    let preview = message.slice(0, LAST_USER_MESSAGE_PREVIEW_MAX_LENGTH);
    // Don't leave half a surrogate pair at the truncation point.
    const lastCode = preview.charCodeAt(preview.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      preview = preview.slice(0, -1);
    }
    return preview;
  } catch {
    return null;
  }
}

/**
 * Explain an unattributed session from the credentials its interactions used.
 *
 * Returns null when the session has users. Ordering matters: a session can mix
 * auth methods, and the most specific explanation wins over `unknown`.
 */
function deriveUnattributedReason(
  userIds: string[],
  authMethods: InteractionAuthMethod[],
): SessionUnattributedReason | null {
  if (userIds.length > 0) {
    return null;
  }
  const methods = new Set(authMethods);
  // A virtual key that reached here is org-scoped by definition: a personal
  // one sets the interaction's user, which would have populated userIds.
  if (methods.has("virtual_key")) {
    return "shared_virtual_key";
  }
  if (methods.has("provider_key")) {
    return "provider_key";
  }
  if (methods.has("oauth_client_credentials")) {
    return "client_credentials";
  }
  if (methods.has("internal")) {
    return "internal";
  }
  return "unknown";
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
