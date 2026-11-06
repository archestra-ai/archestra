import {
  getStatisticsBucketIntervalMinutes,
  parseCustomStatisticsTimeframe,
  type StatisticsTimeFrame,
} from "@archestra/shared";
import {
  and,
  eq,
  gte,
  lt,
  lte,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type { AttributionLabels } from "@/types/attribution-label";

/**
 * Reads and writes of the LLM usage rollup (`llm_usage_hourly`, and its daily
 * sums in `llm_usage_daily`).
 *
 * Cost statistics read {@link LlmUsageRollupModel.facts}: rollup rows for the
 * hours of a window the rollup serves (daily rows for its whole, unmarked days
 * when it buckets by days or longer), and the same rows computed from
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
    const grain =
      statisticsTimeBucket(timeframe) === "minute" ? "minute" : "hour";
    const result = await db.execute<{
      start: string;
      end: string | null;
      served_from: string | null;
      served_to: string | null;
      days_from: string | null;
      days_to: string | null;
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
        (CASE WHEN date_trunc('day', served.served_from) = served.served_from THEN served.served_from
          ELSE date_trunc('day', served.served_from) + interval '1 day' END)::text AS days_from,
        date_trunc('day', served.served_to)::text AS days_to
      FROM bounds, served`);
    const [row] = result.rows;
    // Minute buckets need raw rows: the rollup only has hours.
    const serves =
      grain === "hour" &&
      row.served_from !== null &&
      row.served_to !== null &&
      row.served_from < row.served_to;
    // Daily rows only fit buckets made of whole UTC days.
    const servesDays =
      serves &&
      DAY_BUCKETS.has(statisticsTimeBucket(timeframe)) &&
      getStatisticsBucketIntervalMinutes(timeframe) % MINUTES_PER_DAY === 0 &&
      row.days_from !== null &&
      row.days_to !== null &&
      row.days_from < row.days_to;
    return {
      start: row.start,
      end: row.end,
      grain,
      served: serves
        ? {
            from: row.served_from as string,
            to: row.served_to as string,
            days: servesDays
              ? { from: row.days_from as string, to: row.days_to as string }
              : null,
          }
        : null,
    };
  }

  /**
   * Usage rows of a window, one per key and hour (see `llm_usage_hourly` for
   * the columns). Aggregate them; a group can span several rows.
   */
  static facts(window: UsageWindow | null) {
    const i = schema.interactionsTable;
    // An unparseable range matches nothing, as in timeframeConditions.
    if (!window) return usageFactsQuery(sql`FALSE`, "hour").as("usage_facts");
    const inWindow = and(
      gte(i.createdAt, sql`${window.start}::timestamp`),
      window.end === null
        ? undefined
        : lte(i.createdAt, sql`${window.end}::timestamp`),
    ) as SQL;
    if (!window.served) {
      return usageFactsQuery(inWindow, window.grain).as("usage_facts");
    }
    const { from, to, days } = window.served;
    const d = schema.llmUsageRollupDirtyTable;
    // Marked hours are read from raw rows. The rolled and raw halves test the
    // same marks because one statement reads them under one snapshot.
    const marked = db
      .select({ hour: sql<Date>`${d.hour}`.as("marked_hour") })
      .from(d)
      .where(
        and(
          gte(d.hour, sql`${from}::timestamp`),
          lt(d.hour, sql`${to}::timestamp`),
        ),
      )
      .as("marked");
    // Every part selects the rollup's columns in one order; their types differ
    // only in the table each column is read from.
    type Part = ReturnType<typeof rolledHours>;
    const rolled = days
      ? [
          rolledHours(from, days.from),
          rolledHours(days.to, to),
          rolledDays(days) as unknown as Part,
          hoursOfMarkedDays(days) as unknown as Part,
        ]
      : [rolledHours(from, to)];
    // The window's parts outside the served hours, each its own range so
    // each is an index range scan.
    const head = usageFactsQuery(
      and(
        gte(i.createdAt, sql`${window.start}::timestamp`),
        lt(i.createdAt, sql`${from}::timestamp`),
      ) as SQL,
      window.grain,
    );
    const tail = usageFactsQuery(
      and(
        gte(i.createdAt, sql`${to}::timestamp`),
        window.end === null
          ? undefined
          : lte(i.createdAt, sql`${window.end}::timestamp`),
      ) as SQL,
      window.grain,
    );
    // Each marked hour, as its own index range scan: the fence (OFFSET 0)
    // keeps PostgreSQL from flattening the per-hour query and scanning the
    // whole window instead.
    const markedHour = usageFactsQuery(
      and(
        inWindow,
        gte(i.createdAt, marked.hour),
        lt(i.createdAt, sql`${marked.hour} + interval '1 hour'`),
      ) as SQL,
      window.grain,
    )
      .offset(0)
      .as("marked_usage");
    const remarked = db
      .select(columnsOf(markedHour))
      .from(marked)
      .innerJoinLateral(markedHour, sql`true`);
    const [first, ...others] = rolled;
    return unionAll(first, head, tail, remarked, ...others).as("usage_facts");
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
      await lockRollup(tx);
      // No state row means nothing is rolled yet.
      const advanced = await tx.execute(sql`
        INSERT INTO ${schema.llmUsageRollupStateTable} AS state (id, rolled_through)
        VALUES (${STATE_ID}, ${hour}::timestamp + interval '1 hour')
        ON CONFLICT (id) DO UPDATE SET rolled_through = excluded.rolled_through
        WHERE state.rolled_through = ${hour}::timestamp OR state.rolled_through IS NULL`);
      if (advanced.rowCount === 0) return;
      const settleAfter = await recompute(tx, hour);
      // A mark already there (a change in the hour before it was rolled)
      // becomes a change mark: computed again, then settled in turn. Keeping it
      // as it was could keep an older settle horizon than this computation's.
      await tx.execute(sql`
        INSERT INTO ${schema.llmUsageRollupDirtyTable} AS dirty (hour, settle_after)
        VALUES (${hour}::timestamp, ${settleAfter}::bigint)
        ON CONFLICT (hour) DO UPDATE SET version = dirty.version + 1, settle_after = NULL`);
    });
  }

  /**
   * The oldest rolled, marked hour that is due: marked by a change, or
   * computed and waiting to settle once every transaction running at that
   * point has ended.
   */
  static async nextMarkedHour(): Promise<MarkedHour | null> {
    const result = await db.execute<{
      hour: string;
      version: string;
      settling: boolean;
    }>(sql`
      SELECT hour::text AS hour, version::text AS version, settle_after IS NOT NULL AS settling
      FROM ${schema.llmUsageRollupDirtyTable}
      WHERE (settle_after IS NULL
          OR settle_after <= pg_snapshot_xmin(pg_current_snapshot())::text::bigint)
        -- An hour not rolled yet is computed when it is rolled.
        AND hour < (SELECT rolled_through FROM ${schema.llmUsageRollupStateTable} WHERE id = ${STATE_ID})
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
      await lockRollup(tx);
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

/** A window's usage rows (see {@link LlmUsageRollupModel.facts}). */
export type UsageFacts = ReturnType<typeof LlmUsageRollupModel.facts>;

/** A timeframe's bounds and the part of it the rollup serves. */
export type UsageWindow = {
  /** First instant, as a `timestamp` literal. */
  start: string;
  /** Last instant (inclusive), or null for a window ending now. */
  end: string | null;
  /** Unit raw rows are grouped by; the rollup only serves `hour` windows. */
  grain: "hour" | "minute";
  /**
   * Rolled hours `[from, to)` inside the window, if any. Its marked hours are
   * read from raw rows. `days`: the whole days `[from, to)` among them read
   * from daily rows, when the window buckets by whole days.
   */
  served: {
    from: string;
    to: string;
    days: { from: string; to: string } | null;
  } | null;
};

/**
 * Receipt facts per billed model for one interaction: a LATERAL over the
 * receipt's components grouped by model, with the parent-request flag and the
 * cache savings recomputed from each component's prices. `usage` is the
 * receipt's usage, or NULL for none (the LATERAL then yields no rows).
 */
function billingModelFactsFor(usage: SQL) {
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

/**
 * The `date_trunc` unit statistics bucket a timeframe by before any
 * re-bucketing into wider intervals.
 */
export function statisticsTimeBucket(timeframe: StatisticsTimeFrame): string {
  if (typeof timeframe === "string" && timeframe.startsWith("custom:")) {
    const customRange = parseCustomStatisticsTimeframe(timeframe);
    if (!customRange) return "hour";

    const durationMs =
      customRange.endTime.getTime() - customRange.startTime.getTime();
    const durationHours = durationMs / (1000 * 60 * 60);

    if (durationHours <= 2) return "minute";
    if (durationHours <= 48) return "hour";
    if (durationHours <= 720) return "day"; // 30 days
    return "week";
  }

  switch (timeframe) {
    case "5m":
    case "15m":
    case "30m":
    case "1h":
      // Minutes; 30m and 1h are rounded to 5-minute intervals afterwards.
      return "minute";
    case "24h":
    case "7d":
      // 7d is grouped into 6-hour intervals afterwards.
      return "hour";
    case "30d":
    case "90d":
      // 90d is grouped into 3-day intervals afterwards.
      return "day";
    case "12m":
      return "week";
    case "all":
      return "month";
    default:
      return "hour";
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

type MarkedHour = { hour: string; version: string; settling: boolean };

const STATE_ID = 1;
const MINUTES_PER_DAY = 24 * 60;
const DAY_BUCKETS = new Set(["day", "week", "month"]);
/**
 * How long after an hour ends it is rolled. An interaction is stamped with
 * its transaction's start; a transaction that writes later than this after
 * starting is marked by the insert trigger instead (see the migration).
 */
const ROLL_DELAY = "15 minutes";

/**
 * Serialize the rollup's writes: two computations of one hour at once would
 * each delete the rows the other cannot see yet and keep both inserts.
 */
async function lockRollup(tx: Transaction) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('llm_usage_rollup', 0))`,
  );
}

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
        "hour",
        tx,
      ),
    );
  await recomputeDay(tx, hour);
  const horizon = await tx.execute<{ xmax: string }>(
    sql`SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS xmax`,
  );
  return horizon.rows[0].xmax;
}

