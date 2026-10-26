import { and, count, eq, gte, isNotNull, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import db, { schema, type Transaction } from "@/database";
import {
  type InsertRoutingUsage,
  RoutingSessionFeaturesSchema,
} from "@/types/auto-routing";

const decisions = schema.routingDecisionsTable;
const usage = schema.routingUsageTable;

/** A session counts once nothing was added to it for this long before the fit. */
const IDLE_MS = 24 * 60 * 60 * 1000;
/** How far back the fit reads sessions. */
const HISTORY_MS = 35 * 24 * 60 * 60 * 1000;

class RoutingUsageModel {
  /** Called in the interaction's write transaction; a retried write adds nothing. */
  static async record(tx: Transaction, values: InsertRoutingUsage) {
    await tx
      .insert(usage)
      .values(values)
      .onConflictDoNothing({ target: usage.interactionId });
  }

  /** How many sessions a fit started now would read: the cold-start progress. */
  static async countFitSessions(params: FitWindow): Promise<number> {
    const window = fitWindow(params);
    const sessions = db
      .select({ id: decisions.id })
      .from(decisions)
      .innerJoin(usage, eq(usage.decisionId, decisions.id))
      .where(window.where)
      .groupBy(decisions.id)
      .having(window.having)
      .as("sessions");
    const [row] = await db.select({ sessions: count() }).from(sessions);
    return row?.sessions ?? 0;
  }

  /**
   * Per decision of the given scorer version: its features and summed usage,
   * split into requests whose prompt (input + cache read + cache write)
   * exceeds `longContextThreshold` and the rest. Only sessions idle for a day
   * before `inputWatermark` and created within the history window count.
   */
  static async findFitHistory(params: {
    organizationId: string;
    scorerVersionId: string;
    inputWatermark: Date;
    longContextThreshold: number | null;
  }) {
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
      cacheWrite1h: total(usage.cacheWrite1h, filter),
      output: total(usage.output, filter),
    });

    const rows = await db
      .select({
        decisionId: decisions.id,
        createdAt: decisions.createdAt,
        tierIndex: decisions.tierIndex,
        features: decisions.features,
        short: block(short),
        long: block(long),
        requests: sql<number>`count(*)`.mapWith(Number),
        estimatedRequests:
          sql<number>`count(*) filter (where ${usage.estimated})`.mapWith(
            Number,
          ),
      })
      .from(decisions)
      .innerJoin(usage, eq(usage.decisionId, decisions.id))
      .where(window.where)
      .groupBy(decisions.id)
      .having(window.having)
      .orderBy(decisions.createdAt, decisions.id);
    return rows.map((row) => ({
      ...row,
      features: RoutingSessionFeaturesSchema.parse(row.features),
    }));
  }
}

export default RoutingUsageModel;

type FitWindow = {
  organizationId: string;
  scorerVersionId: string;
  inputWatermark: Date;
};

/** Scored sessions of the scorer version, created within the history window and idle for a day before the watermark. */
function fitWindow(params: FitWindow) {
  const watermark = params.inputWatermark.getTime();
  return {
    where: and(
      eq(decisions.organizationId, params.organizationId),
      eq(decisions.scorerVersionId, params.scorerVersionId),
      isNotNull(decisions.features),
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
