import type { SupportedProvider } from "@archestra/shared";
import { type SQL, sql } from "drizzle-orm";
import db, { type Transaction } from "@/database";

/**
 * The reads and writes of a model cost backfill over `interactions`.
 *
 * Every query here is shaped for `interactions_model_created_at_idx`
 * (`(model, created_at, id) INCLUDE (type, token counts, cost, billing_mode,
 * user_id)`): reads are index-only and the batch walk is an index range scan.
 * The service checks that index is ready before calling any of them.
 */
class InteractionCostBackfillModel {
  /**
   * Eligible requests per calendar day (in `timeZone`) over the model's whole
   * history, with their recorded cost and token sums. Price-independent, so
   * the preview prices these sums for any prices the admin types.
   */
  static async getDailyHistory(params: {
    scope: BackfillScope;
    timeZone: string;
  }): Promise<CostHistoryDay[]> {
    return withStatementTimeout(PREVIEW_STATEMENT_TIMEOUT_MS, async (tx) => {
      const day = sql`to_char(date_trunc('day', (i.created_at at time zone 'UTC') at time zone ${params.timeZone}), 'YYYY-MM-DD')`;
      const result = await tx.execute<CostHistoryDayRow>(sql`
        select ${day} as day,
          count(*)::integer as requests,
          ${tokenSums()},
          coalesce(sum(i.cost), 0)::text as recorded_cost
        from interactions i
        where ${eligible(params.scope)}
        group by 1
        order by 1`);
      return result.rows.map((row) => ({
        day: row.day,
        requests: row.requests,
        recordedCost: Number(row.recorded_cost),
        tokens: toTokenSums(row),
      }));
    });
  }

  /**
   * Totals for the requests a backfill over [since, until) would recompute,
   * plus how many in that window are excluded because an enforced cost limit
   * already settled them.
   */
  static async getWindowTotals(params: {
    scope: BackfillScope;
    since: Date;
    until: Date;
  }): Promise<CostWindowTotals> {
    return withStatementTimeout(PREVIEW_STATEMENT_TIMEOUT_MS, async (tx) => {
      // One pass over the model's window: each row probes its own receipt,
      // instead of a second query reading every receipt of every model.
      const open = sql`b.interaction_id is null`;
      const result = await tx.execute<CostWindowRow>(sql`
        select
          count(*) filter (where ${open})::integer as requests,
          count(*) filter (where ${open} and i.billing_mode = 'subscription')::integer as subscription_requests,
          count(distinct i.user_id) filter (where ${open})::integer as users,
          ${tokenSums(open)},
          coalesce(sum(i.cost) filter (where ${open}), 0)::text as recorded_cost,
          count(*) filter (where not ${open})::integer as settled_requests,
          coalesce(max(i.input_tokens) filter (where ${open}), 0)::text as max_input_tokens,
          coalesce(max(i.output_tokens) filter (where ${open}), 0)::text as max_output_tokens,
          coalesce(max(i.cache_read_tokens) filter (where ${open}), 0)::text as max_cache_read_tokens,
          coalesce(max(i.cache_write_tokens) filter (where ${open}), 0)::text as max_cache_write_tokens
        from interactions i
        left join interaction_billing b
          on b.interaction_id = i.id and ${ENFORCE_RECEIPT}
        where ${matches(params.scope)}
          and i.created_at >= ${toUtcTimestamp(params.since)}::timestamp
          and i.created_at < ${toUtcTimestamp(params.until)}::timestamp`);
      const row = result.rows[0];
      return {
        requests: row.requests,
        subscriptionRequests: row.subscription_requests,
        users: row.users,
        recordedCost: Number(row.recorded_cost),
        tokens: toTokenSums(row),
        settledRequests: row.settled_requests,
        // Each count's largest value, from whichever request: together they
        // bound what any one request can be charged.
        largestRequestBound: {
          inputTokens: Number(row.max_input_tokens),
          outputTokens: Number(row.max_output_tokens),
          cacheReadTokens: Number(row.max_cache_read_tokens),
          cacheWriteTokens: Number(row.max_cache_write_tokens),
          cacheWrite1hTokens: Number(row.max_cache_write_tokens),
        },
      };
    });
  }

