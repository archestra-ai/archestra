import type {
  InteractionSource,
  SupportedProviderDiscriminator,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
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
  InteractionAuthMethod,
  InteractionRequest,
  InteractionResponse,
  ToonSkipReason,
  UnsafeContextBoundary,
} from "@/types";
import agentsTable from "./agent";
import environmentsTable from "./environment";
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
     * Client-app / external agent attribution. Set from the caller-supplied
     * X-Archestra-Agent-Id header (or X-Archestra-Meta segment 0) when present;
     * otherwise auto-discovered for known client apps (Claude → "anthropic_claude").
     * Lets clients associate interactions with their own agent identifiers.
     */
    externalAgentId: varchar("external_agent_id"),
    /**
     * Optional execution ID passed via X-Archestra-Execution-Id header.
     * This allows clients to associate interactions with a specific execution run.
     */
    executionId: varchar("execution_id"),
    /**
     * Optional user ID passed via X-Archestra-User-Id header.
     * This allows clients to associate interactions with a specific Archestra user.
     * Particularly useful for identifying which user was using the Archestra Chat.
     */
    userId: text("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    virtualKeyId: uuid("virtual_key_id").references(
      () => virtualApiKeysTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Optional passthrough virtual key (X-Archestra-Virtual-Key header) that
     * authenticated the acting user for this request. Tracked independently from
     * `virtualKeyId`: a request may carry a standard virtual key as its provider
     * credential AND a passthrough key as the user identity.
     */
    passthroughVirtualKeyId: uuid("passthrough_virtual_key_id").references(
      () => virtualApiKeysTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Snapshot of the environment this request ran under, resolved from the
     * agent's `environment_id` at interaction-creation time (see
     * InteractionModel.create). Null = no environment (the shared/default
     * runtime). Snapshotting — rather than recomputing via the agent's current
     * environment — keeps per-environment cost-limit usage stable when an agent
     * is later reassigned, and consistent with the incremental environment
     * limit counters that are written at request time.
     * ON DELETE SET NULL — deleting an environment clears the snapshot.
     */
    environmentId: uuid("environment_id").references(
      () => environmentsTable.id,
      { onDelete: "set null" },
    ),
    /**
     * Session ID to group related LLM requests together.
     * Can be extracted from:
     * - X-Archestra-Session-Id header (explicit)
     * - Claude/Anthropic metadata.user_id field
     * - OpenAI's user field
     */
    sessionId: varchar("session_id"),
    /**
     * Provenance of the session ID (NOT the client app — that is
     * external_agent_id). Values: 'claude_metadata', 'header', 'meta_header',
     * 'openwebui_chat', 'openai_user', null. Legacy rows may carry 'claude_code'
     * / 'claude_desktop'.
     */
    sessionSource: varchar("session_source"),
    /**
     * Where the request originated from.
     * Values: 'api', 'chat', 'chatops:slack', 'chatops:ms-teams', 'email', null
     * Internal callers set this via X-Archestra-Source header.
     * External API requests default to 'api'.
     */
    source: varchar("source").$type<InteractionSource>(),
    /**
     * Authentication method used for the request.
     */
    authMethod: varchar("auth_method").$type<InteractionAuthMethod>(),
    /**
     * Authenticated application identity resolved from an OAuth client
     * credentials token. This is distinct from externalAgentId, which is a
     * caller-supplied label.
     */
    authenticatedAppId: text("authenticated_app_id"),
    authenticatedAppName: varchar("authenticated_app_name"),
    request: jsonb("request").$type<InteractionRequest>().notNull(),
    processedRequest: jsonb("processed_request").$type<InteractionRequest>(),
    /**
     * Delta-encoding metadata (Claude/Anthropic interactions only — session_source
     * 'claude_metadata', or the legacy 'claude_code' / 'claude_desktop').
     * For eligible rows the `request`/`processedRequest` columns store only the
     * suffix of `messages` that is new versus the parent row; the full request is
     * rebuilt on read by walking the parent chain. Legacy / non-Claude rows leave
     * all of these NULL and store the full request as before.
     *
     * threadId: sha256 hex of messages[0]. NULL marks a legacy/full row.
     */
    threadId: varchar("thread_id"),
    /**
     * Previous interaction in this (sessionId, threadId) branch this request
     * continues. NULL = chain head (the row stores full messages even when
     * threadId is set).
     */
    parentId: uuid("parent_id").references(
      (): AnyPgColumn => interactionsTable.id,
      { onDelete: "set null" },
    ),
    /** # of leading request.messages shared with the parent's reconstructed messages. */
    requestSharedPrefix: integer("request_shared_prefix"),
    /** Same as requestSharedPrefix but for processedRequest; NULL when no processedRequest. */
    processedRequestSharedPrefix: integer("processed_request_shared_prefix"),
    /**
     * Index of the last message of the FULL request (messages.length - 1), used
     * to find a parent on the write path. The matching last-message hash is NOT
     * stored: a delta row always ends at the full request's last message, so it
     * is compared directly against the candidate's stored delta. (The hash is
     * kept only in the in-memory tip cache for the fast-path validity check.)
     */
    requestLastMessageIdx: integer("request_last_message_idx"),
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
    inputTokensEstimated: boolean("input_tokens_estimated")
      .notNull()
      .default(false),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    baselineCost: numeric("baseline_cost", { precision: 13, scale: 10 }),
    cost: numeric("cost", { precision: 13, scale: 10 }),
    cacheCost: numeric("cache_cost", { precision: 13, scale: 10 }),
    cacheSavings: numeric("cache_savings", { precision: 13, scale: 10 }),
    toonTokensBefore: integer("toon_tokens_before"),
    toonTokensAfter: integer("toon_tokens_after"),
    toonCostSavings: numeric("toon_cost_savings", { precision: 13, scale: 10 }),
    toonSkipReason: varchar("toon_skip_reason").$type<ToonSkipReason>(),
    // Monotonic insertion order for delta chaining: createdAt has finite
    // precision, and streamed interactions written in the same instant tie —
    // "latest interaction" picks then become arbitrary and delta chains can
    // attach to the wrong parent. Sequence default (not identity) so the
    // migration backfills history in (created_at, id) order and old writers
    // keep inserting during rollout; NOT NULL deferred per the migration
    // linter's expand/contract rule.
    seq: bigint("seq", { mode: "number" }).default(
      sql`nextval('interactions_seq_seq')`,
    ),
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
    userIdIdx: index("interactions_user_id_idx").on(table.userId),
    environmentIdIdx: index("interactions_environment_id_idx").on(
      table.environmentId,
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
    // Serves delta-encoding parent resolution and chain loads:
    // WHERE session_id = ? AND thread_id = ? ORDER BY created_at DESC.
    sessionThreadCreatedAtIdx: index(
      "interactions_session_thread_created_at_idx",
    ).on(table.sessionId, table.threadId, table.createdAt.desc()),
    parentIdIdx: index("interactions_parent_id_idx").on(table.parentId),
    // Note: Additional pg_trgm GIN indexes for search are created in migration 0116_pg_trgm_indexes.sql:
    // - interactions_request_trgm_idx: GIN index on (request::text)
    // - interactions_response_trgm_idx: GIN index on (response::text)
    // These can't be defined in Drizzle schema as they require ::text cast and gin_trgm_ops operator class.
  }),
);

export default interactionsTable;
