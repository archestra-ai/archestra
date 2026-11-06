import type {
  BillingMode,
  SupportedProviderDiscriminator,
} from "@archestra/shared";
import {
  bigint,
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
import type { AttributionLabels } from "@/types/attribution-label";
import type { InteractionAuthMethod } from "@/types/interaction";

/**
 * Hourly totals of `interactions` (split by the models their billing receipts
 * charged), so cost statistics over long ranges read a few rows per hour
 * instead of every request.
 *
 * A cache, not a source of truth: every row is recomputed from `interactions`
 * and `interaction_billing`, and readers combine it with raw rows for the parts
 * of a window it does not cover (see `LlmUsageRollupModel`). Key columns are
 * copied verbatim from the source rows, never resolved, so a reader applies
 * the same joins and filters (organization scope, team grants, agent types) as
 * it does on raw rows.
 *
 * Two families of measures reproduce the two ways statistics count today:
 * - the request family (`requests` … `max_created_at`) holds each request's own
 *   columns once, on the row of the model that served the request (its
 *   receipt's parent model, or the request's model without a receipt), so a
 *   SUM over any grouping equals the SUM over the raw requests;
 * - the `model_*` family holds the per-model split of each receipt, falling
 *   back to the request's columns without one.
 *
 * No unique key: an hour is replaced as a whole and readers always aggregate.
 * No foreign keys: an id here is only as current as the raw rows it was
 * computed from, and a change to those rows (including the ON DELETE SET NULL
 * of a deleted user, agent or key) recomputes the hour.
 */
export const llmUsageHourlyTable = pgTable(
  "llm_usage_hourly",
  {
    hour: timestamp("hour", { mode: "date" }).notNull(),
    profileId: uuid("profile_id"),
    connectorId: uuid("connector_id"),
    appId: uuid("app_id"),
    billingTeamId: text("billing_team_id"),
    userId: text("user_id"),
    serviceAccountId: uuid("service_account_id"),
    authMethod: varchar("auth_method").$type<InteractionAuthMethod>(),
    virtualKeyId: uuid("virtual_key_id"),
    passthroughVirtualKeyId: uuid("passthrough_virtual_key_id"),
    authenticatedAppId: text("authenticated_app_id"),
    authenticatedAppName: varchar("authenticated_app_name"),
    providerApiKeyId: uuid("provider_api_key_id"),
    modelPoolId: uuid("model_pool_id"),
    externalAgentId: varchar("external_agent_id"),
    type: varchar("type").$type<SupportedProviderDiscriminator>().notNull(),
    model: varchar("model"),
    billedModel: varchar("billed_model"),
    billingMode: varchar("billing_mode").$type<BillingMode>().notNull(),
    /** `COALESCE(receipt.attribution_labels, interaction.attribution_labels)`. */
    attributionLabels: jsonb("attribution_labels").$type<AttributionLabels>(),

    requests: integer("requests").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    /** Input tokens of requests whose input count was not estimated. */
    reportedInputTokens: bigint("reported_input_tokens", {
      mode: "number",
    }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    cacheWriteTokens: bigint("cache_write_tokens", {
      mode: "number",
    }).notNull(),
    cost: numeric("cost").notNull(),
    baselineCost: numeric("baseline_cost").notNull(),
    cacheCost: numeric("cache_cost").notNull(),
    cacheSavings: numeric("cache_savings").notNull(),
    failedOverAttempts: integer("failed_over_attempts").notNull(),
    /** Newest request of the group; null on a row holding only a model split. */
    maxCreatedAt: timestamp("max_created_at", { mode: "date" }),

    modelInputTokens: bigint("model_input_tokens", {
      mode: "number",
    }).notNull(),
    modelReportedInputTokens: bigint("model_reported_input_tokens", {
      mode: "number",
    }).notNull(),
    modelOutputTokens: bigint("model_output_tokens", {
      mode: "number",
    }).notNull(),
    modelCacheReadTokens: bigint("model_cache_read_tokens", {
      mode: "number",
    }).notNull(),
    modelCacheWriteTokens: bigint("model_cache_write_tokens", {
      mode: "number",
    }).notNull(),
    modelCost: numeric("model_cost").notNull(),
    modelBaselineCost: numeric("model_baseline_cost").notNull(),
    modelCacheSavings: numeric("model_cache_savings").notNull(),
  },
  (table) => [index("llm_usage_hourly_hour_idx").on(table.hour)],
);

/**
 * How far `llm_usage_hourly` reaches: every hour before `rolled_through` has
 * been computed at least once. One row, written by the first roll; no row
 * means nothing is rolled yet.
 */
export const llmUsageRollupStateTable = pgTable("llm_usage_rollup_state", {
  id: integer("id").primaryKey(),
  rolledThrough: timestamp("rolled_through", { mode: "date" }),
});

/**
 * Rolled hours to compute again.
 *
 * Database triggers on `interactions` and `interaction_billing` mark an hour
 * when a row in it changes after the hour was rolled, bumping `version`; the
 * rollup clears a mark only if `version` is still what it read before the
 * recompute, so a change racing a recompute keeps its mark. Readers take
 * marked hours from raw rows until then.
 *
 * `settle_after` (a transaction id) is set once an hour has been computed: the
 * hour is computed one final time when every transaction that was running at
 * that point has ended, so a row committed late by one of them is included.
 * Readers use the rollup for such an hour: anything it can still miss is not
 * committed, so a raw read would not see it either.
 */
export const llmUsageRollupDirtyTable = pgTable("llm_usage_rollup_dirty", {
  hour: timestamp("hour", { mode: "date" }).primaryKey(),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  settleAfter: bigint("settle_after", { mode: "number" }),
});
