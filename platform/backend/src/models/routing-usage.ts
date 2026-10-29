import {
  and,
  count,
  eq,
  gte,
  isNotNull,
  max,
  min,
  type SQL,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import db, { schema, type Transaction } from "@/database";
import {
  FEATURES_SCHEMA_VERSION,
  type InsertRoutingUsage,
  RoutingDecisionFeaturesSchema,
} from "@/types/auto-routing";

const decisions = schema.routingDecisionsTable;
const usage = schema.routingUsageTable;

/** A session counts once nothing was added to it for this long before the fit. */
const IDLE_MS = 24 * 60 * 60 * 1000;
/** How far back the fit reads sessions. */
export const HISTORY_MS = 35 * 24 * 60 * 60 * 1000;

class RoutingUsageModel {
  /** Called in the interaction's write transaction; a retried write adds nothing. */
  static async record(tx: Transaction, values: InsertRoutingUsage) {
    await tx
      .insert(usage)
      .values(values)
      .onConflictDoNothing({ target: usage.interactionId });
  }

  /** The organization's latest usage recorded since `since`: a range probe over recent usage only. */
  static async findLatestCreatedAt(
    organizationId: string,
    since: Date,
  ): Promise<Date | null> {
    const [row] = await db
      .select({ at: max(usage.createdAt) })
      .from(usage)
      .innerJoin(decisions, eq(decisions.id, usage.decisionId))
      .where(
        and(
          gte(usage.createdAt, since),
          eq(decisions.organizationId, organizationId),
        ),
      );
    return row?.at ?? null;
  }

  /** The window a fit started at `inputWatermark` would read: the cold-start progress, and what a refit would change. */
  static async findFitVolume(params: FitWindow): Promise<FitVolume> {
    const window = fitWindow(params);
    const tokens = sql`${usage.input} + ${usage.cacheRead} + ${usage.cacheWrite} + ${usage.output}`;
    const sessions = db
      .select({
        createdAt: decisions.createdAt,
        tokens: sql<number>`sum(${tokens})`.as("tokens"),
      })
      .from(decisions)
      .innerJoin(usage, eq(usage.decisionId, decisions.id))
      .where(window.where)
      .groupBy(decisions.id)
      .having(window.having)
      .as("sessions");
    const [row] = await db
      .select({
        sessions: count(),
        tokens: sql<number>`coalesce(sum(${sessions.tokens}), 0)`.mapWith(
          Number,
        ),
        firstCreatedAt: min(sessions.createdAt),
        lastCreatedAt: max(sessions.createdAt),
      })
      .from(sessions);
    return (
      row ?? {
        sessions: 0,
        tokens: 0,
        firstCreatedAt: null,
        lastCreatedAt: null,
      }
    );
  }

  /**
   * Per decision of the given scorer version: its features and summed usage,
   * split into requests whose prompt (input + cache read + cache write)
   * exceeds `longContextThreshold` and the rest. Only sessions idle for a day
   * before `inputWatermark` and created within the history window count.
   *
   * `sample` is at most `maxSessions` of them, picked by a hash of the
   * decision id: uniform over time and stable across refits. `volume`
   * aggregates every session of the window in the same statement.
   */
  static async findFitHistory(
    params: FitWindow & { longContextThreshold: number | null },
    maxSessions = MAX_FIT_SESSIONS,
  ) {
    const window = fitWindow(params);
    const prompt = sql`${usage.input} + ${usage.cacheRead} + ${usage.cacheWrite}`;
    const long =
      params.longContextThreshold === null
        ? sql`false`
        : sql`${prompt} > ${params.longContextThreshold}`;
    const short = sql`not (${long})`;
    const block = (filter: SQL) => ({
      input: total(usage.input, filter),
      cacheRead: total(usage.cacheRead, filter),
      cacheWrite: total(usage.cacheWrite, filter),
      output: total(usage.output, filter),
    });

    const tokens = sql`${usage.input} + ${usage.cacheRead} + ${usage.cacheWrite} + ${usage.output}`;

    const rows = await db
      .select({
        id: decisions.id,
        createdAt: decisions.createdAt,
        features: decisions.features,
        short: block(short),
        long: block(long),
        windowSessions: sql<number>`count(*) over ()`.mapWith(Number),
        windowTokens: sql<number>`sum(sum(${tokens})) over ()`.mapWith(Number),
        windowFirst: sql<Date>`min(${decisions.createdAt}) over ()`.mapWith(
          decisions.createdAt,
        ),
        windowLast: sql<Date>`max(${decisions.createdAt}) over ()`.mapWith(
          decisions.createdAt,
        ),
      })
      .from(decisions)
      .innerJoin(usage, eq(usage.decisionId, decisions.id))
      .where(window.where)
      .groupBy(decisions.id)
      .having(window.having)
      .orderBy(sql`hashtextextended(${decisions.id}::text, 0)`)
      .limit(maxSessions);
    const [first] = rows;
    const volume: FitVolume = first
      ? {
          sessions: first.windowSessions,
          tokens: first.windowTokens,
          firstCreatedAt: first.windowFirst,
          lastCreatedAt: first.windowLast,
        }
      : { sessions: 0, tokens: 0, firstCreatedAt: null, lastCreatedAt: null };
    const sample = rows
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((row) => ({
        createdAt: row.createdAt,
        features: RoutingDecisionFeaturesSchema.parse(row.features),
        short: row.short,
        long: row.long,
      }));
    return { sample, volume };
  }
}

export default RoutingUsageModel;

type FitWindow = {
  organizationId: string;
  scorerVersionId: string;
  inputWatermark: Date;
};

/** Bounds the sessions a fit materializes; volume still counts the whole window. */
const MAX_FIT_SESSIONS = 50_000;

/** The whole fit window, however many of its sessions the sample keeps. */
export type FitVolume = {
  sessions: number;
  tokens: number;
  firstCreatedAt: Date | null;
  lastCreatedAt: Date | null;
};

/** Scored sessions of the scorer version, created within the history window and idle for a day before the watermark. */
function fitWindow(params: FitWindow) {
  const watermark = params.inputWatermark.getTime();
  return {
    where: and(
      eq(decisions.organizationId, params.organizationId),
      eq(decisions.scorerVersionId, params.scorerVersionId),
      isNotNull(decisions.features),
      eq(decisions.featuresSchemaVersion, FEATURES_SCHEMA_VERSION),
      gte(decisions.createdAt, new Date(watermark - HISTORY_MS)),
    ),
    having: sql`max(${usage.createdAt}) < ${new Date(watermark - IDLE_MS).toISOString()}::timestamptz`,
  };
}

function total(column: AnyPgColumn, filter: SQL) {
  return sql<number>`coalesce(sum(${column}) filter (where ${filter}), 0)`.mapWith(
    Number,
  );
}