/**
 * Replace the daily rows of the hour's day with its hourly rows summed, once
 * every hour of the day is rolled.
 */
async function recomputeDay(tx: Transaction, hour: string): Promise<void> {
  const h = schema.llmUsageHourlyTable;
  const daily = schema.llmUsageDailyTable;
  const day = sql`date_trunc('day', ${hour}::timestamp)`;
  await tx.delete(daily).where(eq(daily.hour, day));
  const keys = KEY_COLUMNS.map((key) => h[key]);
  const summed = Object.fromEntries(
    Object.keys(rollupColumns(h)).map((key) => {
      const column = h[key as keyof typeof rollupSelection];
      if (key === "hour")
        return [key, sql`date_trunc('day', ${h.hour})`.as("hour")];
      if ((KEY_COLUMNS as string[]).includes(key)) return [key, column];
      if (key === "maxCreatedAt")
        return [key, sql`MAX(${column})`.as(column.name)];
      const cast =
        column.columnType === "PgInteger"
          ? "integer"
          : column.columnType === "PgNumeric"
            ? "numeric"
            : "bigint";
      return [key, sql`SUM(${column})::${sql.raw(cast)}`.as(column.name)];
    }),
  ) as typeof rollupSelection;
  await tx.insert(daily).select(
    tx
      .select(summed)
      .from(h)
      .where(
        and(
          gte(h.hour, day),
          lt(h.hour, sql`${day} + interval '1 day'`),
          sql`EXISTS (SELECT 1 FROM ${schema.llmUsageRollupStateTable} AS state
            WHERE state.id = ${STATE_ID} AND state.rolled_through >= ${day} + interval '1 day')`,
        ),
      )
      .groupBy(sql`date_trunc('day', ${h.hour})`, ...keys),
  );
}

