import type {
  ClientFilter,
  CursorQuery,
  InteractionSource,
  PaginationQuery,
} from "@archestra/shared";
import {
  clientFilterToAgentIds,
  DynamicInteraction,
  isClaudeSessionSource,
  isLogContentNotStored,
  LEGACY_CLAUDE_CODE_SESSION_SOURCE,
  TimeInMs,
} from "@archestra/shared";
import { isOpenCodeFamilySessionSource } from "@archestra/shared/opencode-family";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  min,
  or,
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { CacheKey, cacheManager, LRUCacheManager } from "@/cache-manager";
import {
  encryptInteractionContent,
  readInteractionRow,
  restoreWrittenInteractionContent,
} from "@/content-encryption/audit-rows";
import type { EncryptedChatAuditContext } from "@/content-encryption/encrypted-chat";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import {
  type CursorPaginatedResult,
  createPaginatedResult,
  decodeCursor,
  encodeCursor,
  type PaginatedResult,
} from "@/database/utils/pagination";
import { buildTokenizedSearchFilter } from "@/database/utils/text-search";
import {
  resolveLogContentMode,
  withholdInteractionContent,
} from "@/log-content";
import logger from "@/logging";
import type {
  InsertInteraction,
  Interaction,
  InteractionAuthMethod,
  InteractionSummary,
  InteractionVirtualKey,
  LimitEntityType,
  SessionSummary,
  SessionUnattributedReason,
  SortingQuery,
  UserInfo,
} from "@/types";
import {
  AgentTypeSchema,
  InteractionAuthMethodSchema,
  LAST_USER_MESSAGE_PREVIEW_MAX_LENGTH,
  normalizeInteractionResponse,
} from "@/types";
import type { AttributionLabels } from "@/types/attribution-label";
import {
  type InteractionSessionPreview,
  InteractionSessionPreviewSchema,
} from "@/types/interaction";
import { trackBackgroundWork } from "@/utils/background-work";
import { retryOnceOnDeadlock } from "@/utils/deadlock";
import { repairLoneSurrogateText } from "@/utils/lone-surrogates";
import { hasUnavailableMediaCost } from "@/utils/media-usage";
import { sizedChunks } from "@/utils/sized-chunks";
import { isUuid, uuidv7 } from "@/utils/uuid";
import AgentModel from "./agent";
import AgentTeamModel from "./agent-team";
import AgentUsageModel from "./agent-usage";
import ConversationChatErrorModel from "./conversation-chat-error";
import InteractionBillingModel from "./interaction-billing";
import InteractionDeltaManager from "./interaction-delta-manager";
import InteractionSessionHeadModel from "./interaction-session-head";
import InteractionUserActivityModel from "./interaction-user-activity";
import LimitModel from "./limit";
import { interactionBelongsToOrganization } from "./log-organization";
import VirtualApiKeyModel from "./virtual-api-key";

/**
 * How long a session total stays reusable across pages of the same filter set.
 * Long enough to cover a client paging through the whole result, short enough
 * that a total on screen is never meaningfully behind the table.
 */
const SESSION_TOTAL_CACHE_TTL_MS = 30 * TimeInMs.Second;

/**
 * Rows read per step of the session-key walk (see findSessionKeysForPage).
 * Sized so a default page of sessions is normally covered by the first step:
 * interactions-per-session averages a small single digit, and over-reading a
 * few hundred indexed rows is far cheaper than a second round trip.
 */
const SESSION_SCAN_BATCH_ROWS = 500;

/**
 * Ceiling on rows the walk will read before giving up and grouping the whole
 * table instead. Only reached when a filter matches very few sessions spread
 * over very many rows, where the walk would be the slower of the two.
 */
const SESSION_SCAN_MAX_ROWS = 20_000;

/**
 * How many of a session's newest rows a preview lookup reads past guardrail
 * calls; a longer run keeps the turn the sample found.
 */
const GUARDRAIL_SKIP_SCAN_ROWS = 200;

/** Rows per UPDATE when the session-preview backfill stores previews. */
const SESSION_PREVIEW_UPDATE_ROWS = 50;

/**
 * A row of a thread's skeleton as fillThreadSessionPreviews lists it (raw
 * SQL, snake_case): no payload, just what the fold order and the chunks need.
 */
type ThreadSkeletonRow = {
  id: string;
  parent_id: string | null;
  bytes: number | null;
  missing: boolean;
};

/** A thread's row with its payload, as one chunk of the thread fill loads it. */
type ThreadChunkRow = {
  id: string;
  parentId: string | null;
  threadId: string | null;
  requestSharedPrefix: number | null;
  request: unknown;
  source: InteractionSource | null;
  sessionSource: string | null;
  type: string;
  encryptedChatConversationId: string | null;
};

/**
 * Session totals keyed by filter set (see getSessions). Per-pod and in-process
 * on purpose: the value is cheap to recompute on a miss, so it is not worth a
 * round-trip to the distributed cache to share it between pods. Bounded well
 * above the number of distinct filter combinations in flight at once.
 */
/**
 * Returned by the session-list condition builder when the caller can reach
 * no agents at all. A distinct value rather than `undefined`, which already
 * means "no predicates" — returning that for a denial would list everything.
 */
const SESSION_ACCESS_DENIED = Symbol("session-access-denied");

/**
 * The logs user filter's default list (most active users first) is cached per
 * organization in the distributed cache. A ready activity summary avoids the
 * history scan; incomplete summaries use the exact aggregate. Stored at the
 * endpoint's maximum size so every requested limit is a prefix of the same entry.
 */
const USER_FILTER_OPTIONS_CACHE_TTL_MS = 30 * TimeInMs.Second;
const USER_FILTER_OPTIONS_MAX = 100;

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

/** A guardrail's own model call (e.g. an annotator consult) inside the session it judges. */
function isGuardrailSource(source: string | null): boolean {
  return source?.startsWith("guardrail:") ?? false;
}

/**
 * Detects if a request is a "main" request or "subagent" request.
 *
 * Applies to Claude agentic sources and OpenCode sessions. Every other source
 * is "main".
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
  if (source?.startsWith("chat:") || isGuardrailSource(source)) {
    return "subagent";
  }

  if (source === "opencode:main" || source === "kilo:main") return "main";
  if (source?.startsWith("opencode:") || source?.startsWith("kilo:")) {
    return "subagent";
  }

  if (isOpenCodeFamilySessionSource(sessionSource)) {
    return computeOpenCodeRequestType(request);
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

function computeOpenCodeRequestType(request: unknown): "main" | "subagent" {
  const req = request as {
    system?: string | Array<{ text?: string; type?: string }>;
    systemInstruction?: { parts?: Array<{ text?: string; type?: string }> };
    instructions?: string;
    tools?: Array<{
      name?: string;
      function?: { name?: string };
      functionDeclarations?: Array<{ name?: string }>;
    }>;
    messages?: Array<{
      content: string | Array<{ text?: string; type?: string }>;
      role: string;
    }>;
  };
  const system = [
    getMessageText(req.system),
    getMessageText(req.systemInstruction?.parts),
    req.instructions ?? "",
    ...(req.messages ?? [])
      .filter((message) => message.role === "system")
      .map((message) => getMessageText(message.content)),
  ].join("\n");
  if (/title generator/i.test(system)) return "subagent";

  const toolNames = (req.tools ?? [])
    .flatMap((tool) => [
      tool.function?.name ?? tool.name ?? "",
      ...(tool.functionDeclarations ?? []).map(
        (declaration) => declaration.name ?? "",
      ),
    ])
    .filter((name) => name.length > 0);
  if (toolNames.length === 0) return "subagent";
  const hasSpawn = toolNames.some(
    (name) =>
      name === "task" || name.endsWith(":task") || name.endsWith(".task"),
  );
  return hasSpawn ? "main" : "subagent";
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
/** The columns every interaction write needs back from the database. */
type StoredInteractionKey = Pick<
  typeof schema.interactionsTable.$inferSelect,
  "id" | "profileId" | "createdAt"
>;

const interactionKeyColumns = {
  id: schema.interactionsTable.id,
  profileId: schema.interactionsTable.profileId,
  createdAt: schema.interactionsTable.createdAt,
};

function stripUnstorableChars<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return repairLoneSurrogateText(
      value.includes("\u0000") ? value.replaceAll("\u0000", "") : value,
    ) as T;
  }
  // Structure-sharing: a clean subtree, the common case, is returned by
  // reference instead of being copied.
  if (Array.isArray(value)) {
    let result: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const stripped = stripUnstorableChars(value[i]);
      if (stripped !== value[i]) {
        result ??= value.slice();
        result[i] = stripped;
      }
    }
    return (result ?? value) as T;
  }
  if (typeof value === "object") {
    let result: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(value)) {
      const stripped = stripUnstorableChars(v);
      if (stripped !== v) {
        if (!result) result = { ...(value as Record<string, unknown>) };
        result[k] = stripped;
      }
    }
    return (result ?? value) as T;
  }
  return value;
}

/**
 * The rows of one session, by the key the session list gives it: a session's
 * own `session_id`, or, for a request logged without one, that request's id —
 * such a request is a session of its own, the same `COALESCE(session_id, id)`
 * key the session list groups by. Only a uuid can be a request id, so any
 * other key matches by `session_id` alone, and the two branches stay on the
 * session and primary-key indexes.
 */
function matchesSessionKey(sessionKey: string): SQL {
  const t = schema.interactionsTable;
  const sessionRows = eq(t.sessionId, sessionKey);
  if (!isUuid(sessionKey)) return sessionRows;
  return or(sessionRows, and(isNull(t.sessionId), eq(t.id, sessionKey))) as SQL;
}

