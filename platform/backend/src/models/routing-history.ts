import {
  CLAUDE_CODE_HEADER_SESSION_SOURCE,
  OPENCODE_FAMILY_SESSION_SOURCES,
} from "@archestra/shared";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
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
/** Rows of a session read per page while looking for its opening main turn. */
const OPENING_PAGE_ROWS = 20;
const PURGE_BATCH_SIZE = 5000;
/** Paid scorer calls a session may take per scorer version before it counts as failed. */
const MAX_PAID_ATTEMPTS = 2;
/** Whether the reading `alias` is still to be taken: pending, with attempts left. */
const retryable = (alias: string) =>
  sql.raw(
    `(${alias}.status = 'pending' and ${alias}.attempts < ${MAX_PAID_ATTEMPTS})`,
  );

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

/** A session's row, decrypted where the server holds the key. */
export type OpeningRow = {
  id: string;
  createdAtText: string;
  apiShape: RoutingApiShape;
  request: unknown;
  sessionSource: string | null;
  source: string | null;
  parentId: string | null;
  encrypted: boolean;
};

class RoutingHistoryModel {
  /**
   * The organization's agents, deleted ones included, with an interaction in
   * [windowStart, cutoff): an organization can hold far more agents than ever
   * see traffic, and a scan visits each one it is given.
   */
  static async profileIds(params: {
    organizationId: string;
    windowStart: Date;
    cutoff: Date;
  }): Promise<string[]> {
    const agents = schema.agentsTable;
    const rows = await withStatementTimeout((tx) =>
      tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.organizationId, params.organizationId),
            sql`exists (
            select 1 from interactions i
            where i.profile_id = ${agents.id}
              and i.created_at >= ${utc(params.windowStart)}::timestamp
              and i.created_at < ${utc(params.cutoff)}::timestamp
          )`,
          ),
        )
        .orderBy(asc(agents.id)),
    );
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
        -- NULLS FIRST matches the backward scan of the created_at DESC NULLS LAST
        -- indexes, so the batch reads ~limit rows instead of sorting the window.
        order by i.created_at nulls first, i.id
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
    // A conversation that began before the window would enter as a false new
    // session, opened at its continuation and with only its tail's usage.
    await setStatementTimeout(tx);
    await tx.execute(sql`
      delete from routing_history_sessions s
      where s.backfill_id = ${backfill.id}
        and exists (
          select 1 from interactions i
          where i.session_id = s.session_key
            and i.profile_id in (select a.id from agents a where a.organization_id = s.organization_id)
            and i.created_at < ${utc(backfill.windowStart)}::timestamp
        )`);
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
   * The sample's sessions the scorer version has still to read, in sample
   * order. The sample is the `maxSessions` lowest-ranked sessions of the
   * population: the same sessions on every run and replica.
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
          sql`not exists (
            select 1 from routing_history_scores sc
            where sc.history_session_id = ${sessions.id}
              and sc.scorer_version_id = ${params.scorerVersionId}
              and not ${retryable("sc")})`,
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
        count(*) filter (where sc.status = 'failed' or (sc.status = 'pending' and not ${retryable("sc")}))::int as failed
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
  static async copyUsage(session: RoutingHistorySession): Promise<void> {
    await withStatementTimeout((tx) =>
      tx.execute(sql`
      insert into routing_history_usage
        (interaction_id, history_session_id, created_at, input, cache_read, cache_write, cache_write_1h, output)
      select i.id, ${session.id}, i.created_at at time zone 'UTC',
        coalesce(i.input_tokens, 0), coalesce(i.cache_read_tokens, 0),
        coalesce(i.cache_write_tokens, 0), coalesce(i.cache_write_1h_tokens, 0),
        coalesce(i.output_tokens, 0)
      from interactions i
      where ${sessionInteractions(session)}
        and (i.input_tokens is not null or i.output_tokens is not null)
      on conflict (interaction_id) do nothing`),
    );
  }

  /** The session's next page of rows after `after`, in (created_at, id) order. */
  static async openingRows(
    session: RoutingHistorySession,
    after: { createdAtText: string; id: string } | null,
  ): Promise<{ rows: OpeningRow[]; last: boolean }> {
    const start = after
      ? sql`and (i.created_at, i.id) > (${after.createdAtText}::timestamp, ${after.id}::uuid)`
      : sql``;
    const result = await withStatementTimeout((tx) =>
      tx.execute<{
        id: string;
        created_at_text: string;
        type: string;
        request: unknown;
        session_source: string | null;
        source: string | null;
        parent_id: string | null;
        encrypted_chat_conversation_id: string | null;
      }>(sql`
        select i.id, i.created_at::text as created_at_text, i.type, i.request,
          i.session_source, i.source, i.parent_id, i.encrypted_chat_conversation_id
        from interactions i
        where ${sessionInteractions(session)} ${start}
        order by i.created_at, i.id
        limit ${OPENING_PAGE_ROWS}`),
    );
    const rows = result.rows.map((raw) => {
      const row = readInteractionRow(raw);
      return {
        id: row.id,
        createdAtText: row.created_at_text,
        apiShape: apiShape(row.type),
        request: row.request,
        sessionSource: row.session_source,
        source: row.source,
        parentId: row.parent_id,
        encrypted: row.encrypted_chat_conversation_id !== null,
      };
    });
    return { rows, last: rows.length < OPENING_PAGE_ROWS };
  }

  /**
   * Counts one paid call for the session, committed with its reservation.
   * False when the session has no attempt left.
   */
  static async takeAttempt(key: ScoreKey, tx: Transaction): Promise<boolean> {
    const rows = await tx
      .insert(scores)
      .values({ ...key, status: "pending", attempts: 1 })
      .onConflictDoUpdate({
        target: [scores.historySessionId, scores.scorerVersionId],
        set: { attempts: sql`${scores.attempts} + 1` },
        setWhere: sql`${scores.status} = 'pending' and ${scores.attempts} < ${MAX_PAID_ATTEMPTS}`,
      })
      .returning({ attempts: scores.attempts });
    return rows.length > 0;
  }

  /** Gives back an attempt whose call was never sent. */
  static async refundAttempt(key: ScoreKey, tx: Transaction): Promise<void> {
    await tx
      .update(scores)
      .set({ attempts: sql`${scores.attempts} - 1` })
      .where(
        and(
          eq(scores.historySessionId, key.historySessionId),
          eq(scores.scorerVersionId, key.scorerVersionId),
          eq(scores.status, "pending"),
        ),
      );
  }

  /** Settles a reading; a session already settled keeps its reading. */
  static async recordScore(
    values: ScoreKey & {
      status: Exclude<RoutingHistoryScoreStatus, "pending">;
      features: RoutingDecisionFeatures | null;
      scorerCost: number | null;
    },
    tx: Transaction,
  ): Promise<void> {
    const scorerCost = values.scorerCost?.toFixed(10) ?? null;
    await tx
      .insert(scores)
      .values({ ...values, scorerCost })
      .onConflictDoUpdate({
        target: [scores.historySessionId, scores.scorerVersionId],
        set: { status: values.status, features: values.features, scorerCost },
        setWhere: sql`${scores.status} = 'pending'`,
      });
  }

  /** Settles the organization's sessions whose attempts ran out as failed. */
  static async failExhausted(
    params: { organizationId: string; scorerVersionId: string },
    tx: Transaction,
  ): Promise<void> {
    await tx.execute(sql`
      update routing_history_scores sc set status = 'failed'
      from routing_history_sessions s
      where s.id = sc.history_session_id and s.organization_id = ${params.organizationId}
        and sc.scorer_version_id = ${params.scorerVersionId}
        and sc.status = 'pending' and not ${retryable("sc")}`);
  }

  /**
   * The past sessions a fit learns from, in one statement so counts and rows
   * agree: the frame is the population of the latest finished scan (`frame`)
   * started from `windowStart`; the sample, the rank prefix of the frame the
   * scorer version attempted without a gap. Each scored session of the
   * sample stands for `population / scored` sessions. `withSample: false`
   * counts without reading the sessions.
   */
  static async findFitSnapshot(params: {
    organizationId: string;
    scorerVersionId: string;
    frame: { windowStart: Date; cutoff: Date };
    windowStart: Date;
    longContextThreshold: number | null;
    withSample: boolean;
  }): Promise<PastWindow & { sample: HistoryFitRow[] }> {
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
    const windowStart =
      params.windowStart > params.frame.windowStart
        ? params.windowStart
        : params.frame.windowStart;
    const result = await db.execute<{
      sessions: number;
      scored: number;
      tokens: string;
      first_ms: string | null;
      last_ms: string | null;
      started_ms: string | null;
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
      with frame as (
        select s.id, s.sample_rank, s.started_at, s.total_tokens, sc.status, sc.attempts, sc.features
        from routing_history_sessions s
        left join routing_history_scores sc
          on sc.history_session_id = s.id and sc.scorer_version_id = ${params.scorerVersionId}
        where ${population({
          organizationId: params.organizationId,
          windowStart,
          cutoff: params.frame.cutoff,
          includeBackfillId: null,
        })}
      ),
      gap as (
        select sample_rank, id from frame
        where status is null or ${retryable("frame")}
        order by sample_rank, id limit 1
      ),
      sample as (
        select f.* from frame f
        where f.status = 'scored'
          and not exists (select 1 from gap g where (f.sample_rank, f.id) > (g.sample_rank, g.id))
          and exists (select 1 from routing_history_usage u where u.history_session_id = f.id)
      ),
      summary as (
        select count(*)::int as sessions,
          (select count(*)::int from sample) as scored,
          coalesce(sum(total_tokens), 0) as tokens,
          extract(epoch from min(started_at)) * 1000 as first_ms,
          extract(epoch from max(started_at)) * 1000 as last_ms
        from frame
      ),
      rows as (
        select extract(epoch from s.started_at) * 1000 as started_ms, s.features,
          ${block(sql`not (${long})`, "s")}, ${block(long, "l")}
        from sample s
        join routing_history_usage u on u.history_session_id = s.id
        where ${params.withSample ? sql`true` : sql`false`}
        group by s.id, s.started_at, s.features
      )
      select summary.*, rows.* from summary left join rows on true
      order by rows.started_ms`);
    const [summary] = result.rows;
    const scored = summary?.scored ?? 0;
    const volume = {
      sessions: summary?.sessions ?? 0,
      tokens: Number(summary?.tokens ?? 0),
      firstCreatedAt: summary?.first_ms
        ? new Date(Number(summary.first_ms))
        : null,
      lastCreatedAt: summary?.last_ms
        ? new Date(Number(summary.last_ms))
        : null,
    };
    // Ranks are a uniform hash, so the prefix is a simple random sample of the
    // frame; its unscorable sessions are taken as missing at random.
    const weight = scored === 0 ? 1 : volume.sessions / scored;
    return {
      scored,
      population: volume,
      sample: result.rows.flatMap((row) =>
        row.started_ms === null
          ? []
          : [
              {
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
              },
            ],
      ),
    };
  }

  /**
   * Deletes, `batchSize` rows per statement, history no fit can read any
   * more: sessions started before `windowStart` (with their usage and
   * scores), scores by a scorer version that is neither `keepScorerVersionId`
   * nor the organization's, and finished backfills whose sessions are gone.
   * Nothing a running or waiting backfill covers is touched.
   */
  static async purgeExpired(params: {
    windowStart: Date;
    keepScorerVersionId: string;
    batchSize?: number;
  }): Promise<{ sessions: number; scores: number; backfills: number }> {
    const batchSize = params.batchSize ?? PURGE_BATCH_SIZE;
    const active = (organizationId: SQL, covers: SQL) => sql`exists (
      select 1 from routing_backfills b
      where b.organization_id = ${organizationId} and b.status in ('running', 'scanned')
        and ${covers})`;
    return {
      sessions: await deleteInBatches(
        batchSize,
        (limit) => sql`
          delete from routing_history_sessions where id in (
            select s.id from routing_history_sessions s
            where s.started_at < ${params.windowStart.toISOString()}::timestamptz
              and not ${active(sql`s.organization_id`, sql`s.started_at >= b.window_start`)}
            limit ${limit})`,
      ),
      scores: await deleteInBatches(
        batchSize,
        (limit) => sql`
          delete from routing_history_scores where (history_session_id, scorer_version_id) in (
            select sc.history_session_id, sc.scorer_version_id
            from routing_history_scores sc
            join routing_history_sessions s on s.id = sc.history_session_id
            where sc.scorer_version_id <> ${params.keepScorerVersionId}
              and not exists (
                select 1 from agents a
                where a.organization_id = s.organization_id
                  and a.auto_routing_scorer_version_id = sc.scorer_version_id
              )
              and not ${active(sql`s.organization_id`, sql`b.scorer_version_id = sc.scorer_version_id`)}
            limit ${limit})`,
      ),
      backfills: await deleteInBatches(
        batchSize,
        (limit) => sql`
          delete from routing_backfills where id in (
            select b.id from routing_backfills b
            where b.status not in ('running', 'scanned')
              and b.cutoff < ${params.windowStart.toISOString()}::timestamptz
              and not exists (select 1 from routing_history_sessions s where s.backfill_id = b.id)
            limit ${limit})`,
      ),
    };
  }
}

export default RoutingHistoryModel;

/** Past sessions in a fit's history window. */
export type PastWindow = {
  population: FitVolume;
  /** Scored sessions of the sample, with usage. */
  scored: number;
};

type ScoreKey = { historySessionId: string; scorerVersionId: string };

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
    await setStatementTimeout(tx);
    return callback(tx);
  });
}

async function setStatementTimeout(tx: Transaction): Promise<void> {
  await tx.execute(
    sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
  );
}

async function deleteInBatches(
  batchSize: number,
  statement: (limit: number) => SQL,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.execute<{ deleted: number }>(sql`
      with removed as (${statement(batchSize)} returning 1)
      select count(*)::int as deleted from removed`);
    const deleted = result.rows[0]?.deleted ?? 0;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