  /**
   * The next eligible rows after `after` (or from `from` on the first batch),
   * strictly before `until`, in `(created_at, id)` order.
   */
  static async findBatch(params: {
    scope: BackfillScope;
    from: Date;
    until: Date;
    after: BatchCursor | null;
    limit: number;
  }): Promise<CostBackfillRow[]> {
    const { scope, from, until, after, limit } = params;
    const start = after
      ? sql`(i.created_at, i.id) > (${after.createdAt}::timestamp, ${after.id}::uuid)`
      : sql`i.created_at >= ${toUtcTimestamp(from)}::timestamp`;
    // Aliased created_at_text, not created_at: an output column named
    // created_at would capture the ORDER BY and turn the index walk into a
    // sort of the whole range.
    const result = await db.execute<CostBackfillDbRow>(sql`
      select i.id, i.created_at::text as created_at_text,
        i.input_tokens, i.output_tokens, i.cache_read_tokens,
        i.cache_write_tokens, i.cache_write_1h_tokens
      from interactions i
      where ${eligible(scope)}
        and ${start}
        and i.created_at < ${toUtcTimestamp(until)}::timestamp
      order by i.created_at, i.id
      limit ${limit}`);
    return result.rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at_text,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      cacheWrite1hTokens: row.cache_write_1h_tokens,
    }));
  }

  /**
   * Write recomputed costs, touching only rows whose stored values change.
   * Mirrors what the write path stores: knowledge-base rows only ever carry
   * `cost`; `baseline_cost` follows `cost` unless the row recorded a different
   * baseline model (a model swap, priced by that other model). Bounded by
   * lock and statement timeouts so a contended batch fails fast and is retried
   * rather than queueing behind the proxy. Returns how many rows changed.
   */
  static async applyBatch(
    rows: RecomputedCost[],
    tx: Transaction,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    await tx.execute(
      sql`select set_config('lock_timeout', ${BATCH_LOCK_TIMEOUT}, true),
                 set_config('statement_timeout', ${BATCH_STATEMENT_TIMEOUT}, true)`,
    );
    const values = sql.join(
      rows.map(
        (row) =>
          sql`(${row.id}::uuid, ${row.cost}::numeric, ${row.cacheCost}::numeric, ${row.cacheSavings}::numeric)`,
      ),
      sql`, `,
    );
    // coalesce: a NULL source would make `not knowledge` NULL and silently
    // drop rows whose only change is in the cache or baseline columns.
    const knowledge = sql`coalesce(i.source, '') like 'knowledge:%'`;
    const baselineFollowsCost = sql`(i.baseline_model is null or i.baseline_model = i.model)`;
    const result = await tx.execute<{ id: string }>(sql`
      update interactions i set
        cost = v.cost,
        baseline_cost = case
          when ${knowledge} or not ${baselineFollowsCost} then i.baseline_cost
          else v.cost end,
        cache_cost = case when ${knowledge} then i.cache_cost else v.cache_cost end,
        cache_savings = case when ${knowledge} then i.cache_savings else v.cache_savings end
      from (values ${values}) as v(id, cost, cache_cost, cache_savings)
      where i.id = v.id
        and (
          i.cost is distinct from v.cost
          or (not ${knowledge} and (
            i.cache_cost is distinct from v.cache_cost
            or i.cache_savings is distinct from v.cache_savings
            or (${baselineFollowsCost} and i.baseline_cost is distinct from v.cost)
          ))
        )
      returning i.id`);
    return result.rows.length;
  }
}

export default InteractionCostBackfillModel;

/** Which recorded requests belong to a model: exact model id + provider. */
export interface BackfillScope {
  modelId: string;
  provider: SupportedProvider;
}

export interface TokenSums {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Already clamped per row to [0, cache_write_tokens], as pricing does. */
  cacheWrite1hTokens: number;
}

export interface CostHistoryDay {
  /** YYYY-MM-DD in the requested time zone. */
  day: string;
  requests: number;
  recordedCost: number;
  tokens: TokenSums;
}