class InteractionModel {
  /** Whether the organization has any LLM request logged under a session. */
  static async existsBySessionId(params: {
    organizationId: string;
    sessionId: string;
  }): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.interactionsTable.id })
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.sessionId, params.sessionId),
          interactionBelongsToOrganization(params.organizationId),
        ),
      )
      .limit(1);
    return result !== undefined;
  }

  /** The ones among `sessionIds` that have logged requests in the organization. */
  static async findLoggedSessionIds(params: {
    organizationId: string;
    sessionIds: string[];
    ownUserId?: string;
  }): Promise<Set<string>> {
    if (params.sessionIds.length === 0) return new Set();
    const rows = await db
      .selectDistinct({ sessionId: schema.interactionsTable.sessionId })
      .from(schema.interactionsTable)
      .where(
        and(
          inArray(schema.interactionsTable.sessionId, params.sessionIds),
          interactionBelongsToOrganization(params.organizationId),
          params.ownUserId
            ? eq(schema.interactionsTable.userId, params.ownUserId)
            : undefined,
        ),
      );
    return new Set(
      rows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
    );
  }

  static async existsByRunId(runId: string): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.interactionsTable.id })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.runId, runId))
      .limit(1);
    return result !== undefined;
  }

  /**
   * @param auditContext when present, this interaction belongs to an encrypted-chat
   * conversation: its content columns are encrypted under that conversation's
   * browser-held key and the row is stamped with the discriminator, instead of
   * being encrypted under the server key (or left plaintext).
   *
   * Do not mutate the returned row: for a delta-encoded request its
   * `request.messages` entries are shared with the reconstruction cache.
   */
  static async create(
    data: InsertInteraction,
    auditContext?: EncryptedChatAuditContext | null,
  ) {
    const interaction = await InteractionModel.write({
      data,
      auditContext,
      returnRow: true,
    });
    return interaction as typeof schema.interactionsTable.$inferSelect;
  }

  /**
   * {@link create} for writers that do not read the stored row back: the
   * database returns only its key columns instead of the whole row.
   */
  static async record(
    data: InsertInteraction,
    auditContext?: EncryptedChatAuditContext | null,
  ): Promise<void> {
    await InteractionModel.write({ data, auditContext, returnRow: false });
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
      organizationId?: string;
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

    if (filters?.organizationId) {
      conditions.push(interactionBelongsToOrganization(filters.organizationId));
    }

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
      conditions.push(matchesSessionKey(filters.sessionId));
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
   * Paginated interaction metadata for list views. Content columns are
   * deliberately absent: they dominate row size and require decryption and
   * delta reconstruction, while list rows render only scalar usage metadata.
   */
  static async findSummariesPaginated(params: {
    pagination: PaginationQuery;
    sorting?: SortingQuery;
    requestingUserId?: string;
    isAgentAdmin?: boolean;
    filters?: {
      organizationId?: string;
      profileId?: string;
      externalAgentId?: string;
      userId?: string;
      sessionId?: string;
      startDate?: Date;
      endDate?: Date;
    };
  }): Promise<PaginatedResult<InteractionSummary>> {
    const { pagination, sorting, requestingUserId, isAgentAdmin, filters } =
      params;
    const conditions: SQL[] = [];
    if (filters?.organizationId) {
      conditions.push(interactionBelongsToOrganization(filters.organizationId));
    }
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
    if (filters?.profileId) {
      conditions.push(
        eq(schema.interactionsTable.profileId, filters.profileId),
      );
    }
    if (filters?.externalAgentId) {
      conditions.push(
        eq(schema.interactionsTable.externalAgentId, filters.externalAgentId),
      );
    }
    if (filters?.userId) {
      conditions.push(eq(schema.interactionsTable.userId, filters.userId));
    }
    if (filters?.sessionId) {
      conditions.push(matchesSessionKey(filters.sessionId));
    }
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
          id: schema.interactionsTable.id,
          profileId: schema.agentsTable.id,
          externalAgentId: schema.interactionsTable.externalAgentId,
          sessionId: schema.interactionsTable.sessionId,
          type: schema.interactionsTable.type,
          model: schema.interactionsTable.model,
          baselineModel: schema.interactionsTable.baselineModel,
          billingMode: schema.interactionsTable.billingMode,
          inputTokens: schema.interactionsTable.inputTokens,
          inputTokensEstimated: schema.interactionsTable.inputTokensEstimated,
          outputTokens: schema.interactionsTable.outputTokens,
          cacheReadTokens: schema.interactionsTable.cacheReadTokens,
          cacheWriteTokens: schema.interactionsTable.cacheWriteTokens,
          cost: schema.interactionsTable.cost,
          baselineCost: schema.interactionsTable.baselineCost,
          durationMs: schema.interactionsTable.durationMs,
          createdAt: schema.interactionsTable.createdAt,
          providerApiKeyId: schema.interactionsTable.providerApiKeyId,
          modelPoolId: schema.interactionsTable.modelPoolId,
          attempt: schema.interactionsTable.attempt,
          attemptOutcome: schema.interactionsTable.attemptOutcome,
          failureReason: schema.interactionsTable.failureReason,
          source: schema.interactionsTable.source,
          // The row's small stored preview (not the payload), so the trace can
          // name a turn by the prompt it served; decrypted below.
          attributionLabels: schema.interactionsTable.attributionLabels,
          sessionPreview: schema.interactionsTable.sessionPreview,
          encryptedChatConversationId:
            schema.interactionsTable.encryptedChatConversationId,
          requestType: sql<"main" | "subagent">`
            CASE
              WHEN ${schema.interactionsTable.source} IN ('opencode:main', 'kilo:main')
              THEN 'main'
              WHEN ${schema.interactionsTable.source} IN ('opencode:subagent', 'opencode:title', 'opencode:compaction', 'kilo:subagent', 'kilo:title', 'kilo:compaction')
                OR ${schema.interactionsTable.source} LIKE 'guardrail:%'
              THEN 'subagent'
              WHEN ${schema.interactionsTable.sessionSource} IN ('opencode_session', 'kilo_session')
                AND LOWER(CONCAT_WS('\n',
                  ${schema.interactionsTable.request}->>'system',
                  ${schema.interactionsTable.request}->>'instructions',
                  ${schema.interactionsTable.request}#>>'{systemInstruction,parts,0,text}'
                )) LIKE '%title generator%'
              THEN 'subagent'
              WHEN ${schema.interactionsTable.sessionSource} IN ('opencode_session', 'kilo_session')
                AND ${schema.interactionsTable.request} ? 'tools'
                AND NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(COALESCE(${schema.interactionsTable.request}->'tools', '[]'::jsonb)) tool
                  WHERE tool->>'name' = 'task'
                    OR tool->'function'->>'name' = 'task'
                    OR EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(COALESCE(tool->'functionDeclarations', '[]'::jsonb)) declaration
                      WHERE declaration->>'name' = 'task'
                    )
                )
              THEN 'subagent'
              ELSE 'main'
            END`,
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
        .orderBy(InteractionModel.getOrderByClause(sorting))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.interactionsTable)
        .where(whereClause),
    ]);

    const agentNamesMap = await getAgentNamesById(
      extractAllAgentIdsFromExternalAgentIds(
        rows.map((row) => row.externalAgentId),
      ),
    );
    return createPaginatedResult(
      rows.map(({ sessionPreview, encryptedChatConversationId, ...row }) => {
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        // Locked-safe: a locked chat's preview stays a sentinel, which then
        // fails the schema check and names nothing.
        const read = readInteractionRow({
          sessionPreview,
          encryptedChatConversationId,
        });
        // SPDX-SnippetEnd
        const preview = InteractionSessionPreviewSchema.safeParse(
          read.sessionPreview,
        );
        return {
          ...row,
          externalAgentIdLabel: resolveExternalAgentIdLabel(
            row.externalAgentId,
            agentNamesMap,
          ),
          userMessagePreview: preview.success
            ? preview.data.lastUserMessagePreview
            : null,
          responseToolNames: preview.success
            ? (preview.data.responseToolNames ?? null)
            : null,
          responseTextPreview: preview.success
            ? (preview.data.responseTextPreview ?? null)
            : null,
        };
      }),
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

  /**
   * The prompt size of a chat conversation's latest turn, so its context
   * indicator can show on load instead of waiting for the next reply.
   * Adapters store uncached input apart from cache reads and writes, so the
   * three add up to the whole prompt — the same figure the live stream sends.
   */
  static async findLatestChatContextUsage(
    conversationId: string,
  ): Promise<{ tokens: number; createdAt: Date } | null> {
    const [row] = await db
      .select({
        inputTokens: schema.interactionsTable.inputTokens,
        cacheReadTokens: schema.interactionsTable.cacheReadTokens,
        cacheWriteTokens: schema.interactionsTable.cacheWriteTokens,
        createdAt: schema.interactionsTable.createdAt,
      })
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.sessionId, conversationId),
          eq(schema.interactionsTable.source, "chat"),
          isNotNull(schema.interactionsTable.inputTokens),
        ),
      )
      .orderBy(desc(schema.interactionsTable.createdAt))
      .limit(1);
    if (!row) return null;
    return {
      tokens:
        (row.inputTokens ?? 0) +
        (row.cacheReadTokens ?? 0) +
        (row.cacheWriteTokens ?? 0),
      createdAt: row.createdAt,
    };
  }

  static async findById(
    idOrScope: string | { id: string; organizationId: string },
    userId?: string,
    isAgentAdmin?: boolean,
  ): Promise<Interaction | null> {
    const id = typeof idOrScope === "string" ? idOrScope : idOrScope.id;
    const organizationId =
      typeof idOrScope === "string" ? undefined : idOrScope.organizationId;
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
      .where(
        and(
          eq(schema.interactionsTable.id, id),
          ...(organizationId
            ? [interactionBelongsToOrganization(organizationId)]
            : []),
        ),
      );

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
      const hasAccess = await AgentTeamModel.userHasAgentAccess({
        userId: userId,
        agentId: interaction.profileId,
        isAgentAdmin: false,
      });
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
        deleted = await InteractionUserActivityModel.deleteExpiredBatch({
          retentionDays: params.retentionDays,
          batchSize,
        });
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
  static async getUniqueExternalAgentIds(params: {
    requestingUserId?: string;
    isAgentAdmin?: boolean;
    /** Narrow to rows attributed to this user (the own-logs log:read view). */
    ownUserId?: string;
    organizationId?: string;
  }): Promise<{ id: string; displayName: string }[]> {
    const { requestingUserId, isAgentAdmin, ownUserId, organizationId } =
      params;
    // Build where clause for access control
    const conditions: SQL[] = [
      isNotNull(schema.interactionsTable.externalAgentId),
    ];
    if (organizationId) {
      conditions.push(interactionBelongsToOrganization(organizationId));
    }
    if (ownUserId) {
      conditions.push(eq(schema.interactionsTable.userId, ownUserId));
    }

    const accessibleAgentIds =
      requestingUserId && !isAgentAdmin
        ? await AgentTeamModel.getUserAccessibleAgentIds(
            requestingUserId,
            false,
          )
        : null;
    if (accessibleAgentIds) {
      if (accessibleAgentIds.length === 0) {
        return [];
      }
      conditions.push(
        inArray(schema.interactionsTable.profileId, accessibleAgentIds),
      );
    }

    // A caller narrowed to their own rows or accessible agents reaches them
    // through the user_id / profile_id indexes, so a plain DISTINCT is cheap;
    // a skip scan there would walk the whole external_agent_id index. The
    // org-wide view walks that index one distinct value at a time instead of
    // reading every row.
    const where = and(...conditions) ?? sql`true`;
    const externalAgentIds =
      ownUserId || accessibleAgentIds
        ? await InteractionModel.distinctExternalAgentIds(where)
        : await InteractionModel.skipScanExternalAgentIds(where);

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
  static async getUniqueUserIds(params: {
    requestingUserId?: string;
    isAgentAdmin?: boolean;
    organizationId?: string;
    limit?: number;
  }): Promise<UserInfo[]> {
    const { requestingUserId, isAgentAdmin, organizationId, limit } = params;
    // Build where clause for access control
    const conditions: SQL[] = [isNotNull(schema.interactionsTable.userId)];
    if (organizationId) {
      conditions.push(interactionBelongsToOrganization(organizationId));
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

    // Put the most active users first so a large organization's filter surfaces
    // likely choices before its alphabetical tail. Names and ids close ties to
    // keep the order stable between requests.
    // Aggregate the log before joining names so user metadata is joined once
    // per distinct user instead of once per interaction.
    const activity = db
      .select({
        userId: schema.interactionsTable.userId,
        activityCount: count().as("activity_count"),
      })
      .from(schema.interactionsTable)
      .where(and(...conditions))
      .groupBy(schema.interactionsTable.userId)
      .as("user_activity");
    const query = db
      .select({
        userId: activity.userId,
        userName: schema.usersTable.name,
      })
      .from(activity)
      .innerJoin(schema.usersTable, eq(activity.userId, schema.usersTable.id))
      .orderBy(
        desc(activity.activityCount),
        asc(schema.usersTable.name),
        asc(activity.userId),
      )
      .$dynamic();
    const result = await (limit === undefined ? query : query.limit(limit));

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
   * Users for the logs user filter: at most `limit` users with at least one
   * interaction in the organization.
   *
   * Without `search` or `ids`, returns the most active users first, from a
   * per-organization cache (see USER_FILTER_OPTIONS_CACHE_TTL_MS). With them,
   * matches users by name (by id when the name is empty), or by exact id, in
   * byte order of name like the member picker (not locale order: non-ASCII
   * names sort by their UTF-8 bytes). That path probes the log per
   * candidate user through the `user_id` index instead of aggregating the
   * whole log.
   */
  static async getUserFilterOptions(params: {
    organizationId: string;
    search?: string;
    ids?: string[];
    limit: number;
  }): Promise<UserInfo[]> {
    const limit = Math.min(params.limit, USER_FILTER_OPTIONS_MAX);
    if (params.search?.trim() || params.ids) {
      return InteractionModel.findUsersWithInteractions({
        organizationId: params.organizationId,
        search: params.search,
        ids: params.ids,
        limit,
      });
    }
    const mostActive = await InteractionModel.getCachedMostActiveUsers(
      params.organizationId,
    );
    return mostActive.slice(0, limit);
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

      // Audio/image counts cannot be repriced using generic text-token tariffs.
      if (hasUnavailableMediaCost(interaction.response)) return;

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

      // If profileId is null (agent was deleted), we can't update usage - skip silently
      if (!interaction.profileId) {
        logger.info(
          `Interaction ${interaction.id} has null profileId (agent deleted) - skipping limit update`,
        );
        return;
      }
      // A credential's billing team takes the place of the agent's teams.
      const teamIds = interaction.billingTeamId
        ? [interaction.billingTeamId]
        : await AgentTeamModel.getTeamsForAgent(interaction.profileId);
      if (teamIds.length === 0) {
        logger.warn(
          `Profile ${interaction.profileId} has no team assignments for interaction ${interaction.id}`,
        );
      }

      // A passthrough virtual key accrues usage independently from the standard
      // virtual key (distinct limit entities), so record against both when present.
      const entityRefs: Array<{
        entityType: LimitEntityType;
        entityId: string | null | undefined;
      }> = [
        // The billing team pays instead of the caller, so a team-billed
        // interaction leaves the caller's personal limit untouched.
        {
          entityType: "user",
          entityId: interaction.billingTeamId ? null : interaction.userId,
        },
        { entityType: "virtual_key", entityId: interaction.virtualKeyId },
        {
          entityType: "llm_oauth_client",
          entityId: interaction.authenticatedAppId,
        },
        {
          entityType: "virtual_key",
          entityId: interaction.passthroughVirtualKeyId,
        },
        { entityType: "environment", entityId: interaction.environmentId },
      ];
      const entities = entityRefs.flatMap(({ entityType, entityId }) =>
        entityId ? [{ entityType, entityId }] : [],
      );

      await LimitModel.recordInteractionTokenUsage({
        agentId: interaction.profileId,
        teamIds,
        entities,
        model,
        inputTokens,
        outputTokens,
      });
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
      organizationId?: string;
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
    const access = await InteractionModel.buildSessionConditions(
      requestingUserId,
      isAgentAdmin,
      filters,
    );
    if (access === SESSION_ACCESS_DENIED) {
      return createPaginatedResult([], 0, pagination);
    }
    const whereClause = access;

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
      filters?.organizationId ?? null,
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
      InteractionModel.findSessionKeysForPage(whereClause, pagination),
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

    const sessions = await InteractionModel.summarizeSessionPage(
      sessionPage,
      whereClause,
    );

    return createPaginatedResult(sessions, Number(total), pagination);
  }

  /**
   * The session keys for one page, most recently active first.
   *
   * Grouping the whole table to produce twenty keys meant every page paid a
   * sequential scan of `interactions` plus a sort of one row per interaction —
   * on a table whose row count grows with every proxied call, and large enough
   * that the sort spilled to disk. Nothing about a page of recent sessions
   * needs that: walking `interactions_created_at_idx` newest-first and taking
   * distinct session keys in the order they first appear yields exactly the
   * same ordering, because the first row seen for a session IS that session's
   * most recent one. The scan stops as soon as the page is covered, so the
   * cost tracks the page, not the history.
   *
   * Falls back to the whole-table grouping if a page cannot be filled within
   * SESSION_SCAN_MAX_ROWS — a pathological case (a filter matching very few
   * sessions spread over very many rows) where the walk would be the slower of
   * the two. Correctness is identical either way.
   */

  /**
   * The same session list, walked by cursor instead of offset.
   *
   * Two costs disappear. There is no total, so a page stops scanning every
   * interaction in the table to count distinct sessions for a page number.
   * And there is no offset, so a page deep in the log costs what the first
   * page costs, instead of walking every session above it.
   *
   * Phase 1 changes shape entirely. The offset walk reads batches of
   * interactions and dedupes session keys in memory, which needs
   * `offset + limit` keys in hand before it can serve page N. A cursor
   * cannot work that way, and does not need to: a session's place in the
   * list is its newest interaction, so the list *is* the rows that have no
   * newer sibling in their own session. Selecting those directly gives each
   * session exactly once, in the right order, with no dedupe pass and no
   * whole-table grouping to fall back to.
   */
  static async getSessionsCursor(
    cursorQuery: CursorQuery,
    requestingUserId?: string,
    isAgentAdmin?: boolean,
    filters?: {
      organizationId?: string;
      profileId?: string;
      userId?: string;
      source?: InteractionSource;
      client?: ClientFilter;
      externalAgentId?: string;
      sessionId?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<CursorPaginatedResult<SessionSummary>> {
    const emptyPage = (): CursorPaginatedResult<SessionSummary> => ({
      data: [],
      pagination: {
        limit: cursorQuery.limit,
        hasNext: false,
        nextCursor: null,
      },
    });

    const access = await InteractionModel.buildSessionConditions(
      requestingUserId,
      isAgentAdmin,
      filters ? { ...filters, organizationId: undefined } : undefined,
    );
    if (access === SESSION_ACCESS_DENIED) {
      return emptyPage();
    }
    const headWhereClause = filters?.organizationId
      ? and(
          access,
          InteractionModel.sessionHeadOrganizationCondition(
            filters.organizationId,
          ),
        )
      : access;

    // One row past the page is fetched so its presence can answer "is there
    // another page" — the job the total count used to do. The stored heads
    // serve the page once they cover all history; until the startup backfill
    // finishes, the interactions scan gives the same answer more slowly.
    const heads = (await InteractionSessionHeadModel.isComplete())
      ? await InteractionModel.findStoredSessionHeadsForCursor(
          headWhereClause,
          cursorQuery,
          filters,
        )
      : await InteractionModel.findSessionHeadsForCursor(
          headWhereClause,
          cursorQuery,
        );
    const hasNext = heads.length > cursorQuery.limit;
    const pageRows = hasNext ? heads.slice(0, cursorQuery.limit) : heads;
    if (pageRows.length === 0) {
      return emptyPage();
    }

    // The page's session keys bound phase 2 to a few hundred rows, but a
    // session can hold rows of another organization, so the organization
    // check still applies there. It uses the primary-key probes rather than
    // the shared predicate, whose owner sets read every agent of the
    // organization on every request.
    const summaries = await InteractionModel.summarizeSessionPage(
      pageRows.map(({ sessionId, interactionId }) => ({
        sessionId,
        interactionId,
      })),
      headWhereClause,
    );

    // The summary query groups, so its row order is not the head order. Emit
    // in head order instead, because that is the order the cursor is cut from
    // — returning them in any other order would make the next page skip or
    // repeat rows.
    const byKey = new Map(
      summaries.map((summary) => [
        summary.sessionId ?? summary.interactionId ?? "",
        summary,
      ]),
    );
    const data = pageRows.flatMap((row) => {
      const summary = byKey.get(row.sessionId ?? row.interactionId ?? "");
      return summary ? [summary] : [];
    });

    const last = pageRows[pageRows.length - 1];

    return {
      data,
      pagination: {
        limit: cursorQuery.limit,
        hasNext,
        // No cursor past the end: it could only produce an empty page.
        nextCursor:
          hasNext && last
            ? encodeCursor({
                value: last.headCreatedAt.toISOString(),
                id: last.headId,
              })
            : null,
      },
    };
  }

  /**
   * Rows with no `session_preview`, newest first, one keyset page at a time.
   * Rows written before migration 0562 have none, and the session list has to
   * load, decrypt and often rebuild each one's full request in its place.
   *
   * Encrypted-chat rows are left out. Their content is keyed to a browser the
   * server does not hold, so nothing can be derived from it.
   *
   * `requestBytes` is the stored request's size, so the caller can cut the page
   * to a memory budget before loading anything. `cursor` is the row's
   * `(created_at, id)` with created_at as text: a JS Date drops microseconds,
   * and resuming from a truncated time would read the same rows again.
   */
  static async findRowsMissingSessionPreview(params: {
    before: { createdAt: string; id: string } | null;
    limit: number;
  }): Promise<
    Array<{
      id: string;
      createdAt: string;
      requestBytes: number;
      sessionId: string | null;
      threadId: string | null;
    }>
  > {
    const before = params.before
      ? sql`AND (created_at, id) < (${params.before.createdAt}::timestamp, ${params.before.id}::uuid)`
      : sql``;
    // Matches the predicate and key order of the partial index built in
    // database/index-maintenance.ts, so this walks only the rows still to do.
    // session_id and thread_id tell the caller which rows are delta-encoded
    // and belong to which thread (see fillThreadSessionPreviews).
    const { rows } = await db.execute<{
      id: string;
      created_at: string;
      request_bytes: number | null;
      session_id: string | null;
      thread_id: string | null;
    }>(sql`
      SELECT id, created_at::text AS created_at,
             pg_column_size(request) AS request_bytes,
             session_id, thread_id
      FROM interactions
      WHERE session_preview IS NULL
        AND encrypted_chat_conversation_id IS NULL
        ${before}
      ORDER BY created_at DESC, id DESC
      LIMIT ${params.limit}
    `);
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      requestBytes: Number(row.request_bytes ?? 0),
      sessionId: row.session_id,
      threadId: row.thread_id,
    }));
  }

  /**
   * Store the session preview each of these rows would have been written with,
   * so the session list stops rebuilding it on every read.
   *
   * It is derived exactly as {@link create} derives it: flags from the stored
   * request, the last-user-message text from the full request. That is also
   * exactly what the list computes for a row without one, so filling it
   * changes no output, only the cost. A row that already has a preview is
   * never overwritten, which keeps concurrent runs harmless.
   *
   * Meant for rows that store their whole request. A delta-encoded row is
   * reconstructed here too, but each one loads and folds its entire chain;
   * the backfill sends those rows through {@link fillThreadSessionPreviews},
   * which folds a thread once.
   *
   * Returns how many rows were filled.
   */
  static async fillSessionPreviews(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const t = schema.interactionsTable;

    const rows = await db
      .select({
        id: t.id,
        threadId: t.threadId,
        request: t.request,
        source: t.source,
        sessionSource: t.sessionSource,
        type: t.type,
        encryptedChatConversationId: t.encryptedChatConversationId,
      })
      .from(t)
      .where(
        and(
          inArray(t.id, ids),
          isNull(t.sessionPreview),
          isNull(t.encryptedChatConversationId),
        ),
      );
    if (rows.length === 0) return 0;
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    for (const row of rows) {
      readInteractionRow(row);
    }
    // SPDX-SnippetEnd

    const reconstructed = await InteractionDeltaManager.reconstructMany(
      rows.map((row) => ({
        id: row.id,
        threadId: row.threadId,
        request: row.request,
        processedRequest: null,
      })),
    );
    const responses = await InteractionModel.responsesFor(rows);
    return InteractionModel.storeSessionPreviews(
      rows.map((row) =>
        InteractionModel.sessionPreviewValue(
          row,
          reconstructed.get(row.id)?.request ?? row.request,
          responses.get(row.id) ?? null,
        ),
      ),
    );
  }

  /**
   * Fill the previews of every row of one delta-encoded thread that still
   * lacks one, in a single pass over the thread.
   *
   * A delta row stores only the messages new since its parent, so its preview
   * needs the request folded from its ancestors. Filling such rows a chunk at
   * a time, as {@link fillSessionPreviews} does, loads the chain of every row
   * in the chunk and folds one whole conversation per row; on Claude Code
   * sessions of hundreds of turns that exhausted the worker's heap. Here the
   * rows still missing a preview and the ancestors their folds need are
   * listed once without their payloads, then loaded parents first in chunks
   * bounded by rows and stored bytes and folded one from the previous, so a
   * thread of any size holds one chunk and one conversation at a time. A
   * thread can be many times the size of its conversation: it stores the
   * whole conversation again in a new head row whenever the client's tool
   * list changes.
   *
   * Ancestors are loaded whether or not they have a preview: a row written by
   * a pod on the previous build during the rollout that introduced previews
   * can sit between two rows that have one. A row that cannot be read fails
   * together with its descendants, which cannot be folded without it; the
   * rest of the thread is filled. Past `deadline` the fill stops between
   * chunks and reports `complete: false`; a later call resumes with the rows
   * still missing, their filled ancestors folded again on the way.
   */
  static async fillThreadSessionPreviews(params: {
    sessionId: string;
    threadId: string;
    chunkRows: number;
    chunkBytes: number;
    deadline?: number;
  }): Promise<{ filled: number; failed: number; complete: boolean }> {
    // The rows to fill plus the ancestors their folds need, without
    // payloads: the skeleton the fold walks and the chunks are cut from.
    const { rows: skeleton } = await db.execute<ThreadSkeletonRow>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM interactions
        WHERE session_id = ${params.sessionId}
          AND thread_id = ${params.threadId}
          AND session_preview IS NULL
          AND encrypted_chat_conversation_id IS NULL
        UNION
        SELECT i.id, i.parent_id FROM interactions i
        JOIN chain c ON i.id = c.parent_id
      )
      SELECT c.id, c.parent_id, pg_column_size(i.request) AS bytes,
             (i.session_preview IS NULL) AS missing
      FROM chain c JOIN interactions i ON i.id = c.id
      ORDER BY i.created_at, i.id
    `);
    if (!skeleton.some((row) => row.missing)) {
      return { filled: 0, failed: 0, complete: true };
    }
    // The listed order only settles siblings; parentsFirst puts every parent
    // ahead of its children, depth first, so a row's last child in this order
    // is its last child at all and the folder can drop the fold with it.
    const order = parentsFirst(skeleton);
    const folder = InteractionDeltaManager.threadFolder(
      order.map((row) => ({ id: row.id, parentId: row.parent_id })),
    );
    // Rows that could not be read or folded; their descendants cannot be
    // folded either, and parents come first.
    const unfoldable = new Set<string>();
    let filled = 0;
    let failed = 0;
    const chunks = [
      ...sizedChunks(
        order,
        { maxRows: params.chunkRows, maxBytes: params.chunkBytes },
        (row) => Number(row.bytes ?? 0),
      ),
    ];
    for (const [index, chunk] of chunks.entries()) {
      if (
        index > 0 &&
        params.deadline !== undefined &&
        Date.now() >= params.deadline
      ) {
        return { filled, failed, complete: false };
      }
      let loaded: ThreadChunkRow[];
      let responses: Map<string, unknown>;
      const unreadable = new Set<string>();
      try {
        const t = schema.interactionsTable;
        loaded = await db
          .select({
            id: t.id,
            parentId: t.parentId,
            threadId: t.threadId,
            requestSharedPrefix: t.requestSharedPrefix,
            request: t.request,
            source: t.source,
            sessionSource: t.sessionSource,
            type: t.type,
            encryptedChatConversationId: t.encryptedChatConversationId,
          })
          .from(t)
          .where(
            inArray(
              t.id,
              chunk.map((row) => row.id),
            ),
          );
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        for (const row of loaded) {
          try {
            readInteractionRow(row);
          } catch (error) {
            unreadable.add(row.id);
            logger.warn(
              { err: error, interactionId: row.id },
              "Could not read an interaction while filling its thread's session previews; it and its descendants keep deriving the preview on read",
            );
          }
        }
        // SPDX-SnippetEnd
        // Ancestors are only folded; only the rows being filled read their
        // response.
        const filling = new Set(
          chunk.filter((member) => member.missing).map((member) => member.id),
        );
        responses = await InteractionModel.responsesFor(
          loaded.filter(
            (row) => filling.has(row.id) && !unreadable.has(row.id),
          ),
        );
      } catch (error) {
        // Without this chunk nothing below it can be folded: the rest of the
        // thread waits for the next pass.
        logger.warn(
          {
            err: error,
            sessionId: params.sessionId,
            threadId: params.threadId,
          },
          "Could not load a chunk of a thread while filling its session previews; the rest of the thread keeps deriving them on read",
        );
        for (const rest of chunks.slice(index)) {
          failed += rest.filter((row) => row.missing).length;
        }
        return { filled, failed, complete: true };
      }

      const byId = new Map(loaded.map((row) => [row.id, row]));
      const values: Array<{ id: string; sessionPreview: unknown }> = [];
      for (const member of chunk) {
        const row = byId.get(member.id);
        // member.parent_id and row.parentId are the same column, read by the
        // skeleton query and by the chunk load.
        const foldable =
          row !== undefined &&
          !unreadable.has(member.id) &&
          (member.parent_id === null || !unfoldable.has(member.parent_id));
        const full = foldable ? folder.fold(row) : null;
        if (full === null) {
          // Removed since the skeleton was read, unreadable, below an
          // unreadable row, or (which parentsFirst rules out) ahead of its
          // parent.
          folder.skip({ id: member.id, parentId: member.parent_id });
          unfoldable.add(member.id);
          if (member.missing) failed += 1;
          continue;
        }
        if (member.missing && row) {
          values.push(
            InteractionModel.sessionPreviewValue(
              row,
              full,
              responses.get(row.id) ?? null,
            ),
          );
        }
      }
      filled += await InteractionModel.storeSessionPreviews(values);
    }
    return { filled, failed, complete: true };
  }

  /**
   * The responses of `rows`, by id: a preview names a request by what it
   * produced (its tool calls or reply) and a title turn by its title. Only
   * rows about to be written are passed, a bounded chunk at a time.
   */
  private static async responsesFor(
    rows: Array<{ id: string }>,
  ): Promise<Map<string, unknown>> {
    const t = schema.interactionsTable;
    const responses = new Map<string, unknown>();
    if (rows.length === 0) return responses;
    const loaded = await db
      .select({
        id: t.id,
        response: t.response,
        encryptedChatConversationId: t.encryptedChatConversationId,
      })
      .from(t)
      .where(
        inArray(
          t.id,
          rows.map((row) => row.id),
        ),
      );
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    for (const row of loaded) {
      readInteractionRow(row);
      responses.set(row.id, row.response);
    }
    // SPDX-SnippetEnd
    return responses;
  }

  /**
   * The stored form of the preview a row would have been written with: built
   * as {@link create} builds it, from the full request and the stored
   * (possibly delta-encoded) one, then encrypted like any content column.
   */
  private static sessionPreviewValue(
    row: {
      id: string;
      source: InteractionSource | null;
      sessionSource: string | null;
      type: string;
      request: unknown;
    },
    fullRequest: unknown,
    response: unknown,
  ): { id: string; sessionPreview: unknown } {
    const preview = buildSessionPreview(
      {
        source: row.source,
        sessionSource: row.sessionSource,
        type: row.type,
        request: fullRequest,
        response,
      } as InsertInteraction,
      row.request,
    );
    const { sessionPreview } = encryptInteractionContent(
      { sessionPreview: preview },
      null,
    );
    return { id: row.id, sessionPreview };
  }

  /**
   * Write previews for rows that still have none, a bounded VALUES list at a
   * time. Returns how many rows were filled; a row filled meanwhile by a
   * concurrent run is left as it is.
   */
  private static async storeSessionPreviews(
    values: Array<{ id: string; sessionPreview: unknown }>,
  ): Promise<number> {
    let filled = 0;
    for (
      let offset = 0;
      offset < values.length;
      offset += SESSION_PREVIEW_UPDATE_ROWS
    ) {
      const chunk = values.slice(offset, offset + SESSION_PREVIEW_UPDATE_ROWS);
      const { rows } = await db.execute<{ id: string }>(sql`
        UPDATE interactions AS i
        SET session_preview = v.preview
        FROM (VALUES ${sql.join(
          chunk.map(
            (value) =>
              sql`(${value.id}::uuid, ${JSON.stringify(value.sessionPreview)}::jsonb)`,
          ),
          sql`, `,
        )}) AS v(id, preview)
        WHERE i.id = v.id AND i.session_preview IS NULL
        RETURNING i.id
      `);
      filled += rows.length;
    }
    return filled;
  }

  /**
   * Access-control and filter predicates for the session list, shared by the
   * offset and cursor paths so they cannot drift into showing different rows.
   *
   * Returns {@link SESSION_ACCESS_DENIED} when the caller can reach no agents.
   * That is deliberately distinct from `undefined`, which means "no
   * predicates, show everything" — conflating the two would turn a permission
   * denial into a full listing.
   */
  private static async buildSessionConditions(
    requestingUserId?: string,
    isAgentAdmin?: boolean,
    filters?: {
      organizationId?: string;
      profileId?: string;
      userId?: string;
      source?: InteractionSource;
      client?: ClientFilter;
      externalAgentId?: string;
      sessionId?: string;
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<SQL | undefined | typeof SESSION_ACCESS_DENIED> {
    // Build where clauses for access control
    const conditions: SQL[] = [];

    if (filters?.organizationId) {
      conditions.push(interactionBelongsToOrganization(filters.organizationId));
    }

    if (requestingUserId && !isAgentAdmin) {
      const accessibleAgentIds = await AgentTeamModel.getUserAccessibleAgentIds(
        requestingUserId,
        false,
      );

      if (accessibleAgentIds.length === 0) {
        return SESSION_ACCESS_DENIED;
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
      conditions.push(matchesSessionKey(filters.sessionId));
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

    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  /**
   * A bounded head scan should probe owner primary keys, rather than build the
   * organization's complete owner sets before it can return its first page.
   * Scalar subqueries prevent PostgreSQL from rewriting EXISTS into hashed
   * full-roster scans. Missing owners fail closed, as in the shared predicate.
   */
  private static sessionHeadOrganizationCondition(organizationId: string): SQL {
    const t = schema.interactionsTable;
    const agent = schema.agentsTable;
    const connector = schema.knowledgeBaseConnectorsTable;
    const app = schema.appsTable;
    const agentBelongs = sql`COALESCE((SELECT ${agent.organizationId} = ${organizationId} FROM ${agent} WHERE ${agent.id} = ${t.profileId}), false)`;
    const connectorBelongs = sql`COALESCE((SELECT ${connector.organizationId} = ${organizationId} FROM ${connector} WHERE ${connector.id} = ${t.connectorId}), false)`;
    const appBelongs = sql`COALESCE((SELECT ${app.organizationId} = ${organizationId} FROM ${app} WHERE ${app.id} = ${t.appId}), false)`;
    return and(
      or(agentBelongs, connectorBelongs, appBelongs),
      or(sql`${t.profileId} IS NULL`, agentBelongs),
      or(sql`${t.connectorId} IS NULL`, connectorBelongs),
      or(sql`${t.appId} IS NULL`, appBelongs),
    ) as SQL;
  }

  /**
   * {@link findSessionHeadsForCursor}, answered from the stored session heads:
   * one ordered scan of `interaction_session_heads` with a primary-key join to
   * each head interaction for the filters, instead of a walk over every
   * interaction above the cursor with a newer-sibling probe per row.
   *
   * Cursors are the same `(created_at, id)` of the head interaction, so a
   * cursor issued by either reader continues correctly on the other.
   */
  private static async findStoredSessionHeadsForCursor(
    whereClause: SQL | undefined,
    cursorQuery: CursorQuery,
    filters: { userId?: string; sessionId?: string } | undefined,
  ): Promise<
    Array<{
      sessionId: string | null;
      interactionId: string | null;
      headCreatedAt: Date;
      headId: string;
    }>
  > {
    const position = decodeCursor(cursorQuery.cursor);
    const before =
      position && !Number.isNaN(new Date(position.value).getTime())
        ? { createdAt: position.value, id: position.id }
        : null;
    const rows = await InteractionSessionHeadModel.findPage({
      interactionFilter: whereClause,
      userId: filters?.userId,
      sessionKey: filters?.sessionId,
      before,
      limit: cursorQuery.limit,
    });
    return rows.map((row) => ({
      sessionId: row.sessionId,
      interactionId: row.sessionId ? null : row.headId,
      headCreatedAt: row.headCreatedAt,
      headId: row.headId,
    }));
  }

  /**
   * The newest interaction of each session, newest first, for one cursor page.
   *
   * A row qualifies when no newer row shares its session — that row is the
   * session's head, and a session has exactly one, so the result needs no
   * deduplication. Ordering by the head row's own `(created_at, id)` is
   * therefore the same ordering as by the session's last activity, which is
   * what makes a keyset cursor possible here at all.
   *
   * The `NOT EXISTS` probe runs against `interactions_session_created_at_idx`
   * — `(session_id, created_at DESC)` — so it is an index lookup per candidate
   * row rather than a scan. Sessionless rows skip the probe: each one is its
   * own session, so it is always its own head.
   *
   * Fetches `limit + 1` rows; the caller uses the extra to decide whether
   * another page exists.
   */
  private static async findSessionHeadsForCursor(
    whereClause: SQL | undefined,
    cursorQuery: CursorQuery,
  ): Promise<
    Array<{
      sessionId: string | null;
      interactionId: string | null;
      headCreatedAt: Date;
      headId: string;
    }>
  > {
    const t = schema.interactionsTable;

    const conditions: SQL[] = [];
    if (whereClause) conditions.push(whereClause);

    // An unreadable cursor is treated as absent, so a stale or hand-edited
    // link lands on the newest page instead of erroring.
    const position = decodeCursor(cursorQuery.cursor);
    if (position) {
      const at = new Date(position.value);
      if (!Number.isNaN(at.getTime())) {
        conditions.push(
          sql`(${t.createdAt}, ${t.id}) < (${position.value}::timestamp, ${position.id}::uuid)`,
        );
      }
    }

    // Newer sibling in the same session => this row is not the head.
    const newerSibling = sql`
      NOT EXISTS (
        SELECT 1
        FROM ${t} AS newer
        WHERE newer.session_id = ${t.sessionId}
          AND (newer.created_at, newer.id) > (${t.createdAt}, ${t.id})
      )
    `;
    conditions.push(sql`(${t.sessionId} IS NULL OR ${newerSibling})`);

    const rows = await db
      .select({
        id: t.id,
        sessionId: t.sessionId,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(and(...conditions))
      // Drizzle's descending timestamp indexes use NULLS LAST. PostgreSQL
      // otherwise defaults DESC to NULLS FIRST and sorts the entire history,
      // even though createdAt is non-nullable.
      .orderBy(sql`${t.createdAt} DESC NULLS LAST`, desc(t.id))
      .limit(cursorQuery.limit + 1);

    return rows.map((row) => ({
      sessionId: row.sessionId,
      interactionId: row.sessionId ? null : row.id,
      headCreatedAt: row.createdAt,
      headId: row.id,
    }));
  }

  /**
   * Phases 2 and 3 for one page of session keys: aggregate the sessions, then
   * fetch the interaction window each row's tip is read from.
   *
   * Split out of {@link getSessions} so the offset and cursor paths share it.
   * Everything expensive here is already bounded by the page, which is the
   * property both phase-1 strategies exist to preserve.
   */
  private static async summarizeSessionPage(
    sessionPage: Array<{
      sessionId: string | null;
      interactionId: string | null;
    }>,
    whereClause: SQL | undefined,
  ): Promise<SessionSummary[]> {
    // Sessionless interactions each form their own group; real sessions group
    // by their shared session id.
    const sessionGroupExpr = sql`COALESCE(${schema.interactionsTable.sessionId}, ${schema.interactionsTable.id}::text)`;
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
        failedOverCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.interactionsTable.attemptOutcome} = 'failed_over')`,
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
        totalCacheSavings: sum(schema.interactionsTable.cacheSavings),
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
        // Same preference as profileName, so the type names the same agent.
        profileAgentType: sql<
          string | null
        >`COALESCE(MAX(${schema.agentsTable.agentType}::text) FILTER (WHERE ${schema.agentsTable.builtIn} = false), MAX(${schema.agentsTable.agentType}::text))`,
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
        // Title of the Archestra Chat conversation whose id is the session id.
        // Looked up by primary key once per session: joining on
        // `conversations.id::text` cannot use that key, so every page read
        // the whole conversations table. The CASE keeps a non-uuid session id
        // from reaching the cast (an invalid uuid would fail the query), and
        // matches only the canonical lowercase form, as the text join did.
        conversationTitle: sql<
          string | null
        >`(SELECT ${schema.conversationsTable.title} FROM ${schema.conversationsTable} WHERE ${schema.conversationsTable.id} = CASE WHEN MAX(${schema.interactionsTable.sessionId}) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN MAX(${schema.interactionsTable.sessionId})::uuid END)`,
        // The knowledge connector a knowledge:* row ran for, so the list can
        // tell "Embedding documents" rows apart. Only when one connector owns
        // every row; looked up by primary key once per session.
        connectorName: sql<
          string | null
        >`CASE WHEN COUNT(DISTINCT ${schema.interactionsTable.connectorId}) = 1 THEN (SELECT ${schema.knowledgeBaseConnectorsTable.name} FROM ${schema.knowledgeBaseConnectorsTable} WHERE ${schema.knowledgeBaseConnectorsTable.id} = MAX(${schema.interactionsTable.connectorId}::text)::uuid) END`,
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
        whereClause,
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
        failedOverCount: Number(s.failedOverCount),
        totalInputTokens: Number(s.totalInputTokens) || 0,
        totalOutputTokens: Number(s.totalOutputTokens) || 0,
        totalCacheReadTokens: Number(s.totalCacheReadTokens) || 0,
        totalCacheWriteTokens: Number(s.totalCacheWriteTokens) || 0,
        totalCost: s.totalCost,
        totalBilledCost: s.totalBilledCost,
        totalSubscriptionCost: s.totalSubscriptionCost,
        totalBaselineCost: s.totalBaselineCost,
        totalCacheSavings: s.totalCacheSavings,
        firstRequestTime: s.firstRequestTime ?? new Date(),
        lastRequestTime: s.lastRequestTime ?? new Date(),
        models: s.models ? s.models.split(",").filter(Boolean) : [],
        profileId: s.profileId,
        profileName: s.profileName,
        profileAgentType:
          AgentTypeSchema.safeParse(s.profileAgentType).data ?? null,
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
        lastInteractionId: lastInteraction?.lastInteractionId ?? null,
        lastInteractionType: lastInteraction?.lastInteractionType ?? null,
        attributionLabels: lastInteraction?.attributionLabels ?? null,
        contentNotStored: lastInteraction?.contentNotStored ?? false,
        conversationTitle: s.conversationTitle,
        claudeCodeTitle: lastInteraction?.claudeCodeTitle ?? null,
        connectorName: s.connectorName ?? null,
      };
    });
    return sessions;
  }

  private static async findSessionKeysForPage(
    whereClause: SQL | undefined,
    pagination: PaginationQuery,
    /**
     * Overridable so tests can drive the fallback without seeding twenty
     * thousand rows. Production always uses the module default.
     */
    maxScanRows: number = SESSION_SCAN_MAX_ROWS,
  ): Promise<
    Array<{ sessionId: string | null; interactionId: string | null }>
  > {
    const needed = pagination.offset + pagination.limit;
    const keys: Array<{
      sessionId: string | null;
      interactionId: string | null;
    }> = [];
    const seen = new Set<string>();
    let scanned = 0;

    // Each scanned interaction can yield at most one session. A page beyond
    // the scan budget cannot be filled by this walk, so go straight to grouping.
    while (
      needed <= maxScanRows &&
      keys.length < needed &&
      scanned < maxScanRows
    ) {
      const batch = await db
        .select({
          id: schema.interactionsTable.id,
          sessionId: schema.interactionsTable.sessionId,
        })
        .from(schema.interactionsTable)
        .where(whereClause)
        // `id` only breaks ties on identical timestamps; without it a row could
        // be seen twice (or skipped) across two OFFSET windows.
        //
        // Rows inserted between two steps land at the newest end and push the
        // window back over ground already covered, which the `seen` set
        // absorbs. Nothing is skipped: that would take a deletion above the
        // cursor, and the only thing that removes interactions is retention,
        // which works from the oldest end — far below anything this walk
        // reads.
        .orderBy(
          sql`${schema.interactionsTable.createdAt} DESC NULLS LAST`,
          desc(schema.interactionsTable.id),
        )
        .limit(SESSION_SCAN_BATCH_ROWS)
        .offset(scanned);

      for (const row of batch) {
        const key = row.sessionId ?? row.id;
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push({
          sessionId: row.sessionId,
          interactionId: row.sessionId ? null : row.id,
        });
      }

      scanned += batch.length;
      // A short batch means the filtered set is exhausted: every session that
      // matches has been seen, so the page is as complete as it can be.
      if (batch.length < SESSION_SCAN_BATCH_ROWS) {
        return keys.slice(pagination.offset, needed);
      }
    }

    if (keys.length >= needed) {
      return keys.slice(pagination.offset, needed);
    }

    return db
      .select({
        sessionId: max(schema.interactionsTable.sessionId),
        interactionId: sql<
          string | null
        >`CASE WHEN MAX(${schema.interactionsTable.sessionId}) IS NULL THEN MAX(${schema.interactionsTable.id}::text) ELSE NULL END`,
      })
      .from(schema.interactionsTable)
      .where(whereClause)
      .groupBy(
        sql`COALESCE(${schema.interactionsTable.sessionId}, ${schema.interactionsTable.id}::text)`,
      )
      .orderBy(desc(max(schema.interactionsTable.createdAt)))
      .limit(pagination.limit)
      .offset(pagination.offset);
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
    whereClause: SQL | undefined,
  ): Promise<
    Map<
      string,
      {
        lastUserMessagePreview: string | null;
        lastInteractionId: string | null;
        lastInteractionType: string | null;
        attributionLabels: AttributionLabels | null;
        contentNotStored: boolean;
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

    // Two narrow windows per session instead of one deep one. The scan below
    // needs exactly two things: the session's latest "main" interaction, which
    // lives among its newest rows, and — for Claude Code — the one-off
    // title-generation call, which the client issues at the *start* of a
    // session. Reading 20 newest rows to look for both was the heaviest part of
    // the sessions list by a wide margin: each of a session's newest turns
    // carries the whole conversation so far, so every one of them had to be
    // pulled out of TOAST, decrypted and stringified. Three rows from each end
    // cover both signals for a fraction of the bytes, and they find titles in
    // long sessions, where a newest-only window has long since scrolled past
    // the opening turns.
    const NEWEST_PER_SESSION = 3;
    const OLDEST_PER_SESSION = 3;
    // Fallback depth, used only for sessions the narrow windows leave without a
    // main interaction (see below).
    const DEEP_PER_SESSION = 20;

    const interactions = await InteractionModel.fetchSessionWindowRows({
      sessionKeys,
      uuidKeys,
      newest: NEWEST_PER_SESSION,
      oldest: OLDEST_PER_SESSION,
      whereClause,
    });

    // Group by session and find the "last main interaction" and "title interaction"
    const result = new Map<
      string,
      {
        lastUserMessagePreview: string | null;
        lastInteractionId: string | null;
        lastInteractionType: string | null;
        attributionLabels: AttributionLabels | null;
        contentNotStored: boolean;
        claudeCodeTitle: string | null;
      }
    >();

    // Group interactions by session key (sessionId or interaction id for single interactions)
    const groupedBySession = groupRowsBySession(interactions);

    // For each session, find the last "main" interaction and title. Selection
    // is pure, so it runs for every session first and the chosen tips are
    // reconstructed in one batch below — reconstructing inside this loop issued
    // a recursive ancestor query per session, i.e. one per row on the page.
    const selectedPerSession = new Map<
      string,
      {
        lastMainInteraction: (typeof interactions)[0] | null;
        guardrailTip: (typeof interactions)[0] | null;
        claudeCodeTitle: string | null | undefined;
      }
    >();

    // Selection is pure, so it can run a second time over a deeper window.
    const selectTip = (
      windowRows: SessionWindowRow[],
    ): {
      lastMainInteraction: SessionWindowRow | null;
      guardrailTip: SessionWindowRow | null;
      claudeCodeTitle: string | null | undefined;
    } => {
      let lastMainInteraction: SessionWindowRow | null = null;
      // A guardrail's call previews only a session that has nothing else.
      let guardrailTip: SessionWindowRow | null = null;
      // undefined = not yet found, null = found but no text, string = found with text
      let claudeCodeTitle: string | null | undefined;

      for (const interaction of windowRows) {
        const isGuardrail = isGuardrailSource(interaction.source);
        const isOpenCodeSideTurn =
          interaction.preview?.isOpenCodeSideTurn ??
          (isOpenCodeFamilySessionSource(interaction.sessionSource) &&
            computeRequestType(
              interaction.request,
              interaction.sessionSource,
              interaction.source,
            ) === "subagent");

        // Check for title generation request (Claude Code)
        if (interaction.isTitleGeneration && claudeCodeTitle === undefined) {
          // Extract title from response
          const response = interaction.response as {
            content?: Array<{ text?: string }>;
          };
          claudeCodeTitle = interaction.preview
            ? interaction.preview.claudeCodeTitle
            : (response?.content?.[0]?.text ?? null);
          continue;
        }

        // Skip if this is not a "main" interaction
        if (
          !lastMainInteraction &&
          (isGuardrail ||
            (!isOpenCodeSideTurn &&
              !interaction.isPromptSuggestion &&
              !interaction.isTitleGeneration))
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

          // A Metadata only turn is a real turn whose content was never
          // stored: it is the session's tip, with no preview to show.
          if (
            interaction.preview?.hasContent ??
            (hasOpenAiContent ||
              hasResponsesContent ||
              hasGeminiContent ||
              isLogContentNotStored(interaction.request))
          ) {
            if (isGuardrail) guardrailTip ??= interaction;
            else lastMainInteraction = interaction;
          }
        }

        // Early exit if we found both (undefined = not yet searched for title)
        if (lastMainInteraction && claudeCodeTitle !== undefined) {
          break;
        }
      }

      return { lastMainInteraction, guardrailTip, claudeCodeTitle };
    };

    for (const [sessionKey, windowRows] of groupedBySession) {
      const selection = selectTip(windowRows);
      if (
        selection.lastMainInteraction ||
        selection.guardrailTip ||
        selection.claudeCodeTitle
      ) {
        selectedPerSession.set(sessionKey, selection);
      }
    }

    // A session whose sampled rows are all scaffolding — title generation,
    // prompt suggestions — yields no main interaction, and would lose the
    // preview the old deep window used to find. Re-read just those sessions at
    // the old depth so the preview cannot regress; in the common case the list
    // is empty and this costs nothing. A tip found only past the newest rows
    // may skip newer turns between the two windows (behind a run of guardrail
    // calls, say), so such a session is re-read too.
    const unresolvedKeys = [...groupedBySession]
      .filter(([key, rows]) => {
        const tip = selectedPerSession.get(key)?.lastMainInteraction;
        return !tip || rows.indexOf(tip) >= NEWEST_PER_SESSION;
      })
      .map(([key]) => key);
    if (unresolvedKeys.length > 0) {
      const deepRows = await InteractionModel.fetchSessionWindowRows({
        sessionKeys: unresolvedKeys,
        uuidKeys: [],
        newest: DEEP_PER_SESSION,
        oldest: 0,
        // However many guardrail calls follow the last turn; a session of
        // nothing but them keeps the guardrail tip its sample found.
        skipGuardrails: true,
        whereClause,
      });
      for (const [sessionKey, windowRows] of groupRowsBySession(deepRows)) {
        const deep = selectTip(windowRows);
        const sampled = selectedPerSession.get(sessionKey);
        const selection = {
          lastMainInteraction:
            deep.lastMainInteraction ?? sampled?.lastMainInteraction ?? null,
          guardrailTip: sampled?.guardrailTip ?? null,
          claudeCodeTitle: deep.claudeCodeTitle ?? sampled?.claudeCodeTitle,
        };
        if (
          selection.lastMainInteraction ||
          selection.guardrailTip ||
          selection.claudeCodeTitle
        ) {
          selectedPerSession.set(sessionKey, selection);
        }
      }
    }

    // Only old tips without compact metadata need their full delta history.
    // Batch those legacy reads; modern previews never load an ancestor chain.
    const reconstructed = await InteractionDeltaManager.reconstructMany(
      [...selectedPerSession.values()]
        .map(
          ({ lastMainInteraction, guardrailTip }) =>
            lastMainInteraction ?? guardrailTip,
        )
        .filter(
          (tip): tip is (typeof interactions)[0] =>
            tip !== null && tip.preview === null,
        )
        .map((tip) => ({
          id: tip.id,
          threadId: tip.threadId,
          request: tip.request,
          processedRequest: null,
        })),
    );

    for (const [
      sessionKey,
      { lastMainInteraction: mainTip, guardrailTip, claudeCodeTitle },
    ] of selectedPerSession) {
      const lastMainInteraction = mainTip ?? guardrailTip;
      const tipRequest = lastMainInteraction
        ? (reconstructed.get(lastMainInteraction.id)?.request ??
          lastMainInteraction.request)
        : null;

      result.set(sessionKey, {
        lastUserMessagePreview: lastMainInteraction
          ? lastMainInteraction.preview
            ? lastMainInteraction.preview.lastUserMessagePreview
            : buildLastUserMessagePreview(tipRequest, lastMainInteraction.type)
          : null,
        lastInteractionId: lastMainInteraction?.id ?? null,
        lastInteractionType: lastMainInteraction?.type ?? null,
        attributionLabels: lastMainInteraction?.attributionLabels ?? null,
        contentNotStored: lastMainInteraction
          ? (lastMainInteraction.preview?.contentNotStored ??
            isLogContentNotStored(lastMainInteraction.request))
          : false,
        claudeCodeTitle: claudeCodeTitle ?? null,
      });
    }

    return result;
  }

  /**
   * Rows from the head and/or tail of each session's interaction list,
   * decrypted and returned newest-first across all sessions.
   *
   * `newest`/`oldest` are per-session row budgets. A session shorter than their
   * sum simply yields its rows once — the two windows overlap and are
   * de-duplicated by id. Sessionless interaction ids in `uuidKeys` are fetched
   * whole, since each such row is its own "session".
   */
  private static async fetchSessionWindowRows({
    sessionKeys,
    uuidKeys,
    newest,
    oldest,
    skipGuardrails = false,
    whereClause,
  }: {
    sessionKeys: string[];
    uuidKeys: string[];
    newest: number;
    oldest: number;
    skipGuardrails?: boolean;
    whereClause: SQL | undefined;
  }): Promise<SessionWindowRow[]> {
    if (sessionKeys.length === 0) {
      return [];
    }

    // Per-key top-N via LATERAL instead of one `session_id IN (...) OR
    // id IN (...)` query ranked with ROW_NUMBER(): the window form had to
    // materialize and sort EVERY interaction of every listed session —
    // request/response payloads included — before discarding all but the
    // first N, which pushed busy organizations into statement timeout. Each
    // LATERAL branch is one (session_id, created_at) index descent per key
    // that stops after N rows; sessionless interaction ids are a separate
    // primary-key lookup (each such row is its own "session", so N does not
    // apply). A uuid key that matches a row owned by a *different* session is
    // not fetched — the JS grouping filed such rows under a key nobody asked
    // for and never read them.
    const sessionKeyList = sql.join(
      sessionKeys.map((k) => sql`${k}`),
      sql`, `,
    );
    // Migration-created indexes use DESC NULLS LAST. PostgreSQL requires the
    // same ordering to stop at LIMIT, even though created_at is NOT NULL.
    // The reverse scan therefore needs ASC NULLS FIRST.
    const oldestBranch =
      oldest > 0
        ? sql`
        UNION ALL
        (SELECT id, session_id, session_source, source, thread_id, CASE WHEN session_preview IS NULL THEN request ELSE NULL END AS request, session_preview, attribution_labels, type, created_at,
                encrypted_chat_conversation_id
         FROM interactions
         WHERE session_id = keys.key AND ${whereClause ?? sql`true`}
         ORDER BY created_at ASC NULLS FIRST, id ASC
         LIMIT ${oldest})`
        : sql``;
    const newestFrom = skipGuardrails
      ? sql`(SELECT * FROM interactions
             WHERE session_id = keys.key AND ${whereClause ?? sql`true`}
             ORDER BY created_at DESC NULLS LAST, id DESC
             LIMIT ${GUARDRAIL_SKIP_SCAN_ROWS}) recent
           WHERE source IS NULL OR source NOT LIKE 'guardrail:%'`
      : sql`interactions WHERE session_id = keys.key AND ${whereClause ?? sql`true`}`;
    const sessionlessBranch =
      uuidKeys.length > 0
        ? sql`
      UNION ALL
      SELECT id, session_id, session_source, source, thread_id, CASE WHEN session_preview IS NULL THEN request ELSE NULL END AS request, session_preview, attribution_labels, type, created_at,
             encrypted_chat_conversation_id
      FROM interactions
      WHERE id IN (${sql.join(
        uuidKeys.map((k) => sql`${k}::uuid`),
        sql`, `,
      )})
        AND session_id IS NULL AND ${whereClause ?? sql`true`}`
        : sql``;

    // thread_id is selected so the chosen tip can be reconstructed from deltas.
    const interactionsResult = await db.execute<{
      id: string;
      session_id: string | null;
      session_source: string | null;
      source: InteractionSource | null;
      thread_id: string | null;
      request: unknown;
      session_preview: unknown;
      attribution_labels: AttributionLabels | null;
      type: string;
      // Raw SQL bypasses Drizzle's column mapping, so timestamps arrive as
      // whatever the driver hands back — a Date on one, a string on another.
      created_at: Date | string;
      // Selected so readInteractionRow can tell an encrypted-chat row from an
      // ordinary one; without it the guard cannot fire and a DEK envelope
      // would be handed to the server-key decryptor.
      encrypted_chat_conversation_id: string | null;
    }>(sql`
      -- id tiebreak: turns within one session commonly land on the same
      -- millisecond, and created_at alone leaves their order undefined — which
      -- let an earlier turn be picked as the session's latest, showing a stale
      -- preview. Ids are monotonic UUIDv7, so they settle the tie by true
      -- insertion order (the same tiebreak the write path already uses to
      -- resolve a delta parent). Final ordering is applied in JS, since the
      -- per-key UNION below has no single ordering to inherit.
      SELECT t.id, t.session_id, t.session_source, t.source, t.thread_id, t.request, t.session_preview, t.attribution_labels, t.type,
             t.created_at, t.encrypted_chat_conversation_id
      FROM (SELECT DISTINCT k.key FROM unnest(ARRAY[${sessionKeyList}]::text[]) AS k(key)) keys
      CROSS JOIN LATERAL (
        (SELECT id, session_id, session_source, source, thread_id, CASE WHEN session_preview IS NULL THEN request ELSE NULL END AS request, session_preview, attribution_labels, type, created_at,
                encrypted_chat_conversation_id
         FROM ${newestFrom}
         ORDER BY created_at DESC NULLS LAST, id DESC
         LIMIT ${newest})
        ${oldestBranch}
      ) t
      ${sessionlessBranch}
    `);

    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Raw-SQL rows bypass the model select paths — decrypt before the caller
    // scans their content.
    for (const row of interactionsResult.rows) {
      readInteractionRow(row);
    }
    // SPDX-SnippetEnd

    // De-duplicate: on a session shorter than newest + oldest the two windows
    // overlap, and the caller's scan must not see the same row twice.
    const byId = new Map<string, SessionWindowRow>();
    for (const row of interactionsResult.rows) {
      const parsedPreview = InteractionSessionPreviewSchema.safeParse(
        row.session_preview,
      );
      const preview = parsedPreview.success ? parsedPreview.data : null;
      // A guardrail consult quotes the call it judges, so its text marks
      // nothing about the consult itself.
      const requestText =
        preview || isGuardrailSource(row.source)
          ? ""
          : JSON.stringify(row.request);
      byId.set(row.id, {
        id: row.id,
        sessionId: row.session_id,
        sessionSource: row.session_source,
        source: row.source,
        threadId: row.thread_id,
        request: row.request,
        preview,
        attributionLabels: row.attribution_labels,
        response: undefined,
        isTitleGeneration:
          preview?.isTitleGeneration ??
          requestText.includes(TITLE_GENERATION_MARKER),
        isPromptSuggestion:
          preview?.isPromptSuggestion ??
          requestText.includes(PROMPT_SUGGESTION_MARKER),
        type: row.type,
        createdAt: new Date(row.created_at).getTime(),
      });
    }

    // Ordinary previews only use the request. Load response bodies in one
    // batch for the sampled title-generation turns that actually need them;
    // full assistant responses can otherwise dwarf the session-list reads.
    const titleIds = [...byId.values()]
      .filter((row) => row.isTitleGeneration && !row.preview)
      .map((row) => row.id);
    if (titleIds.length > 0) {
      const titles = await db
        .select({
          id: schema.interactionsTable.id,
          response: schema.interactionsTable.response,
          encryptedChatConversationId:
            schema.interactionsTable.encryptedChatConversationId,
        })
        .from(schema.interactionsTable)
        .where(inArray(schema.interactionsTable.id, titleIds));
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      for (const title of titles) {
        readInteractionRow(title);
        const row = byId.get(title.id);
        if (row) row.response = title.response;
      }
      // SPDX-SnippetEnd
    }

    return [...byId.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    );
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

  /**
   * Concurrent misses for the same organization share one load, so a burst of
   * page visits after the entry expires runs the loader once per process.
   */
  private static mostActiveUsersLoads = new Map<string, Promise<UserInfo[]>>();

  private static async getCachedMostActiveUsers(
    organizationId: string,
  ): Promise<UserInfo[]> {
    const state = await InteractionUserActivityModel.state();
    const version = `${organizationId}-${state.generation}-${state.revision}-${state.ready}`;
    const pending = InteractionModel.mostActiveUsersLoads.get(version);
    if (pending) {
      return pending;
    }
    const load = InteractionModel.loadMostActiveUsers(
      organizationId,
      state,
    ).finally(() => InteractionModel.mostActiveUsersLoads.delete(version));
    InteractionModel.mostActiveUsersLoads.set(version, load);
    return load;
  }

  private static async loadMostActiveUsers(
    organizationId: string,
    state: Awaited<ReturnType<typeof InteractionUserActivityModel.state>>,
  ): Promise<UserInfo[]> {
    const key =
      `${CacheKey.InteractionUserOptions}-${organizationId}-${state.generation}-${state.revision}-${state.ready}` as const;
    const cached = await cacheManager.get<UserInfo[]>(key);
    if (cached) {
      return cached;
    }
    const startedAt = Date.now();
    const users = state.ready
      ? await InteractionUserActivityModel.mostActive({
          organizationId,
          limit: USER_FILTER_OPTIONS_MAX,
          generation: state.generation,
        })
      : await InteractionModel.getUniqueUserIds({
          organizationId,
          limit: USER_FILTER_OPTIONS_MAX,
        });
    const current = await InteractionUserActivityModel.state();
    if (
      current.generation !== state.generation ||
      current.revision !== state.revision ||
      current.ready !== state.ready
    ) {
      return InteractionModel.getUniqueUserIds({
        organizationId,
        limit: USER_FILTER_OPTIONS_MAX,
      });
    }
    try {
      const ttl = USER_FILTER_OPTIONS_CACHE_TTL_MS - (Date.now() - startedAt);
      if (ttl > 0) await cacheManager.set(key, users, ttl);
    } catch (error) {
      // The list is still correct; the next request recomputes it.
      logger.warn(
        { error, organizationId },
        "InteractionModel: could not cache the logs user filter options",
      );
    }
    return users;
  }

  private static async findUsersWithInteractions(params: {
    organizationId: string;
    search?: string;
    ids?: string[];
    limit: number;
  }): Promise<UserInfo[]> {
    const users = schema.usersTable;
    const search = params.search?.trim();
    const candidates = db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(
        and(
          params.ids
            ? sql`${users.id} = ANY(${sql.param(params.ids)}::text[])`
            : undefined,
          search
            ? or(
                buildTokenizedSearchFilter({
                  query: search,
                  columns: [users.name],
                }),
                and(
                  eq(users.name, ""),
                  buildTokenizedSearchFilter({
                    query: search,
                    columns: [users.id],
                  }),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(sql`${users.name} COLLATE "C"`, sql`${users.id} COLLATE "C"`);
    // One indexed probe per candidate on `user_id`, stopping at the user's
    // first interaction in the organization. It refers to the `candidates`
    // alias of the outer query below, so it is valid only inside that query.
    const probe = db
      .select({ found: sql`1` })
      .from(schema.interactionsTable)
      .where(
        and(
          sql`${schema.interactionsTable.userId} = candidates.id`,
          interactionBelongsToOrganization(params.organizationId),
        ),
      )
      .limit(1);
    // Sort the matching users by name before probing the log, so the probes
    // stop once `limit` users with logs are found. `OFFSET 0` keeps PostgreSQL
    // from flattening the subquery, which would probe every candidate and
    // sort afterwards. Drizzle omits a zero offset, hence the raw outer query.
    const result = await db.execute<UserInfo>(sql`
      SELECT candidates.id, candidates.name
      FROM (${candidates} OFFSET 0) AS candidates
      CROSS JOIN LATERAL (${probe}) AS probe
      ORDER BY candidates.name COLLATE "C", candidates.id COLLATE "C"
      LIMIT ${params.limit}
    `);
    return result.rows;
  }

  private static async distinctExternalAgentIds(where: SQL): Promise<string[]> {
    const rows = await db
      .selectDistinct({
        externalAgentId: schema.interactionsTable.externalAgentId,
      })
      .from(schema.interactionsTable)
      .where(where)
      .orderBy(asc(schema.interactionsTable.externalAgentId));
    return rows
      .map((row) => row.externalAgentId)
      .filter((id): id is string => id !== null);
  }

  /**
   * Distinct external agent ids in ascending order, found by a loose index
   * scan: each step jumps the external_agent_id index to the next value with
   * a row matching `where`, so the cost follows the number of distinct ids
   * rather than the number of interactions.
   */
  private static async skipScanExternalAgentIds(where: SQL): Promise<string[]> {
    const column = schema.interactionsTable.externalAgentId;
    const result = await db.execute<{ value: string }>(sql`
      WITH RECURSIVE external_agent_ids AS (
        (SELECT ${column} AS value FROM ${schema.interactionsTable}
         WHERE ${where} AND ${column} IS NOT NULL
         ORDER BY ${column} LIMIT 1)
        UNION ALL
        SELECT (SELECT ${column} FROM ${schema.interactionsTable}
                WHERE ${where} AND ${column} > previous.value
                ORDER BY ${column} LIMIT 1)
        FROM external_agent_ids previous
        WHERE previous.value IS NOT NULL
      )
      SELECT value FROM external_agent_ids WHERE value IS NOT NULL
    `);
    return result.rows.map((row) => row.value);
  }

  private static async write(params: {
    data: InsertInteraction;
    auditContext?: EncryptedChatAuditContext | null;
    returnRow: boolean;
  }) {
    const { data, auditContext, returnRow } = params;
    // Snapshot the environment from the agent at creation time (single funnel
    // for all interaction writes) so per-environment cost-limit usage stays
    // stable under later agent reassignment. The agent is authoritative: when a
    // profile is present its current environment wins over any caller-supplied
    // value. Only profile-less system interactions may set it explicitly.
    const { billingUsage, billingAttribution, ...columns } = data;
    if (billingUsage && !billingAttribution)
      throw new Error("Billing attribution is required for settlement");
    const environmentId = billingAttribution
      ? billingAttribution.environmentId
      : data.profileId
        ? await AgentModel.findEnvironmentId(data.profileId)
        : (data.environmentId ?? null);
    // Enforced here, in the single funnel, so no writer can store content
    // the deployment's Log Content mode withholds.
    const withheld = resolveLogContentMode() === "metadata_only";
    const record = withheld ? withholdInteractionContent(columns) : columns;
    // A withheld row holds no content to encrypt under a conversation key, so
    // it is written like the encrypted-chat fallback: unkeyed, marker in place.
    const audit = withheld ? null : (auditContext ?? null);

    // Sanitize JSONB fields to strip null bytes (\u0000) that PostgreSQL rejects
    const sanitized = {
      ...record,
      environmentId,
      request: stripUnstorableChars(record.request),
      processedRequest: stripUnstorableChars(record.processedRequest),
      response: stripUnstorableChars(record.response),
    };

    // Delta-encode Claude Code / Claude Desktop requests so we don't re-store the
    // whole conversation on every row (no-op for all other interactions). Delta
    // encoding stays active under content encryption: deltas are computed on
    // plaintext before encryptInteractionContent runs below, and parent
    // resolution matches on the always-plaintext hash columns.
    //
    // EncryptedChat rows are excluded outright. Today they could not qualify anyway
    // (isEligible demands a Claude session source, and these are chat sources),
    // but relying on that coincidence would be fragile: a delta chain mixes rows
    // across requests and only the request that created a row carries its key,
    // so a chain spanning keys could not be reconstructed by any reader.
    //
    // Withheld rows are excluded too: there is no conversation to share with
    // a parent, and leaving their hash columns empty keeps a later full-content
    // row from chaining onto a request that was never stored.
    const { values, tip } =
      audit || withheld
        ? { values: sanitized, tip: null }
        : await InteractionDeltaManager.encodeOnWrite(sanitized);

    const interactionId = values.id ?? uuidv7();
    const plaintext = {
      ...values,
      sessionPreview: buildSessionPreview(sanitized, values.request),
    };
    const insertValues = {
      ...encryptInteractionContent({ ...plaintext }, audit),
      id: interactionId,
    };
    const insert = async (tx?: Transaction) => {
      const writer = tx ?? db;
      const inserting = writer
        .insert(schema.interactionsTable)
        // Monotonic v7 id: created_at ties happen under load, and the delta
        // manager's "most recent interaction" lookup breaks ties with the id.
        .values(insertValues)
        .onConflictDoNothing({ target: schema.interactionsTable.id });
      const [created]: StoredInteractionKey[] = returnRow
        ? await inserting.returning()
        : await inserting.returning(interactionKeyColumns);
      if (!created) {
        const [existing] = await writer
          .select()
          .from(schema.interactionsTable)
          .where(eq(schema.interactionsTable.id, interactionId));
        if (
          !existing ||
          existing.userId !== (data.userId ?? null) ||
          existing.profileId !== (data.profileId ?? null) ||
          existing.appId !== (data.appId ?? null) ||
          existing.connectorId !== (data.connectorId ?? null)
        )
          throw new Error(
            "Interaction id was already used for different attribution",
          );
        return existing;
      }
      return created;
    };
    const write = (tx?: Transaction) =>
      insertValues.userId == null
        ? insert(tx)
        : returnRow
          ? InteractionUserActivityModel.append(insertValues, tx)
          : InteractionUserActivityModel.appendReturningKey(insertValues, tx);
    const interaction =
      billingUsage && billingAttribution
        ? await retainDeletedBillingAttribution({
            values: insertValues,
            run: () =>
              retryOnceOnDeadlock(() =>
                withDbTransaction(async (tx) => {
                  const claimed = await InteractionBillingModel.claim({
                    tx,
                    interactionId,
                    usage: billingUsage,
                    attribution: billingAttribution,
                    userId: data.userId ?? null,
                    billingTeamId: data.billingTeamId ?? null,
                    billingMode: data.billingMode ?? "metered",
                    attributionLabels: data.attributionLabels,
                    logIdentity: {
                      profileId: data.profileId,
                      appId: data.appId ?? null,
                      connectorId: data.connectorId ?? null,
                      serviceAccountId: data.serviceAccountId ?? null,
                    },
                  });
                  if (!claimed) {
                    const [existing] = await tx
                      .select()
                      .from(schema.interactionsTable)
                      .where(eq(schema.interactionsTable.id, interactionId));
                    if (existing) return existing;
                  }
                  if (claimed) {
                    const [legacy] = await tx
                      .select({ id: schema.interactionsTable.id })
                      .from(schema.interactionsTable)
                      .where(eq(schema.interactionsTable.id, interactionId));
                    if (legacy)
                      throw new Error(
                        "Cannot settle an interaction already written without a billing receipt",
                      );
                  }
                  const created = await write(tx);
                  if (claimed && data.billingMode !== "subscription") {
                    if (billingUsage.mode === "enforce") {
                      await LimitModel.settleBillableUsage({
                        tx,
                        usage: billingUsage,
                        attribution: billingAttribution,
                      });
                    } else {
                      // Shadow records the candidate quote but posts only legacy counts.
                      await LimitModel.recordInteractionTokenUsage({
                        agentId: data.profileId ?? "",
                        teamIds: [],
                        entities: [],
                        model: data.model ?? "",
                        inputTokens: data.inputTokens ?? 0,
                        outputTokens: data.outputTokens ?? 0,
                        tx,
                        attribution: billingAttribution,
                      });
                    }
                  }
                  return created;
                }),
              ),
          })
        : await write();
    // The RETURNING row is create's public return value, so callers never
    // see envelopes. Safe for encrypted-chat rows too: this caller supplied the
    // very key that just encrypted them.
    if (returnRow)
      restoreWrittenInteractionContent(interaction, {
        written: insertValues,
        plaintext,
        audit,
      });

    if (tip) {
      InteractionDeltaManager.commitTip(interaction.id, tip);
    }

    // Update usage tracking after interaction is created
    // Run in background to not block the response
    if (!billingUsage)
      trackBackgroundWork(
        InteractionModel.updateUsageAfterInteraction(
          returnRow
            ? (interaction as InsertInteraction & { id: string })
            : { ...plaintext, id: interaction.id },
        ).catch((error) => {
          logger.error(
            { error },
            `Failed to update usage tracking for interaction ${interaction.id}`,
          );
        }),
      );

    AgentUsageModel.recordUseInBackground({
      agentId: interaction.profileId,
      usedAt: interaction.createdAt,
    });

    return interaction;
  }
}

export default InteractionModel;

/** One interaction row sampled for a session's list entry. */
type SessionWindowRow = {
  preview: InteractionSessionPreview | null;
  attributionLabels: AttributionLabels | null;
  id: string;
  sessionId: string | null;
  sessionSource: string | null;
  source: InteractionSource | null;
  threadId: string | null;
  request: unknown;
  response: unknown;
  isTitleGeneration: boolean;
  isPromptSuggestion: boolean;
  type: string;
  /** Epoch milliseconds — see the driver note in fetchSessionWindowRows. */
  createdAt: number;
};

/** Key by session id, falling back to the row's own id for sessionless rows. */
function groupRowsBySession(
  rows: SessionWindowRow[],
): Map<string, SessionWindowRow[]> {
  const grouped = new Map<string, SessionWindowRow[]>();
  for (const row of rows) {
    const key = row.sessionId ?? row.id;
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }
  return grouped;
}

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
    return truncatePreview(message);
  } catch {
    return null;
  }
}

function truncatePreview(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let preview = trimmed.slice(0, LAST_USER_MESSAGE_PREVIEW_MAX_LENGTH);
  // Don't leave half a surrogate pair at the truncation point.
  const lastCode = preview.charCodeAt(preview.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    preview = preview.slice(0, -1);
  }
  return preview;
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

/**
 * A thread's skeleton with every parent ahead of its children, keeping the
 * listed (created_at, id) order otherwise. The fold needs parents first, and
 * timestamps alone do not promise it: a clock stepping back between two
 * inserts, or rows restored with their own timestamps, can put a child first.
 */
function parentsFirst(rows: ThreadSkeletonRow[]): ThreadSkeletonRow[] {
  const members = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, ThreadSkeletonRow[]>();
  const roots: ThreadSkeletonRow[] = [];
  for (const row of rows) {
    if (row.parent_id !== null && members.has(row.parent_id)) {
      const siblings = children.get(row.parent_id) ?? [];
      siblings.push(row);
      children.set(row.parent_id, siblings);
    } else {
      roots.push(row);
    }
  }
  // Depth first from each root, siblings in listed order. Iterative: a thread
  // can be thousands of rows deep.
  const ordered: ThreadSkeletonRow[] = [];
  const stack = roots.reverse();
  while (stack.length > 0) {
    const row = stack.pop() as ThreadSkeletonRow;
    ordered.push(row);
    const next = children.get(row.id);
    if (next) {
      for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
    }
  }
  return ordered;
}

/** Derive text from the full request and classify the stored delta suffix. */
function buildSessionPreview(
  data: InsertInteraction,
  storedRequest: unknown,
): InteractionSessionPreview {
  const request = storedRequest as {
    messages?: unknown[];
    input?: unknown[];
    contents?: unknown[];
  };
  const markers = isGuardrailSource(data.source ?? null)
    ? new Set<string>()
    : findMarkers(request, SESSION_PREVIEW_MARKERS);
  const isTitleGeneration = markers.has(TITLE_GENERATION_MARKER);
  const response = data.response as { content?: Array<{ text?: string }> };
  const contentNotStored = isLogContentNotStored(request);
  return {
    hasContent:
      [request?.messages, request?.input, request?.contents].some(
        (value) => Array.isArray(value) && value.length > 0,
      ) || contentNotStored,
    isTitleGeneration,
    isPromptSuggestion: markers.has(PROMPT_SUGGESTION_MARKER),
    isOpenCodeSideTurn:
      isOpenCodeFamilySessionSource(data.sessionSource ?? null) &&
      computeRequestType(
        request,
        data.sessionSource ?? null,
        data.source ?? null,
      ) === "subagent",
    contentNotStored,
    lastUserMessagePreview: buildLastUserMessagePreview(
      data.request,
      data.type,
    ),
    claudeCodeTitle: isTitleGeneration
      ? (response?.content?.[0]?.text ?? null)
      : null,
    ...(contentNotStored
      ? { responseToolNames: [], responseTextPreview: null }
      : buildResponsePreview(data)),
  };
}

const TITLE_GENERATION_MARKER = "Please write a 5-10 word title";
const PROMPT_SUGGESTION_MARKER = "prompt suggestion generator";
const SESSION_PREVIEW_MARKERS = [
  TITLE_GENERATION_MARKER,
  PROMPT_SUGGESTION_MARKER,
];

/**
 * Markers found in any string of a stored request. Walking the strings finds
 * the same markers as searching its JSON, since none contains a character JSON
 * escapes, without serializing a large conversation on every write.
 */
function findMarkers(value: unknown, markers: string[]): Set<string> {
  const found = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length && found.size < markers.length) {
    const next = pending.pop();
    if (typeof next === "string") {
      for (const marker of markers)
        if (next.includes(marker)) found.add(marker);
    } else if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (next && typeof next === "object") {
      for (const [key, item] of Object.entries(next)) pending.push(key, item);
    }
  }
  return found;
}

/** The tools a response asked for, else the start of its reply. */
function buildResponsePreview(
  data: InsertInteraction,
): Pick<
  InteractionSessionPreview,
  "responseToolNames" | "responseTextPreview"
> {
  try {
    const interaction = new DynamicInteraction({
      request: data.request,
      response: data.response,
      type: data.type,
    } as never);
    const responseToolNames = interaction.getToolNamesRequested();
    return {
      responseToolNames,
      responseTextPreview:
        responseToolNames.length > 0
          ? null
          : truncatePreview(interaction.getLastAssistantResponse()),
    };
  } catch {
    return { responseToolNames: [], responseTextPreview: null };
  }
}

/** Retry only failed log foreign keys; admission attribution stays in the receipt. */
async function retainDeletedBillingAttribution<T>(params: {
  values: typeof schema.interactionsTable.$inferInsert;
  run: () => Promise<T>;
}): Promise<T> {
  const columns = getTableColumns(schema.interactionsTable);
  const foreignKeys = getTableConfig(schema.interactionsTable).foreignKeys;
  const clearedConstraints = new Set<string>();
  // Each retry clears a nullable log reference. Unknown constraints fail
  // immediately; each constraint can be cleared only once.
  for (let attempt = 0; ; attempt++) {
    try {
      return await params.run();
    } catch (error) {
      let detail: unknown = error;
      for (
        let depth = 0;
        depth < 5 &&
        detail &&
        typeof detail === "object" &&
        !("constraint" in detail);
        depth++
      )
        detail = "cause" in detail ? detail.cause : null;
      if (
        !detail ||
        typeof detail !== "object" ||
        !("code" in detail) ||
        detail.code !== "23503" ||
        !("constraint" in detail) ||
        typeof detail.constraint !== "string" ||
        clearedConstraints.has(detail.constraint) ||
        attempt >= foreignKeys.length
      )
        throw error;
      const missing = foreignKeys
        .find((key) => key.getName() === detail.constraint)
        ?.reference().columns;
      if (!missing?.length || missing.some((column) => column.notNull))
        throw error;
      clearedConstraints.add(detail.constraint);
      for (const column of missing) {
        const key = Object.entries(columns).find(
          ([, value]) => value.name === column.name,
        )?.[0];
        if (!key) throw error;
        Reflect.set(params.values, key, null);
      }
      logger.info(
        { constraint: detail.constraint },
        "Cleared deleted log reference; retained admitted billing attribution",
      );
    }
  }
}
