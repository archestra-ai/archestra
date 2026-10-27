import {
  CLAUDE_CODE_HEADER_SESSION_SOURCE,
  OPENCODE_FAMILY_SESSION_SOURCES,
} from "@archestra/shared";
import { and, asc, eq, notExists, type SQL, sql } from "drizzle-orm";
import { readInteractionRow } from "@/content-encryption/audit-rows";
import db, { schema, type Transaction } from "@/database";
import type { SessionSource } from "@/routes/proxy/utils/headers/session-id";
import {
  type RoutingApiShape,
  RoutingApiShapeSchema,
  type RoutingBackfillBreakdown,
  type RoutingDecisionFeatures,
  RoutingDecisionFeaturesSchema,
  type RoutingHistoryScoreStatus,
  type RoutingHistorySession,
  SelectRoutingHistorySessionSchema,
} from "@/types/auto-routing";
import type { FitVolume } from "./routing-usage";

const sessions = schema.routingHistorySessionsTable;
const scores = schema.routingHistoryScoresTable;

/**
 * Session sources that name one conversation. `openai_user` and
 * `claude_metadata` can span many (a user id, a forked conversation), and
 * `auto_routing` sessions are live history already.
 */
const SESSION_SOURCES: Exclude<SessionSource, null>[] = [
  "header",
  "meta_header",
  "codex_session",
  "pi_session",
  CLAUDE_CODE_HEADER_SESSION_SOURCE,
  ...OPENCODE_FAMILY_SESSION_SOURCES,
];

/** A session counts once nothing was added to it for this long before the scan's cutoff. */
const HISTORY_IDLE_MS = 24 * 60 * 60 * 1000;
/** Every query into `interactions` runs under this, so a slow scan fails its batch instead of holding a connection. */
const STATEMENT_TIMEOUT_MS = 20_000;
/** Rows of a session read to find its opening main turn. */
const OPENING_ROWS = 20;

/** One eligible interaction of a scan batch, scalars only. */
type ScanRow = {
  id: string;
  createdAtText: string;
  sessionKey: string;
  sessionSource: string;
  apiShape: RoutingApiShape;
  client: string;
  tokens: number;
};

/** A session's first rows, decrypted where the server holds the key. */
export type OpeningRow = {
  id: string;
  request: unknown;
  sessionSource: string | null;
  source: string | null;
  parentId: string | null;
  encrypted: boolean;
};