export interface CostWindowTotals {
  requests: number;
  subscriptionRequests: number;
  users: number;
  recordedCost: number;
  tokens: TokenSums;
  settledRequests: number;
  /** Token counts no single request in the window exceeds. */
  largestRequestBound: TokenSums;
}

interface BatchCursor {
  /** `created_at::text`, microsecond-exact. */
  createdAt: string;
  id: string;
}

export interface CostBackfillRow extends BatchCursor {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
}

export interface RecomputedCost {
  id: string;
  /** Decimal strings with 10 places, as the write path stores them. */
  cost: string;
  cacheCost: string | null;
  cacheSavings: string | null;
}

// ===

// A read that never blocks writers; ~1 µs per row, so 30 s covers a model
// with tens of millions of requests even with a cold cache.
const PREVIEW_STATEMENT_TIMEOUT_MS = 30_000;
const BATCH_LOCK_TIMEOUT = "2s";
const BATCH_STATEMENT_TIMEOUT = "15s";

const ENFORCE_RECEIPT = sql`b.usage->>'mode' = 'enforce'`;

/** Token sums, with the 1h cache writes clamped per row as pricing does. */
function tokenSums(filter?: SQL): SQL {
  const only = filter ? sql` filter (where ${filter})` : sql``;
  return sql`
    coalesce(sum(i.input_tokens)${only}, 0)::bigint::text as input_tokens,
    coalesce(sum(i.output_tokens)${only}, 0)::bigint::text as output_tokens,
    coalesce(sum(i.cache_read_tokens)${only}, 0)::bigint::text as cache_read_tokens,
    coalesce(sum(i.cache_write_tokens)${only}, 0)::bigint::text as cache_write_tokens,
    coalesce(sum(least(greatest(coalesce(i.cache_write_1h_tokens, 0), 0), coalesce(i.cache_write_tokens, 0)))${only}, 0)::bigint::text as cache_write_1h_tokens`;
}

/**
 * The requests a backfill recomputes:
 * - this model, from this provider (the interaction type's prefix);
 * - not audio or image requests, whose cost is never available;
 * - with some recorded usage, since there is nothing to price otherwise;
 * - not settled by an enforced cost limit: that receipt is the authoritative
 *   charge, and limit balances and statistics read it instead of the row.
 */
function eligible(scope: BackfillScope): SQL {
  return sql`${matches(scope)}
    and not exists (
      select 1 from interaction_billing b
      where b.interaction_id = i.id and ${ENFORCE_RECEIPT}
    )`;
}

/** {@link eligible} without the settled-receipt check. */
function matches(scope: BackfillScope): SQL {
  return sql`i.model = ${scope.modelId}
    and split_part(i.type, ':', 1) = ${scope.provider}
    and i.type not like '%:audio'
    and i.type <> 'azure:images'
    and (coalesce(i.input_tokens, 0) > 0 or coalesce(i.output_tokens, 0) > 0
      or coalesce(i.cache_read_tokens, 0) > 0 or coalesce(i.cache_write_tokens, 0) > 0)`;
}

/**
 * `interactions.created_at` is a timestamp without time zone holding UTC.
 * Bind instants as UTC wall-clock text so the database's or the driver's
 * time zone can't shift them.
 */
function toUtcTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

async function withStatementTimeout<T>(
  ms: number,
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(ms)}, true)`,
    );
    return callback(tx);
  });
}

function toTokenSums(row: TokenSumColumns): TokenSums {
  return {
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    cacheWrite1hTokens: Number(row.cache_write_1h_tokens),
  };
}

interface TokenSumColumns extends Record<string, unknown> {
  input_tokens: string;
  output_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  cache_write_1h_tokens: string;
}

interface CostHistoryDayRow extends TokenSumColumns {
  day: string;
  requests: number;
  recorded_cost: string;
}

interface CostWindowRow extends TokenSumColumns {
  requests: number;
  subscription_requests: number;
  users: number;
  recorded_cost: string;
  settled_requests: number;
  max_input_tokens: string;
  max_output_tokens: string;
  max_cache_read_tokens: string;
  max_cache_write_tokens: string;
}

interface CostBackfillDbRow extends Record<string, unknown> {
  id: string;
  created_at_text: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cache_write_1h_tokens: number | null;
}
