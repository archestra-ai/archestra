import type {
  InteractionSource,
  SupportedProviderDiscriminator,
} from "@shared";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  DualLlmAnalysis,
  InteractionRequest,
  InteractionResponse,
  ToonSkipReason,
  UnsafeContextBoundary,
} from "@/types";
import agentsTable from "./agent";
import usersTable from "./user";
import virtualApiKeysTable from "./virtual-api-key";

const interactionsTable = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable to preserve interactions when profile is deleted
    // null indicates the profile was deleted
    profileId: uuid("profile_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    /**
     * Optional external agent ID passed via X-Archestra-Agent-Id header.
     * This allows clients to associate interactions with their own agent identifiers.
     */
    externalAgentId: varchar("external_agent_id"),
    /**
     * Optional execution ID passed via X-Archestra-Execution-Id header.
     * This allows clients to associate interactions with a specific execution run.
     */
    executionId: varchar("execution_id"),
    /**
     * Optional user ID passed via X-Archestra-User-Id header.
     * Header-derived tracing/attribution field — do NOT overload for budget
     * accounting. Budget write-back reads `billedUserId` instead.
     */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /**
     * Authoritative "who pays" field for per-user token budgets.
     * Populated by the LLM proxy based on the auth path:
     *   - Chat UI session           → request.user.id
     *   - personal chat API key     → chatApiKey.user_id
     *   - team / org chat API key   → NULL
     *   - virtual API key           → NULL (vkey traffic never bills a user)
     *   - JWKS external caller      → jwksResult.userId
     * Read by `updateUsageAfterInteraction` and the "By user" cost breakdown.
     */
    billedUserId: text("billed_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    /**
     * Virtual API key that served this request, when applicable.
     * Populated for every vkey-authenticated call; NULL otherwise.
     * Drives per-vkey budget accounting and the "By virtual key" breakdown.
     */
    virtualApiKeyId: uuid("virtual_api_key_id").references(
      () => virtualApiKeysTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Session ID to group related LLM requests together.
     * Can be extracted from:
     * - X-Archestra-Session-Id header (explicit)
     * - Claude Code's metadata.user_id field (format: user_xxx_session_{uuid})
     * - OpenAI's user field
     */
    sessionId: varchar("session_id"),
    /**
     * Source of the session ID for display purposes.
     * Values: 'claude_code', 'header', 'openai_user', null
     */
    sessionSource: varchar("session_source"),
    /**
     * Where the request originated from.
     * Values: 'api', 'chat', 'chatops:slack', 'chatops:ms-teams', 'email', null
     * Internal callers set this via X-Archestra-Source header.
     * External API requests default to 'api'.
     */
    source: varchar("source").$type<InteractionSource>(),
    request: jsonb("request").$type<InteractionRequest>().notNull(),
    processedRequest: jsonb("processed_request").$type<InteractionRequest>(),
    response: jsonb("response").$type<InteractionResponse>().notNull(),
    dualLlmAnalyses: jsonb("dual_llm_analyses").$type<DualLlmAnalysis[]>(),
    unsafeContextBoundary: jsonb(
      "unsafe_context_boundary",
    ).$type<UnsafeContextBoundary>(),
    type: varchar("type").$type<SupportedProviderDiscriminator>().notNull(),
    model: varchar("model"),
    /**
     * The original requested model before cost optimization.
     * When model optimization applies: baselineModel ≠ model
     * When no optimization: baselineModel = model (or null for backward compatibility)
     */
    baselineModel: varchar("baseline_model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    baselineCost: numeric("baseline_cost", { precision: 13, scale: 10 }),
    cost: numeric("cost", { precision: 13, scale: 10 }),
    toonTokensBefore: integer("toon_tokens_before"),
    toonTokensAfter: integer("toon_tokens_after"),
    toonCostSavings: numeric("toon_cost_savings", { precision: 13, scale: 10 }),
    toonSkipReason: varchar("toon_skip_reason").$type<ToonSkipReason>(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    profileIdIdx: index("interactions_agent_id_idx").on(table.profileId),
    externalAgentIdIdx: index("interactions_external_agent_id_idx").on(
      table.externalAgentId,
    ),
    executionIdIdx: index("interactions_execution_id_idx").on(
      table.executionId,
    ),
    // Kept load-bearing by the LLM proxy logs filter/order and the getDistinctUsers admin view; both read user_id directly.
    userIdIdx: index("interactions_user_id_idx").on(table.userId),
    billedUserCreatedAtIdx: index("interactions_billed_user_created_at_idx").on(
      table.billedUserId,
      table.createdAt.desc(),
    ),
    virtualApiKeyIdIdx: index("interactions_virtual_api_key_id_idx").on(
      table.virtualApiKeyId,
      table.createdAt.desc(),
    ),
    sessionIdIdx: index("interactions_session_id_idx").on(table.sessionId),
    createdAtIdx: index("interactions_created_at_idx").on(
      table.createdAt.desc(),
    ),
    profileCreatedAtIdx: index("interactions_profile_created_at_idx").on(
      table.profileId,
      table.createdAt.desc(),
    ),
    sessionCreatedAtIdx: index("interactions_session_created_at_idx").on(
      table.sessionId,
      table.createdAt.desc(),
    ),
    // Note: Additional pg_trgm GIN indexes for search are created in migration 0116_pg_trgm_indexes.sql:
    // - interactions_request_trgm_idx: GIN index on (request::text)
    // - interactions_response_trgm_idx: GIN index on (response::text)
    // These can't be defined in Drizzle schema as they require ::text cast and gin_trgm_ops operator class.
  }),
);

export default interactionsTable;