/** Rolled, unmarked hours `[from, to)`. */
function rolledHours(from: string, to: string) {
  const h = schema.llmUsageHourlyTable;
  return db
    .select(rollupSelection)
    .from(h)
    .where(
      and(
        gte(h.hour, sql`${from}::timestamp`),
        lt(h.hour, sql`${to}::timestamp`),
        notMarked(h.hour),
      ),
    );
}

/** Daily rows of the whole days `[from, to)` with no marked hour. */
function rolledDays(days: { from: string; to: string }) {
  const daily = schema.llmUsageDailyTable;
  return db
    .select(rollupColumns(daily))
    .from(daily)
    .where(
      and(
        gte(daily.hour, sql`${days.from}::timestamp`),
        lt(daily.hour, sql`${days.to}::timestamp`),
        sql`${daily.hour} NOT IN (SELECT date_trunc('day', ${schema.llmUsageRollupDirtyTable.hour}) FROM ${schema.llmUsageRollupDirtyTable})`,
      ),
    );
}

/**
 * The unmarked hours of the days `[from, to)` that have a marked hour, each
 * day its own index range scan (fenced, as in the marked hours' raw read).
 */
function hoursOfMarkedDays(days: { from: string; to: string }) {
  const d = schema.llmUsageRollupDirtyTable;
  const h = schema.llmUsageHourlyTable;
  const markedDay = db
    .selectDistinct({
      day: sql<Date>`date_trunc('day', ${d.hour})`.as("marked_day"),
    })
    .from(d)
    .where(
      and(
        gte(d.hour, sql`${days.from}::timestamp`),
        lt(d.hour, sql`${days.to}::timestamp`),
      ),
    )
    .as("marked_days");
  const dayHours = db
    .select(rollupSelection)
    .from(h)
    .where(
      and(
        gte(h.hour, markedDay.day),
        lt(h.hour, sql`${markedDay.day} + interval '1 day'`),
        notMarked(h.hour),
      ),
    )
    .offset(0)
    .as("marked_day_hours");
  return db
    .select(columnsOf(dayHours))
    .from(markedDay)
    .innerJoinLateral(dayHours, sql`true`);
}

