import type {
  BillingMode,
  InteractionSource,
  SupportedProviderDiscriminator,
} from "@archestra/shared";
import {
  type AnyPgColumn,
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
  ToolCallBlock,
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
     * Knowledge-base connector this call was made for. Set only on `knowledge:*`
     * interactions, and only when one connector owns the call: an embedding
     * batch spanning several connectors (the stalled-embedding recovery sweep)
     * or a query fanning out across them stays NULL rather than naming one
     * arbitrarily.
     *
     * Deliberately not a foreign key, unlike the sibling id columns here. ON
     * DELETE SET NULL needs an index on this column or every connector delete
     * seq-scans `interactions`, and an index on this table cannot be built in a
     * transactional migration (see the archestra-dev-interactions-migrations
     * skill). The id of a deleted connector is kept and resolves to no name on
     * read.
     */
    connectorId: uuid("connector_id"),
    /**
     * MCP App whose runtime made this LLM call. Set only on app-runtime
     * interactions (`source = 'app:llm_complete'` today) from the app-bound
     * proxy header, which the LLM proxy honours only on its loopback path and
     * only for an app of the executing agent's organization — see
     * `resolveAttributedAppId`.
     *
     * This is the *runtime* half of per-app cost: an app is not always LLM-free
     * once built, and every such call used to collapse into the shared
     * APP_RUNTIME agent with the app identity dropped at the call site. The
     * *build* half is not stored here — authoring turns are ordinary chat
     * interactions, joined through `apps.authoring_session_id`.
     *
     * Deliberately not a foreign key and deliberately unindexed, for the same
     * reason as `connectorId` above: ON DELETE SET NULL would seq-scan
     * `interactions` on every app delete, and an index on this table cannot be
     * built in a transactional migration (see the
     * archestra-dev-interactions-migrations skill). The per-app aggregation is
     * an analytics query that already filters on `created_at`, so it rides the
     * created-at index and reads this column from the heap. A deleted app's id
     * is kept and resolves to no name on read.
     */
    appId: uuid("app_id"),
    /**
     * Session ID to group related LLM requests together.
     * Can be extracted from:
     * - X-Archestra-Session-Id header (explicit)
     * - Codex `client_metadata.session_id` body field / `session-id` request
     *   header (only on requests identified as Codex)
     * - Claude/Anthropic metadata.user_id field
     * - OpenAI's user field
     */
    sessionId: varchar("session_id"),
    /**
     * Provenance of the session ID (NOT the client app — that is
     * external_agent_id). Values: 'claude_metadata', 'header', 'meta_header',
     * 'openwebui_chat', 'codex_session', 'openai_user', null. Legacy rows may
     * carry 'claude_code' / 'claude_desktop'.
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
     * Whether this interaction's upstream fulfillment actually incurs a
     * per-token charge. `metered` (default) = real per-token cost; `subscription`
     * = flat-rate coverage (e.g. Claude Code on a Max/Pro plan) that incurs no
     * per-token charge. `cost` is always kept as the list-price estimate; billed
     * spend is `cost` for metered rows and 0 for subscription rows. Resolved at
     * request time from the fulfilling credential (see resolveInteractionBillingMode).
     */
    billingMode: varchar("billing_mode")
      .$type<BillingMode>()
      .notNull()
      .default("metered"),
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
     * to find a parent on the write path.
     */
    requestLastMessageIdx: integer("request_last_message_idx"),
    /**
     * sha256 hex of the FULL request's last message (the message at
     * requestLastMessageIdx). Like threadId it is always stored in plaintext —
     * a hash only supports equality checks — so write-path parent resolution
     * can match candidates without reading `request`, which content encryption
     * at rest may have replaced with ciphertext. NULL on rows written before
     * this column existed; such rows are simply never matched as parents.
     */
    requestLastMessageHash: varchar("request_last_message_hash"),
    response: jsonb("response").$type<InteractionResponse>().notNull(),
    dualLlmAnalyses: jsonb("dual_llm_analyses").$type<DualLlmAnalysis[]>(),
    unsafeContextBoundary: jsonb(
      "unsafe_context_boundary",
    ).$type<UnsafeContextBoundary>(),
    /**
     * Non-null when a guardrail refused this turn's tool calls. Lets a refused
     * turn be told apart from a healthy one — and counted per session — without
     * decrypting anything, which nothing else on the row allows.
     *
     * Metadata only, and deliberately NOT one of the encrypted content columns:
     * it carries the block reason and a count, never tool names or arguments.
     * No index — this is analytics, not a hot-path lookup, and `interactions`
     * is far too large to take a non-concurrent index build in a migration.
     */
    toolCallBlock: jsonb("tool_call_block").$type<ToolCallBlock>(),
    /**
     * Non-null marks this row's five content columns (request, processedRequest,
     * response, dualLlmAnalyses, unsafeContextBoundary) as encrypted under an
     * locked chat's browser-held key rather than the server key, and
     * names the conversation whose escrow record recovers it. Readers MUST
     * consult this before decrypting: a server-key decrypt of these envelopes
     * throws.
     *
     * Deliberately has no FK — these rows outlive the conversation under
     * retention — and no index: reads test it per row, and break-glass rides
     * the existing sessionId index.
     */
    lockedChatConversationId: uuid("locked_chat_conversation_id"),
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
    /**
     * When this row's request/response payloads were replaced with a
     * placeholder by payload retention. NULL means the payloads are intact.
     *
     * The row itself is deliberately kept: every numeric column feeding cost
     * statistics, usage limits and session summaries stays valid, so pruning
     * changes what an operator can read back from the LLM logs but nothing
     * that is counted. Nullable with no default, so adding it is a
     * metadata-only change on a table far too large to rewrite (see the
     * interactions-migrations skill). No index — the sweep already narrows by
     * `created_at`, and this is only ever a filter on top of that.
     */
    payloadPrunedAt: timestamp("payload_pruned_at", { mode: "date" }),
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
    // Covering index for the cost-statistics aggregations (StatisticsModel):
    // they filter on created_at and only read these numeric/model columns, so
    // an index-only scan avoids fetching scattered heap pages of a table whose
    // rows are dominated by large TOASTed JSONB payloads.
    //
    // NOTE: `billingMode` is intentionally NOT in this index. The aggregations
    // split billed vs subscription cost with a conditional (FILTER) SUM on it,
    // so including it would make the split index-only — but adding a column to
    // this index means a non-concurrent DROP/CREATE rebuild, which takes a
    // write-blocking lock on a very large `interactions` table. The rebuild risk
    // outweighs the index-only win for an analytics query, so the FILTER reads
    // billing_mode from the heap instead. If that ever becomes a bottleneck, add
    // the column with a separate `CREATE INDEX CONCURRENTLY` ops step (see the
    // interactions-table migration skill), never a transactional migration.
    statisticsCoveringIdx: index("interactions_statistics_covering_idx").on(
      table.createdAt,
      table.profileId,
      table.model,
      table.inputTokens,
      table.outputTokens,
      table.cacheReadTokens,
      table.cost,
      table.baselineCost,
      table.toonCostSavings,
      table.cacheSavings,
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
    // Note: interactions deliberately has NO trgm/GIN indexes on the request/
    // response payload columns. Migration 0116 used to create them for a
    // free-text log search that no longer exists (the LLM logs UI filters by
    // dropdowns + exact session id), and GIN over multi-hundred-KB payloads
    // write-amplified every hot-path insert. If payload search ever returns,
    // build it on a bounded column — not on (request::text)/(response::text) —
    // and create the index CONCURRENTLY out of band (see the
    // archestra-dev-interactions-migrations skill).
  }),
);

export default interactionsTable;