class RoutingHistoryModel {
  /** The organization's agents, deleted ones included: every past interaction belongs to one of them. */
  static async profileIds(organizationId: string): Promise<string[]> {
    const agents = schema.agentsTable;
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.organizationId, organizationId))
      .orderBy(asc(agents.id));
    return rows.map((row) => row.id);
  }

  /**
   * The next eligible interactions of one profile in [windowStart, cutoff)
   * after `after`, in (created_at, id) order, scalars only.
   */
  static async readScanBatch(params: {
    profileId: string;
    windowStart: Date;
    cutoff: Date;
    after: { createdAt: string; id: string } | null;
    limit: number;
  }): Promise<ScanRow[]> {
    const { after } = params;
    const start = after
      ? sql`(i.created_at, i.id) > (${after.createdAt}::timestamp, ${after.id}::uuid)`
      : sql`i.created_at >= ${utc(params.windowStart)}::timestamp`;
    const rows = await withStatementTimeout((tx) =>
      tx.execute<{
        id: string;
        created_at_text: string;
        session_id: string;
        session_source: string;
        type: string;
        client: string;
        tokens: string;
      }>(sql`
        select i.id, i.created_at::text as created_at_text, i.session_id,
          i.session_source, i.type, coalesce(i.external_agent_id, 'unknown') as client,
          coalesce(i.input_tokens, 0) + coalesce(i.cache_read_tokens, 0)
            + coalesce(i.cache_write_tokens, 0) + coalesce(i.output_tokens, 0) as tokens
        from interactions i
        where i.profile_id = ${params.profileId}
          and ${start}
          and i.created_at < ${utc(params.cutoff)}::timestamp
          and ${eligibleInteraction}
        order by i.created_at, i.id
        limit ${params.limit}`),
    );
    return rows.rows.map((row) => ({
      id: row.id,
      createdAtText: row.created_at_text,
      sessionKey: row.session_id,
      sessionSource: row.session_source,
      apiShape: apiShape(row.type),
      client: row.client,
      tokens: Number(row.tokens),
    }));
  }

  /**
   * Folds a batch into the backfill's sessions. A session another backfill
   * found first is left as that scan froze it.
   */
  static async upsertSessions(
    params: { organizationId: string; backfillId: string; rows: ScanRow[] },
    tx: Transaction,
  ): Promise<void> {
    const bySession = new Map<string, ScanRow[]>();
    for (const row of params.rows) {
      const rows = bySession.get(row.sessionKey) ?? [];
      rows.push(row);
      bySession.set(row.sessionKey, rows);
    }
    if (bySession.size === 0) return;
    const values = [...bySession.values()].map((rows) => {
      const [first] = rows;
      const last = rows[rows.length - 1];
      return {
        organizationId: params.organizationId,
        backfillId: params.backfillId,
        sessionKey: first.sessionKey,
        sessionSource: first.sessionSource,
        apiShape: first.apiShape,
        client: first.client,
        startedAt: utcDate(first.createdAtText),
        lastActivityAt: utcDate(last.createdAtText),
        interactions: rows.length,
        totalTokens: rows.reduce((total, row) => total + row.tokens, 0),
        sampleRank: sql<bigint>`hashtextextended(${first.sessionKey}, 0)`,
        firstInteractionId: first.id,
      };
    });
    const earlier = sql`excluded.started_at < ${sessions.startedAt}`;
    await tx
      .insert(sessions)
      .values(values)
      .onConflictDoUpdate({
        target: [sessions.organizationId, sessions.sessionKey],
        set: {
          startedAt: sql`least(${sessions.startedAt}, excluded.started_at)`,
          lastActivityAt: sql`greatest(${sessions.lastActivityAt}, excluded.last_activity_at)`,
          interactions: sql`${sessions.interactions} + excluded.interactions`,
          totalTokens: sql`${sessions.totalTokens} + excluded.total_tokens`,
          firstInteractionId: sql`case when ${earlier} then excluded.first_interaction_id else ${sessions.firstInteractionId} end`,
          sessionSource: sql`case when ${earlier} then excluded.session_source else ${sessions.sessionSource} end`,
          apiShape: sql`case when ${earlier} then excluded.api_shape else ${sessions.apiShape} end`,
          client: sql`case when ${earlier} then excluded.client else ${sessions.client} end`,
        },
        setWhere: sql`${sessions.backfillId} = excluded.backfill_id`,
      });
  }

  /**
   * Drops the backfill's sessions still active within a day of its cutoff
   * (a later scan finds them whole), then counts the population a sample is
   * drawn from: every scanned session started in [windowStart, cutoff) that
   * live routing has not seen.
   */
  static async finishScan(
    backfill: {
      id: string;
      organizationId: string;
      windowStart: Date;
      cutoff: Date;
    },
    tx: Transaction,
  ): Promise<{
    sessions: number;
    tokens: number;
    breakdown: RoutingBackfillBreakdown;
  }> {
    const idleBefore = new Date(backfill.cutoff.getTime() - HISTORY_IDLE_MS);
    await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.backfillId, backfill.id),
          sql`${sessions.lastActivityAt} >= ${idleBefore.toISOString()}::timestamptz`,
        ),
      );
    const rows = await tx.execute<{
      api_shape: string;
      client: string;
      sessions: number;
      tokens: string;
    }>(sql`
      select s.api_shape, s.client, count(*)::int as sessions,
        coalesce(sum(s.total_tokens), 0) as tokens
      from routing_history_sessions s
      where ${population({ ...backfill, includeBackfillId: backfill.id })}
      group by s.api_shape, s.client
      order by sessions desc, s.api_shape, s.client`);
    return {
      sessions: rows.rows.reduce((total, row) => total + row.sessions, 0),
      tokens: rows.rows.reduce((total, row) => total + Number(row.tokens), 0),
      breakdown: rows.rows.map((row) => ({
        apiShape: RoutingApiShapeSchema.parse(row.api_shape),
        client: row.client,
        sessions: row.sessions,
      })),
    };
  }

  /** Sessions of a scan that never finished: partial, so no later scan may skip them. */
  static async deleteBackfillSessions(backfillId: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.backfillId, backfillId));
  }

  /**
   * The sample's sessions without a reading by the scorer version, in
   * sample order. The sample is the `maxSessions` lowest-ranked sessions of
   * the population: the same sessions on every run and replica.
   */
  static async nextToScore(
    params: SampleParams & { limit: number },
  ): Promise<RoutingHistorySession[]> {
    const rows = await db
      .select()
      .from(sessions)
      .where(
        and(
          sql`${sessions.id} in (select sampled.id from (${sample(params)}) sampled)`,
          notExists(
            db
              .select({ one: sql`1` })
              .from(scores)
              .where(
                and(
                  eq(scores.historySessionId, sessions.id),
                  eq(scores.scorerVersionId, params.scorerVersionId),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(sessions.sampleRank), asc(sessions.id))
      .limit(params.limit);
    return rows.map((row) => SelectRoutingHistorySessionSchema.parse(row));
  }

  /** How far scoring of the sample got for the scorer version. */
  static async sampleProgress(params: SampleParams): Promise<SampleProgress> {
    const result = await db.execute<{
      sample: number;
      scored: number;
      no_text: number;
      failed: number;
    }>(sql`
      with sample as (${sample(params)})
      select count(*)::int as sample,
        count(*) filter (where sc.status = 'scored')::int as scored,
        count(*) filter (where sc.status = 'no_text')::int as no_text,
        count(*) filter (where sc.status = 'failed')::int as failed
      from sample s
      left join routing_history_scores sc
        on sc.history_session_id = s.id and sc.scorer_version_id = ${params.scorerVersionId}`);
    const [row] = result.rows;
    return {
      sample: row?.sample ?? 0,
      scored: row?.scored ?? 0,
      noText: row?.no_text ?? 0,
      failed: row?.failed ?? 0,
    };
  }

  /** Copies the session's per-interaction usage, read through the organization's profiles. */
  static async copyUsage(
    session: RoutingHistorySession,
    tx: Transaction,
  ): Promise<void> {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
    );
    await tx.execute(sql`
      insert into routing_history_usage
        (interaction_id, history_session_id, created_at, input, cache_read, cache_write, cache_write_1h, output)
      select i.id, ${session.id}, i.created_at at time zone 'UTC',
        coalesce(i.input_tokens, 0), coalesce(i.cache_read_tokens, 0),
        coalesce(i.cache_write_tokens, 0), coalesce(i.cache_write_1h_tokens, 0),
        coalesce(i.output_tokens, 0)
      from interactions i
      where ${sessionInteractions(session)}
        and (i.input_tokens is not null or i.output_tokens is not null)
      on conflict (interaction_id) do nothing`);
  }

  /** The session's first rows in (created_at, id) order, decrypted where the server holds the key. */
  static async openingRows(
    session: RoutingHistorySession,
  ): Promise<OpeningRow[]> {
    const result = await withStatementTimeout((tx) =>
      tx.execute<{
        id: string;
        request: unknown;
        session_source: string | null;
        source: string | null;
        parent_id: string | null;
        encrypted_chat_conversation_id: string | null;
      }>(sql`
        select i.id, i.request, i.session_source, i.source, i.parent_id,
          i.encrypted_chat_conversation_id
        from interactions i
        where ${sessionInteractions(session)}
        order by i.created_at, i.id
        limit ${OPENING_ROWS}`),
    );
    return result.rows.map((raw) => {
      const row = readInteractionRow(raw);
      return {
        id: row.id,
        request: row.request,
        sessionSource: row.session_source,
        source: row.source,
        parentId: row.parent_id,
        encrypted: row.encrypted_chat_conversation_id !== null,
      };
    });
  }

  static async recordScore(
    values: {
      historySessionId: string;
      scorerVersionId: string;
      status: RoutingHistoryScoreStatus;
      features: RoutingDecisionFeatures | null;
      scorerCost: number | null;
    },
    tx: Transaction,
  ): Promise<void> {
    await tx
      .insert(scores)
      .values({
        ...values,
        scorerCost: values.scorerCost?.toFixed(10) ?? null,
      })
      .onConflictDoNothing();
  }

  /**
   * The past sessions a fit over the history window from `windowStart`
   * would read: the population (scanned, not seen by live routing) and how
   * many of them the scorer version scored. Cheap: no session is
   * materialized.
   */
  static async findPopulation(params: PopulationParams): Promise<PastWindow> {
    const [row] = (
      await db.execute<{
        sessions: number;
        scored: number;
        tokens: string;
        first_ms: string | null;
        last_ms: string | null;
      }>(sql`
        select count(*)::int as sessions,
          count(*) filter (where ${scoredWithUsage(params.scorerVersionId)})::int as scored,
          coalesce(sum(s.total_tokens), 0) as tokens,
          extract(epoch from min(s.started_at)) * 1000 as first_ms,
          extract(epoch from max(s.started_at)) * 1000 as last_ms
        from routing_history_sessions s
        where ${fitPopulation(params)}`)
    ).rows;
    return {
      scored: row?.scored ?? 0,
      population: {
        sessions: row?.sessions ?? 0,
        tokens: Number(row?.tokens ?? 0),
        firstCreatedAt: row?.first_ms ? new Date(Number(row.first_ms)) : null,
        lastCreatedAt: row?.last_ms ? new Date(Number(row.last_ms)) : null,
      },
    };
  }

  /**
   * Each past session the scorer version scored, with its usage split at
   * `longContextThreshold` like live usage and weighted by the inverse of
   * the scored share of the population, so the sample stands for all of it.
   */
  static async findFitHistory(
    params: PopulationParams & { longContextThreshold: number | null },
  ): Promise<PastWindow & { sample: HistoryFitRow[] }> {
    const window = await RoutingHistoryModel.findPopulation(params);
    const prompt = sql`u.input + u.cache_read + u.cache_write`;
    const long =
      params.longContextThreshold === null
        ? sql`false`
        : sql`${prompt} > ${params.longContextThreshold}`;
    const block = (filter: SQL, prefix: "s" | "l") => sql`
      coalesce(sum(u.input) filter (where ${filter}), 0) as ${sql.raw(`${prefix}_input`)},
      coalesce(sum(u.cache_read) filter (where ${filter}), 0) as ${sql.raw(`${prefix}_cache_read`)},
      coalesce(sum(u.cache_write) filter (where ${filter}), 0) as ${sql.raw(`${prefix}_cache_write`)},
      coalesce(sum(u.output) filter (where ${filter}), 0) as ${sql.raw(`${prefix}_output`)}`;
    const rows = await db.execute<{
      started_ms: string;
      features: unknown;
      s_input: string;
      s_cache_read: string;
      s_cache_write: string;
      s_output: string;
      l_input: string;
      l_cache_read: string;
      l_cache_write: string;
      l_output: string;
    }>(sql`
      select extract(epoch from s.started_at) * 1000 as started_ms, sc.features,
        ${block(sql`not (${long})`, "s")}, ${block(long, "l")}
      from routing_history_sessions s
      join routing_history_scores sc
        on sc.history_session_id = s.id
        and sc.scorer_version_id = ${params.scorerVersionId}
        and sc.status = 'scored'
      join routing_history_usage u on u.history_session_id = s.id
      where ${fitPopulation(params)}
      group by s.id, s.started_at, sc.features
      order by s.started_at, s.id`);
    const weight =
      window.scored === 0 ? 1 : window.population.sessions / window.scored;
    return {
      ...window,
      sample: rows.rows.map((row) => ({
        createdAt: new Date(Number(row.started_ms)),
        features: RoutingDecisionFeaturesSchema.parse(row.features),
        short: {
          input: Number(row.s_input),
          cacheRead: Number(row.s_cache_read),
          cacheWrite: Number(row.s_cache_write),
          output: Number(row.s_output),
        },
        long: {
          input: Number(row.l_input),
          cacheRead: Number(row.l_cache_read),
          cacheWrite: Number(row.l_cache_write),
          output: Number(row.l_output),
        },
        weight,
      })),
    };
  }
}

export default RoutingHistoryModel;

type PopulationParams = {
  organizationId: string;
  scorerVersionId: string;
  windowStart: Date;
};

/** Past sessions in a fit's history window. */
export type PastWindow = {
  population: FitVolume;
  /** Sessions of the population scored by the scorer version, with usage. */
  scored: number;
};

type SampleParams = {
  organizationId: string;
  windowStart: Date;
  cutoff: Date;
  maxSessions: number;
  scorerVersionId: string;
};

export type SampleProgress = {
  sample: number;
  scored: number;
  noText: number;
  failed: number;
};

/** A scored history session as the fit reads it. */
export type HistoryFitRow = {
  createdAt: Date;
  features: RoutingDecisionFeatures;
  short: TokenBlock;
  long: TokenBlock;
  weight: number;
};

type TokenBlock = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

/** An interaction a backfill reads: a conversation turn of a shape auto routing serves, from a client's own session. */
const eligibleInteraction = sql`i.session_id is not null
  and i.session_source in (${sql.join(
    SESSION_SOURCES.map((source) => sql`${source}`),
    sql`, `,
  )})
  and (i.source in ('api', 'model_router') or i.source like 'opencode:%' or i.source like 'kilo:%')
  and (i.type like '%:chatCompletions' or i.type like '%:responses' or i.type = 'anthropic:messages')`;

function apiShape(type: string): RoutingApiShape {
  if (type.endsWith(":responses")) return "responses";
  if (type.endsWith(":chatCompletions")) return "chat_completions";
  return "messages";
}

/**
 * The session's eligible interactions, through the organization's profiles:
 * another organization's rows under the same session id are never read.
 */
function sessionInteractions(session: RoutingHistorySession): SQL {
  // The bounds come back as millisecond Dates over microsecond timestamps,
  // so the upper one is widened by the truncated part.
  return sql`i.session_id = ${session.sessionKey}
    and i.profile_id in (select a.id from agents a where a.organization_id = ${session.organizationId})
    and i.created_at >= ${utc(session.startedAt)}::timestamp
    and i.created_at < ${utc(session.lastActivityAt)}::timestamp + interval '1 millisecond'
    and ${eligibleInteraction}`;
}

/**
 * Scanned sessions of the organization started from `windowStart` (and
 * before `cutoff`) that live routing has no decision for. A scan still in
 * progress counts only when it is `includeBackfillId`.
 */
function population(params: {
  organizationId: string;
  windowStart: Date;
  cutoff: Date | null;
  includeBackfillId: string | null;
}): SQL {
  const scanned = params.includeBackfillId
    ? sql`(b.scanned_at is not null or b.id = ${params.includeBackfillId})`
    : sql`b.scanned_at is not null`;
  return sql`s.organization_id = ${params.organizationId}
    and s.started_at >= ${params.windowStart.toISOString()}::timestamptz
    ${params.cutoff ? sql`and s.started_at < ${params.cutoff.toISOString()}::timestamptz` : sql``}
    and exists (select 1 from routing_backfills b where b.id = s.backfill_id and ${scanned})
    and not exists (
      select 1 from routing_decisions d
      where d.organization_id = s.organization_id and d.session_key = s.session_key
    )`;
}

function fitPopulation(params: PopulationParams): SQL {
  return population({ ...params, cutoff: null, includeBackfillId: null });
}

function scoredWithUsage(scorerVersionId: string): SQL {
  return sql`exists (
      select 1 from routing_history_scores sc
      where sc.history_session_id = s.id and sc.scorer_version_id = ${scorerVersionId}
        and sc.status = 'scored'
    ) and exists (select 1 from routing_history_usage u where u.history_session_id = s.id)`;
}

function sample(params: SampleParams): SQL {
  return sql`select s.* from routing_history_sessions s
    where ${population({ ...params, includeBackfillId: null })}
    order by s.sample_rank, s.id
    limit ${params.maxSessions}`;
}

/** `interactions.created_at` holds UTC wall-clock time without a zone. */
function utc(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function utcDate(text: string): Date {
  return new Date(`${text.replace(" ", "T")}Z`);
}

async function withStatementTimeout<T>(
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
    );
    return callback(tx);
  });
}