/** Not a marked hour: a hashed set of the marks, read once per statement. */
function notMarked(hour: SQLWrapper) {
  const d = schema.llmUsageRollupDirtyTable;
  return sql`${hour} NOT IN (SELECT ${d.hour} FROM ${d})`;
}

/** The rollup columns of a subquery, in {@link rollupSelection}'s order. */
function columnsOf<S extends Record<keyof typeof rollupSelection, unknown>>(
  subquery: S,
) {
  return Object.fromEntries(
    Object.keys(rollupSelection).map((key) => [
      key,
      subquery[key as keyof typeof rollupSelection],
    ]),
  ) as { [K in keyof typeof rollupSelection]: S[K] };
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
 * Rollup rows computed from `interactions` matching `where`, grouped by
 * `grain` (in the `hour` column) and every key column. Both the rollup writer
 * and the raw half of {@link LlmUsageRollupModel.facts} use it.
 */
function usageFactsQuery(
  where: SQL,
  grain: UsageWindow["grain"],
  executor: typeof db | Transaction = db,
) {
  const i = schema.interactionsTable;
  const r = schema.interactionBillingTable;
  // Decode every computed column like its rollup column, so raw and rolled
  // rows read identically.
  const h = schema.llmUsageHourlyTable;
  const hour = sql<Date>`date_trunc(${sql.raw(`'${grain}'`)}, ${i.createdAt})`;
  const billedModel = sql<
    string | null
  >`COALESCE(billing_model.model, ${i.model})`;
  const labels = sql<AttributionLabels | null>`COALESCE(${r.attributionLabels}, ${i.attributionLabels})`;
  const own = (column: SQLWrapper, cast: string) =>
    sql`COALESCE(SUM(${column}) FILTER (WHERE ${parentRow}), 0)::${sql.raw(cast)}`;
  const split = (receipt: string, fallback: SQLWrapper) =>
    sql`COALESCE(SUM(COALESCE(billing_model.${sql.raw(receipt)}, ${fallback})), 0)`;
  const query = executor
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
    .$dynamic();
  return query
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

/** A rollup table's columns, in {@link usageFactsQuery}'s shape. */
function rollupColumns(
  h: typeof schema.llmUsageHourlyTable | typeof schema.llmUsageDailyTable,
) {
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
}

const rollupSelection = rollupColumns(schema.llmUsageHourlyTable);

/** The columns a rollup row is keyed by (every column but the measures). */
const KEY_COLUMNS = [
  "profileId",
  "connectorId",
  "appId",
  "billingTeamId",
  "userId",
  "serviceAccountId",
  "authMethod",
  "virtualKeyId",
  "passthroughVirtualKeyId",
  "authenticatedAppId",
  "authenticatedAppName",
  "providerApiKeyId",
  "modelPoolId",
  "externalAgentId",
  "type",
  "model",
  "billedModel",
  "billingMode",
  "attributionLabels",
] as const satisfies (keyof typeof rollupSelection)[];
