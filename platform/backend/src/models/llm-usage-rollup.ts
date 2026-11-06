import {
  parseCustomStatisticsTimeframe,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import {
  and,
  eq,
  gte,
  lt,
  lte,
  or,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { AttributionLabels } from "@/types/attribution-label";

/**
 * Reads and writes of the hourly LLM usage rollup (`llm_usage_hourly`).
 *
 * Cost statistics read {@link LlmUsageRollupModel.facts}: rollup rows for the
 * hours of a window the rollup serves, and the same rows computed from
 * `interactions` for everything else (the window's partial first and last
 * hours, hours not rolled yet, hours marked for recompute). Both halves come
 * from {@link usageFactsQuery}, so a statistic is the same whichever half a
 * request lands in.
 *
 * The `llm_usage_rollup` periodic task (`services/llm-usage-rollup.ts`) keeps
 * the rollup current with {@link LlmUsageRollupModel.rollHour} and
 * {@link LlmUsageRollupModel.recomputeMarkedHour}.
 */
class LlmUsageRollupModel {
  /**
   * The timeframe's bounds and which of its hours the rollup serves, read in
   * one statement so the bounds and the rollup state are consistent. Null for
   * an unparseable custom range (rejected at the API boundary).
   */
  static async window(
    timeframe: StatisticsTimeFrame,
  ): Promise<UsageWindow | null> {
    const bounds = timeframeBounds(timeframe);
    if (!bounds) return null;
    const result = await db.execute<{
      start: string;
      end: string | null;
      served_from: string | null;
      served_to: string | null;
      pending: string[];
    }>(sql`
      WITH bounds AS (
        SELECT (${bounds.start})::timestamp AS start, (${bounds.end})::timestamp AS "end"
      ), served AS (
        SELECT
          CASE WHEN date_trunc('hour', bounds.start) = bounds.start THEN bounds.start
            ELSE date_trunc('hour', bounds.start) + interval '1 hour' END AS served_from,
          CASE WHEN state.rolled_through IS NULL THEN NULL
            ELSE LEAST(state.rolled_through, date_trunc('hour', bounds."end")) END AS served_to
        FROM bounds
        LEFT JOIN ${schema.llmUsageRollupStateTable} AS state ON state.id = ${STATE_ID}
      )
      SELECT bounds.start::text AS start, bounds."end"::text AS "end",
        served.served_from::text AS served_from, served.served_to::text AS served_to,
        ARRAY(
          SELECT dirty.hour::text FROM ${schema.llmUsageRollupDirtyTable} AS dirty
          WHERE dirty.hour >= served.served_from AND dirty.hour < served.served_to
          ORDER BY dirty.hour
        ) AS pending
      FROM bounds, served`);
    const [row] = result.rows;
    const serves =
      row.served_from !== null &&
      row.served_to !== null &&
      row.served_from < row.served_to;
    return {
      start: row.start,
      end: row.end,
      served: serves
        ? { from: row.served_from as string, to: row.served_to as string }
        : null,
      pendingHours: serves ? row.pending : [],
    };
  }

  /**
   * Usage rows of a window, one per key and hour (see `llm_usage_hourly` for
   * the columns). Aggregate them; a group can span several rows.
   */
  static facts(window: UsageWindow) {
    const h = schema.llmUsageHourlyTable;
    const i = schema.interactionsTable;
    const inWindow = and(
      gte(i.createdAt, sql`${window.start}::timestamp`),
      window.end === null
        ? undefined
        : lte(i.createdAt, sql`${window.end}::timestamp`),
    ) as SQL;
    if (!window.served) {
      return usageFactsQuery(inWindow).as("usage_facts");
    }
    const { from, to } = window.served;
    const pending = window.pendingHours.map(
      (hour) =>
        and(
          gte(i.createdAt, sql`${hour}::timestamp`),
          lt(i.createdAt, sql`${hour}::timestamp + interval '1 hour'`),
        ) as SQL,
    );
    const rolled = db
      .select(rollupSelection)
      .from(h)
      .where(
        and(
          gte(h.hour, sql`${from}::timestamp`),
          lt(h.hour, sql`${to}::timestamp`),
          window.pendingHours.length === 0
            ? undefined
            : sql`NOT (${h.hour} = ANY(ARRAY[${sql.join(
                window.pendingHours.map((hour) => sql`${hour}::timestamp`),
                sql`, `,
              )}]))`,
        ),
      );
    const raw = usageFactsQuery(
      and(
        inWindow,
        or(
          lt(i.createdAt, sql`${from}::timestamp`),
          gte(i.createdAt, sql`${to}::timestamp`),
          ...pending,
        ),
      ) as SQL,
    );
    return unionAll(rolled, raw).as("usage_facts");
  }

  /**
   * The next hour to roll for the first time, if it ended at least
   * {@link ROLL_DELAY} ago: the hour after the last rolled one, or the hour of
   * the oldest interaction when nothing is rolled yet.
   */
  static async nextUnrolledHour(): Promise<string | null> {
    const result = await db.execute<{ hour: string | null }>(sql`
      SELECT next.hour::text AS hour
      FROM (
        SELECT COALESCE(
          (SELECT rolled_through FROM ${schema.llmUsageRollupStateTable} WHERE id = ${STATE_ID}),
          (SELECT date_trunc('hour', min(${schema.interactionsTable.createdAt})) FROM ${schema.interactionsTable})
        ) AS hour
      ) AS next
      WHERE next.hour + interval '1 hour' <= (now() - ${sql.raw(`interval '${ROLL_DELAY}'`)})::timestamp`);
    return result.rows[0]?.hour ?? null;
  }

  /**
   * Compute an hour for the first time and move `rolled_through` past it.
   * The hour is left marked to settle (see `llm_usage_rollup_dirty`). A no-op
   * when another run already rolled it.
   */
  static async rollHour(hour: string): Promise<void> {
    await withDbTransaction(async (tx) => {
      // No state row means nothing is rolled yet.
      const advanced = await tx.execute(sql`
        INSERT INTO ${schema.llmUsageRollupStateTable} AS state (id, rolled_through)
        VALUES (${STATE_ID}, ${hour}::timestamp + interval '1 hour')
        ON CONFLICT (id) DO UPDATE SET rolled_through = excluded.rolled_through
        WHERE state.rolled_through = ${hour}::timestamp OR state.rolled_through IS NULL`);
      if (advanced.rowCount === 0) return;
      const settleAfter = await recompute(tx, hour);
      // A mark already there (a change since the hour was read) keeps the
      // hour due for another recompute, which settles it in turn.
      await tx.execute(sql`
        INSERT INTO ${schema.llmUsageRollupDirtyTable} (hour, settle_after)
        VALUES (${hour}::timestamp, ${settleAfter}::bigint)
        ON CONFLICT (hour) DO NOTHING`);
    });
  }

  /**
   * The oldest marked hour that is due: marked by a change, or computed and
   * waiting to settle once every transaction running at that point has ended.
   */
  static async nextMarkedHour(): Promise<MarkedHour | null> {
    const result = await db.execute<{
      hour: string;
      version: string;
      settling: boolean;
    }>(sql`
      SELECT hour::text AS hour, version::text AS version, settle_after IS NOT NULL AS settling
      FROM ${schema.llmUsageRollupDirtyTable}
      WHERE settle_after IS NULL
        OR settle_after <= pg_snapshot_xmin(pg_current_snapshot())::text::bigint
      ORDER BY hour
      LIMIT 1`);
    const [row] = result.rows;
    return row
      ? { hour: row.hour, version: row.version, settling: row.settling }
      : null;
  }

  /**
   * Recompute a marked hour. A settled hour's mark is removed; a changed
   * hour's mark becomes a settle mark. Either only while the mark is the one
   * that was read: a change committed meanwhile bumped its version and keeps
   * the hour due.
   */
  static async recomputeMarkedHour(marked: MarkedHour): Promise<void> {
    await withDbTransaction(async (tx) => {
      const settleAfter = await recompute(tx, marked.hour);
      await tx.execute(
        marked.settling
          ? sql`
            DELETE FROM ${schema.llmUsageRollupDirtyTable}
            WHERE hour = ${marked.hour}::timestamp AND version = ${marked.version}::bigint`
          : sql`
            UPDATE ${schema.llmUsageRollupDirtyTable}
            SET settle_after = ${settleAfter}::bigint
            WHERE hour = ${marked.hour}::timestamp AND version = ${marked.version}::bigint`,
      );
    });
  }
}

export default LlmUsageRollupModel;

/** A timeframe's bounds and the part of it the rollup serves. */
export type UsageWindow = {
  /** First instant, as a `timestamp` literal. */
  start: string;
  /** Last instant (inclusive), or null for a window ending now. */
  end: string | null;
  /** Rolled hours `[from, to)` inside the window, if any. */
  served: { from: string; to: string } | null;
  /** Hours inside `served` that must be read from raw rows. */
  pendingHours: string[];
};

/**
 * Receipt facts per billed model for one interaction: a LATERAL over the
 * receipt's components grouped by model, with the parent-request flag and the
 * cache savings recomputed from each component's prices. `usage` is the
 * receipt's usage, or NULL for none (the LATERAL then yields no rows).
 */
export function billingModelFactsFor(usage: SQL) {
  return sql`LATERAL (
  SELECT component->>'model' AS model,
    bool_or(component->>'model' = COALESCE(
      jsonb_path_query_first(${usage}, '$.components[*] ? (@.kind == "message")')->>'model',
      ${usage}->'components'->0->>'model'
    )) AS parent_request,
    sum((component->>'inputTokens')::bigint) AS input_tokens,
    sum((component->>'outputTokens')::bigint) AS output_tokens,
    sum((component->>'cacheReadTokens')::bigint) AS cache_read_tokens,
    sum((component->>'cacheWriteTokens')::bigint) AS cache_write_tokens,
    sum((component->>'cost')::numeric) AS cost,
    -- A cache direction with no known rate adds no savings, as in
    -- componentCacheCosts.
    sum(round((
      COALESCE((component->>'cacheReadTokens')::numeric * ((component->'prices'->>'input')::numeric - (component->'prices'->>'cacheRead')::numeric), 0)
      + CASE WHEN component->'prices'->>'cacheWrite' IS NULL THEN 0 ELSE
          (component->>'cacheWriteTokens')::numeric * (component->'prices'->>'input')::numeric
          - ((component->>'cacheWriteTokens')::numeric - (component->>'cacheWrite1hTokens')::numeric) * (component->'prices'->>'cacheWrite')::numeric
          - (component->>'cacheWrite1hTokens')::numeric * COALESCE((component->'prices'->>'cacheWrite1h')::numeric, 0)
        END
    ) / 1000000, 10)) AS cache_savings
  FROM jsonb_array_elements(${usage}->'components') AS component
  GROUP BY component->>'model'
) AS billing_model`;
}

/**
 * The SQL interval a preset timeframe reaches back from now; custom ranges
 * have explicit bounds instead. Unknown presets read as 24 hours.
 */
export function statisticsTimeframeInterval(
  timeframe: StatisticsTimeFrame,
): string {
  switch (timeframe) {
    case "5m":
      return "5 minutes";
    case "15m":
      return "15 minutes";
    case "30m":
      return "30 minutes";
    case "1h":
      return "1 hour";
    case "24h":
      return "24 hours";
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
    case "90d":
      return "90 days";
    case "12m":
      return "12 months";
    case "all":
      return "100 years"; // Effectively all time
    default:
      return "24 hours";
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

type MarkedHour = { hour: string; version: string; settling: boolean };

const STATE_ID = 1;
/**
 * How long after an hour ends it is rolled. An interaction is stamped with
 * its transaction's start; a transaction that writes later than this after
 * starting is marked by the insert trigger instead (see the migration).
 */
const ROLL_DELAY = "15 minutes";

/**
 * Replace an hour's rollup rows with rows computed from `interactions`, and
 * return the snapshot horizon to settle after: every transaction id at or
 * above it may still commit rows into the hour.
 */
async function recompute(tx: Transaction, hour: string): Promise<string> {
  const h = schema.llmUsageHourlyTable;
  const i = schema.interactionsTable;
  await tx.delete(h).where(eq(h.hour, sql`${hour}::timestamp`));
  await tx
    .insert(h)
    .select(
      usageFactsQuery(
        and(
          gte(i.createdAt, sql`${hour}::timestamp`),
          lt(i.createdAt, sql`${hour}::timestamp + interval '1 hour'`),
        ) as SQL,
        tx,
      ),
    );
  const horizon = await tx.execute<{ xmax: string }>(
    sql`SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS xmax`,
  );
  return horizon.rows[0].xmax;
}

function timeframeBounds(
  timeframe: StatisticsTimeFrame,
): { start: SQL; end: SQL } | null {
  if (timeframe.startsWith("custom:")) {
    const range = parseCustomStatisticsTimeframe(timeframe);
    return range
      ? // As a timestamp column maps a Date: its UTC wall-clock time.
        {
          start: sql`${range.startTime.toISOString()}`,
          end: sql`${range.endTime.toISOString()}`,
        }
      : null;
  }
  return {
    start: sql`NOW() - INTERVAL ${sql.raw(`'${statisticsTimeframeInterval(timeframe)}'`)}`,
    end: sql`NULL`,
  };
}

const billingModel = billingModelFactsFor(
  sql`CASE WHEN ${schema.interactionBillingTable.usage}->>'mode' = 'enforce' THEN ${schema.interactionBillingTable.usage} END`,
);

/**
 * True on the one row of each interaction that carries its own columns: the
 * receipt's parent model, or the interaction itself without a receipt split.
 */
const parentRow = sql`(billing_model.model IS NULL OR billing_model.parent_request)`;

/**
 * Rollup rows computed from `interactions` matching `where`, grouped by hour
 * and every key column. Both the rollup writer and the raw half of
 * {@link LlmUsageRollupModel.facts} use it.
 */
function usageFactsQuery(where: SQL, executor: typeof db | Transaction = db) {
  const i = schema.interactionsTable;
  const r = schema.interactionBillingTable;
  // Decode every computed column like its rollup column, so raw and rolled
  // rows read identically.
  const h = schema.llmUsageHourlyTable;
  const hour = sql<Date>`date_trunc('hour', ${i.createdAt})`;
  const billedModel = sql<
    string | null
  >`COALESCE(billing_model.model, ${i.model})`;
  const labels = sql<AttributionLabels | null>`COALESCE(${r.attributionLabels}, ${i.attributionLabels})`;
  const own = (column: SQLWrapper, cast: string) =>
    sql`COALESCE(SUM(${column}) FILTER (WHERE ${parentRow}), 0)::${sql.raw(cast)}`;
  const split = (receipt: string, fallback: SQLWrapper) =>
    sql`COALESCE(SUM(COALESCE(billing_model.${sql.raw(receipt)}, ${fallback})), 0)`;
  return executor
    .select({
      hour: hour.mapWith(h.hour).as("hour"),
      profileId: i.profileId,
      connectorId: i.connectorId,
      appId: i.appId,
      billingTeamId: i.billingTeamId,
      userId: i.userId,
      serviceAccountId: i.serviceAccountId,
      authMethod: i.authMethod,
      virtualKeyId: i.virtualKeyId,
      passthroughVirtualKeyId: i.passthroughVirtualKeyId,
      authenticatedAppId: i.authenticatedAppId,
      authenticatedAppName: i.authenticatedAppName,
      providerApiKeyId: i.providerApiKeyId,
      modelPoolId: i.modelPoolId,
      externalAgentId: i.externalAgentId,
      type: i.type,
      model: i.model,
      billedModel: billedModel.mapWith(h.billedModel).as("billed_model"),
      billingMode: i.billingMode,
      attributionLabels: labels
        .mapWith(h.attributionLabels)
        .as("attribution_labels"),
      requests: sql<number>`(COUNT(*) FILTER (WHERE ${parentRow}))::integer`
        .mapWith(h.requests)
        .as("requests"),
      inputTokens: sql<number>`${own(i.inputTokens, "bigint")}`
        .mapWith(h.inputTokens)
        .as("input_tokens"),
      reportedInputTokens:
        sql<number>`COALESCE(SUM(${i.inputTokens}) FILTER (WHERE ${parentRow} AND NOT ${i.inputTokensEstimated}), 0)::bigint`
          .mapWith(h.reportedInputTokens)
          .as("reported_input_tokens"),
      outputTokens: sql<number>`${own(i.outputTokens, "bigint")}`
        .mapWith(h.outputTokens)
        .as("output_tokens"),
      cacheReadTokens: sql<number>`${own(i.cacheReadTokens, "bigint")}`
        .mapWith(h.cacheReadTokens)
        .as("cache_read_tokens"),
      cacheWriteTokens: sql<number>`${own(i.cacheWriteTokens, "bigint")}`
        .mapWith(h.cacheWriteTokens)
        .as("cache_write_tokens"),
      cost: sql<string>`${own(i.cost, "numeric")}`.mapWith(h.cost).as("cost"),
      baselineCost: sql<string>`${own(i.baselineCost, "numeric")}`
        .mapWith(h.baselineCost)
        .as("baseline_cost"),
      cacheCost: sql<string>`${own(i.cacheCost, "numeric")}`
        .mapWith(h.cacheCost)
        .as("cache_cost"),
      cacheSavings: sql<string>`${own(i.cacheSavings, "numeric")}`
        .mapWith(h.cacheSavings)
        .as("cache_savings"),
      failedOverAttempts:
        sql<number>`(COUNT(*) FILTER (WHERE ${parentRow} AND ${i.attemptOutcome} = 'failed_over'))::integer`
          .mapWith(h.failedOverAttempts)
          .as("failed_over_attempts"),
      maxCreatedAt:
        sql<Date | null>`MAX(${i.createdAt}) FILTER (WHERE ${parentRow})`
          .mapWith(h.maxCreatedAt)
          .as("max_created_at"),
      modelInputTokens:
        sql<number>`${split("input_tokens", i.inputTokens)}::bigint`
          .mapWith(h.modelInputTokens)
          .as("model_input_tokens"),
      modelReportedInputTokens:
        sql<number>`${split("input_tokens", sql`CASE WHEN NOT ${i.inputTokensEstimated} THEN ${i.inputTokens} ELSE 0 END`)}::bigint`
          .mapWith(h.modelReportedInputTokens)
          .as("model_reported_input_tokens"),
      modelOutputTokens:
        sql<number>`${split("output_tokens", i.outputTokens)}::bigint`
          .mapWith(h.modelOutputTokens)
          .as("model_output_tokens"),
      modelCacheReadTokens:
        sql<number>`${split("cache_read_tokens", i.cacheReadTokens)}::bigint`
          .mapWith(h.modelCacheReadTokens)
          .as("model_cache_read_tokens"),
      modelCacheWriteTokens:
        sql<number>`${split("cache_write_tokens", i.cacheWriteTokens)}::bigint`
          .mapWith(h.modelCacheWriteTokens)
          .as("model_cache_write_tokens"),
      modelCost: sql<string>`${split("cost", i.cost)}::numeric`
        .mapWith(h.modelCost)
        .as("model_cost"),
      modelBaselineCost: sql<string>`${split("cost", i.baselineCost)}::numeric`
        .mapWith(h.modelBaselineCost)
        .as("model_baseline_cost"),
      modelCacheSavings:
        sql<string>`${split("cache_savings", i.cacheSavings)}::numeric`
          .mapWith(h.modelCacheSavings)
          .as("model_cache_savings"),
    })
    .from(i)
    .leftJoin(r, eq(r.interactionId, i.id))
    .leftJoin(billingModel, sql`true`)
    .where(where)
    .groupBy(
      hour,
      i.profileId,
      i.connectorId,
      i.appId,
      i.billingTeamId,
      i.userId,
      i.serviceAccountId,
      i.authMethod,
      i.virtualKeyId,
      i.passthroughVirtualKeyId,
      i.authenticatedAppId,
      i.authenticatedAppName,
      i.providerApiKeyId,
      i.modelPoolId,
      i.externalAgentId,
      i.type,
      i.model,
      billedModel,
      i.billingMode,
      labels,
    );
}

/** The rollup's own columns, in {@link usageFactsQuery}'s shape. */
const rollupSelection = (() => {
  const h = schema.llmUsageHourlyTable;
  return {
    hour: h.hour,
    profileId: h.profileId,
    connectorId: h.connectorId,
    appId: h.appId,
    billingTeamId: h.billingTeamId,
    userId: h.userId,
    serviceAccountId: h.serviceAccountId,
    authMethod: h.authMethod,
    virtualKeyId: h.virtualKeyId,
    passthroughVirtualKeyId: h.passthroughVirtualKeyId,
    authenticatedAppId: h.authenticatedAppId,
    authenticatedAppName: h.authenticatedAppName,
    providerApiKeyId: h.providerApiKeyId,
    modelPoolId: h.modelPoolId,
    externalAgentId: h.externalAgentId,
    type: h.type,
    model: h.model,
    billedModel: h.billedModel,
    billingMode: h.billingMode,
    attributionLabels: h.attributionLabels,
    requests: h.requests,
    inputTokens: h.inputTokens,
    reportedInputTokens: h.reportedInputTokens,
    outputTokens: h.outputTokens,
    cacheReadTokens: h.cacheReadTokens,
    cacheWriteTokens: h.cacheWriteTokens,
    cost: h.cost,
    baselineCost: h.baselineCost,
    cacheCost: h.cacheCost,
    cacheSavings: h.cacheSavings,
    failedOverAttempts: h.failedOverAttempts,
    maxCreatedAt: h.maxCreatedAt,
    modelInputTokens: h.modelInputTokens,
    modelReportedInputTokens: h.modelReportedInputTokens,
    modelOutputTokens: h.modelOutputTokens,
    modelCacheReadTokens: h.modelCacheReadTokens,
    modelCacheWriteTokens: h.modelCacheWriteTokens,
    modelCost: h.modelCost,
    modelBaselineCost: h.modelBaselineCost,
    modelCacheSavings: h.modelCacheSavings,
  };
})();
